/**
 * seed-ticket-packs.ts — Install the launch ticket-type catalogue
 * (FR-013, docs/specs/2026-08-04/ticket-type-packs.spec.yaml).
 *
 * Usage (against remote Neon):
 *   DATABASE_URL=<neon-url> pnpm -F api exec tsx \
 *     src/scripts/seed-ticket-packs.ts
 *
 * Or via the root convenience scripts:
 *   pnpm seed:ticket-packs          (local dev DB, dotenv-aware)
 *   pnpm seed:ticket-packs:remote   (uses whatever DATABASE_URL is exported)
 *
 * ── Default: INSTALL-ONLY ──────────────────────────────────────────────────
 *
 * Creates packs and catalogue templates that do not exist yet, and touches
 * nothing else. It never overwrites an existing row's content and never
 * deletes: `/platform/ticket-packs` is where staff author the catalogue,
 * this script runs on EVERY deploy dispatch, and a deploy for an unrelated
 * web fix must not revert or destroy their work.
 *
 * Two opt-ins widen it — both OFF in `deploy-dev.yml` / `deploy-prod.yml`:
 *
 *   --refresh   Push this file's content over existing packs/templates.
 *   --prune     Delete catalogue rows the git baseline no longer names
 *               (plus case-folded duplicates), audited in-transaction.
 *
 * Either can also be set from the environment:
 *
 *   TICKET_PACKS_REFRESH=1   TICKET_PACKS_PRUNE=1
 *
 * Idempotent in every mode: keyed on `TicketPack.key`, then (packId, name)
 * per template, so a re-run reconciles in place and never churns ids. Staff
 * CURATION (status / sortOrder) is preserved after the first insert in
 * every mode. A converged run writes nothing at all, including no audit
 * rows.
 */

import "dotenv/config";
import { getPrisma } from "@th/db";
import { ensureTicketPacks } from "./seed/index.js";

const argv = process.argv.slice(2);

/** `--flag` on argv, or `FOO=1|true|yes` in the environment. */
function flag(name: string, envVar: string): boolean {
  if (argv.includes(`--${name}`)) return true;
  const raw = process.env[envVar]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

const unknown = argv.filter((a) => !["--refresh", "--prune"].includes(a));
if (unknown.length > 0) {
  // Fail loudly rather than silently ignoring a typo: the flags gate
  // destructive behaviour, so "I thought I passed it" must not be a
  // possible outcome in either direction.
  console.error(
    `Unknown argument(s): ${unknown.join(", ")}. Supported: --refresh, --prune`,
  );
  process.exit(1);
}

const refresh = flag("refresh", "TICKET_PACKS_REFRESH");
const prune = flag("prune", "TICKET_PACKS_PRUNE");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Pass it as an env var or put it in .env.local.",
  );
  process.exit(1);
}

try {
  const url = new URL(process.env.DATABASE_URL);
  console.log(`[ticket-packs-seed] Target database host: ${url.hostname}`);
} catch {
  console.log("[ticket-packs-seed] DATABASE_URL set (could not parse host)");
}

console.log(
  `[ticket-packs-seed] mode: ${
    refresh || prune
      ? [refresh ? "refresh" : null, prune ? "prune" : null]
          .filter(Boolean)
          .join(" + ")
      : "install-only (no updates, no deletes)"
  }`,
);

const prisma = getPrisma();

async function main() {
  const result = await ensureTicketPacks(prisma, { refresh, prune });
  console.log(
    `[ticket-packs-seed] ${result.packCount} packs, ${result.templateCount} templates ` +
      `(created ${result.createdPacks} pack(s) / ${result.createdTemplates} template(s); ` +
      `updated ${result.updatedPacks} pack(s) / ${result.updatedTemplates} template(s); ` +
      `removed ${result.removedTemplates} template(s))`,
  );
}

main()
  .catch((err) => {
    console.error("[ticket-packs-seed] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
