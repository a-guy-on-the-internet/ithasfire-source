import type { PrismaClient } from "@prisma/client";

import { DEMO_IDS } from "./ids.js";

// ─────────────────────────────────────────────────────────────────────────────
// Payout history fixtures — the PAID half of /platform/settlements.
//
// Without these, a freshly seeded dev database has ZERO Payout and ZERO
// PayoutItem rows, so the "Payouts sent" section can only ever render its
// empty state and nobody can see (or review) the thing they built. These give
// it a batch per outcome: one completed, one whose items failed, and one
// running with money still in flight.
//
// FILL GAPS, NEVER CLOBBER (house seed convention). Every row is written
// create-if-absent against a deterministic id, so a re-run is a no-op and a
// developer who has been poking at a row by hand keeps their edits. Nothing
// here deletes.
//
// DELIBERATELY NOT LEDGER-COMPLETE, AND INERT TO THE BATCH. These are DISPLAY
// fixtures for the staff view: they mint `Payout` / `PayoutItem` rows only,
// and write no PAYOUT ledger entry, consume no credits and stamp no
// `paidOutAt`. Writing half a real payout into the ledger would make the
// seeded payable disagree with the seeded history — the exact confusion the
// settlements page exists to prevent.
//
// `reserveHeldCents` / `reserveReleasedCents` are therefore ALWAYS ZERO here,
// and that is a correctness constraint, not a gap. A transferred item with
// either column set is selected by
// `payoutItems.listTransferredWithReserveActivity`, and `runPayoutBatch`'s
// reserve crash sweep replays holds and reconstructs releases from exactly
// those rows — so a local `runPayoutBatch` would write RESERVE_HOLD /
// RESERVE_RELEASE ledger entries for payouts that never happened. Worse, if
// the dev database already holds a real unreleased hold for that payee, the
// sweep's oldest-first reconstruction cannot consume the fabricated amount
// exactly, raises an integrity violation, and SKIPS THE WHOLE RESERVE STEP
// for that run — which reads as a product bug in a feature nobody touched.
// The Connect account fee alone exercises the deductions column safely; it is
// display-only and no sweep reads it.
//
// The real thing is `runPayoutBatch`; run that if you want end-to-end payout
// state.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (now: Date, days: number, hourUtc = 5): Date => {
  const d = new Date(now.getTime() - days * DAY_MS);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

type SeedPayout = {
  id: string;
  scheduledFor: Date;
  status: "completed" | "running";
  startedAt: Date | null;
  completedAt: Date | null;
  processorBatchId: string | null;
  items: SeedPayoutItem[];
};

type SeedPayoutItem = {
  id: string;
  payeeId: string;
  currency: string;
  /** GROSS — the payable claimed this cycle, before any withholding. */
  amountCents: number;
  connectAccountFeeCents?: number;
  status: "transferred" | "failed" | "pending";
  transferredAt?: Date | null;
  failedAt?: Date | null;
  failureReason?: string | null;
  stripeTransferId?: string | null;
};

/**
 * `plannedNetCents` is the cents actually handed to Stripe. Computed rather
 * than hard-coded so a fixture cannot ship a net that contradicts its own
 * deductions and make the staff view's arithmetic look broken.
 *
 * The schema's full expression is
 * `amount − recoveredDebt − reserveHeld − connectFee + reserveReleased`; the
 * three terms omitted here are all structurally zero in these fixtures (debt
 * recovery is legacy and never written; the two reserve columns are held at
 * zero deliberately — see the header).
 */
const plannedNetOf = (item: SeedPayoutItem): number =>
  item.amountCents - (item.connectAccountFeeCents ?? 0);

function buildSeedPayouts(now: Date): SeedPayout[] {
  return [
    // ── A clean completed batch, nine days back ─────────────────────────────
    {
      id: DEMO_IDS.payoutCompleted,
      scheduledFor: daysAgo(now, 9),
      status: "completed",
      startedAt: daysAgo(now, 9),
      completedAt: daysAgo(now, 9, 6),
      processorBatchId: null,
      items: [
        {
          // Stripe's monthly active-account fee landed on this one.
          id: DEMO_IDS.payoutItemTransferredOrg,
          payeeId: DEMO_IDS.payee3,
          currency: "usd",
          amountCents: 142_500,
          connectAccountFeeCents: 200,
          status: "transferred",
          transferredAt: daysAgo(now, 9, 6),
          stripeTransferId: "tr_seed_completed_org3",
        },
        {
          // A second org in the same batch, so the view shows more than one
          // payee per run. No reserve columns — see the header.
          id: DEMO_IDS.payoutItemReserveHeld,
          payeeId: DEMO_IDS.payee,
          currency: "usd",
          amountCents: 68_000,
          connectAccountFeeCents: 200,
          status: "transferred",
          transferredAt: daysAgo(now, 9, 6),
          stripeTransferId: "tr_seed_completed_org1",
        },
      ],
    },

    // ── A completed batch with a failure in it, four days back ──────────────
    {
      id: DEMO_IDS.payoutWithFailure,
      scheduledFor: daysAgo(now, 4),
      status: "completed",
      startedAt: daysAgo(now, 4),
      completedAt: daysAgo(now, 4, 6),
      processorBatchId: null,
      items: [
        {
          // The human payee's Connect account rejected the transfer.
          id: DEMO_IDS.payoutItemFailed,
          payeeId: DEMO_IDS.devPayee,
          currency: "usd",
          amountCents: 24_750,
          status: "failed",
          failedAt: daysAgo(now, 4, 6),
          failureReason:
            "Stripe: the destination account cannot currently receive transfers (account_capability_inactive).",
          stripeTransferId: null,
        },
        {
          // A clean transfer with no deductions at all, so the view's "None"
          // branch is exercised. No reserve columns — see the header.
          id: DEMO_IDS.payoutItemReserveReleased,
          payeeId: DEMO_IDS.payee,
          currency: "usd",
          amountCents: 31_200,
          status: "transferred",
          transferredAt: daysAgo(now, 4, 6),
          stripeTransferId: "tr_seed_release_org1",
        },
        {
          // A non-USD payee, so the view's per-currency handling is visible.
          id: DEMO_IDS.payoutItemMxn,
          payeeId: DEMO_IDS.payeeMxn,
          currency: "mxn",
          amountCents: 415_000,
          status: "transferred",
          transferredAt: daysAgo(now, 4, 6),
          stripeTransferId: "tr_seed_mxn",
        },
      ],
    },

    // ── Tonight's batch, still running: money in flight ─────────────────────
    {
      id: DEMO_IDS.payoutRunning,
      scheduledFor: daysAgo(now, 0),
      status: "running",
      startedAt: daysAgo(now, 0),
      completedAt: null,
      processorBatchId: null,
      items: [
        {
          id: DEMO_IDS.payoutItemPending,
          payeeId: DEMO_IDS.payee2,
          currency: "usd",
          amountCents: 57_400,
          connectAccountFeeCents: 200,
          status: "pending",
          transferredAt: null,
          stripeTransferId: null,
        },
      ],
    },
  ];
}

/**
 * Create-if-absent payout history for the platform settlements page.
 *
 * Skips any item whose payee is not present (the seed's payee set varies by
 * which orgs a given run created), so a partial database gets partial history
 * rather than a foreign-key crash.
 */
export const ensurePayoutHistory = async (
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ payouts: number; items: number }> => {
  const payouts = buildSeedPayouts(now);

  const payeeIds = [
    ...new Set(payouts.flatMap((p) => p.items.map((i) => i.payeeId))),
  ];
  const existingPayees = new Set(
    (
      await prisma.payee.findMany({
        where: { id: { in: payeeIds } },
        select: { id: true },
      })
    ).map((p) => p.id),
  );

  let createdPayouts = 0;
  let createdItems = 0;

  for (const payout of payouts) {
    const items = payout.items.filter((i) => existingPayees.has(i.payeeId));
    if (items.length === 0) continue;

    const existing = await prisma.payout.findUnique({
      where: { id: payout.id },
      select: { id: true },
    });
    if (!existing) {
      await prisma.payout.create({
        data: {
          id: payout.id,
          scheduledFor: payout.scheduledFor,
          status: payout.status,
          startedAt: payout.startedAt,
          completedAt: payout.completedAt,
          processorBatchId: payout.processorBatchId,
        },
      });
      createdPayouts += 1;
    }

    for (const item of items) {
      const existingItem = await prisma.payoutItem.findUnique({
        where: { id: item.id },
        select: { id: true },
      });
      if (existingItem) continue;

      await prisma.payoutItem.create({
        data: {
          id: item.id,
          payoutId: payout.id,
          payeeId: item.payeeId,
          currency: item.currency,
          amountCents: item.amountCents,
          connectAccountFeeCents: item.connectAccountFeeCents ?? 0,
          // Left at the column defaults of 0 on purpose — see the header.
          plannedNetCents: plannedNetOf(item),
          status: item.status,
          transferredAt: item.transferredAt ?? null,
          failedAt: item.failedAt ?? null,
          failureReason: item.failureReason ?? null,
          stripeTransferId: item.stripeTransferId ?? null,
        },
      });
      createdItems += 1;
    }
  }

  return { payouts: createdPayouts, items: createdItems };
};
