/**
 * Unit-price AND sellability resolution for a TicketType — THE one place a
 * ticket's effective price is decided, and THE one place "may this be sold
 * right now?" is answered.
 *
 * The module is still named `door-pricing` for its origin (a since-removed
 * advance/door price override) and is deliberately NOT renamed here: it is
 * imported by every money site in the codebase and a rename during a
 * shared-tree phase buys nothing. Read it as "ticket-type money facts".
 * `isEverPaidTicketType` already lives here for the same reason — one import,
 * one place to look, no second opinion.
 *
 * A TicketType carries up to two prices:
 *   - `priceCents`          — the list price;
 *   - `scheduledPriceCents` — a post-flip price, effective at or after
 *                             `scheduledPriceAt` (FR-005).
 *
 * There is NO separate door price. The door (POS card and cash) sells at the
 * same resolved price the event page shows (door-sales-same-price-and-tax spec
 * FR-012, owner ruling R1 2026-10-07).
 *
 * Every surface must resolve them the same way, because the resolved number is
 * simultaneously:
 *   - what the buyer is charged,
 *   - the base a PERCENT promo is computed against, and
 *   - the eligible amount a TICKET_TYPE-scoped promo matches on.
 *
 * A surface that resolved this differently (e.g. a preview pricing off
 * `priceCents` while the sale prices off the post-flip price) would quote the
 * operator one discount and charge the buyer another. Time-scheduled pricing
 * reintroduces exactly that hazard with a second axis, which is why there is
 * ONE resolver and why `now` is a REQUIRED parameter: a default would let a
 * call site silently keep today's behaviour while looking migrated, and the
 * compiler is the only thing that reliably finds every site.
 *
 * LAYERING: this is a pure function. It has no repo access and no clock of its
 * own — callers pass `deps.clock.now()`. Transport and UI never compute a
 * price; they display what core resolved.
 *
 * NFR-003: nothing here is a post-purchase recompute. The price resolved at
 * purchase time is snapshotted onto `OrderItem.unitPriceCents` and every
 * historical read (resale face value, wallet passes, refunds) reads that
 * snapshot, never this resolver.
 *
 * Spec: docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-003,
 * FR-005, FR-006. Sales windows: docs/specs/2026-08-04/
 * ticket-type-packs.spec.yaml FR-014, adopted by FR-009.
 */
import { fail } from "@th/errors";

/**
 * The minimum shape the resolver needs. Deliberately structural rather than
 * `TicketTypeRecord` so summaries, POS rows and checkout maps can all be
 * passed without a widening cast.
 *
 * `scheduledPriceCents` / `scheduledPriceAt` are optional here ONLY so that a
 * caller holding a projection that predates the columns still type-checks;
 * every projection that feeds a money-authoritative site now carries them
 * explicitly and non-optionally.
 */
export type PriceResolvableTicketType = {
  priceCents: number;
  scheduledPriceCents?: number | null;
  scheduledPriceAt?: Date | string | null;
};

/*
 * NOTE on the asymmetry above: `SellableTicketType` narrows its bounds to
 * `Date | null` while `scheduledPriceAt` here still accepts `string`. That is a
 * KNOWN, DELIBERATE inconsistency, not an oversight.
 *
 * The same hazard applies to both — an ISO string without an offset parses as
 * LOCAL time, so a string instant under a money gate flips at the wrong hour
 * depending on the container's TZ. Narrowing `scheduledPriceAt` was tried and
 * TYPECHECKS CLEAN across packages, apps/api and apps/jobs (no production caller
 * passes a string), so it is safe. It was NOT taken in Phase 2a because:
 *   - it deletes two Phase-1a tests that exist solely to pin the string branch
 *     ("an ISO string instant resolves identically to a Date"), and
 *   - `resolveUpcomingPriceChange` (lib/orders/ticket-type-sellability.ts,
 *     Phase 2b) independently accepts `Date | string` for the same field, so
 *     narrowing one without the other just moves the inconsistency.
 * Tracked as a follow-up rather than done unilaterally mid-phase.
 */

export type ResolveUnitPriceOptions = {
  /**
   * The evaluation instant, from the caller's injected `ClockPort`. REQUIRED —
   * see the module header. Never defaulted, never `Date.now()` in here.
   */
  now: Date;
};

/**
 * Effective unit price in cents at the given instant, for EVERY surface
 * (online checkout, event page, POS card and cash):
 *
 *   `now < scheduledPriceAt`  → `priceCents`
 *   `now >= scheduledPriceAt` → `scheduledPriceCents`
 *
 * The flip is inclusive at the boundary: at exactly T the new price is live,
 * so a "$20 from 6pm" schedule charges $20 at 18:00:00.000.
 *
 * A half-configured row (one of the two schedule fields set, which the write
 * boundary rejects with TICKET_TYPE_SCHEDULE_INCOMPLETE) is treated here as
 * UNSCHEDULED — the resolver fails safe to today's price rather than guessing.
 *
 * `scheduledPriceCents: 0` is a legitimate "free after T" tier and is NOT
 * collapsed with `null`; the null check is explicit (`!= null`), never falsy.
 */
export function resolveUnitPriceCents(
  ticketType: PriceResolvableTicketType,
  { now }: ResolveUnitPriceOptions,
): number {
  const { scheduledPriceCents, scheduledPriceAt } = ticketType;

  // Both-or-neither. A half-configuration is rejected at the write boundary;
  // if one ever reaches here (legacy row, partial projection) it is inert.
  if (scheduledPriceCents == null || scheduledPriceAt == null) {
    return ticketType.priceCents;
  }

  const flipAtMs =
    scheduledPriceAt instanceof Date
      ? scheduledPriceAt.getTime()
      : new Date(scheduledPriceAt).getTime();

  // An unparseable instant is inert too — never a silent mispricing.
  if (Number.isNaN(flipAtMs)) {
    return ticketType.priceCents;
  }

  return now.getTime() >= flipAtMs ? scheduledPriceCents : ticketType.priceCents;
}

/**
 * Does this ticket type EVER take money — now or later?
 *
 * The companion to {@link resolveUnitPriceCents}, and the predicate every
 * "is this event paid?" gate must use. Those gates are time-INDEPENDENT by
 * nature: they run once, before money moves (create a type, publish an event,
 * decide whether to show a Buy CTA), and they must be armed for the whole
 * lifetime of the type, not for the instant they happen to execute.
 *
 * WHY THIS EXISTS. Before FR-005 the only way to express "paid" was
 * `priceCents > 0 || pricingMode === "ADJUSTABLE"`, and three gates hardcoded
 * exactly that. A scheduled price change makes "free now, $20 at T" expressible
 * for the first time, and all three would have waved it through: the type would
 * be created and the event PUBLISHED with no connected payee, sell fine before
 * T, and then fail EVERY checkout from T onward (PRIMARY_AGREEMENT_MISSING /
 * PAYEE_NOT_CONNECTED) while the public page still advertised the tier. It
 * fails closed, so no buyer is mischarged — but it is a total, undiagnosable
 * sales outage, and it is newly reachable.
 *
 * NOT the resolver: this answers "could money ever move", never "how much".
 * Never use it to price anything.
 */
export function isEverPaidTicketType(ticketType: {
  priceCents: number;
  scheduledPriceCents?: number | null;
  pricingMode?: "FIXED" | "ADJUSTABLE" | null;
}): boolean {
  return (
    ticketType.priceCents > 0 ||
    (ticketType.scheduledPriceCents ?? 0) > 0 ||
    ticketType.pricingMode === "ADJUSTABLE"
  );
}

/**
 * The minimum shape the sales-window predicates need — deliberately structural
 * and deliberately SEPARATE from {@link PriceResolvableTicketType}, because
 * "how much" and "may it be sold at all" are different questions and a caller
 * asking one must not be forced to satisfy the other.
 *
 * Both fields are optional so a projection that predates the columns still
 * type-checks; every projection feeding a money-authoritative site carries them
 * explicitly and non-optionally.
 *
 * `Date | null` ONLY — deliberately NOT `Date | string`. An ISO string without
 * an offset (`"2026-09-01T17:00:00"`) parses as LOCAL time under ES semantics,
 * so a string bound would be a silent server-timezone coercion sitting directly
 * under a money gate: the same window would open an hour early or late depending
 * on the container's TZ. No production caller ever passes a string here (the
 * adapters hand back `Date`, Zod coerces to `Date`, and the column is
 * `TIMESTAMP(3)`), so the hazard buys nothing and is made unrepresentable
 * instead. Parse at the boundary; pass instants inward.
 */
export type SellableTicketType = {
  salesOpenAt?: Date | null;
  salesCloseAt?: Date | null;
};

/**
 * Why a tier is not purchasable, or that it is. The two closed reasons are kept
 * distinct because the buyer-facing copy differs — "opens Friday at 10am" is an
 * invitation to come back, "sales ended" is not — and Phase 2b's per-type
 * sellability surfacing (FR-010) consumes exactly this discriminant.
 */
export type TicketTypeSaleState =
  | { onSale: true }
  | { onSale: false; reason: "not_yet_on_sale"; opensAt: Date }
  | { onSale: false; reason: "sales_ended"; closedAt: Date };

/**
 * Is this ticket type purchasable at `now`, and if not, why?
 *
 * BOUNDARY SEMANTICS — stated, pinned by tests, and NOT symmetric:
 *
 *   `salesOpenAt`  is INCLUSIVE. At exactly `salesOpenAt` the tier IS on sale.
 *                  This mirrors the scheduled-price flip, which chose
 *                  inclusive-at-T (`now >= scheduledPriceAt` → new price), so
 *                  an organizer who sets "10:00" gets the same answer from both
 *                  features at 10:00:00.000.
 *   `salesCloseAt` is EXCLUSIVE. At exactly `salesCloseAt` the tier is CLOSED.
 *
 * Half-open `[open, close)` is the only pairing under which two back-to-back
 * tiers — "Advance closes at 18:00, Door opens at 18:00" — neither overlap nor
 * leave a gap. Inclusive-at-both would make 18:00:00.000 sell BOTH tiers;
 * exclusive-at-both would make it sell NEITHER. It also matches the
 * event-level close already in the codebase (`now >= endsAt` ⇒ closed), so the
 * two gates agree about what "closes at 18:00" means.
 *
 * `null` on either side means "no bound" — today's behaviour for every existing
 * row, and the reason NFR-001 holds by construction: with both null this
 * function is a constant `{ onSale: true }`.
 *
 * An UNPARSEABLE instant (an `Invalid Date`) is treated as no bound rather than
 * as a refusal. That is a deliberate fail-OPEN on exactly one axis, and only on
 * data that the write boundary (`normalizeSalesWindow`) cannot produce: the
 * alternative would let a corrupt column silently close every sale on an event
 * with no diagnosable cause. An INVERTED window (open >= close) is NOT this case
 * — it is representable, rejected at the write boundary, and refuses here, which
 * fails closed.
 *
 * A fail-open that is INVISIBLE is the real hazard, so it is not left silent:
 * {@link findUnparseableSalesWindowBounds} names the offending bounds and
 * {@link assertTicketTypeOnSale} hands them to an optional callback that the
 * money sites wire to `deps.reportError`. This function itself stays pure and
 * dependency-free — reporting belongs to the layers that have deps.
 *
 * This is a pure function with no clock of its own; `now` comes from the
 * caller's injected `ClockPort`, same discipline as the price resolver.
 */
export function resolveTicketTypeSaleState(
  ticketType: SellableTicketType,
  now: Date,
): TicketTypeSaleState {
  const nowMs = now.getTime();

  const opensAtMs = toInstantMs(ticketType.salesOpenAt);
  if (opensAtMs != null && nowMs < opensAtMs) {
    return {
      onSale: false,
      reason: "not_yet_on_sale",
      opensAt: new Date(opensAtMs),
    };
  }

  const closesAtMs = toInstantMs(ticketType.salesCloseAt);
  if (closesAtMs != null && nowMs >= closesAtMs) {
    return {
      onSale: false,
      reason: "sales_ended",
      closedAt: new Date(closesAtMs),
    };
  }

  return { onSale: true };
}

/**
 * Boolean form of {@link resolveTicketTypeSaleState} for call sites that only
 * need the yes/no. Same semantics, no second implementation.
 */
export function isTicketTypeOnSale(
  ticketType: SellableTicketType,
  now: Date,
): boolean {
  return resolveTicketTypeSaleState(ticketType, now).onSale;
}

/** Which bound of a sales window is set but cannot be evaluated. */
export type SalesWindowBoundField = "salesOpenAt" | "salesCloseAt";

/**
 * Names every bound that is NON-NULL but unparseable — i.e. every bound the
 * resolver is about to ignore.
 *
 * This exists so the fail-open above is DIAGNOSABLE rather than merely correct.
 * The window gate is the only sellability check the POS has (there is no
 * event-level close at a till), so a corrupt bound there means a tier sells
 * forever with nothing anywhere to say why. Three layers make it unreachable —
 * Zod `z.coerce.date()` at the transport boundary, `normalizeSalesWindow`'s
 * independent NaN check on the MERGED partial-update value, and a `TIMESTAMP(3)`
 * column that cannot hold a malformed instant — but "unreachable" and
 * "unobservable if reached" are different properties, and only one of them is
 * worth having on a money path.
 *
 * Returns an empty array in the overwhelming case, so callers can skip the
 * reporting branch on a cheap `.length === 0`.
 */
export function findUnparseableSalesWindowBounds(
  ticketType: SellableTicketType,
): SalesWindowBoundField[] {
  const bad: SalesWindowBoundField[] = [];
  if (isUnparseableBound(ticketType.salesOpenAt)) bad.push("salesOpenAt");
  if (isUnparseableBound(ticketType.salesCloseAt)) bad.push("salesCloseAt");
  return bad;
}

function isUnparseableBound(value: Date | null | undefined): boolean {
  return value != null && Number.isNaN(value.getTime());
}

/**
 * Options for {@link assertTicketTypeOnSale}.
 */
export type AssertTicketTypeOnSaleOptions = {
  /** Merged into the thrown error's `meta` (e.g. the ticket type id). */
  meta?: Record<string, unknown>;
  /**
   * Invoked ONCE per refused-to-evaluate bound, before the sale decision, when
   * a non-null bound is unparseable. The money sites wire this to
   * `deps.reportError` so the fail-open raises a Sentry event instead of
   * disappearing. Best-effort by contract: it must never throw, and the guard
   * below treats it as if it might anyway.
   */
  onUnparseableBound?: (detail: {
    field: SalesWindowBoundField;
    meta?: Record<string, unknown>;
  }) => void;
};

/**
 * THE enforcement call. Every site that takes money uses this one function, so
 * no two surfaces can disagree about whether a tier is sellable — the same
 * reasoning that produced one price resolver, applied to sellability.
 *
 * Enforced at: `computeOrderAmounts` (which is the single choke point for
 * createCheckout's routing probe AND its paid path, updateOrderItems and
 * claimFreeTickets) plus `startPosSale` and `recordCashSale`, which price their
 * own door lines and therefore call this directly.
 *
 * COMPOSITION WITH THE EVENT-LEVEL CLOSE. The event-wide gate
 * (`now >= endsAt ?? startsAt` ⇒ EVENT_SALES_CLOSED, in `ensureEventOnSale`)
 * still runs first on every online path and is untouched here. Because both
 * gates are pure refusals, the STRICTER wins automatically and a per-type window
 * can never widen the event-level one — this function has no way to permit a
 * purchase, only to deny one. The POS surfaces deliberately have no event-level
 * close (door sales happen after the event starts), so there the per-type window
 * is the only window gate; that asymmetry predates this change and is preserved.
 *
 * DELIBERATELY NOT GATED, and named here so the next person auditing mint paths
 * does not have to re-derive it: `issueCompTickets` and
 * `grantVolunteerReward`. Both mint tickets without taking money, and both are
 * ORGANIZER actions rather than purchases — comping a tier before it goes on
 * sale is routine, not an error. Each carries the same note at its own mint
 * site.
 *
 * @throws TICKET_TYPE_NOT_YET_ON_SALE before `salesOpenAt`
 * @throws TICKET_TYPE_SALES_ENDED at or after `salesCloseAt`
 */
export function assertTicketTypeOnSale(
  ticketType: SellableTicketType,
  now: Date,
  options?: AssertTicketTypeOnSaleOptions,
): void {
  // Diagnostics FIRST: an unparseable bound makes this function fail OPEN, so
  // the report has to happen on the path that returns without throwing —
  // otherwise the one case worth seeing is the one case that stays silent.
  if (options?.onUnparseableBound) {
    for (const field of findUnparseableSalesWindowBounds(ticketType)) {
      try {
        options.onUnparseableBound({ field, meta: options.meta });
      } catch {
        // Reporting is best-effort by contract (ReporterPort). A throwing
        // reporter must never turn an allowed sale into a failed one.
      }
    }
  }

  const state = resolveTicketTypeSaleState(ticketType, now);
  if (state.onSale) return;

  if (state.reason === "not_yet_on_sale") {
    throw fail("TICKET_TYPE_NOT_YET_ON_SALE", {
      meta: { ...options?.meta, salesOpenAt: state.opensAt.toISOString() },
    });
  }

  throw fail("TICKET_TYPE_SALES_ENDED", {
    meta: { ...options?.meta, salesCloseAt: state.closedAt.toISOString() },
  });
}

/**
 * Normalizes a nullable `Date` bound to epoch millis, or `null` when there is no
 * usable bound. Shared by both window checks so they cannot drift.
 */
function toInstantMs(value: Date | null | undefined): number | null {
  if (value == null) return null;
  const ms = value.getTime();
  return Number.isNaN(ms) ? null : ms;
}
