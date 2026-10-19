import { fail } from "@th/errors";

/**
 * Write-boundary validation for a TicketType's scheduled price change
 * (docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-005).
 *
 * The invariant is BOTH NULL OR BOTH SET. A half-configuration is a rejected
 * write, never a silently-ignored setting: an organizer who set "$20" but no
 * date, or a date but no price, must be told — the alternative is a tier that
 * looks scheduled in the admin and never flips (or flips to nothing).
 *
 * Lives here rather than inline in each use case so the create path
 * (upsertTicketType) and the partial-update path (updateTicketType, which must
 * merge against the stored row first) cannot drift apart.
 *
 * Not a database CHECK constraint: a 23514 surfaces through Prisma as an
 * opaque driver error with no `AppErrorCode` the UI can translate. The
 * resolver stays defensive regardless and treats a half-configured row as
 * unscheduled.
 */
export type ScheduledPriceFields = {
  scheduledPriceCents: number | null;
  scheduledPriceAt: Date | null;
};

/**
 * Validates the both-or-neither invariant plus a non-negative, integral price,
 * and returns the normalized pair.
 *
 * `scheduledPriceCents: 0` is a LEGITIMATE value — a tier that becomes free at
 * T — and is deliberately not collapsed with `null`. Every check here is an
 * explicit `== null` / `!= null`, never a falsy test.
 *
 * @throws TICKET_TYPE_SCHEDULE_INCOMPLETE when exactly one field is set, or
 *         when the price is negative / non-integral.
 */
export function normalizeScheduledPrice(
  input: Partial<ScheduledPriceFields>,
): ScheduledPriceFields {
  const priceCents = input.scheduledPriceCents ?? null;
  const at = input.scheduledPriceAt ?? null;

  if ((priceCents == null) !== (at == null)) {
    throw fail("TICKET_TYPE_SCHEDULE_INCOMPLETE");
  }

  if (priceCents == null || at == null) {
    return { scheduledPriceCents: null, scheduledPriceAt: null };
  }

  // Money is integer cents. A negative or fractional scheduled price would
  // flow straight into a charge, so it is rejected with the same named code
  // rather than clamped.
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw fail("TICKET_TYPE_SCHEDULE_INCOMPLETE");
  }

  // An unparseable instant is the same class of half-configuration: the
  // schedule exists but can never be evaluated.
  if (Number.isNaN(at.getTime())) {
    throw fail("TICKET_TYPE_SCHEDULE_INCOMPLETE");
  }

  return { scheduledPriceCents: priceCents, scheduledPriceAt: at };
}
