/**
 * seed-volunteer-packs.ts — Install the launch volunteer-role catalogue
 * (FR-018, docs/specs/2026-07-27/volunteer-role-packs.spec.yaml).
 *
 * Usage (against remote Neon):
 *   DATABASE_URL=<neon-url> pnpm -F api exec tsx \
 *     src/scripts/seed-volunteer-packs.ts
 *
 * Or via the root convenience scripts:
 *   pnpm seed:volunteer-packs          (local dev DB, dotenv-aware)
 *   pnpm seed:volunteer-packs:remote   (uses whatever DATABASE_URL is exported)
 *
 * ── Default: INSTALL-ONLY ──────────────────────────────────────────────────
 *
 * Creates packs, catalogue roles and anchored shift presets that do not exist
 * yet, and touches nothing else. It never overwrites an existing row's content
 * and never deletes. That is the whole point: `/platform/volunteer-packs` is
 * where staff author the catalogue, this script runs on EVERY deploy dispatch,
 * and a deploy for an unrelated web fix must not revert or destroy their work.
 *
 * Two opt-ins widen it — both OFF in `deploy-dev.yml` / `deploy-prod.yml`:
 *
 *   --refresh   Push this file's content over existing packs/roles/shifts.
 *               This is how a typo fixed in git reaches an environment, and
 *               it is also what reverts a staff edit. Deliberate only.
 *   --prune     Delete catalogue rows the git baseline no longer names (plus
 *               case-folded duplicates). Every delete runs in the same
 *               transaction as a `volunteer_pack.seed_pruned` AuditLog row.
 *
 * Either can also be set from the environment, for CI where passing argv
 * through `pnpm -F api exec` is awkward:
 *
 *   VOLUNTEER_PACKS_REFRESH=1   VOLUNTEER_PACKS_PRUNE=1
 *
 * Idempotent in every mode: keyed on `VolunteerPack.key`, then (packId, name)
 * per role and (templateId, label) per shift, so a re-run reconciles in place
 * and never churns ids. Staff CURATION (status / ranking / targeting) is
 * preserved after the first insert in every mode — see the header of
 * `seed/volunteer-packs.ts`.
 *
 * A converged run writes nothing at all, including no audit rows.
 */

import "dotenv/config";
import { getPrisma } from "@th/db";
import { ensureVolunteerPacks } from "./seed/index.js";

const argv = process.argv.slice(2);

/** `--flag` on argv, or `FOO=1|true|yes` in the environment. */
function flag(name: string, envVar: string): boolean {
  if (argv.includes(`--${name}`)) return true;
  const raw = process.env[envVar]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

const unknown = argv.filter((a) => !["--refresh", "--prune"].includes(a));
if (unknown.length > 0) {
  // Fail loudly rather than silently ignoring a typo'd `--prude`: the flags
  // gate destructive behaviour, so "I thought I passed it" must not be a
  // possible outcome in either direction.
  console.error(
    `Unknown argument(s): ${unknown.join(", ")}. Supported: --refresh, --prune`,
  );
  process.exit(1);
}

const refresh = flag("refresh", "VOLUNTEER_PACKS_REFRESH");
const prune = flag("prune", "VOLUNTEER_PACKS_PRUNE");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Pass it as an env var or put it in .env.local.",
  );
  process.exit(1);
}

try {
  const url = new URL(process.env.DATABASE_URL);
  console.log(`[volunteer-packs-seed] Target database host: ${url.hostname}`);
} catch {
  console.log("[volunteer-packs-seed] DATABASE_URL set (could not parse host)");
}

console.log(
  `[volunteer-packs-seed] mode: ${
    refresh || prune
      ? [refresh ? "refresh" : null, prune ? "prune" : null]
          .filter(Boolean)
          .join(" + ")
      : "install-only (no updates, no deletes)"
  }`,
);

const prisma = getPrisma();

async function main() {
  const result = await ensureVolunteerPacks(prisma, { refresh, prune });
  console.log(
    `[volunteer-packs-seed] ${result.packCount} packs, ${result.roleCount} roles, ${result.shiftCount} shift presets ` +
      `(created ${result.createdPacks} pack(s) / ${result.createdRoles} role(s) / ${result.createdShifts} shift(s); ` +
      `updated ${result.updatedRoles} role(s) / ${result.updatedShifts} shift(s); ` +
      `removed ${result.removedRoles} role(s) / ${result.removedShifts} shift(s))`,
  );
}

main()
  .catch((err) => {
    console.error("[volunteer-packs-seed] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
