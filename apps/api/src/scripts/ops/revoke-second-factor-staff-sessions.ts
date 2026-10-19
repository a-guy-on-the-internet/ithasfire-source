/**
 * Sign out every staff account that has a second factor enrolled: the
 * one-time sweep the owner runs when the passkey-only staff sign-in gate
 * (`apps/api/src/auth/second-factor-bypass.ts`) deploys.
 *
 * Before that gate, a staff account with a passkey and no authenticator app
 * could get a full session from its password, the inbox or Google / Apple,
 * and staff checks pass on an enrolled factor, so those sessions keep staff
 * authority until they end. A session does not record how it was minted, so
 * every enrolled staff holder (passkey or TOTP) is signed out. Staff with no
 * factor are left alone: their roles grant nothing yet.
 *
 * Thin wrapper around the core use case `revokeSecondFactorStaffSessions`
 * (one transaction, one `staff.sessions_revoked` audit row per human).
 *
 * DRY RUN BY DEFAULT: prints how many people and sessions would be signed
 * out, writes nothing. `--apply` signs them out. Run it AFTER the API with
 * the gate is serving, or a holder could sign back in through the old path.
 * Safe to re-run.
 *
 * Usage (from the repo root; `DATABASE_URL` is REQUIRED and never read from a
 * .env file, so the target database is always a deliberate choice):
 *
 *   DATABASE_URL=postgresql://... pnpm -F api exec tsx src/scripts/ops/revoke-second-factor-staff-sessions.ts
 *   DATABASE_URL=postgresql://... PRISMA_TX_TIMEOUT=60000 pnpm -F api exec tsx src/scripts/ops/revoke-second-factor-staff-sessions.ts --apply
 *
 * `--apply` is one transaction with two round trips per holder; against a
 * remote database the default 5 s transaction timeout can run out, hence
 * `PRISMA_TX_TIMEOUT`. Check the dry run's count first.
 */
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { revokeSecondFactorStaffSessions } from "@th/core/use-cases/platform/revoke-second-factor-staff-sessions";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set explicitly (this script never loads .env files — the target DB must be deliberate).",
    );
  }
  const apply = process.argv.includes("--apply");
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `revoke-second-factor-staff-sessions → ${target.hostname}:${target.port || "5432"}${target.pathname}${apply ? " (APPLY)" : " (DRY RUN)"}`,
  );

  const prisma = getPrisma();
  try {
    const result = await revokeSecondFactorStaffSessions(
      { repos: createPrismaRepos(prisma), clock: createSystemClock() },
      { dryRun: !apply },
    );
    console.log(
      `staff with a factor enrolled: ${result.humans}; sessions found: ${result.sessionsFound}; sessions revoked: ${result.sessionsRevoked}`,
    );
    if (!apply) {
      console.log("(DRY RUN — nothing written. Re-run with --apply to sign them out.)");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
