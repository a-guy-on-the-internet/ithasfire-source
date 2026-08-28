/**
 * seed-application-form-templates.ts — Install the platform starter catalogue
 * of application forms (docs/specs/2026-08-10/application-driven-events.spec.md,
 * Phase 4).
 *
 * Usage (against remote Neon):
 *   DATABASE_URL=<neon-url> pnpm -F api exec tsx \
 *     src/scripts/seed-application-form-templates.ts
 *
 * Or via the root convenience scripts:
 *   pnpm seed:application-form-templates          (local dev DB, dotenv-aware)
 *   pnpm seed:application-form-templates:remote   (uses exported DATABASE_URL)
 *
 * ── Default: INSTALL-ONLY ──────────────────────────────────────────────────
 *
 * Creates catalogue templates that do not exist yet and touches nothing else.
 * It never overwrites an existing row's content and never deletes: this script
 * runs on EVERY deploy dispatch, and a deploy for an unrelated web fix must not
 * revert or destroy curated copy.
 *
 * Two opt-ins widen it — both OFF in the deploy workflows:
 *
 *   --refresh   Push this file's content over existing catalogue rows.
 *   --prune     Delete catalogue rows the git baseline no longer names
 *               (plus case-folded duplicates), audited in-transaction.
 *
 * Either can also be set from the environment:
 *
 *   APPLICATION_FORM_TEMPLATES_REFRESH=1  APPLICATION_FORM_TEMPLATES_PRUNE=1
 *
 * Idempotent in every mode: keyed on the case-folded template name among
 * `isPlatform: true` rows, so a re-run reconciles in place and never churns
 * ids. A converged run writes nothing at all, including no audit rows.
 */

import "dotenv/config";
import { getPrisma } from "@th/db";
import { ensureApplicationFormTemplates } from "./seed/index.js";

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
  // destructive behaviour, so "I thought I passed it" must not be a possible
  // outcome in either direction.
  console.error(
    `Unknown argument(s): ${unknown.join(", ")}. Supported: --refresh, --prune`,
  );
  process.exit(1);
}

const refresh = flag("refresh", "APPLICATION_FORM_TEMPLATES_REFRESH");
const prune = flag("prune", "APPLICATION_FORM_TEMPLATES_PRUNE");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Pass it as an env var or put it in .env.local.",
  );
  process.exit(1);
}

try {
  const url = new URL(process.env.DATABASE_URL);
  console.log(`[application-form-templates-seed] Target host: ${url.hostname}`);
} catch {
  console.log(
    "[application-form-templates-seed] DATABASE_URL set (could not parse host)",
  );
}

console.log(
  `[application-form-templates-seed] mode: ${
    refresh || prune
      ? [refresh ? "refresh" : null, prune ? "prune" : null]
          .filter(Boolean)
          .join(" + ")
      : "install-only (no updates, no deletes)"
  }`,
);

const prisma = getPrisma();

async function main() {
  const result = await ensureApplicationFormTemplates(prisma, {
    refresh,
    prune,
  });
  console.log(
    `[application-form-templates-seed] ${result.templateCount} templates ` +
      `(created ${result.created}; updated ${result.updated}; removed ${result.removed})`,
  );
}

main()
  .catch((err) => {
    console.error("[application-form-templates-seed] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
