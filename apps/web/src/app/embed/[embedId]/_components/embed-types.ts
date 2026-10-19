import type { CheckoutStepId } from "@/app/events/checkout/[...slug]/_components/CheckoutStepper";

import type { EmbedTicketCode } from "./embed-tickets";

// ─────────────────────────────────────────────────────────────────────────────
// Shared embed types
// ─────────────────────────────────────────────────────────────────────────────

export type EventItem = {
  id: string;
  title: string;
  slug: string | null;
  startsAt: Date;
  endsAt: Date | null;
  /**
   * `Event.timezone` (IANA): the card's date is printed in it, never in the
   * renderer's zone. Optional because a stale cached payload may predate it
   * (read as `DEFAULT_VENUE_TIMEZONE`, as the shared card does).
   */
  timezone?: string | null;
  currency: string;
  heroImageUrl: string | null;
  /**
   * The search index's place label on org/human grids (a place name, or the
   * public address when there is no name to print), sent only for an event
   * whose public location is exact; else null. The card prints it first.
   * Optional because a stale cached payload may predate it (read as null).
   */
  placeLabel?: string | null;
  addressText: string | null;
  locality: string | null;
  region: string | null;
  /**
   * Pricing summary for the browse card's price label. SEARCH-INDEX SEMANTICS
   * (mirrors `getEmbedForWidget` / `build-search-index.ts`): `lowestPriceCents`
   * is 0 whenever a free tier exists and null ONLY when there are no ACTIVE
   * tiers — it is NOT the minimum PAID price. The label derivation needs all
   * three fields: `paidTierCount` separates "$25" from "$25+" and
   * `hasFreeTier` separates "Free" from "Free+". A stale cached payload may
   * lack them at runtime — `mapEventItemToSummary` degrades to "See details".
   */
  lowestPriceCents: number | null;
  paidTierCount: number;
  hasFreeTier: boolean;
  /**
   * A floor-0 pay-what-you-want tier is on sale: the card reads "Pay what you
   * want", never "Free" (owner ruling 2026-10-06, F2). Optional because a
   * stale cached payload may predate it (read as false).
   */
  hasPayWhatYouWantTier?: boolean;
  /**
   * ALL-IN price of the cheapest on-sale paid tier (ticket + fees + tax), the
   * only figure a paid card prints. Already plausibility-checked by core. Null
   * means "See details"; may be absent on a stale cached payload (read as null).
   */
  lowestBuyerTotalCents: number | null;
  /**
   * The event's gate (owner ruling 2026-10-12: a gated event stays listed,
   * with the site card's gate badge). Optional because a stale cached payload
   * may predate it; the detail read answers the gate authoritatively.
   */
  gateType?: EmbedGateType;
};

/** `embedGateTypeSchema` in core (`assert-event-ungated-for-embed.ts`). */
export type EmbedGateType = "NONE" | "PASSWORD" | "APPLICATION";

export type CartItem = {
  ticketTypeId: string;
  qty: number;
  seatIds?: string[];
  donationAmountCents?: number;
  /**
   * The price the seat picker showed for each picked seat that has an
   * override (plain seats are absent). The summary prices those seats at it,
   * and checkout sends it as `seatQuotes` (seat-price-overrides D-007).
   */
  seatQuotes?: Array<{ seatId: string; unitPriceCents: number }>;
  /** The section `seatIds` were picked from: re-read after a price refusal. */
  seatSectionId?: string;
};

export type Screen = "grid" | "eventDetail" | "checkout" | "confirmation";
export type SlideDirection = "forward" | "back";

/** The two sub-steps within the checkout screen. */
export type CheckoutStep = "details" | "payment";

export type SeatStatus = "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";

export type EmbedTicketLine = {
  id: string;
  name: string;
  priceCents: number;
  buyerUnitTotalCents?: number | null;
  qty: number;
  /**
   * Face × qty at the shown prices, when the line's tickets are not all at
   * `priceCents` (an override seat at its own price). Defaults to
   * `priceCents × qty`.
   */
  lineCents?: number;
};

export type EmbedBillingAddress = {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

export type EmbedOrderFees = {
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  /**
   * Processor fee in cents. For a PASS_THROUGH Stripe charge this is the
   * grossed-up fee the buyer funds — `createCheckout` adds it to the
   * PaymentIntent, so the buyer-facing total includes it. For ABSORB it is a
   * display-only estimate excluded from the total (Stripe deducts it from the
   * organizer's settlement instead).
   */
  processorFeeCents: number;
  /**
   * Effective fee mode stamped by `createEmbedGuestCheckout`. PASS_THROUGH →
   * the processor fee is a charged line included in the total; ABSORB → it is
   * an "Included" estimate excluded from the total. Absent on pre-charge
   * estimates (display falls back to the fee-rates query's feeMode).
   */
  feeMode?: "ABSORB" | "PASS_THROUGH";
  taxAmountCents: number;
};

/** One persisted order line, as `createGuestCheckout` returns it. */
export type EmbedOrderLineItem = {
  ticketTypeId: string;
  name: string;
  qty: number;
  /** Pre-discount face price per ticket (the buyer's amount on PWYW). */
  unitPriceCents: number;
  /** unitPriceCents × qty. */
  lineCents: number;
};

export type EmbedCheckoutConfirmation = {
  orderId: string;
  clientSecret: string | null;
  /**
   * Currency of the charged event, resolved by EmbedCheckout from
   * `embeds.getEventDetail` (`event.currency ?? "usd"` — the same rule
   * `embeds.getForWidget` maps). Carried on the confirmation so
   * `hf:orderComplete` can emit it without re-deriving from a browse list
   * (the calendar browse view has no getForWidget events to look it up in).
   */
  currency: string;
  orderFees: EmbedOrderFees;
  /**
   * The order's ticket lines as `createGuestCheckout` read them back from the
   * persisted order — what the confirmation prints. Never rebuilt from the
   * cart: the server priced them, and with a promo Σ lineCents −
   * `orderFees.amountGrossCents` is the discount. Empty only when the server
   * completed a free order but could not read its lines
   * back (reported server-side); the Total still comes from `orderFees`.
   */
  lineItems: EmbedOrderLineItem[];
  billingAddress: EmbedBillingAddress | null;
  waiverAccepted: boolean;
  /**
   * THIS order's tickets, once the server has confirmed it and handed them
   * over: from `confirmGuestPayment`'s "confirmed" answer for a paid order,
   * from `createGuestCheckout` for a free one. Absent or empty when the
   * server sent none; the confirmation then shows no tickets section.
   *
   * Component state only (see embed-tickets.ts): a code is never stored,
   * put in a URL, posted to the host page or logged.
   */
  tickets?: EmbedTicketCode[];
};

export type { CheckoutStepId };
