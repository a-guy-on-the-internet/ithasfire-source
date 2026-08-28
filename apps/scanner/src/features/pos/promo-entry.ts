/**
 * Door promo-code entry — pure state machine for the POS Sell screen.
 *
 * Lives outside `sell-screen.tsx` for two reasons:
 *
 *   1. **It is money logic.** The discount an operator reads off the screen
 *      before taking cash has to be the discount the sale actually applies.
 *      That correctness is worth unit tests, and the scanner has no React
 *      renderer in its vitest setup (every existing test is pure-logic), so
 *      the logic has to be renderer-free to be testable at all.
 *   2. It keeps the screen a thin presentational shell.
 *
 * The three hazards this module exists to contain:
 *
 *   • **Stale discount after a cart change.** The discount depends on the
 *     cart: PERCENT promos scale with it, TICKET_TYPE-scoped promos only
 *     match certain lines, and `minOrderCents` rules start/stop applying.
 *     Every cart mutation therefore re-previews.
 *   • **Overlapping previews.** The quantity steppers fire fast. Requests
 *     are debounced AND generation-stamped, so a slow earlier response can
 *     never overwrite a newer one.
 *   • **A displayed discount the sale won't honour.** Any re-preview that
 *     fails drops the codes rather than leaving the previous (now unproven)
 *     number on screen next to a "collect cash" button.
 *
 * Everything here is framework-agnostic: the caller injects the transport
 * (`preview`) and receives state via `onChange`.
 */
import type { RouterOutputs } from "../../trpc";

export type PromoPreviewOutput = RouterOutputs["promos"]["preview"];
export type PromoApplication = PromoPreviewOutput["applications"][number];

export type PromoTicketSelection = { ticketTypeId: string; qty: number };

/**
 * The ONLY shape we ever send to `promos.preview` from the door.
 *
 * `pricing: "DOOR"` is not optional here and is deliberately a literal type,
 * not `"STANDARD" | "DOOR"`: the server defaults to `STANDARD` (the online
 * price), and previewing at the online price while the sale charges the door
 * price would quote the operator a discount that differs from the one they
 * collect against — visibly so for PERCENT promos.
 */
export type PromoPreviewRequest = {
  eventId: string;
  codes: string[];
  ticketSelections: PromoTicketSelection[];
  source: "manual";
  pricing: "DOOR";
};

export type PromoPreviewFn = (
  request: PromoPreviewRequest,
) => Promise<PromoPreviewOutput>;

/** Server cap: `promoCodes` on startSale / recordCashSale is `.max(4)`. */
export const MAX_PROMO_CODES = 4;

/**
 * Quantity steppers fire faster than a round trip. Long enough to coalesce a
 * burst of taps, short enough that the operator isn't waiting on the total.
 */
export const PROMO_PREVIEW_DEBOUNCE_MS = 250;

export type PromoState = {
  /** Applied codes, normalized, in the order the operator entered them. */
  codes: string[];
  /** Per-code breakdown from the last successful preview. */
  applications: PromoApplication[];
  totalDiscountCents: number;
  /**
   * Cart signature the discount above was computed against. When it differs
   * from the live cart, the discount is stale and the sale CTAs must not fire.
   */
  previewedCartKey: string | null;
  isPreviewing: boolean;
  /** Operator-readable failure from the last apply/remove/re-preview. */
  error: string | null;
};

export const EMPTY_PROMO_STATE: PromoState = {
  codes: [],
  applications: [],
  totalDiscountCents: 0,
  previewedCartKey: null,
  isPreviewing: false,
  error: null,
};

/** Trim + upper-case, matching the server's `preparePromoCodes` normalization. */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Order-independent signature of a cart. Two carts with the same signature
 * produce the same discount; anything else must be re-previewed.
 */
export function cartKeyOf(selections: PromoTicketSelection[]): string {
  return selections
    .filter((line) => line.qty > 0)
    .map((line) => `${line.ticketTypeId}:${line.qty}`)
    .sort()
    .join("|");
}

// ─────────────────────────────────────────────────────────────────────────────
// Error copy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The typed messages `evaluatePromoApplications` throws, rendered for someone
 * standing at a door with a queue behind them. Kept terse on purpose — this
 * renders inline under a 44pt input, not in a modal.
 */
const PROMO_ERROR_COPY: Record<string, string> = {
  // ── Stable `data.appCode` keys (preferred; see promoErrorMessage) ────────
  PROMO_NOT_FOUND: "Code not recognised.",
  PROMO_EXPIRED: "That code has expired.",
  PROMO_NOT_APPLICABLE: "That code doesn't apply to this cart.",
  PROMO_MAX_REDEEMED: "That code has hit its redemption limit.",
  PROMO_REDEEMED_BY_HUMAN: "That code has already been used.",
  PROMO_MIN_ORDER_NOT_MET: "Cart is below this code's minimum.",
  PROMO_NOT_STACKABLE: "That code can't be combined with another code.",
  DUPLICATE_PROMO: "That code is already applied.",
  TICKET_TYPE_NOT_FOUND: "A ticket in the cart is no longer on sale.",
  EVENT_NOT_FOUND: "This event is no longer available.",
  // ── Legacy wire `message` tokens (still thrown by checkout-promos) ───────
  promo_not_found: "Code not recognised.",
  promo_expired: "That code has expired.",
  promo_not_applicable: "That code doesn't apply to this cart.",
  promo_max_redeemed: "That code has hit its redemption limit.",
  promo_redeemed_by_human: "That code has already been used.",
  promo_min_order_not_met: "Cart is below this code's minimum.",
  promo_minimum_not_met: "Cart is below this code's minimum.",
  promo_not_stackable: "That code can't be combined with another code.",
  duplicate_promo: "That code is already applied.",
  duplicate_promo_code: "That code is already applied.",
  ticket_type_not_found: "A ticket in the cart is no longer on sale.",
};

const FALLBACK_PROMO_ERROR = "Couldn't apply that code. Try again.";

/** Longest free-text message we'll show verbatim (a Zod dump is far longer). */
const MAX_PASSTHROUGH_LENGTH = 120;

/**
 * Operator-facing copy for a failed preview or sale.
 *
 * Resolution order matters. `errorFormatter` puts a STABLE `data.appCode` on
 * the wire, whereas the `message` is whatever the thrower happened to use —
 * and promo throws are mid-migration from the legacy `{code, message}` literal
 * to `fail("CODE")`. Keying on appCode first means a thrower converted to
 * `fail()` keeps its specific copy instead of silently degrading to the
 * generic fallback. The message map stays as the fallback for the throws that
 * haven't been converted yet.
 */
export function promoErrorMessage(err: unknown): string {
  return errorMessageFrom(err, PROMO_ERROR_COPY, FALLBACK_PROMO_ERROR);
}

/**
 * Copy for a failure at SALE time (`pos.startSale` / `pos.recordCashSale`),
 * which can fail for reasons that have nothing to do with promo codes. Routing
 * these through `promoErrorMessage` told an operator with no code applied that
 * "that code" failed — and silently discarded the one message that matters
 * most at a door: someone else is mid-tap on the last ticket.
 */
const SALE_ERROR_COPY: Record<string, string> = {
  ...PROMO_ERROR_COPY,
  TICKET_TYPE_SOLD_OUT: "That ticket type just sold out.",
  TICKET_TYPE_TEMPORARILY_HELD:
    "Someone else is mid-sale on the last of these. Try again in a moment.",
  seat_unavailable: "Those seats were just taken. Try again.",
  AMOUNT_MUST_BE_POSITIVE: "Use Cash to record a $0 comp — a card can't be charged for nothing.",
  PAYEE_CHARGES_DISABLED:
    "This organisation can't take card payments yet. Use Cash.",
  PAYEE_NOT_CONNECTED:
    "This organisation isn't set up for card payments. Use Cash.",
  PAYEE_MISSING_STRIPE_ACCOUNT:
    "This organisation isn't set up for card payments. Use Cash.",
  SCANNER_TERMS_REQUIRED: "Accept the scanner terms in Settings first.",
  INSUFFICIENT_ROLE: "You don't have permission to sell for this event.",
  EVENT_NOT_ORG_OWNED: "Door sales aren't available for this event.",
  IDEMPOTENCY_LOCK_IN_PROGRESS:
    "That sale is still processing. Check the last sale before retrying.",
  IDEMPOTENCY_KEY_CONFLICT:
    "That sale is still processing. Check the last sale before retrying.",
};

const FALLBACK_SALE_ERROR = "Couldn't complete that sale. Try again.";

export function saleErrorMessage(err: unknown): string {
  return errorMessageFrom(err, SALE_ERROR_COPY, FALLBACK_SALE_ERROR);
}

function errorMessageFrom(
  err: unknown,
  copy: Record<string, string>,
  fallback: string,
): string {
  const lookup = (key: unknown): string | null => {
    // `Object.hasOwn` so an appCode of "constructor"/"toString" can't return an
    // inherited non-string that React Native would then refuse to render.
    if (typeof key !== "string" || !Object.hasOwn(copy, key)) return null;
    const value = copy[key];
    return typeof value === "string" ? value : null;
  };

  const mappedByCode = lookup(
    (err as { data?: { appCode?: unknown } | null } | null)?.data?.appCode,
  );
  if (mappedByCode) return mappedByCode;

  const token =
    typeof err === "string"
      ? err
      : typeof (err as { message?: unknown } | null)?.message === "string"
        ? (err as { message: string }).message
        : null;
  if (!token) return fallback;
  const mapped = lookup(token);
  if (mapped) return mapped;
  // Internal-looking token (snake_case / SCREAMING_SNAKE, no spaces).
  if (/^[A-Za-z0-9_.]+$/.test(token)) return fallback;
  // Free text — "Network request failed" is worth showing. A Zod input-
  // validation failure is not: its message is a multi-line JSON dump of the
  // issue array, which would render verbatim under the input.
  if (
    token.length > MAX_PASSTHROUGH_LENGTH ||
    /[\n{[]/.test(token) ||
    token.trim() === ""
  ) {
    return fallback;
  }
  return token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Totals
// ─────────────────────────────────────────────────────────────────────────────

export type CartTotals = {
  /** Door-price subtotal, integer cents. */
  subtotalCents: number;
  /** Clamped to the subtotal — a discount can zero a cart, never invert it. */
  discountCents: number;
  /** What the buyer owes: subtotal − discount. */
  totalCents: number;
  /**
   * True when codes are applied but the displayed discount was computed
   * against a different cart (or a preview is in flight). The sale CTAs stay
   * disabled while this is true.
   */
  isStale: boolean;
};

export function selectCartTotals(args: {
  subtotalCents: number;
  cartKey: string;
  promo: PromoState;
}): CartTotals {
  const { subtotalCents, cartKey, promo } = args;
  const discountCents = Math.max(
    0,
    Math.min(promo.totalDiscountCents, subtotalCents),
  );
  const hasCodes = promo.codes.length > 0;
  return {
    subtotalCents,
    discountCents: hasCodes ? discountCents : 0,
    totalCents: Math.max(0, subtotalCents - (hasCodes ? discountCents : 0)),
    isStale:
      hasCodes && (promo.isPreviewing || promo.previewedCartKey !== cartKey),
  };
}

/**
 * Codes to send with `pos.startSale` / `pos.recordCashSale`. Returns
 * `undefined` (not `[]`) when nothing is applied so the caller can omit the
 * field entirely rather than sending an empty array.
 */
export function promoCodesForSale(promo: PromoState): string[] | undefined {
  return promo.codes.length > 0 ? [...promo.codes] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

export type PromoContext = {
  eventId: string;
  selections: PromoTicketSelection[];
};

export type PromoController = {
  getState(): PromoState;
  /** Validate + add a code. No-op on empty/whitespace input. */
  apply(rawCode: string, ctx: PromoContext): Promise<void>;
  remove(rawCode: string, ctx: PromoContext): Promise<void>;
  /** Call on every cart change; debounced + generation-guarded internally. */
  syncCart(ctx: PromoContext): void;
  /** Drop everything — between sales, and on "next sale". */
  reset(): void;
  /** Cancel timers and orphan in-flight responses (unmount). */
  dispose(): void;
};

export function createPromoController(opts: {
  preview: PromoPreviewFn;
  onChange: (state: PromoState) => void;
  debounceMs?: number;
  /**
   * Reads the CURRENT cart. Without this the controller is edge-triggered —
   * it only reacts to `syncCart` calls — and can come to rest holding a quote
   * for a cart the operator has already changed, with no re-preview scheduled
   * and both sale CTAs disabled forever. Consulted whenever a preview settles
   * so staleness is self-healing. Optional only so existing tests can omit it.
   */
  getCart?: () => PromoContext;
}): PromoController {
  const debounceMs = opts.debounceMs ?? PROMO_PREVIEW_DEBOUNCE_MS;

  let state: PromoState = EMPTY_PROMO_STATE;
  /**
   * Bumped by every new intent. A response whose stamp no longer matches is
   * dropped on the floor — this is what stops a slow "+1" preview from
   * landing on top of the "+3" the operator has since tapped.
   */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Cart key of the scheduled-or-in-flight preview; suppresses duplicates.
   *
   * INVARIANT (the whole self-healing story rests on it): whenever there is no
   * timer and nothing in flight, `pendingCartKey` is either `null` or exactly
   * `state.previewedCartKey`. If it were ever left holding some third value,
   * `syncCart`'s `cartKey === pendingCartKey` early-return would skip a needed
   * re-preview and the screen would wedge with both sale CTAs disabled.
   */
  let pendingCartKey: string | null = null;

  const set = (patch: Partial<PromoState>) => {
    state = { ...state, ...patch };
    opts.onChange(state);
  };

  /** Invalidates any scheduled timer AND any in-flight response. */
  const invalidate = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    generation += 1;
  };

  /** Schedules a debounced re-preview of `codes` against `ctx`. */
  const scheduleSync = (ctx: PromoContext, codes: string[]) => {
    invalidate();
    pendingCartKey = cartKeyOf(ctx.selections);
    const snapshot = [...codes];
    timer = setTimeout(() => {
      timer = null;
      void runPreview(snapshot, ctx, "drop");
    }, debounceMs);
  };

  /**
   * Called after a preview settles. If the cart moved while the request was
   * in flight, the state we just committed is already stale — reconcile by
   * scheduling a re-preview against the live cart. This is what makes
   * staleness self-healing: without it, a cart change that lands during an
   * in-flight preview leaves `previewedCartKey` permanently behind the live
   * cart, `isStale` stuck true, and both sale CTAs dead with no explanation.
   *
   * Note the re-preview carries only the codes that SURVIVED — a rejected
   * candidate is never retried, so this can't turn into a retry storm.
   */
  const reconcileWithLiveCart = (codes: string[]) => {
    if (codes.length === 0) return;
    const live = opts.getCart?.();
    if (!live) return;
    const liveKey = cartKeyOf(live.selections);
    if (liveKey === "") {
      // Cart emptied mid-flight — drop the codes rather than leave them to
      // ride along into whatever is rung up next.
      invalidate();
      pendingCartKey = null;
      set({ ...EMPTY_PROMO_STATE });
      return;
    }
    if (liveKey === state.previewedCartKey) {
      pendingCartKey = state.previewedCartKey;
      return;
    }
    scheduleSync(live, codes);
  };

  const runPreview = async (
    codes: string[],
    ctx: PromoContext,
    onFailure: "keep" | "drop",
  ): Promise<void> => {
    invalidate();
    const stamp = generation;
    const cartKey = cartKeyOf(ctx.selections);
    pendingCartKey = cartKey;
    set({ isPreviewing: true, error: null });

    try {
      const out = await opts.preview({
        eventId: ctx.eventId,
        codes,
        ticketSelections: ctx.selections
          .filter((line) => line.qty > 0)
          .map((line) => ({ ticketTypeId: line.ticketTypeId, qty: line.qty })),
        source: "manual",
        pricing: "DOOR",
      });
      if (stamp !== generation) return; // superseded
      set({
        codes,
        applications: out.applications,
        totalDiscountCents: out.totalDiscountCents,
        previewedCartKey: cartKey,
        isPreviewing: false,
        error: null,
      });
      reconcileWithLiveCart(codes);
    } catch (err) {
      if (stamp !== generation) return; // superseded
      const message = promoErrorMessage(err);
      if (onFailure === "drop") {
        // The previously-shown discount is now unproven. Showing it next to a
        // "collect cash" button would be a money bug, so the codes go.
        pendingCartKey = null;
        set({ ...EMPTY_PROMO_STATE, error: message });
      } else {
        // Apply path: the candidate code is simply not added, and the codes
        // that were already validated keep their (still valid) discount.
        pendingCartKey = state.previewedCartKey;
        set({ isPreviewing: false, error: message });
        // The surviving codes may still be quoted against a stale cart if the
        // operator changed it while this apply was in flight.
        reconcileWithLiveCart(state.codes);
      }
    }
  };

  return {
    getState: () => state,

    async apply(rawCode, ctx) {
      const code = normalizePromoCode(rawCode);
      if (code === "") return; // empty / whitespace does nothing
      if (state.codes.includes(code)) {
        set({ error: "That code is already applied." });
        return;
      }
      if (state.codes.length >= MAX_PROMO_CODES) {
        set({ error: `Up to ${MAX_PROMO_CODES} promo codes per sale.` });
        return;
      }
      if (cartKeyOf(ctx.selections) === "") {
        // The server requires at least one ticket selection, and a discount
        // against an empty cart is meaningless anyway.
        set({ error: "Add tickets before applying a code." });
        return;
      }
      await runPreview([...state.codes, code], ctx, "keep");
    },

    async remove(rawCode, ctx) {
      const code = normalizePromoCode(rawCode);
      const next = state.codes.filter((applied) => applied !== code);
      if (next.length === state.codes.length) return;
      if (next.length === 0 || cartKeyOf(ctx.selections) === "") {
        invalidate();
        pendingCartKey = null;
        set({ ...EMPTY_PROMO_STATE });
        return;
      }
      // "drop" on failure: leaving the removed chip on screen because the
      // re-preview errored would be worse than clearing and re-entering.
      await runPreview(next, ctx, "drop");
    },

    syncCart(ctx) {
      if (state.codes.length === 0) {
        // Either nothing is applied (nothing to reconcile), or a first apply
        // is in flight — in which case invalidating here would silently
        // discard the code the operator just submitted. `reconcileWithLiveCart`
        // picks the cart change up when that apply settles.
        return;
      }
      const cartKey = cartKeyOf(ctx.selections);
      if (cartKey === "") {
        // Cart emptied — nothing left to discount. Drop the codes so one can
        // never silently ride along into whatever is rung up next.
        invalidate();
        pendingCartKey = null;
        set({ ...EMPTY_PROMO_STATE });
        return;
      }
      if (cartKey === pendingCartKey) return; // already scheduled / previewed
      if (cartKey === state.previewedCartKey && !state.isPreviewing) {
        // The cart came back to a shape we already hold a settled quote for
        // (+1 then −1). Cancel any scheduled re-preview and adopt the quote
        // instead of making a pointless round trip. Cancelling matters as much
        // as skipping: a timer left pending while `isStale` reads false means
        // the sale CTAs are live with a re-preview about to fire under them —
        // and if that fires and fails, it drops the codes after the operator
        // has already opened the cash sheet.
        invalidate();
        pendingCartKey = cartKey;
        return;
      }
      scheduleSync(ctx, state.codes);
    },

    reset() {
      invalidate();
      pendingCartKey = null;
      set({ ...EMPTY_PROMO_STATE });
    },

    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      generation += 1;
    },
  };
}
