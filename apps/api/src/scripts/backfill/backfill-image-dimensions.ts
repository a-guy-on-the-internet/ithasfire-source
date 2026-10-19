/**
 * backfill-image-dimensions.ts — DRY-RUN-BY-DEFAULT backfill of
 * `event_images.width` / `height` for images uploaded before finalize started
 * recording them (2026-10).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The event poster `<img>` carries the file's pixel size as `width`/`height`
 * so the browser reserves its box before the bytes arrive (cold-load CLS 0.48
 * at 320px without it). `finalizeEventImageUpload` reads the size for new
 * uploads; this fills the rows that predate it.
 *
 * It reads the size the SAME way finalize does, through
 * `readStoredImageDimensions`: a ranged read of the first 256 KB of the object
 * (never the whole file), parsed by the header reader in
 * `@th/core/lib/images/image-dimensions`. A header that cannot be parsed from
 * that prefix stays null; there is no full-file fallback.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *   - Nothing is written unless `--apply` is passed.
 *   - Only finalized, live rows with no width yet are selected
 *     (`uploadedAt IS NOT NULL AND deletedAt IS NULL AND width IS NULL`).
 *   - Every write is a Prisma `updateMany` scoped to ONE id, setting ONLY
 *     `width` and `height`, compare-and-swap guarded on `width` still being
 *     null, so a row finalize measured mid-run is never overwritten.
 *   - Paging is keyset on `id`, so rows that stay null (unreadable header,
 *     storage miss) are passed over rather than re-read forever.
 *   - Storage is only READ. A missing object or a storage error is counted
 *     and the row is left alone.
 *   - The guard checks what getPrisma (`packages/db/src/index.ts`) really
 *     connects to: DATABASE_URL's HOSTNAME. getPrisma ignores a `?host=`
 *     param, so a URL carrying one is refused outright (it would make a
 *     remote URL look local), and so is an empty hostname (pg would fall
 *     back to PGHOST).
 *   - `--apply` against a non-local hostname requires
 *     `--confirm-remote-host=<hostname>` matching it exactly.
 *   - Against a local hostname, `localhost` is pinned to ::1 (IPv6 first, no
 *     IPv4 fallback) before connecting, because 127.0.0.1:5432 can be a lima
 *     CI Postgres and the real dev DB listens on ::1. `--apply` on a local
 *     database therefore requires the hostname `localhost` (127.0.0.1 is
 *     refused) and checks that `localhost` now resolves to ::1.
 *     The pin is PROCESS-WIDE: it also governs the storage client's sockets.
 *     With a local DB and a remote R2/S3 endpoint on a network with no IPv6
 *     route, every read fails (ENETUNREACH, counted as storage failures) and
 *     nothing is written. Run that combination from a host with IPv6, or
 *     point the DB and storage at the same side.
 *
 * ── Environment ─────────────────────────────────────────────────────────────
 * DATABASE_URL and S3_BUCKET / S3_ENDPOINT / S3_ACCESS_KEY_ID /
 * S3_SECRET_ACCESS_KEY. Unset keys are filled from `apps/api/.env.local`, then
 * the repo-root `.env.local` (never overriding what the shell set). For the
 * local dev DB use `localhost` as the hostname: pg cannot connect to a
 * bracketed `[::1]` hostname, and the ::1 pin above makes `localhost` reach
 * the right Postgres. Do NOT add `?host=::1`: getPrisma ignores it and the
 * script refuses it.
 *
 * USAGE — from the repo root:
 *
 *   # dry run (reads storage, writes nothing)
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dev?schema=public" \
 *     pnpm -F api exec tsx src/scripts/backfill/backfill-image-dimensions.ts
 *
 *   # apply
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dev?schema=public" \
 *     pnpm -F api exec tsx src/scripts/backfill/backfill-image-dimensions.ts --apply
 *
 *   # apply (remote)
 *   DATABASE_URL=<url> S3_...=<...> pnpm -F api exec tsx \
 *     src/scripts/backfill/backfill-image-dimensions.ts \
 *     --apply --confirm-remote-host=<host>
 *
 * Options: `--limit=<n>` stops after n rows; `--batch=<n>` sets the page size
 * (default 100).
 */

import dns from "node:dns";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { config as dotenvConfig } from "dotenv";

import { S3FileStorageAdapter } from "@th/adapters/file-storage/s3";
import { readStoredImageDimensions } from "@th/core/lib/images/read-stored-image-dimensions";
import { getPrisma } from "@th/db";
import { isFileStorageError } from "@th/ports/file-storage";

const SCRIPT_NAME = "backfill-image-dimensions";
// Compared against `URL.hostname`, lowercased. That always brackets IPv6, so
// "[::1]" is the only form of the IPv6 loopback that can appear.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

let prisma: ReturnType<typeof getPrisma> | undefined;

const here = path.dirname(fileURLToPath(import.meta.url));
// Fill, never override: an explicitly exported value always wins.
dotenvConfig({ path: path.resolve(here, "../../../.env.local"), override: false });
dotenvConfig({
  path: path.resolve(here, "../../../../../.env.local"),
  override: false,
});

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "confirm-remote-host": { type: "string" },
    limit: { type: "string" },
    batch: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const APPLY = values.apply === true;
const LIMIT = parsePositiveInt(values.limit, "--limit");
const BATCH = parsePositiveInt(values.batch, "--batch") ?? 100;

function parsePositiveInt(raw: string | undefined, flag: string) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer (got "${raw}")`);
  }
  return n;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The host getPrisma will actually connect to: `url.hostname`
 * (packages/db/src/index.ts builds its pool from it and ignores `?host=`).
 * A `host=` param is refused rather than trusted or stripped: it is the one
 * way a remote URL could pass for local here.
 */
function resolveDbHost(): string {
  const raw = requireEnv("DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL");
  }
  if (parsed.searchParams.has("host")) {
    throw new Error(
      `Refusing to run: DATABASE_URL has a host= param ("${parsed.searchParams.get("host")}"). ` +
        `getPrisma ignores it and connects to the hostname "${parsed.hostname}"; remove it. ` +
        `For the local dev DB use localhost (it is pinned to ::1).`,
    );
  }
  if (!parsed.hostname) {
    throw new Error(
      "Refusing to run: DATABASE_URL has no hostname, so pg would fall back to PGHOST.",
    );
  }
  // `postgresql:` URLs keep the host's case (`LOCALHOST` stays upper), and
  // DNS does not care, so compare lowercased.
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".")) {
    // `localhost.` resolves like `localhost` but would miss LOCAL_HOSTS, and a
    // remote FQDN with a dot would never match --confirm-remote-host.
    throw new Error(
      `Refusing to run: DATABASE_URL hostname "${hostname}" ends with a dot; remove it.`,
    );
  }
  return hostname;
}

function assertWriteAllowed(host: string): void {
  if (!APPLY || LOCAL_HOSTS.has(host)) return;
  if (values["confirm-remote-host"] !== host) {
    throw new Error(
      `Refusing to --apply against remote host "${host}".\n` +
        `Re-run with --confirm-remote-host=${host} if that is intended.`,
    );
  }
}

async function main() {
  const host = resolveDbHost();
  assertWriteAllowed(host);

  const storage = new S3FileStorageAdapter({
    bucket: requireEnv("S3_BUCKET"),
    endpoint: requireEnv("S3_ENDPOINT"),
    accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
  });

  console.log(
    `${SCRIPT_NAME} — ${APPLY ? "APPLY" : "DRY RUN"} against db ${host}, ` +
      `bucket ${process.env.S3_BUCKET} @ ${process.env.S3_ENDPOINT}\n`,
  );

  if (LOCAL_HOSTS.has(host)) {
    // Every pool connection resolves `localhost` again; pin it to ::1 so none
    // can land on a 127.0.0.1 Postgres (lima CI) instead of the dev DB.
    dns.setDefaultResultOrder("ipv6first");
    net.setDefaultAutoSelectFamily(false);
    const resolved = await dns.promises.lookup("localhost");
    console.log(`  localhost resolves to ${resolved.address}\n`);
    if (APPLY && host !== "localhost") {
      throw new Error(
        `Refusing to --apply against "${host}": 127.0.0.1:5432 can be a lima CI ` +
          `Postgres and pg cannot reach a bracketed [::1]. Use localhost (pinned to ::1).`,
      );
    }
    if (APPLY && resolved.address !== "::1") {
      throw new Error(
        `Refusing to --apply: localhost resolves to ${resolved.address}, not ::1 where the dev DB lives.`,
      );
    }
  }

  const db = getPrisma();
  prisma = db;
  const stats = {
    scanned: 0,
    measured: 0,
    written: 0,
    unreadable: 0,
    storageFailed: 0,
    skippedDrift: 0,
  };
  const failuresByCode = new Map<string, number>();

  let cursor: string | undefined;
  while (LIMIT === undefined || stats.scanned < LIMIT) {
    const take =
      LIMIT === undefined ? BATCH : Math.min(BATCH, LIMIT - stats.scanned);
    const rows = await db.image.findMany({
      where: {
        uploadedAt: { not: null },
        deletedAt: null,
        width: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, key: true, contentType: true },
      orderBy: { id: "asc" },
      take,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      stats.scanned += 1;

      let size: { width: number; height: number } | null;
      try {
        size = await readStoredImageDimensions(storage, row.key);
      } catch (err) {
        stats.storageFailed += 1;
        const code = isFileStorageError(err) ? err.code : "unknown";
        failuresByCode.set(code, (failuresByCode.get(code) ?? 0) + 1);
        console.log(`  FAIL  ${row.id} ${row.key} storage=${code}`);
        continue;
      }

      if (!size) {
        stats.unreadable += 1;
        console.log(
          `  skip  ${row.id} ${row.key} (${row.contentType ?? "?"}) header unreadable`,
        );
        continue;
      }
      stats.measured += 1;
      console.log(
        `  ${APPLY ? "write" : "plan "} ${row.id} ${size.width}x${size.height}`,
      );

      if (!APPLY) continue;

      const res = await db.image.updateMany({
        where: { id: row.id, width: null },
        data: { width: size.width, height: size.height },
      });
      if (res.count === 0) {
        stats.skippedDrift += 1;
        console.log(`        SKIPPED: row changed since it was read`);
        continue;
      }
      stats.written += 1;
    }
  }

  console.log(`\n${SCRIPT_NAME} summary (${APPLY ? "APPLIED" : "DRY RUN"}):`);
  console.log(`  rows scanned:        ${stats.scanned}`);
  console.log(`  sizes read:          ${stats.measured}`);
  console.log(`  sizes written:       ${stats.written}`);
  console.log(`  header unreadable:   ${stats.unreadable}`);
  console.log(`  storage failures:    ${stats.storageFailed}`);
  for (const [code, n] of failuresByCode) {
    console.log(`    ${code}: ${n}`);
  }
  console.log(`  skipped (drift):     ${stats.skippedDrift}`);
  if (!APPLY) console.log(`\nNothing was written. Re-run with --apply.`);
}

main()
  .catch((err) => {
    console.error(`${SCRIPT_NAME} failed:`, err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
