import type { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo root — five levels up from apps/api/src/scripts/seed/ */
const REPO_ROOT = resolve(__dirname, "../../../../..");
const PRISMA_CONFIG = resolve(REPO_ROOT, "prisma.config.ts");

/**
 * Nuke-and-pave: DROP the entire public schema and re-apply migrations.
 *
 * This is drastically simpler (and future-proof) compared to the old
 * table-by-table deleteMany approach — we never have to remember to add
 * new tables here when the schema evolves.
 */
export const wipeSeedData = async (prisma: PrismaClient) => {
  const dbUrl = getDatabaseUrl();

  const schemaMatch = dbUrl.match(/[?&]schema=([^&]+)/);
  const schemaName = schemaMatch?.[1]
    ? decodeURIComponent(schemaMatch[1])
    : "public";

  // Defense-in-depth: schemaName is parsed from DATABASE_URL and not
  // reachable from HTTP input today, but guard the raw-SQL interpolation
  // below against anything that isn't a plain Postgres identifier.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
    throw new Error(
      `Refusing to wipe schema with unexpected name: ${schemaName}`,
    );
  }

  console.log(`Dropping schema "${schemaName}" and re-applying migrations…`);

  // 1. Drop + recreate the schema
  await prisma.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE; CREATE SCHEMA "${schemaName}";`,
  );

  // 2. Disconnect so Prisma doesn't hold stale references to dropped objects
  await prisma.$disconnect();

  // 3. Re-apply migrations (creates all tables + enums from scratch).
  //    Migrations are the single source of truth — no follow-up `db push`,
  //    since `db push` chokes on the SearchDocument generated tsvector column
  //    and the historical models it used to backfill (PlaceReview, PlaceStats,
  //    Place.listedInDirectory) are all migrated now.
  await runChild("pnpm", [
    "exec",
    "prisma",
    "migrate",
    "deploy",
    "--config",
    PRISMA_CONFIG,
  ]);

  // 4. Reconnect so subsequent seed code works
  await prisma.$connect();

  console.log("  Schema dropped and migrations re-applied — clean slate.");
};

// ── Helpers ──────────────────────────────────────────────────────────────

function getDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL;
  if (!envUrl || /postgres:\/\/USER:PASSWORD@HOST/i.test(envUrl)) {
    return "postgresql://postgres:postgres@localhost:5432/dev?schema=public";
  }
  return envUrl;
}

function runChild(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: { ...process.env },
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`),
        );
    });
  });
}
