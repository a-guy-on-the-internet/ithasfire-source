import type { DisputeStatus } from "./disputes";
import type { ResaleSharePayer, ResaleShareType } from "./payout-terms";
import type {
  AddressRevealPreset,
  EventLocationMode,
  EventOwnerType,
  EventStewardship,
} from "./events";

export type OrderStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "PART_REFUNDED"
  | "REFUNDED"
  | "DISPUTED"
  | "CANCELLED";

export type OrderSource = "PRIMARY" | "RESALE" | "COMP";

/**
 * The order statuses `recalculatePlaceStats` counts as "tickets sold" at a
 * place — and therefore the ONLY statuses whose change makes a place's stats
 * stale (`PlaceStatsRepo.listStalePlaceIds`, venue-track-record FR-008).
 * Shared here so core's read and the adapter's SQL cannot drift: a PENDING or
 * FAILED order changing is not a change to anything the stats read.
 */
export const PLACE_STATS_ELIGIBLE_ORDER_STATUSES = [
  "SUCCEEDED",
  "PROCESSING",
  "PART_REFUNDED",
  "REFUNDED",
] as const satisfies readonly OrderStatus[];

/**
 * What an Order IS, as opposed to how it was sold (`OrderSource`).
 *
 * Membership invoices are materialised as Orders with `eventId = null` so that
 * settlement, refunds, the ledger and dispute holds all work unchanged. This
 * discriminator is what lets every ticketing consumer narrow positively
 * instead of null-checking `eventId`.
 */
export type OrderKind = "TICKETING" | "MEMBERSHIP";
/**
 * Channel an Order was collected through. WEB = standard online checkout
 * (default), POS = in-person Tap to Pay via the scanner, CASH = in-person
 * cash collected by the operator (no PaymentIntent, no Settlement). See
 * scanner-pos-tap-to-pay spec NFR-003 / FR-015.
 */
export type PaymentChannel = "WEB" | "POS" | "CASH";

export type OrderItemKind =
  | "ticket"
  | "discount"
  | "surcharge"
  | "platform_credit"
  /**
   * One billing period of a membership tier. `membershipId` is set,
   * `ticketTypeId` is null, and the parent Order carries `kind = MEMBERSHIP`.
   */
  | "membership";

export type OrderItemStatus = "active" | "refunded" | "transferred";

/**
 * Stripe `charge.payment_method_details.card.checks`, verbatim. Each value is
 * Stripe's vocabulary (`pass` | `fail` | `unavailable` | `unchecked`) or null
 * when the check was not performed. Kept as `string` because Stripe's set is
 * open-ended on their side.
 */
export interface PaymentCardChecks {
  addressLine1Check: string | null;
  addressPostalCodeCheck: string | null;
  cvcCheck: string | null;
}
export type ResaleOrderItemPayoutStatus =
  | "PENDING"
  | "HELD"
  | "READY"
  | "PAID"
  | "BLOCKED";

export interface OrderItemRecord {
  id: string;
  orderId: string;
  kind: OrderItemKind;
  ticketTypeId: string | null;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  meta: unknown;
  /** When set, indicates this item's funds have been transferred to the organizer. */
  paidOutAt: Date | null;
  /** When set, indicates this item was refunded. */
  refundedAt: Date | null;
  /**
   * The tax portion of the refund actually issued for this item, in cents.
   * NULL = not attributed (refunded before the column existed, or refunded by
   * a whole-order path that leaves the tax rollup on status anyway). Sums
   * treat NULL as 0; it is never backfilled with a guess.
   */
  refundedTaxCents: number | null;
  /** When set, indicates this item was transferred via resale or gift. */
  transferredAt: Date | null;
  resaleListingId: string | null;
  resaleFaceValueCents: number | null;
  resaleProcessingPassThroughCents: number;
  resaleProcessingFeeConfigRef: string | null;
  resaleSaleCutoffAt: Date | null;
  resalePayoutReleaseAt: Date | null;
  resalePayoutStatus: ResaleOrderItemPayoutStatus | null;
  resalePayoutHeldAt: Date | null;
  resalePayoutHoldReason: string | null;
  resalePayoutNoticeSentAt: Date | null;
  resalePayoutReminderSentAt: Date | null;
  resalePayoutFinalNoticeSentAt: Date | null;
  // ── Resale share record (organiser-resale-share FR-003) ──
  // The resale clause in force at the ticket's first sale, copied down the
  // resale chain; plus, on resale items, the share that sale paid. All null
  // on items sold before the record existed. Optional only so hand-built
  // fakes predating it still type-check; the Prisma adapter always sets them.
  resaleClauseType?: ResaleShareType | null;
  resaleClauseBps?: number | null;
  resaleClauseCents?: number | null;
  resaleClausePayer?: ResaleSharePayer | null;
  resaleClauseTermsId?: string | null;
  resaleClauseTermsVersion?: number | null;
  /** "Original price": the organiser's unit price at the first sale (FR-007). */
  originalUnitPriceCents?: number | null;
  eventShareCents?: number | null;
  sharePayer?: ResaleSharePayer | null;
  /** "active" | "refunded" | "transferred" */
  status: OrderItemStatus;
}

/**
 * FR-004's one-time fill of a ticket's resale clause record (organiser-resale-
 * share spec): a SET clause (type, amount, payer, the terms id + version it
 * came from) and the ticket's original unit price, which the
 * `OrderItem_resale_clause_complete_check` CHECK requires beside a set clause.
 * PERCENT carries `bps` and `cents: null`; FLAT the reverse.
 */
export interface ResaleClauseFillInput {
  resaleClauseType: ResaleShareType;
  resaleClauseBps: number | null;
  resaleClauseCents: number | null;
  resaleClausePayer: ResaleSharePayer;
  resaleClauseTermsId: string;
  resaleClauseTermsVersion: number;
  originalUnitPriceCents: number;
}

export interface OrderRecord {
  id: string;
  /**
   * NULL for membership invoices, which have no event. Narrow on
   * `kind === "TICKETING"` rather than null-checking this — the discriminator
   * is the intent, the null is a consequence.
   */
  eventId: string | null;
  /** What this order IS, as opposed to `source` (how it was sold). */
  kind: OrderKind;
  buyerHumanId: string;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  currency: string;
  feePolicySnapshot: unknown;
  status: OrderStatus;
  stripePaymentIntentId: string | null;
  billingDescriptor?: string | null;
  refundPolicyAckAt?: Date | null;
  refundPolicyAckIp?: string | null;
  refundPolicyVersion?: string | null;
  refundPolicyText?: string | null;
  disputedAt?: Date | null;
  disputeStatus?: DisputeStatus | null;
  checkoutIp?: string | null;
  source: OrderSource;
  nonRefundable: boolean;
  occurredAt: Date;

  /**
   * Stripe payment method type used for this order.
   * Populated from the charge's `payment_method_details.type` when the
   * webhook fires. Examples: "card", "us_bank_account", "cashapp", "amazon_pay".
   * Null for free orders or rows without this data.
   */
  paymentMethodType: string | null;
  /**
   * Stripe card AVS/CVC check results captured at `payment_intent.succeeded`.
   * Null on legacy rows, non-card methods, and when the capture failed
   * (best-effort). Optional because many purpose-built projections predate it.
   */
  paymentCardChecks?: PaymentCardChecks | null;
  /** ToS version the buyer accepted at checkout. Optional on projections. */
  termsVersion?: string | null;
  /** When the buyer accepted the ToS. Optional on projections. */
  termsAcceptedAt?: Date | null;
  /**
   * Channel this order was collected through. Defaults to "WEB" for legacy
   * rows and standard online checkouts. POS = in-person Tap to Pay,
   * CASH = in-person cash collected by the operator.
   */
  paymentChannel: PaymentChannel;
  /**
   * When set, indicates the order has been included in a payout cycle (i.e. funds were transferred).
   * Used to branch refund behavior (pre-payout self-serve vs post-payout staff/manual).
   */
  paidOutAt?: Date | null;
  parentOrderId: string | null;
  items: OrderItemRecord[];

  // Billing address (captured at checkout for tax calculation)
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  billingCountry: string | null;

  /** Stripe Tax Calculation ID, when tax was computed via Stripe Tax. */
  stripeTaxCalculationId: string | null;

  // ── Point-in-time tax situs snapshot (spec 2026-07-01 §5.2) ────────────
  /** Frozen venue country ("US" | "CA") that determined this order's tax. */
  taxSitusCountry: string | null;
  /** Frozen venue state / province code (e.g. "AB", "FL", "TN"). */
  taxSitusState: string | null;
  /** Frozen venue postal code. */
  taxSitusPostal: string | null;
  /** Tax rate source actually used: "ziptax" | "ca_gst_hst" | "none". */
  taxRateSource: string | null;
}

export interface CreateOrderItemInput {
  kind: OrderItemKind;
  ticketTypeId?: string | null;
  /** Concrete FK for `kind = "membership"` lines. Null for every other kind. */
  membershipId?: string | null;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  meta?: unknown;
  resaleListingId?: string | null;
  resaleFaceValueCents?: number | null;
  resaleProcessingPassThroughCents?: number;
  resaleProcessingFeeConfigRef?: string | null;
  resaleSaleCutoffAt?: Date | null;
  resalePayoutReleaseAt?: Date | null;
  resalePayoutStatus?: ResaleOrderItemPayoutStatus | null;
  resalePayoutHeldAt?: Date | null;
  resalePayoutHoldReason?: string | null;
  resalePayoutNoticeSentAt?: Date | null;
  resalePayoutReminderSentAt?: Date | null;
  resalePayoutFinalNoticeSentAt?: Date | null;
  /** Resale share record (FR-003); see OrderItemRecord. Written once. */
  resaleClauseType?: ResaleShareType | null;
  resaleClauseBps?: number | null;
  resaleClauseCents?: number | null;
  resaleClausePayer?: ResaleSharePayer | null;
  resaleClauseTermsId?: string | null;
  resaleClauseTermsVersion?: number | null;
  originalUnitPriceCents?: number | null;
  eventShareCents?: number | null;
  sharePayer?: ResaleSharePayer | null;
}

export interface UpdateResaleOrderItemFinanceStateInput {
  orderItemId: string;
  resalePayoutReleaseAt?: Date | null;
  resalePayoutStatus?: ResaleOrderItemPayoutStatus | null;
  resalePayoutHeldAt?: Date | null;
  resalePayoutHoldReason?: string | null;
  resalePayoutNoticeSentAt?: Date | null;
  resalePayoutReminderSentAt?: Date | null;
  resalePayoutFinalNoticeSentAt?: Date | null;
}

export interface CreatePendingOrderInput {
  /** Pre-generated order UUID. When omitted the database generates one. */
  id?: string;
  /** NULL only for membership invoices. Every ticketing path must set it. */
  eventId: string | null;
  /** Defaults to TICKETING at the DB level; membership invoices pass MEMBERSHIP. */
  kind?: OrderKind;
  buyerHumanId: string;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents?: number;
  currency: string;
  feePolicySnapshot?: unknown;
  source: OrderSource;
  nonRefundable?: boolean;
  /**
   * Comp provenance — only meaningful when `source === "COMP"`.
   *
   * Set by the hand-issue path (`issueCompTickets`). Left undefined by
   * `grantVolunteerReward`, whose comps have no typed reason and no human
   * issuer; those are identified instead by the VolunteerRewardGrant row
   * pointing at the order.
   */
  compReason?: string | null;
  compIssuedByHumanId?: string | null;
  items: CreateOrderItemInput[];
  stripePaymentIntentId?: string;
  /**
   * Stripe Billing invoice that produced this order. MEMBERSHIP orders only.
   *
   * UNIQUE at the database level — it is the idempotency key for
   * `invoice.payment_succeeded`, so a replayed webhook that gets past the
   * application-level checks collides here instead of minting a second order.
   */
  stripeInvoiceId?: string | null;
  parentOrderId?: string | null;

  // Billing address (optional — only for primary checkout)
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingPostalCode?: string | null;
  billingCountry?: string | null;

  /** Stripe Tax Calculation ID, when tax was computed via Stripe Tax. */
  stripeTaxCalculationId?: string | null;

  // ── Point-in-time tax situs snapshot (spec 2026-07-01 §5.2) ────────────
  /** Frozen venue country ("US" | "CA") that determined this order's tax. */
  taxSitusCountry?: string | null;
  /** Frozen venue state / province code. */
  taxSitusState?: string | null;
  /** Frozen venue postal code. */
  taxSitusPostal?: string | null;
  /** Tax rate source actually used: "ziptax" | "ca_gst_hst" | "none". */
  taxRateSource?: string | null;

  /** Statement descriptor suffix submitted to the processor for online checkout. */
  billingDescriptor?: string | null;
  /** Timestamp when the buyer acknowledged the refund policy. */
  refundPolicyAckAt?: Date | null;
  /** Server-observed client IP when the buyer acknowledged the refund policy. */
  refundPolicyAckIp?: string | null;
  /** Version of the refund policy snapshot acknowledged at checkout. */
  refundPolicyVersion?: string | null;
  /** Text of the refund policy snapshot acknowledged at checkout. */
  refundPolicyText?: string | null;
  /** Server-observed checkout IP captured for dispute evidence. */
  checkoutIp?: string | null;

  /** ToS version the buyer accepted at checkout. */
  termsVersion?: string | null;
  /** Timestamp when the buyer accepted the ToS. */
  termsAcceptedAt?: Date | null;
  /**
   * How this order was collected. Defaults to WEB. POS / CASH are set
   * by the scanner POS use cases.
   */
  paymentChannel?: PaymentChannel;
}

/** What a tax line's rate applies to (mirrors core's `TaxableBase`). */
export type OrderTaxBase = "TICKET_FACE" | "BUYER_TOTAL";
/** Who owes a tax line: PLATFORM lines are charged; ORGANISER lines are disclosed. */
export type OrderTaxCollector = "PLATFORM" | "ORGANISER";

/** One solved tax imposition to persist on an order (see `OrderTaxLine`). */
export interface CreateOrderTaxLineInput {
  code: string;
  label: string;
  jurisdiction: string;
  rateBps: number;
  base: OrderTaxBase;
  collector: OrderTaxCollector;
  taxableAmountCents: number;
  amountCents: number;
}

export interface CreateOrderTaxLinesInput {
  orderId: string;
  lines: CreateOrderTaxLineInput[];
}

/** A persisted `OrderTaxLine` row. */
export interface OrderTaxLineRecord extends CreateOrderTaxLineInput {
  id: string;
  orderId: string;
  createdAt: Date;
}

export interface UpdatePendingOrderItemsInput {
  orderId: string;
  amountGrossCents: number;
  feesPlatformCents: number;
  currency: string;
  feePolicySnapshot?: unknown;
  items: CreateOrderItemInput[];
}

export interface CreatePendingOrderResult {
  id: string;
  amountGrossCents: number;
  feesPlatformCents: number;
  currency: string;
}

export interface FindOrderByPaymentIntentResult {
  id: string;
  status: OrderStatus;
}

export interface MarkOrderDisputeStatusInput {
  orderId: string;
  disputeStatus: DisputeStatus;
  disputedAt?: Date | null;
}

export interface ListOrdersForOrgInput {
  orgId: string;
  eventId?: string | null;
  /**
   * Free-text search on buyer name or email, PLUS an identifier arm when the
   * query is id-shaped (see `orderIdentifierFromQuery`). Two arms, by shape:
   *
   *  - a full 36-char UUID → **exact** match on `Order.id`;
   *  - 8 hex chars → **`endsWith`** on `Order.id`, because that is the order
   *    code every surface displays (`formatOrderCode` — the id's tail,
   *    uppercased). Not unique by construction, and not indexable.
   *
   * A non-id-shaped query emits exactly the buyer-only predicate it always has.
   */
  searchQuery?: string | null;
  limit?: number;
  offset?: number;
  status?: OrderStatus;
  statuses?: OrderStatus[];
  /**
   * Filter on the order's Dispute-row mirror (`Order.disputeStatus IN (...)`).
   * The use cases translate the `DISPUTED` status-filter value into this —
   * the dispute lifecycle never writes `Order.status = 'DISPUTED'`, so a
   * plain status filter for it is always empty. Every other status value
   * keeps its `Order.status` semantics.
   */
  disputeStatuses?: readonly DisputeStatus[];
  occurredAtGte?: Date;
  occurredAtLte?: Date;
  sort?: "occurredAt_desc" | "occurredAt_asc";
  /**
   * Skip the `COUNT(*)` the repo otherwise runs beside its page query.
   *
   * For callers that never read `total` — the admin search's attendee group
   * gets its total from {@link OrdersRepo.countDistinctBuyersForOwner} instead
   * — the count is pure waste, and it is the expensive shape (a count over the
   * owner's orders joined to a buyer `ILIKE`) on every debounced keystroke.
   *
   * When set, `total` comes back as **-1**: a value that cannot be mistaken
   * for a real count, so a caller that opts out and then reads it fails loudly
   * instead of silently rendering "0 orders". Absent = today's behaviour.
   */
  skipTotal?: boolean;
}

export interface ListOrdersForOrgItem {
  id: string;
  eventId: string;
  eventTitle: string;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  currency: string;
  status: OrderStatus;
  stripePaymentIntentId: string | null;
  occurredAt: Date;
  source: OrderSource;
  /** Mirror of the order's Dispute row; drives the list badge and the panel banner. */
  disputeStatus: DisputeStatus | null;
}

export interface ListOrdersForOrgResult {
  items: ListOrdersForOrgItem[];
  /** Total matching ORDERS — or `-1` when the caller passed `skipTotal`. */
  total: number;
  limit: number;
  offset: number;
}

export interface ListOrdersForHumanOwnedEventsInput {
  ownerHumanId: string;
  eventId?: string | null;
  orgId?: string | null;
  /** @see ListOrdersForOrgInput.searchQuery — same buyer + identifier arms. */
  searchQuery?: string | null;
  limit?: number;
  offset?: number;
  status?: OrderStatus;
  statuses?: OrderStatus[];
  /**
   * Filter on the order's Dispute-row mirror (`Order.disputeStatus IN (...)`).
   * The use cases translate the `DISPUTED` status-filter value into this —
   * the dispute lifecycle never writes `Order.status = 'DISPUTED'`, so a
   * plain status filter for it is always empty. Every other status value
   * keeps its `Order.status` semantics.
   */
  disputeStatuses?: readonly DisputeStatus[];
  occurredAtGte?: Date;
  occurredAtLte?: Date;
  sort?: "occurredAt_desc" | "occurredAt_asc";
  /** @see ListOrdersForOrgInput.skipTotal — `total` comes back as -1. */
  skipTotal?: boolean;
}

export interface ListOrdersForHumanOwnedEventsItem {
  id: string;
  eventId: string;
  eventTitle: string;
  orgId: string | null;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  currency: string;
  status: OrderStatus;
  stripePaymentIntentId: string | null;
  occurredAt: Date;
  source: OrderSource;
  /** Mirror of the order's Dispute row; drives the list badge and the panel banner. */
  disputeStatus: DisputeStatus | null;
}

export interface ListOrdersForHumanOwnedEventsResult {
  items: ListOrdersForHumanOwnedEventsItem[];
  /** Total matching ORDERS — or `-1` when the caller passed `skipTotal`. */
  total: number;
  limit: number;
  offset: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner-scoped order lookup + buyer aggregates (admin search — FR-012 / FR-013)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Owner scope shared by the admin-search order queries. Resolved exactly the
 * way {@link ListOrdersForOrgInput} / {@link ListOrdersForHumanOwnedEventsInput}
 * resolve theirs: ORGANIZATION → `event.orgId`, HUMAN → `event.humanId`.
 */
export interface OrderOwnerScope {
  ownerType: EventOwnerType;
  ownerId: string;
}

/**
 * Look up a SINGLE order the owner owns, by exact identifier.
 *
 * TENANCY (FR-012 / NFR-002): the owner scope and the identifier live in the
 * SAME where-clause, so the query is structurally incapable of leaking an
 * existence signal — "exists but belongs to another org" and "does not exist"
 * both return `null` from the identical code path. Do NOT re-implement this as
 * a global fetch followed by an ownership comparison.
 *
 * Both identifier fields are optional and OR'd. The caller decides which shape
 * applies — the full UUID and its 8-hex tail are different formats, and a
 * caller must never send free text into either. With NEITHER set the repo
 * returns `null` without querying — an owner scope alone must never be allowed
 * to select an arbitrary order.
 */
export interface FindOrderForOwnerInput extends OrderOwnerScope {
  /** Exact `Order.id`. Only set when the caller verified UUID shape. */
  id?: string;
  /**
   * The last 8 hex characters of `Order.id` — the ONE code every surface
   * renders (`formatOrderCode` in `@th/types/order-identifier`). Lowercase;
   * matched case-insensitively.
   *
   * AMBIGUITY CONTRACT: 8 hex characters is 32 bits, so a suffix is NOT
   * unique. When more than one of the owner's orders matches, the repo returns
   * `null` — showing an arbitrary "the" order for an ambiguous code would be
   * worse than showing none, and a silent first-match is exactly the kind of
   * accident this note exists to prevent.
   */
  idSuffix?: string;
}

/** Minimal row for an admin-search "Order" result — never the full order. */
export interface FindOrderForOwnerResult {
  id: string;
  eventId: string;
  eventTitle: string;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  amountGrossCents: number;
  currency: string;
  status: OrderStatus;
  occurredAt: Date;
}

/**
 * COUNT(DISTINCT buyer) for the owner's orders. This is the honest total
 * behind a page of deduped attendees: `listForOrg().total` counts ORDERS,
 * which is a different number entirely.
 *
 * MUST APPLY THE LIST'S FULL SEARCH PREDICATE, not just its buyer arm. The
 * result is compared directly against a page from
 * {@link ListOrdersForOrgInput} / {@link ListOrdersForHumanOwnedEventsInput}
 * (as `total` vs `shown`), so anything the list matches on — buyer name/email
 * AND the order-identifier arms — this must match on too. Implementations
 * share one predicate builder; do not hand-roll a second one here.
 *
 * The failure this prevents, observed live: an id-shaped query made the list
 * return the order's buyer while the count returned 0, rendering a visible
 * attendee row under the header "0 attendees".
 *
 * DELIBERATELY NOT status-filtered, unlike {@link COMPLETED_ORDER_STATUSES}
 * above: this total must count the same population the attendee PAGE contains,
 * and that page applies no status filter either. Filtering one and not the
 * other would make `shown` and `total` count different things — the same class
 * of bug from the other direction.
 */
export interface CountDistinctBuyersForOwnerInput extends OrderOwnerScope {
  /** Free-text search on buyer name or email — same semantics as the lists. */
  searchQuery?: string | null;
}

/**
 * Order statuses that represent a COMPLETED CHECKOUT — what an organiser means
 * by "orders" when reading a buyer's history.
 *
 * Excludes exactly two:
 *  - `PENDING` — a held cart, not a purchase. Without this exclusion a buyer
 *    who abandoned three carts yesterday reads as "4 orders · last yesterday"
 *    when they have one real purchase from March.
 *  - `CANCELLED` — expired carts and voided comps; the checkout never
 *    completed.
 *
 * `PROCESSING` IS included: it is a delayed-settlement payment (ACH) whose
 * debit has been initiated, so the buyer is committed and the row will become
 * `SUCCEEDED`. `REFUNDED` / `PART_REFUNDED` / `DISPUTED` are included because
 * they WERE purchases — refunding one does not un-buy it.
 */
export const COMPLETED_ORDER_STATUSES = [
  "PROCESSING",
  "SUCCEEDED",
  "PART_REFUNDED",
  "REFUNDED",
  "DISPUTED",
] as const satisfies readonly OrderStatus[];

/**
 * Per-buyer order aggregates within the owner scope, for an explicit (bounded)
 * set of buyers — normally the buyers on the current page of results.
 */
export interface SummarizeBuyerOrdersForOwnerInput extends OrderOwnerScope {
  buyerHumanIds: string[];
}

export interface BuyerOrderSummary {
  buyerHumanId: string;
  /**
   * This buyer's {@link COMPLETED_ORDER_STATUSES} orders under the owner scope
   * — ALL of them, not just the ones on the caller's page, and not filtered by
   * any search query.
   *
   * A buyer whose only orders are PENDING carts therefore gets NO row from the
   * repo at all. Callers must read a missing row as ZERO completed orders, not
   * as "unknown" — falling back to a page-derived count would resurrect
   * exactly the cart-counting lie this filter removes.
   */
  orderCount: number;
  /**
   * Most recent `occurredAt` across those orders. Note `occurredAt` defaults
   * to row creation and is NOT restamped by `markSucceeded`, so it is the
   * checkout START time, not the settlement time — close enough for "last
   * ordered", but do not present it as a payment date.
   */
  lastOrderAt: Date | null;
}

export interface ListOrdersByBuyerInput {
  buyerHumanId: string;
  /**
   * Extra order ids to include in the result on top of `buyerHumanId` matches.
   * Used to surface orders where the actor received a ticket via transfer
   * (they own a ticket row in the order without having bought it). The repo
   * should treat this as a logical OR with the buyer filter.
   */
  extraOrderIds?: string[];
  statuses?: OrderStatus[];
  limit?: number;
  offset?: number;
  sort?: "occurredAt_desc" | "occurredAt_asc";
}

/**
 * The RAW location-privacy inputs behind a my-tickets row's venue line.
 *
 * NEVER render these. There is deliberately no ready-made venue string on
 * `ListOrdersByBuyerItem`: whether a holder may see the venue's name depends
 * on the event's mode, its venue's floor, the reveal date and the NEVER
 * preset, and that decision lives in core (`resolveHolderAddress`), not in an
 * adapter. `listMyOrders` turns this into the holder-safe `eventVenue`.
 */
export interface ListOrdersByBuyerEventLocation {
  locationMode: EventLocationMode;
  locationRadiusMeters: number | null;
  /** Organizer's coarse public area label. */
  locationLabel: string | null;
  addressRevealAt: Date | null;
  addressRevealPreset: AddressRevealPreset | null;
  locality: string | null;
  region: string | null;
  /**
   * The event's venue link and the raw inputs of the venue-confirmation rule
   * (`venueConfirmationArm` in core). A venue that withholds its address
   * releases it only to events it vouched for, so the holder gate needs to
   * know HOW this venue vouched; the rule itself stays in core, and the
   * owner half reads the place row there.
   */
  placeId: string | null;
  orgId: string | null;
  humanId: string | null;
  stewardship: EventStewardship;
  venueConfirmedAt: Date | null;
  venueConfirmationWithdrawnAt: Date | null;
  venueConfirmedPlaceId: string | null;
  /**
   * The start the venue vouched for when it stamped the event (null when not
   * stamped). The venue floor is `max(startsAt, this) − 24h`.
   */
  venueConfirmedStartsAt: Date | null;
  /** The event's start, for the venue's "not before a day ahead" floor. */
  startsAt: Date;
  /** The event's own venue, or null for a freeform-address event. */
  place: {
    name: string;
    city: string | null;
    locationMode: EventLocationMode;
    locationRadiusMeters: number | null;
  } | null;
}

export interface ListOrdersByBuyerItem {
  id: string;
  eventId: string;
  /** Public-facing event slug, when set. Falls back to eventId in URLs. */
  eventSlug: string | null;
  eventName: string;
  eventStartsAt: Date | null;
  /** Raw privacy inputs for the venue line. See the type's doc: never render. */
  eventLocation: ListOrdersByBuyerEventLocation;
  amountGrossCents: number;
  feesPlatformCents: number;
  currency: string;
  status: OrderStatus;
  occurredAt: Date;
  source: OrderSource;
  ticketCount: number;
  /**
   * Distinct ticket-type names on this order ("GA", "VIP"), in the order the
   * tickets were issued.
   *
   * An array rather than one tier because a wallet row is an ORDER, and one
   * order can span tiers. Empty when the tickets carry no type — `ticketTypeId`
   * is nullable and set null when a type is deleted, so a row can legitimately
   * have none.
   */
  tiers: string[];
  /**
   * Raw inputs of the buyer charge breakdown (`computeBuyerChargeBreakdown`,
   * run in `listMyOrders`): what the buyer paid is a money rule, so core
   * decides it. Never rendered; `listMyOrders` drops them.
   */
  taxAmountCents: number;
  feePolicySnapshot: unknown;
  stripePaymentIntentId: string | null;
  chargeLines: Array<{ kind: string; amountCents: number; meta: unknown }>;
  /**
   * Who bought the order. `listMyOrders` also returns orders the viewer only
   * holds a transferred-in ticket from; those carry no "Total paid".
   */
  buyerHumanId: string;
}

export interface ListOrdersByBuyerResult {
  items: ListOrdersByBuyerItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Input for listing pending cart orders (orders with PENDING status that have active holds).
 * Used for cart recovery feature.
 */
export interface ListPendingCartsInput {
  buyerHumanId: string;
  /** Only include orders where at least one item's holdExpiresAt is after this time */
  holdExpiresAfter: Date;
  limit?: number;
}

export interface PendingCartItem {
  id: string;
  eventId: string;
  eventName: string;
  eventSlug: string | null;
  eventStartsAt: Date | null;
  amountGrossCents: number;
  feesPlatformCents: number;
  /**
   * Every line of the order as stored — ticket AND discount lines — so the
   * `getActiveCartHolds` use case can derive what a resumed held step needs
   * (the pre-discount gross, the buyer-side fees, the codes the cart was
   * priced with). Plain data: no derivation happens in the adapter.
   */
  lines: Array<{ kind: string; amountCents: number; meta: unknown }>;
  currency: string;
  holdExpiresAt: Date | null;
  createdAt: Date;
  ticketSummary: Array<{
    ticketTypeId: string;
    ticketTypeName: string;
    qty: number;
    unitPriceCents: number;
    /** Seat IDs held for this ticket type (empty for GA-only events). */
    seatIds: string[];
    /**
     * Each held seat with the unit price of the line holding it (empty for
     * GA). `unitPriceCents` above is the first line's, so a type mixing a
     * $50 override seat and a $30 seat needs this to show and quote each.
     */
    seats: Array<{ seatId: string; unitPriceCents: number }>;
  }>;
}

export interface ListPendingCartsResult {
  items: PendingCartItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Event attendee search (for organizer verification)
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchEventAttendeesInput {
  orgId: string;
  eventId: string;
  /** Free-text search on buyer name or email */
  searchQuery?: string;
  status?: OrderStatus;
  limit?: number;
  offset?: number;
}

export interface SearchEventAttendeeItem {
  orderId: string;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  ticketCount: number;
  amountGrossCents: number;
  currency: string;
  status: OrderStatus;
  /**
   * How the order was created. Carried so the attendees table can tell a COMP
   * apart from a genuinely free ticket — both render as $0.00 SUCCEEDED
   * otherwise.
   */
  source: OrderSource;
  occurredAt: Date;
}

export interface SearchEventAttendeesResult {
  items: SearchEventAttendeeItem[];
  total: number;
  limit: number;
  offset: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comps ledger (source = COMP, one event)
// ─────────────────────────────────────────────────────────────────────────────

export interface ListEventCompOrdersInput {
  eventId: string;
  limit?: number;
  offset?: number;
}

/**
 * One ticket-type line of a comp, grouped from the order's `kind = "ticket"`
 * items.
 *
 * An array rather than a single name: both callers of `createCompOrder` issue
 * ONE ticket type per comp, but nothing in the Order model enforces that, and
 * collapsing several types down to one label would silently mislabel the row.
 */
export interface EventCompOrderTicketTypeLine {
  ticketTypeId: string;
  /** Null only when the TicketType row no longer resolves. */
  name: string | null;
  quantity: number;
}

export interface EventCompOrderItem {
  orderId: string;
  occurredAt: Date;
  /**
   * Carried, not filtered on. A revoked volunteer reward is a CANCELLED comp
   * (see `cancelCompOrder`), and a ledger that hid it would lose the record of
   * a comp having been issued at all.
   */
  status: OrderStatus;
  recipientHumanId: string;
  recipientName: string | null;
  recipientEmail: string | null;
  ticketTypes: EventCompOrderTicketTypeLine[];
  /** Total tickets on the comp — sum of qty over `kind = "ticket"` items. */
  quantity: number;
  /** `Order.compReason`. Null for reward-granted comps AND for hand-issued
   * comps predating the provenance columns — the caller must NOT read meaning
   * into null on its own. */
  reason: string | null;
  /**
   * `Order.compIssuedByHumanId`. No FK by design, so this may reference a
   * human who no longer exists; name hydration is the caller's job and must
   * degrade rather than drop the row.
   *
   * Within a hand-issued comp this is ALSO the legacy tell:
   * `issueCompTickets` always stamps the issuer and only `reason` is optional,
   * so a stamped issuer with a blank reason is a modern hand-issue, while a
   * null issuer on a hand-issued comp means it predates the provenance
   * columns.
   */
  issuedByHumanId: string | null;
  /**
   * Whether a VolunteerRewardGrant points at this order. This is the ONLY
   * thing that separates a trigger-issued comp from a hand-issued one whose
   * provenance was never stamped — `compReason == null` does not.
   *
   * Deliberately a BOOLEAN, not the grant id: existence is all any caller
   * needs, and an id-shaped field would invite a caller to treat one
   * arbitrarily-chosen row of a to-many relation as *the* grant.
   *
   * CAVEAT for whoever adds a hard delete: this is only as durable as the
   * grant row. `VolunteerRewardGrant.reward` and `.signup` are `onDelete:
   * Cascade` while `compOrder` is the `SetNull` side, so deleting a
   * VolunteerReward or VolunteerSignup would destroy the grant and leave the
   * $0 comp behind — after which a trigger-issued comp becomes
   * indistinguishable from a legacy hand-issue, unrecoverably. No such delete
   * exists in the adapter today; if you add one, decide what the ledger should
   * say BEFORE you ship it.
   */
  hasVolunteerRewardGrant: boolean;
}

export interface ListEventCompOrdersResult {
  items: EventCompOrderItem[];
  total: number;
  limit: number;
  offset: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout attribution (naming the show a ledger credit came from)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an order is ABOUT, for a payouts view that has a ledger entry's
 * `orderId` and needs to print the show the money came from.
 *
 * Attribution ONLY. Nothing here is money, and nothing here may be summed:
 * the cents behind a tranche come from the ledger, never from an Order row.
 */
export interface OrderEventAttribution {
  orderId: string;
  /**
   * `Order.shortId` — the human-facing order code. NULL on rows minted before
   * the column existed; the caller falls back to nothing, never to the uuid.
   */
  orderCode: string | null;
  kind: OrderKind;
  /**
   * NULL for MEMBERSHIP invoices, which genuinely have no event — and also
   * when the event row was deleted under the order. A null here means "this
   * credit cannot be attributed to a show", which is a real state a payouts
   * view must render as such rather than hide the row.
   */
  eventId: string | null;
  eventTitle: string | null;
  /** `Event.slug`, for a `/events/<slug>` link. Never the uuid — see
   * `project_event_links_slug_not_id`: `/events/<uuid>` 404s. */
  eventSlug: string | null;
  eventStartsAt: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout summary (pending funds aggregation)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Platform-wide order listing (staff-only)
// ─────────────────────────────────────────────────────────────────────────────

export interface ListAllOrdersInput {
  /** Optional org filter (platform staff can view across orgs) */
  orgId?: string | null;
  eventId?: string | null;
  /** Optional buyer filter — scope to orders placed by this Human (Order.buyerHumanId). */
  buyerHumanId?: string | null;
  /** Free-text search on buyer name, email, or order ID */
  searchQuery?: string | null;
  status?: OrderStatus;
  statuses?: OrderStatus[];
  /**
   * Filter on the order's Dispute-row mirror (`Order.disputeStatus IN (...)`).
   * The use cases translate the `DISPUTED` status-filter value into this —
   * the dispute lifecycle never writes `Order.status = 'DISPUTED'`, so a
   * plain status filter for it is always empty. Every other status value
   * keeps its `Order.status` semantics.
   */
  disputeStatuses?: readonly DisputeStatus[];
  source?: OrderSource;
  occurredAtGte?: Date;
  occurredAtLte?: Date;
  sort?: "occurredAt_desc" | "occurredAt_asc";
  limit?: number;
  offset?: number;
}

/** Lightweight item summary returned inside ListPlatformOrdersItem. */
export interface PlatformOrderItemSummary {
  id: string;
  kind: OrderItemKind;
  ticketTypeName: string | null;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  status: OrderItemStatus;
  paidOutAt: Date | null;
  refundedAt: Date | null;
  transferredAt: Date | null;
  /** Ticket code (e.g. "TKT-ABC123"). Null for non-ticket items. */
  ticketCode: string | null;
  /** When the ticket was scanned at the door. */
  ticketScannedAt: Date | null;
  /** Reserved seat ID. */
  seatId: string | null;
  /** Display name of the current ticket owner (may differ from buyer after transfer). */
  ticketOwnerName: string | null;
  /**
   * Raw item meta, read by `listPlatformOrders` to build the buyer charge
   * breakdown (`buyerTotalCents`, `effectiveFeeMode`). Not sent to clients.
   */
  meta?: unknown;
}

export interface ListPlatformOrdersItem {
  id: string;
  /**
   * Platform admin sees every order, including membership invoices — so unlike
   * the org/human-scoped lists this one is genuinely mixed and these three
   * fields are null for memberships. Use `kind` to decide how to render.
   */
  eventId: string | null;
  eventTitle: string | null;
  kind: OrderKind;
  orgId: string | null;
  orgName: string | null;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  currency: string;
  status: OrderStatus;
  source: OrderSource;
  stripePaymentIntentId: string | null;
  paymentMethodType: string | null;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;

  /** Fee policy rates frozen at order creation time. */
  feePolicySnapshot: unknown;
  /** ISO-3166-1 alpha-2 billing country code. */
  billingCountry: string | null;
  /** Stripe Tax Calculation ID (when tax computed via Stripe Tax). */
  stripeTaxCalculationId: string | null;
  /** Parent order ID for resale / child orders. */
  parentOrderId: string | null;
  /** Full billing address captured at checkout. */
  billingAddress: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  /**
   * The discount attributed to this order. `code` is NULL for a
   * membership-sourced one — a benefit has no code, and the ledger's internal
   * `benefit:{id}` marker is not something an operator could type or search.
   */
  promo: {
    source: "code" | "membership";
    code: string | null;
    amountDiscountCents: number;
  } | null;
  /** Per-item breakdown with settlement & refund status. */
  items: PlatformOrderItemSummary[];
}

export interface ListAllOrdersResult {
  items: ListPlatformOrdersItem[];
  total: number;
  limit: number;
  offset: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Order migration (bulk move orders between events)
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkMigrateOrdersInput {
  sourceEventId: string;
  targetEventId: string;
  statuses: OrderStatus[];
}

export interface BulkMigrateOrdersResult {
  updatedCount: number;
  /** IDs of the orders that were migrated. */
  migratedOrderIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Expired carts (for cron cleanup)
// ─────────────────────────────────────────────────────────────────────────────

export interface ListExpiredPendingOrdersInput {
  /** Orders created before this cutoff are considered expired. */
  createdBefore: Date;
  limit?: number;
  /**
   * Order ids to leave out of the page entirely.
   *
   * The scan is `orderBy: occurredAt asc, take: limit`, so a cart the reaper
   * cannot retire is by definition among the OLDEST rows and would occupy a
   * page slot on every pass forever, displacing a cart that could actually be
   * reaped. The caller passes its quarantined ids here so the exclusion
   * happens in the query rather than after it. Empty / omitted = no filter.
   */
  excludeOrderIds?: string[];
}

export interface ExpiredPendingOrderItem {
  id: string;
  stripePaymentIntentId: string | null;
  buyerHumanId: string;
}

// ── Stale-cart cleanup after successful order ─────────────────────────────

export interface ListOtherPendingInput {
  /** The buyer whose stale carts to find. */
  buyerHumanId: string;
  /** Only return carts for the same event. */
  eventId: string;
  /** Exclude this order (the one that just succeeded). */
  excludeOrderId: string;
}

export interface StalePendingOrderItem {
  id: string;
  stripePaymentIntentId: string | null;
}

// ── Tax nexus rollup (spec 2026-07-01 §5.3) ────────────────────────────────
// Net facilitated sales + collected tax grouped by the frozen tax situs
// (country + state/province), for the economic-nexus threshold watch.
export interface GetTaxNexusRollupInput {
  /** Rolling-window start; only orders created at/after this are counted. */
  since: Date;
}

export interface TaxNexusRollupRow {
  /** Frozen venue country ("US" | "CA"), or null when unstamped. */
  country: string | null;
  /** Frozen venue state/province code (e.g. "AB", "FL"), or null. */
  state: string | null;
  /**
   * Σ `amountGrossCents`, NET of partial refunds: each PART_REFUNDED order
   * contributes its gross scaled by the un-refunded fraction of ticket value
   * (all history — needs no stamp). See the tax-nexus-threshold-watch runbook
   * §3 for why that is no longer the conservative direction for a threshold.
   */
  netSalesCents: number;
  /**
   * Σ `taxAmountCents` minus Σ stamped `OrderItem.refundedTaxCents` — tax
   * collected and STILL HELD. A NULL stamp (refund predating the column)
   * contributes nothing to the netting, so those orders still report full tax.
   */
  taxCollectedCents: number;
  /** Number of counted orders in the group. */
  orderCount: number;
  /**
   * The raw parts of the per-tax-line breakdown of `taxCollectedCents`, over
   * the same orders. Core turns these into `taxByLine`; the invariant is
   *
   *   Σ lines (chargedCents − refundedCents) + unattributedCents
   *     − Σ splitOrders.refundedTaxCents === taxCollectedCents
   *
   * where core places each split order's `refundedTaxCents` back on its lines
   * (or on UNATTRIBUTED when it cannot).
   */
  taxLineParts: TaxNexusRollupTaxLineParts;
}

/** See {@link TaxNexusRollupRow.taxLineParts}. */
export interface TaxNexusRollupTaxLineParts {
  /**
   * One entry per PLATFORM (code, jurisdiction) with amount > 0 charged on a
   * counted order (≤0 lines are ignored throughout). `chargedCents` = Σ
   * `OrderTaxLine.amountCents`. `refundedCents` = the refunded tax SQL can
   * attribute exactly: Σ stamped `refundedTaxCents` of orders with exactly
   * ONE such line whose amount equals `taxAmountCents`, put on that line.
   * Refunds of orders with ≥2 such lines are NOT in here (see `splitOrders`).
   */
  lines: Array<{
    code: string;
    jurisdiction: string;
    chargedCents: number;
    refundedCents: number;
  }>;
  /**
   * Net tax no line can carry: orders without a PLATFORM line with amount > 0
   * (legacy, pre-2026-09-28) contribute `taxAmountCents` − Σ stamps; an order
   * whose lone line disagrees with `taxAmountCents` contributes
   * `taxAmountCents` − line − Σ stamps; every other order contributes
   * `taxAmountCents` − Σ its lines (0 when they agree, as they should).
   */
  unattributedCents: number;
  /**
   * Counted orders whose PLATFORM lines (amount > 0; one or more) do not sum
   * to `taxAmountCents`; core reports a non-zero count. The difference (and,
   * for a lone line, its refunds) sits in `unattributedCents`. EXCLUDES the
   * orders in `splitOrders`: core reports those individually when the
   * allocator flags `lineMismatch`, so no order is reported twice.
   */
  lineMismatchOrderCount: number;
  /**
   * Counted orders with ≥2 PLATFORM lines with amount > 0 and at least one
   * refunded ticket item. Their stamped refunds must be split per line in core
   * (`allocateRefundTaxSharesByLine`). `refundedTaxCents` is the Σ of stamps
   * this same query netted, so core's split stays tied to this snapshot.
   */
  splitOrders: Array<{
    orderId: string;
    taxAmountCents: number;
    refundedTaxCents: number;
  }>;
}

/**
 * A ticket item of an order whose refunded tax the nexus rollup splits per
 * line (`orders.listTicketItemsForTaxSplit`).
 */
export interface TaxSplitTicketItem {
  id: string;
  amountCents: number;
  meta: unknown;
  status: OrderItemStatus;
  /** Stamped tax of the refund issued for this item; null = not attributed. */
  refundedTaxCents: number | null;
}

/**
 * All-time collected sales tax for one currency — the platform's tax
 * liability line in the solvency read.
 *
 * DELIBERATELY AN UPPER BOUND. `Order.taxAmountCents` is the tax CHARGED at
 * checkout and is never decremented afterwards, and there is no remittance
 * ledger, so this figure overstates in three known ways:
 *
 *  1. Partial refunds. A PART_REFUNDED order keeps its full
 *     `taxAmountCents` here even though `OrderItem.refundedTaxCents` records
 *     tax that went back to the buyer. (Fully REFUNDED orders leave the
 *     status filter entirely, so they contribute nothing.)
 *  2. Lost disputes. A chargeback never changes `Order.status`, so a
 *     disputed-and-lost order still contributes its full tax.
 *  3. Remittance. Nothing tracks what has already been filed and paid to a
 *     jurisdiction, so tax we no longer hold still counts as held.
 *
 * Overstating a liability is the SAFE direction — it makes the platform look
 * less solvent than it is, never more. Do NOT "fix" this downward by netting
 * refunds or subtracting guessed remittances: a guessed number reading as a
 * measured one is exactly the failure mode a solvency check exists to
 * prevent. The correct fix is a real tax ledger; until that exists, this is
 * the honest ceiling.
 */
export interface CollectedTaxTotal {
  /** Lowercase ISO-4217, as stored on the order. */
  currency: string;
  /** Σ `Order.taxAmountCents`, all time, for the counted statuses. */
  taxCollectedCents: number;
  /** Orders behind the figure — context for a triaging human. */
  orderCount: number;
}

// ── Processor-fee backfill ─────────────────────────────────────────────────

/** One order the processor-fee sweep has yet to read from Stripe. */
export interface OrderMissingProcessorFee {
  id: string;
  /** Non-null by construction — the query requires it. */
  stripePaymentIntentId: string;
  /** Lowercase ISO-4217, for the currency-mismatch guard at stamp time. */
  currency: string;
  /** Oldest-first ordering key, surfaced so a report can name the backlog's age. */
  occurredAt: Date;
  /**
   * How many times the sweep has already failed to read this order's fee.
   * Retry bookkeeping, never money. The sweep uses it to decide whether a
   * fresh failure is the FIRST (report it) or the one that PARKS the row
   * (report it again) — the retries in between are logged, not reported.
   */
  processorFeeReadFailures: number;
}

/**
 * How long the processor-fee sweep leaves a failed row alone before trying
 * again. Six hours: a transient Stripe outage clears well inside that, and a
 * permanent failure stops costing a page slot every hour. Lives here (not in
 * core) so the adapter can default to it — adapters sit below core.
 */
export const PROCESSOR_FEE_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Failures after which the sweep PARKS a row and stops retrying it. 24: with
 * hourly runs and the six-hour backoff that is roughly a week of attempts —
 * long enough to ride out any Stripe incident, short enough that a dead row
 * stops firing. Parked rows need a manual reset of the counter to re-enter.
 */
export const PROCESSOR_FEE_MAX_READ_FAILURES = 24;

export interface ListOrdersMissingProcessorFeeInput {
  /** Hard cap on rows per sweep run. */
  limit: number;
  /**
   * The sweep's clock. A row whose last failure is not yet older than
   * `now − retryBackoffMs` is skipped this run (a failure exactly on the
   * boundary stays backed off — the adapter compares with a strict `<`).
   */
  now: Date;
  /**
   * How long a failed row is left alone before it is retried. Defaults to
   * `PROCESSOR_FEE_RETRY_BACKOFF_MS`.
   */
  retryBackoffMs?: number;
  /**
   * Rows with this many failures or more are PARKED — never returned again
   * until the count is reset by hand. Defaults to
   * `PROCESSOR_FEE_MAX_READ_FAILURES`.
   */
  maxFailures?: number;
}

export interface RecordProcessorFeeReadFailureInput {
  orderId: string;
  /** The sweep's `now` — becomes `processorFeeReadFailedAt`. */
  failedAt: Date;
}

export interface StampProcessorFeeInput {
  orderId: string;
  /**
   * What Stripe reported on the balance transaction. NEVER a modelled or
   * rate-card figure: once stored it is indistinguishable from a measurement,
   * and the whole point of the column is that it is the real number.
   */
  feeCents: number;
}

// ── Cash till report (POS) ─────────────────────────────────────────────────
// Cash orders (`paymentChannel = "CASH"`) never touch Settlement — the
// organiser physically holds the money, so there is nothing for the platform
// to move. That is correct, and it is also why cash is invisible in every
// money view we have: payouts, settlement lines and the order revenue tiles
// all read the Settlement side. The result is that the one number a door
// team needs at the end of a night — how much cash should be in the box —
// is the one number nothing in the product computes.
//
// This is that read, and it is deliberately EVENT-scoped rather than
// operator-scoped: `Order` carries no `soldByHumanId`, so per-operator
// attribution would need a schema change. Reconciling the box is an
// event-level question; who took which sale is a different (and additive)
// feature.

export interface SummarizeCashTillForEventInput {
  /** The event whose till is being reconciled. */
  eventId: string;
  /** Cap on the returned `recentSales` tail. */
  recentLimit: number;
}

export interface CashTillSaleRow {
  orderId: string;
  /** Short human-quotable order code, when the row has one. */
  shortId: string | null;
  /**
   * What the sale cost the buyer — ticket net of discount + tax (plus the
   * platform fee on a sale recorded before the owner ruling of 2026-10-08:
   * cash = no platform fee) — the cash that stayed in the box. `0` on a
   * comp, and on a sale made free by a promo code (see `promoCode`). A cash
   * order recorded before the door was priced (spec 2026-10-07) carries no
   * fee or tax, so this is the amount the operator typed then.
   */
  amountCents: number;
  /** Tickets minted by this sale. */
  ticketCount: number;
  /**
   * The explicit Comp action only (`classifyCashSale` in core, the rule
   * `recordCashSale` reports). A $0 sale with a promo code is NOT a comp.
   */
  isComp: boolean;
  /**
   * The first promo code redeemed on this sale (normalized; redemption
   * order), or null. With `amountCents: 0` the row is "free with <CODE>".
   */
  promoCode: string | null;
  /** True once the sale has been reversed via `refundCashSale`. */
  isRefunded: boolean;
  occurredAt: Date;
}

export interface CashTillSummary {
  /**
   * True when the event has more cash orders than the read's scan cap, so the
   * totals below cover only the most recent slice. A silent cap on a
   * reconciliation number would read as a complete count.
   */
  truncated: boolean;
  /**
   * Sales recorded as sales: excludes comps, sales made free by a promo code
   * (`freeWithCodeSaleCount`), and refunds. A priced sale of a $0 tier with
   * no code counts here and adds 0 cents.
   */
  paidSaleCount: number;
  /** Cash the operator should be holding, in cents. Refunds are excluded. */
  cashCollectedCents: number;
  /**
   * The split of `cashCollectedCents` (spec 2026-10-07 FR-009), over the same
   * paid, unrefunded sales: `taxCents + platformFeeOwedCents +
   * organiserKeepsCents === cashCollectedCents`. Tax is owed to the platform
   * (a CASH_SALE_DEBIT, recovered from the next payout); the organiser keeps
   * the ticket money net of discounts. `platformFeeOwedCents` sums the fee
   * each order RECORDED: 0 for every cash sale since the owner ruling of
   * 2026-10-08 (cash = no platform fee), non-zero only for older ones.
   */
  taxCents: number;
  platformFeeOwedCents: number;
  organiserKeepsCents: number;
  /**
   * Explicit comps — the guest list (`classifyCashSale`). Excludes refunded
   * rows and $0 sales made free by a promo code.
   */
  compSaleCount: number;
  /** Tickets minted by comp sales. */
  compTicketCount: number;
  /**
   * Sales whose total is $0 because of a promo code (a 100%-off code is a
   * $0 SALE, owner ruling; never a comp). Excludes refunded rows. Add 0 to
   * every money figure.
   */
  freeWithCodeSaleCount: number;
  /** Tickets minted by free-with-a-code sales. */
  freeWithCodeTicketCount: number;
  /** Tickets minted by paid cash sales. */
  paidTicketCount: number;
  /** Cash sales later reversed via the 15-minute gate refund. */
  refundedSaleCount: number;
  /**
   * Cash handed BACK, in cents. Already excluded from `cashCollectedCents` —
   * reported separately so the operator can explain a short drawer rather
   * than just seeing a smaller number than they remember taking.
   */
  refundedCents: number;
  /** Newest-first tail, capped by `recentLimit`. */
  recentSales: CashTillSaleRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// One event's cash door sales, paged (owner ruling 2026-10-08: editors refund
// cash from the Sell screen, which lists every cash sale of the event)
// ─────────────────────────────────────────────────────────────────────────────

export interface ListCashSalesForEventInput {
  eventId: string;
  /**
   * Opaque keyset cursor from a previous page's `nextCursor`. A cursor the
   * adapter cannot read restarts from the first page.
   */
  cursor: string | null;
  /** Page size; the use case caps it. */
  limit: number;
}

/**
 * One cash sale as stored, carrying only what the Sell screen's row and the
 * refund-amount rule need. NO buyer columns (email, name, address, buyer id):
 * the Sell screen is open to Editors and Scanners, and buyer PII stays on
 * Orders (Owner/Admin/Finance).
 */
export interface CashSaleListRow {
  orderId: string;
  /**
   * SUCCEEDED or REFUNDED in practice; PART_REFUNDED is read for the same
   * reason the till reads it (no cash path writes it, by accident not by
   * guard). PENDING cash rows are rolled-back attempts and never listed.
   */
  status: "SUCCEEDED" | "REFUNDED" | "PART_REFUNDED";
  occurredAt: Date;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  /** Tickets minted by the sale (refunded ones included). */
  ticketCount: number;
  /**
   * Every item of the order, each kind, as `computeExpectedPaymentAmount`
   * and `classifyCashSale` read them. `refundedAt` is stamped on each ticket
   * item by the cash refund.
   */
  items: Array<{
    kind: string;
    amountCents: number;
    meta: unknown;
    refundedAt: Date | null;
  }>;
  /** Typed promo codes on the sale, in redemption order (benefits excluded). */
  promoCodes: string[];
}

export interface ListCashSalesForEventResult {
  /** Newest first: `occurredAt` desc, then `orderId` desc. */
  items: CashSaleListRow[];
  nextCursor: string | null;
}

/**
 * A door card sale left open on a cancelled event (the verify-ledger
 * invariant `cancelled_event_open_door_card_sale`): SUCCEEDED with a
 * PaymentIntent and never refunded, or PENDING and never voided.
 */
export interface CancelledEventOpenDoorCardSaleRow {
  orderId: string;
  eventId: string;
  status: "SUCCEEDED" | "PENDING";
  paymentIntentId: string | null;
  currency: string;
  amountGrossCents: number;
}
