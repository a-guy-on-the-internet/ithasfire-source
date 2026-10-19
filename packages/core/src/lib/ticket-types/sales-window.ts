import { fail } from "@th/errors";

/**
 * Write-boundary validation for a TicketType's per-type SALES WINDOW
 * (docs/specs/2026-08-04/completed/ticket-type-packs.spec.yaml FR-014, adopted by
 * docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-009).
 *
 * The invariant is: when BOTH bounds are set, `salesOpenAt` < `salesCloseAt`.
 * Unlike the scheduled price, the two fields are INDEPENDENT — "opens Friday,
 * never closes" and "closes Friday, always open until then" are both legitimate
 * single-bound configurations, so there is no both-or-neither rule here.
 *
 * Equality is rejected along with inversion. A zero-width window can never sell
 * anything (`salesOpenAt` is inclusive, `salesCloseAt` exclusive — see
 * `resolveTicketTypeSaleState`), so accepting it would persist a tier that is
 * permanently unpurchasable while looking configured, which is the same
 * "silently unsellable type" failure FR-016 forbids for template apply.
 *
 * Lives here rather than inline in each use case — the sibling of
 * `scheduled-price.ts` and shaped the same way — so the create path
 * (upsertTicketType) and the partial-update path (updateTicketType, which must
 * merge against the stored row first) cannot drift apart.
 *
 * Not a database CHECK constraint, for the same reason the scheduled-price
 * invariant is not: a 23514 surfaces through Prisma as an opaque driver error
 * with no `AppErrorCode` the UI can translate. The runtime predicate stays
 * defensive regardless — an inverted window that somehow reaches it refuses
 * every purchase, which fails closed.
 */
export type SalesWindowFields = {
  salesOpenAt: Date | null;
  salesCloseAt: Date | null;
};

/**
 * Validates the ordering invariant and returns the normalized pair.
 *
 * Every check is an explicit `== null` / `!= null`, never a falsy test — the
 * epoch (`new Date(0)`) is a legitimate, if odd, instant and must not collapse
 * to "unset".
 *
 * @throws TICKET_TYPE_SALES_WINDOW_INVALID when both bounds are set and
 *         `salesOpenAt` is not strictly before `salesCloseAt`, or when either
 *         supplied bound is an unparseable instant.
 */
export function normalizeSalesWindow(
  input: Partial<SalesWindowFields>,
): SalesWindowFields {
  const salesOpenAt = input.salesOpenAt ?? null;
  const salesCloseAt = input.salesCloseAt ?? null;

  // An unparseable instant is the same class of misconfiguration as an
  // inverted one: the bound exists but can never be evaluated. Rejected rather
  // than silently dropped, so the organizer is told.
  if (salesOpenAt != null && Number.isNaN(salesOpenAt.getTime())) {
    throw fail("TICKET_TYPE_SALES_WINDOW_INVALID");
  }
  if (salesCloseAt != null && Number.isNaN(salesCloseAt.getTime())) {
    throw fail("TICKET_TYPE_SALES_WINDOW_INVALID");
  }

  if (
    salesOpenAt != null &&
    salesCloseAt != null &&
    salesOpenAt.getTime() >= salesCloseAt.getTime()
  ) {
    throw fail("TICKET_TYPE_SALES_WINDOW_INVALID");
  }

  return { salesOpenAt, salesCloseAt };
}
