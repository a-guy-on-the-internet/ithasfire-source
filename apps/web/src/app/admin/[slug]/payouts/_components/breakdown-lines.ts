import type { OrgPayoutCreditLine } from "@th/core/use-cases/payouts/get-org-payout-overview";

// ─────────────────────────────────────────────────────────────────────────────
// The rows under one tranche date, folded per EVENT. A tranche's `lines` are
// one row per ledger credit (one per order); the reader wants "which show,
// how many orders, how much", so the fold is by `eventId`. Lines with no
// event (a membership, a deleted show, or a naming read that failed — the
// caller tells those apart with `attributionResolved`) fold into one
// unattributed group so the rows still sum to what the heading says.
// ─────────────────────────────────────────────────────────────────────────────

export type BreakdownEventGroup = {
  key: string;
  eventId: string | null;
  eventTitle: string | null;
  eventSlug: string | null;
  eventStartsAt: Date | null;
  orderCount: number;
  amountCents: number;
};

const UNATTRIBUTED_KEY = "__unattributed";

export function groupTrancheLines(
  lines: ReadonlyArray<OrgPayoutCreditLine>,
): BreakdownEventGroup[] {
  const groups = new Map<string, BreakdownEventGroup>();
  for (const line of lines) {
    const key = line.eventId ?? UNATTRIBUTED_KEY;
    const existing = groups.get(key);
    if (existing) {
      existing.orderCount += 1;
      existing.amountCents += line.amountCents;
      continue;
    }
    groups.set(key, {
      key,
      eventId: line.eventId,
      eventTitle: line.eventTitle,
      eventSlug: line.eventSlug,
      eventStartsAt: line.eventStartsAt,
      orderCount: 1,
      amountCents: line.amountCents,
    });
  }
  // Largest share first; the unattributed bucket last regardless of size so
  // named shows lead.
  return [...groups.values()].sort((a, b) => {
    if (a.eventId === null && b.eventId !== null) return 1;
    if (b.eventId === null && a.eventId !== null) return -1;
    return b.amountCents - a.amountCents;
  });
}
