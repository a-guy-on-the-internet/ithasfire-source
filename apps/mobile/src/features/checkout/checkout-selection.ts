/**
 * Pure checkout-selection core (FR-003) — no React, no Expo, no transport.
 *
 * Owns the cart the buyer assembles on CheckoutScreen before payment:
 *
 *   - per-ticket-type quantities, bounded 0..min(capacity, 10)
 *   - per-unit donation amounts for ADJUSTABLE (pay-what-you-want) types,
 *     clamped to ≥ minimumCents, stored as integer cents
 *   - promo codes (max 5, deduped case-insensitively, trimmed)
 *   - the per-attempt `clientKey` idempotency key for orders.createCheckout
 *     (min 8 chars server-side; we use a UUID). The key stays stable across
 *     retries of the same attempt and only changes via ROTATE_CLIENT_KEY.
 *
 * `toCheckoutItems` mirrors the `items` element schema of
 * `createCheckoutInputSchema` (packages/core/src/use-cases/orders/
 * create-checkout.ts): `{ ticketTypeId, qty, donationAmountCents? }` —
 * `seatIds` never applies (mobile checkout is GA-only).
 *
 * All money values are integer cents end-to-end. The subtotal here is a
 * DISPLAY ESTIMATE only — fees, tax, and discounts come from the server at
 * payment time (FR-010); no fee/tax math happens client-side.
 */

/** UI cap per ticket type, even when capacity is plentiful or unbounded. */
export const MAX_QTY_PER_TYPE = 10;

/** Max promo codes accepted by `createCheckoutInputSchema` (`.max(5)`). */
export const MAX_PROMO_CODES = 5;

/** Length bounds from `createCheckoutInputSchema` (`trim().min(3).max(64)`). */
const PROMO_CODE_MIN_LENGTH = 3;
const PROMO_CODE_MAX_LENGTH = 64;

/**
 * Structural subset of `events.listEventTicketTypes` ticket types — only the
 * fields the selection logic needs. `capacity` is the raw TicketType.capacity
 * column (NOT live remaining availability); interpreting <= 0 as sold out
 * mirrors web's TicketTypeGrid (apps/web/src/app/events/checkout/[...slug]/
 * _components/TicketTypeGrid.tsx). `null` is tolerated defensively and
 * treated as unbounded.
 */
export type CheckoutTicketType = {
  id: string;
  pricingMode: "FIXED" | "ADJUSTABLE";
  priceCents: number;
  minimumCents: number | null;
  suggestedCents: number | null;
  capacity: number | null;
};

export type CheckoutItem = {
  qty: number;
  /** Per-unit amount in integer cents — ADJUSTABLE types only. */
  donationAmountCents?: number;
};

export type CheckoutItems = Readonly<Record<string, CheckoutItem>>;

export type CheckoutSelectionState = {
  clientKey: string;
  items: CheckoutItems;
  promoCodes: readonly string[];
};

// ── Quantities ─────────────────────────────────────────────────────────────

/** Stepper upper bound: min(capacity, 10); sold out (capacity <= 0) → 0. */
export const maxSelectableQty = (ticketType: CheckoutTicketType): number =>
  ticketType.capacity == null
    ? MAX_QTY_PER_TYPE
    : Math.max(0, Math.min(ticketType.capacity, MAX_QTY_PER_TYPE));

// ── Donations (ADJUSTABLE pricing) ─────────────────────────────────────────

/** Clamp a per-unit amount to ≥ (minimumCents ?? 0), integer cents. */
export const clampDonationCents = (
  ticketType: CheckoutTicketType,
  cents: number,
): number => {
  const floorCents = Math.max(0, ticketType.minimumCents ?? 0);
  if (!Number.isFinite(cents)) return floorCents;
  return Math.max(floorCents, Math.trunc(cents));
};

/** Default per-unit amount: suggested → minimum → list price, clamped. */
export const defaultDonationCents = (ticketType: CheckoutTicketType): number =>
  clampDonationCents(
    ticketType,
    ticketType.suggestedCents ??
      ticketType.minimumCents ??
      ticketType.priceCents,
  );

// ── Item updates ───────────────────────────────────────────────────────────

const setItemQty = (
  items: CheckoutItems,
  ticketType: CheckoutTicketType,
  qty: number,
): CheckoutItems => {
  const clamped = Math.max(
    0,
    Math.min(maxSelectableQty(ticketType), Math.trunc(qty)),
  );
  if (clamped === 0) {
    if (!(ticketType.id in items)) return items;
    const next = { ...items };
    delete next[ticketType.id];
    return next;
  }
  const existing = items[ticketType.id];
  return {
    ...items,
    [ticketType.id]: {
      qty: clamped,
      ...(ticketType.pricingMode === "ADJUSTABLE"
        ? {
            donationAmountCents:
              existing?.donationAmountCents ?? defaultDonationCents(ticketType),
          }
        : {}),
    },
  };
};

export const adjustItemQty = (
  items: CheckoutItems,
  ticketType: CheckoutTicketType,
  delta: number,
): CheckoutItems =>
  setItemQty(items, ticketType, (items[ticketType.id]?.qty ?? 0) + delta);

/** No-op for FIXED types or when the type isn't selected. */
export const setItemDonationCents = (
  items: CheckoutItems,
  ticketType: CheckoutTicketType,
  cents: number,
): CheckoutItems => {
  if (ticketType.pricingMode !== "ADJUSTABLE") return items;
  const existing = items[ticketType.id];
  if (!existing || existing.qty === 0) return items;
  return {
    ...items,
    [ticketType.id]: {
      qty: existing.qty,
      donationAmountCents: clampDonationCents(ticketType, cents),
    },
  };
};

// ── Promo codes ────────────────────────────────────────────────────────────

export type AddPromoCodeFailure =
  | "too_short"
  | "too_long"
  | "duplicate"
  | "limit_reached";

export type AddPromoCodeResult =
  | { ok: true; codes: readonly string[] }
  | { ok: false; reason: AddPromoCodeFailure };

export const addPromoCode = (
  codes: readonly string[],
  rawCode: string,
): AddPromoCodeResult => {
  const code = rawCode.trim();
  if (code.length < PROMO_CODE_MIN_LENGTH) {
    return { ok: false, reason: "too_short" };
  }
  if (code.length > PROMO_CODE_MAX_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  const lowered = code.toLowerCase();
  if (codes.some((existing) => existing.toLowerCase() === lowered)) {
    return { ok: false, reason: "duplicate" };
  }
  if (codes.length >= MAX_PROMO_CODES) {
    return { ok: false, reason: "limit_reached" };
  }
  return { ok: true, codes: [...codes, code] };
};

export const removePromoCode = (
  codes: readonly string[],
  code: string,
): readonly string[] => codes.filter((existing) => existing !== code);

// ── Derived ────────────────────────────────────────────────────────────────

/**
 * Total selected qty, counted against the CURRENT ticket-type list. Items
 * whose ticketTypeId no longer exists (a refetch can drop a type) contribute
 * 0 — mirroring `estimateSubtotalCents` / `toCheckoutItems` — so the summary
 * count, subtotal, and payload can never disagree.
 */
export const totalSelectedQty = (
  items: CheckoutItems,
  ticketTypes: readonly CheckoutTicketType[],
): number =>
  ticketTypes.reduce(
    (sum, ticketType) => sum + (items[ticketType.id]?.qty ?? 0),
    0,
  );

/**
 * Display-only estimated subtotal in integer cents: priceCents×qty for
 * FIXED, donationAmountCents×qty for ADJUSTABLE. NOT the charge amount —
 * fees/tax/discounts are computed server-side at payment time (FR-010).
 */
export const estimateSubtotalCents = (
  items: CheckoutItems,
  ticketTypes: readonly CheckoutTicketType[],
): number =>
  ticketTypes.reduce((sum, ticketType) => {
    const item = items[ticketType.id];
    if (!item) return sum;
    const unitCents =
      ticketType.pricingMode === "ADJUSTABLE"
        ? (item.donationAmountCents ?? 0)
        : ticketType.priceCents;
    return sum + unitCents * item.qty;
  }, 0);

/**
 * Shape the selection into `createCheckoutInputSchema.items` elements:
 * `{ ticketTypeId, qty, donationAmountCents? }`. `donationAmountCents` is
 * only attached for ADJUSTABLE types; zero-qty rows are omitted; order
 * follows the server's ticket-type order.
 */
export const toCheckoutItems = (
  items: CheckoutItems,
  ticketTypes: readonly CheckoutTicketType[],
): { ticketTypeId: string; qty: number; donationAmountCents?: number }[] =>
  ticketTypes.flatMap((ticketType) => {
    const item = items[ticketType.id];
    if (!item || item.qty <= 0) return [];
    return [
      {
        ticketTypeId: ticketType.id,
        qty: item.qty,
        ...(ticketType.pricingMode === "ADJUSTABLE"
          ? { donationAmountCents: item.donationAmountCents ?? 0 }
          : {}),
      },
    ];
  });

// ── Reducer ────────────────────────────────────────────────────────────────

export type CheckoutSelectionAction =
  | { type: "ADJUST_QTY"; ticketType: CheckoutTicketType; delta: number }
  | {
      type: "SET_DONATION_CENTS";
      ticketType: CheckoutTicketType;
      cents: number;
    }
  | { type: "ADD_PROMO_CODE"; code: string }
  | { type: "REMOVE_PROMO_CODE"; code: string }
  /** `nextKey` is generated by the caller so the reducer stays pure. */
  | { type: "ROTATE_CLIENT_KEY"; nextKey: string };

export const createInitialCheckoutState = (
  generateKey: () => string,
): CheckoutSelectionState => ({
  clientKey: generateKey(),
  items: {},
  promoCodes: [],
});

export const checkoutSelectionReducer = (
  state: CheckoutSelectionState,
  action: CheckoutSelectionAction,
): CheckoutSelectionState => {
  switch (action.type) {
    case "ADJUST_QTY":
      return {
        ...state,
        items: adjustItemQty(state.items, action.ticketType, action.delta),
      };
    case "SET_DONATION_CENTS":
      return {
        ...state,
        items: setItemDonationCents(
          state.items,
          action.ticketType,
          action.cents,
        ),
      };
    case "ADD_PROMO_CODE": {
      const result = addPromoCode(state.promoCodes, action.code);
      if (!result.ok) return state;
      return { ...state, promoCodes: result.codes };
    }
    case "REMOVE_PROMO_CODE":
      return {
        ...state,
        promoCodes: removePromoCode(state.promoCodes, action.code),
      };
    case "ROTATE_CLIENT_KEY":
      return { ...state, clientKey: action.nextKey };
    default:
      return state;
  }
};

// ── Money input parsing (ADJUSTABLE amount field) ──────────────────────────

/**
 * Parse a dollars-and-cents text input ("12", "12.5", "$1,200.50", "1,50")
 * into integer cents. Commas are accepted in exactly two unambiguous forms:
 *
 *   - a trailing decimal comma with 1–2 digits ("1,50" → 150¢) — the comma
 *     is the only separator on many fr/de/es iOS decimal pads;
 *   - strict thousands grouping ("$1,234.56" → 123456¢).
 *
 * Any other comma placement — including mixed European style ("1.234,56")
 * and bad grouping ("1,2345") — returns null rather than guessing. Only
 * outer whitespace is trimmed; internal whitespace ("1 2") is rejected.
 *
 * The arithmetic is `Number(whole) * 100 + Number(fraction)` — exact ONLY
 * because both operands are digit-only integers and the
 * `Number.isSafeInteger` guard below rejects overflow. The guard is
 * load-bearing; do not remove it. Returns null when the text isn't a valid
 * non-negative amount with at most 2 decimal places.
 */
export const parseDollarsToCents = (raw: string): number | null => {
  let cleaned = raw.trim();
  if (/\s/.test(cleaned)) return null;
  cleaned = cleaned.replace(/^\$/, "");
  if (cleaned.includes(",")) {
    if (/^\d*,\d{1,2}$/.test(cleaned)) {
      // Trailing decimal comma ("1,50") — fr/de/es decimal pads emit ",".
      cleaned = cleaned.replace(",", ".");
    } else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cleaned)) {
      // Strict thousands grouping ("1,234.56").
      cleaned = cleaned.replace(/,/g, "");
    } else {
      // Ambiguous comma placement — reject rather than misparse 100x.
      return null;
    }
  }
  if (cleaned === "" || cleaned === ".") return null;
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole = "", fraction = ""] = cleaned.split(".");
  const cents =
    Number(whole === "" ? "0" : whole) * 100 +
    Number(fraction === "" ? "0" : fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
};

/** Inverse of {@link parseDollarsToCents} for seeding the text input. */
export const formatCentsAsDollarsInput = (cents: number): string => {
  const safe = Math.max(0, Math.trunc(cents));
  const whole = Math.trunc(safe / 100);
  const fraction = safe % 100;
  return fraction === 0
    ? String(whole)
    : `${whole}.${String(fraction).padStart(2, "0")}`;
};
