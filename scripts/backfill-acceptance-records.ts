import "dotenv/config";
import { prisma } from "@th/db";

import {
  CURRENT_CHARGEBACK_TERMS_TEXT,
  CURRENT_CHARGEBACK_TERMS_VERSION,
} from "@th/core/lib/payments";

/**
 * Backfill AcceptanceRecord rows for chargeback-terms acceptances that predate
 * the canonical ledger (Phase 2 of docs/specs/2026-05-17/completed/acceptance-records.spec.md).
 *
 *   • Organization.chargebackTermsAcceptedAt → AcceptanceRecord
 *       (humanId = chargebackTermsAcceptedByHumanId, scopeType = ORGANIZATION,
 *        scopeId = org.id)
 *   • Human.chargebackTermsAcceptedAt → AcceptanceRecord
 *       (humanId = human.id, scopeType = GLOBAL, scopeId = null)
 *
 * Idempotent: skips any (humanId, documentType, documentVersion, scopeType,
 * scopeId) that already has a record, so it is safe to re-run.
 *
 * Note on snapshots: legacy rows only stored a version string, not the verbatim
 * text the user saw. We snapshot the *current* terms text. For rows whose stored
 * version differs from the current constant, the snapshot is best-effort and the
 * gate will (correctly) require a re-accept on the next check.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-acceptance-records.ts --dry-run
 *   pnpm exec tsx scripts/backfill-acceptance-records.ts
 */

const DOC_TYPE = "CHARGEBACK_TERMS_ORGANIZER" as const;

async function recordExists(args: {
  humanId: string;
  documentVersion: string;
  scopeType: "GLOBAL" | "ORGANIZATION";
  scopeId: string | null;
}): Promise<boolean> {
  const existing = await prisma.acceptanceRecord.findFirst({
    where: {
      humanId: args.humanId,
      documentType: DOC_TYPE,
      documentVersion: args.documentVersion,
      scopeType: args.scopeType,
      scopeId: args.scopeId,
    },
    select: { id: true },
  });
  return existing !== null;
}

async function main() {
  const dryRun =
    process.argv.includes("--dry-run") || process.argv.includes("-n");
  console.log(`Backfill AcceptanceRecord — dry run: ${dryRun}`);

  let created = 0;
  let skipped = 0;

  // ── Organizations ──────────────────────────────────────────────────────
  const orgs = await prisma.organization.findMany({
    where: {
      chargebackTermsAcceptedAt: { not: null },
      chargebackTermsAcceptedByHumanId: { not: null },
    },
    select: {
      id: true,
      chargebackTermsVersion: true,
      chargebackTermsAcceptedAt: true,
      chargebackTermsAcceptedByHumanId: true,
    },
  });
  console.log(`Organizations with accepted chargeback terms: ${orgs.length}`);

  for (const org of orgs) {
    const humanId = org.chargebackTermsAcceptedByHumanId!;
    const version = org.chargebackTermsVersion ?? CURRENT_CHARGEBACK_TERMS_VERSION;
    if (
      await recordExists({
        humanId,
        documentVersion: version,
        scopeType: "ORGANIZATION",
        scopeId: org.id,
      })
    ) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      await prisma.acceptanceRecord.create({
        data: {
          humanId,
          documentType: DOC_TYPE,
          documentVersion: version,
          documentTextSnapshot: CURRENT_CHARGEBACK_TERMS_TEXT,
          scopeType: "ORGANIZATION",
          scopeId: org.id,
          acceptedAt: org.chargebackTermsAcceptedAt!,
        },
      });
    }
    created++;
  }

  // ── Humans (solo organizers) ───────────────────────────────────────────
  const humans = await prisma.human.findMany({
    where: { chargebackTermsAcceptedAt: { not: null } },
    select: {
      id: true,
      chargebackTermsVersion: true,
      chargebackTermsAcceptedAt: true,
    },
  });
  console.log(`Humans with accepted chargeback terms: ${humans.length}`);

  for (const human of humans) {
    const version =
      human.chargebackTermsVersion ?? CURRENT_CHARGEBACK_TERMS_VERSION;
    if (
      await recordExists({
        humanId: human.id,
        documentVersion: version,
        scopeType: "GLOBAL",
        scopeId: null,
      })
    ) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      await prisma.acceptanceRecord.create({
        data: {
          humanId: human.id,
          documentType: DOC_TYPE,
          documentVersion: version,
          documentTextSnapshot: CURRENT_CHARGEBACK_TERMS_TEXT,
          scopeType: "GLOBAL",
          scopeId: null,
          acceptedAt: human.chargebackTermsAcceptedAt!,
        },
      });
    }
    created++;
  }

  console.log(
    `${dryRun ? "[dry-run] would create" : "created"}: ${created}, skipped (already present): ${skipped}`,
  );
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
