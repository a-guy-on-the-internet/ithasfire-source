// ─────────────────────────────────────────────────────────────────────────────
// Checkout URL state
//
// Reflects the buyer's in-progress cart in the URL so:
//   • a refresh keeps their quantity + promo selections
//   • the page is shareable (organizer can prefill a cart for a customer)
//   • analytics can see which step a buyer dropped at
//
// Scope (Phase 1): step, ticket quantities, promo codes.
// Out of scope (Phase 2): selected seats, donation amounts. Those need
// server-side re-validation (seat may be taken, donation amount may exceed
// updated max) so we keep them in memory only for now. One exception: the
// SIGN-IN redirect carries a nonce (`a=`) for donation amounts stashed in
// sessionStorage, so an OAuth round trip does not lose them; the continuous
// sync strips `a` on its first write.
//
// Wire format (query params):
//   ?step=selecting|details|payment
//   &t=ttId1:2,ttId2:1
//   &p=EARLYBIRD,STUDENT
//
// Once the order is confirmed, the URL names the ORDER instead of the cart:
//   ?step=confirmed&order=<orderId>
// with `t`, `p` and `a` removed. Kept, the cart's quantities survived the
// purchase, and a reload showed the ticket picker with the same tickets
// selected, one click from buying them again. A reload of the confirmed URL
// restores the confirmation for that order (buyer-scoped; see `Checkout`); an
// `order` that is not a UUID is ignored, and `step=confirmed` without a valid
// `order` reads as no step at all.
//
// Ticket-type IDs are UUIDs in this codebase. We URL-encode them as a safety
// belt in case they ever change shape.
// ─────────────────────────────────────────────────────────────────────────────

import { MAX_DONATION_AMOUNT_CENTS } from "@/lib/pricing/pay-what-you-want";

export type CheckoutUrlStep = "selecting" | "details" | "payment" | "confirmed";

export type CheckoutPhase =
  | "selecting"
  | "holding"
  | "held"
  | "creating"
  | "paying"
  | "confirming"
  | "confirmed"
  | "done";

export const URL_PARAM_STEP = "step";
export const URL_PARAM_TICKETS = "t";
export const URL_PARAM_PROMO = "p";
/** The confirmed order's id. Written only with `step=confirmed`. */
export const URL_PARAM_ORDER = "order";
/**
 * Pay-what-you-want amounts across a sign-in round trip. The param holds a
 * one-time NONCE, never an amount: the amounts themselves are stashed in THIS
 * tab's `sessionStorage` under that nonce by `buildSignInRedirect`, and taken
 * (read + deleted) once on return. A crafted link carrying `a=` therefore
 * finds nothing to take and pre-fills nothing. The continuous URL sync never
 * writes it and STRIPS it on its first write.
 */
export const URL_PARAM_AMOUNTS = "a";

/**
 * Map the granular phase enum to the three user-visible steps. Transient
 * phases (`holding`, `creating`, `confirming`) collapse to their stable
 * neighbor so the URL doesn't flicker during async work.
 */
export function phaseToStep(phase: CheckoutPhase): CheckoutUrlStep | null {
  switch (phase) {
    case "selecting":
      return "selecting";
    case "holding":
    case "held":
      return "details";
    case "creating":
    case "paying":
    case "confirming":
      return "payment";
    case "confirmed":
    case "done":
      // Buyer is on / heading to the confirmation page — drop the step so
      // the URL doesn't keep showing an in-progress step. The `confirmed`
      // URL step needs the order id, which this mapping does not have: see
      // `checkoutUrlSnapshot`.
      return null;
  }
}

export function isCheckoutUrlStep(value: unknown): value is CheckoutUrlStep {
  return (
    value === "selecting" ||
    value === "details" ||
    value === "payment" ||
    value === "confirmed"
  );
}

// The pattern the server's `z.string().uuid()` applies (zod 4.3.6,
// `v4/core/regexes.js` `uuid()`): RFC 9562 version nibble 1-8 and variant
// 8/9/a/b, plus the nil and max UUIDs. Looser, a crafted 8-4-4-4-12 id got a
// BAD_REQUEST from `getMyOrder` (a toast and a Sentry event) instead of being
// ignored here.
const ORDER_ID_RE =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

/** A syntactically valid order id: one `getMyOrder`'s input accepts. */
export function isUrlOrderId(value: unknown): value is string {
  return typeof value === "string" && ORDER_ID_RE.test(value);
}

// ── Quantities ─────────────────────────────────────────────────────────

/**
 * Serialize `{ttId1: 2, ttId2: 0, ttId3: 1}` → `ttId1:2,ttId3:1`.
 * Drops zero-quantities. Returns `null` for empty carts (param omitted).
 */
export function serializeQuantities(
  quantities: Record<string, number>,
): string | null {
  const parts: string[] = [];
  for (const [ttId, qty] of Object.entries(quantities)) {
    if (qty > 0) parts.push(`${encodeURIComponent(ttId)}:${qty}`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

/** Defensive ceiling on quantity parsed from a URL. Per-line `max` is enforced server-side. */
const MAX_URL_QTY = 50;

/**
 * Parse `ttId1:2,ttId3:1` → `{ttId1: 2, ttId3: 1}`. Silently drops malformed
 * entries — the URL is user-editable, so we never throw. Caps each qty at
 * MAX_URL_QTY so a crafted URL can't pin the main thread seeding state.
 */
export function parseQuantities(value: string | null): Record<string, number> {
  if (!value) return {};
  const out: Record<string, number> = {};
  for (const segment of value.split(",")) {
    const [rawId, rawQty] = segment.split(":");
    if (!rawId || !rawQty) continue;
    const qty = Number.parseInt(rawQty, 10);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    try {
      out[decodeURIComponent(rawId)] = Math.min(qty, MAX_URL_QTY);
    } catch {
      // Malformed percent-encoding — skip.
    }
  }
  return out;
}

// ── Promo codes ────────────────────────────────────────────────────────

export function serializePromoCodes(codes: readonly string[]): string | null {
  if (codes.length === 0) return null;
  return codes.map((c) => encodeURIComponent(c)).join(",");
}

export function parsePromoCodes(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(",")) {
    if (!raw) continue;
    try {
      const decoded = decodeURIComponent(raw).trim();
      if (decoded.length >= 3) out.push(decoded);
    } catch {
      // skip
    }
  }
  return out;
}

// ── Pay-what-you-want amounts (sign-in round trip only) ────────────────


/** `{ttId: 1500}` → `ttId:1500`. Returns `null` when there is nothing to carry. */
export function serializeDonationAmounts(
  amounts: Record<string, number>,
): string | null {
  const parts: string[] = [];
  for (const [ttId, cents] of Object.entries(amounts)) {
    if (Number.isInteger(cents) && cents >= 0) {
      parts.push(`${encodeURIComponent(ttId)}:${cents}`);
    }
  }
  return parts.length > 0 ? parts.join(",") : null;
}

/**
 * Parse `ttId:1500,…`. The URL is user-editable: malformed entries are
 * dropped, and an amount above the per-ticket cap is dropped rather than
 * clamped (the buyer never typed a clamped number). Validity against the
 * tier's minimum is the hold guard's job, as for a typed amount.
 */
export function parseDonationAmounts(
  value: string | null,
): Record<string, number> {
  if (!value) return {};
  const out: Record<string, number> = {};
  for (const segment of value.split(",")) {
    const [rawId, rawCents] = segment.split(":");
    if (!rawId || !rawCents || !/^\d+$/.test(rawCents)) continue;
    const cents = Number.parseInt(rawCents, 10);
    if (cents > MAX_DONATION_AMOUNT_CENTS) continue;
    try {
      out[decodeURIComponent(rawId)] = cents;
    } catch {
      // Malformed percent-encoding — skip.
    }
  }
  return out;
}

const SIGN_IN_AMOUNTS_KEY_PREFIX = "checkout:pwyw-amounts:";

/**
 * Stash the buyer's PWYW amounts for a sign-in round trip. Returns the nonce
 * the redirect URL carries, or null when there is nothing to carry or no
 * storage (the buyer then simply returns to the default amount).
 */
export function stashSignInAmounts(
  amounts: Record<string, number>,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    // One round trip is in flight at a time: clear earlier stashes (every
    // opening of the sign-in overlay stashes afresh), so abandoned attempts
    // don't pile up in the tab's storage. Runs even when there is nothing new
    // to stash — a buyer who emptied their PWYW selection must not come back
    // from sign-in to an amount stashed by an earlier attempt.
    const storage = window.sessionStorage;
    for (let i = storage.length - 1; i >= 0; i -= 1) {
      const key = storage.key(i);
      if (key?.startsWith(SIGN_IN_AMOUNTS_KEY_PREFIX)) storage.removeItem(key);
    }
    const serialized = serializeDonationAmounts(amounts);
    if (!serialized) return null;
    const token = crypto.randomUUID();
    window.sessionStorage.setItem(
      `${SIGN_IN_AMOUNTS_KEY_PREFIX}${token}`,
      serialized,
    );
    return token;
  } catch {
    return null;
  }
}

/**
 * Take (read AND delete) the amounts a sign-in redirect stashed under
 * `token`. Unknown token ⇒ `{}` — which is what makes a crafted `a=` inert.
 * The stored value goes through `parseDonationAmounts`, so a tampered entry
 * is still filtered like any other input.
 */
export function takeSignInAmounts(
  token: string | null | undefined,
): Record<string, number> {
  if (!token || typeof window === "undefined") return {};
  try {
    const key = `${SIGN_IN_AMOUNTS_KEY_PREFIX}${token}`;
    const stored = window.sessionStorage.getItem(key);
    window.sessionStorage.removeItem(key);
    return parseDonationAmounts(stored);
  } catch {
    return {};
  }
}

// ── Whole-URL build ────────────────────────────────────────────────────

export type CheckoutUrlSnapshot = {
  step: CheckoutUrlStep | null;
  quantities: Record<string, number>;
  promoCodes: readonly string[];
  /**
   * Nonce for PWYW amounts stashed by the sign-in redirect (see
   * `stashSignInAmounts`). The URL sync leaves it unset, which is what strips
   * `a` from the address bar.
   */
  amountsToken?: string | null;
  /**
   * The confirmed order, written (and read back) only with
   * `step: "confirmed"`. With that step the cart fields are ignored: the
   * confirmed URL carries no `t`, `p` or `a`.
   */
  orderId?: string | null;
};

/**
 * The snapshot the continuous URL sync writes for the page's state. A
 * confirmed (or done) checkout with a known order is `step=confirmed&order=`
 * and nothing of the cart; every other phase is its step plus the cart.
 */
export function checkoutUrlSnapshot({
  phase,
  orderId,
  quantities,
  promoCodes,
}: {
  phase: CheckoutPhase;
  orderId: string | null;
  quantities: Record<string, number>;
  promoCodes: readonly string[];
}): CheckoutUrlSnapshot {
  if ((phase === "confirmed" || phase === "done") && isUrlOrderId(orderId)) {
    return { step: "confirmed", orderId, quantities: {}, promoCodes: [] };
  }
  return { step: phaseToStep(phase), quantities, promoCodes };
}

/**
 * Build a query-string payload from a state snapshot. Returns the search
 * portion *without* the leading `?` so callers can compose with their own
 * pathname / hash.
 */
export function buildCheckoutSearch(snapshot: CheckoutUrlSnapshot): string {
  const params = new URLSearchParams();
  if (snapshot.step === "confirmed") {
    // The order, never the cart. Without a valid order id there is nothing
    // to name, so nothing is written.
    if (isUrlOrderId(snapshot.orderId)) {
      params.set(URL_PARAM_STEP, snapshot.step);
      params.set(URL_PARAM_ORDER, snapshot.orderId);
    }
    return params.toString();
  }
  if (snapshot.step) params.set(URL_PARAM_STEP, snapshot.step);
  const t = serializeQuantities(snapshot.quantities);
  if (t) params.set(URL_PARAM_TICKETS, t);
  const p = serializePromoCodes(snapshot.promoCodes);
  if (p) params.set(URL_PARAM_PROMO, p);
  if (snapshot.amountsToken) {
    params.set(URL_PARAM_AMOUNTS, snapshot.amountsToken);
  }
  return params.toString();
}

/**
 * Merge a checkout snapshot on top of an existing search string, preserving
 * any unrelated params (e.g. ?resume=, ?ref=) that other code owns. Our keys
 * (`step`, `t`, `p`, `a`, `order`) are replaced wholesale. Accepts the search with or
 * without the leading `?`. Returns the merged query string without `?`.
 */
export function mergeCheckoutSearch(
  existingSearch: string,
  snapshot: CheckoutUrlSnapshot,
): string {
  const merged = new URLSearchParams(
    existingSearch.startsWith("?") ? existingSearch.slice(1) : existingSearch,
  );
  merged.delete(URL_PARAM_STEP);
  merged.delete(URL_PARAM_TICKETS);
  merged.delete(URL_PARAM_PROMO);
  merged.delete(URL_PARAM_AMOUNTS);
  merged.delete(URL_PARAM_ORDER);
  for (const [key, value] of new URLSearchParams(
    buildCheckoutSearch(snapshot),
  )) {
    merged.set(key, value);
  }
  return merged.toString();
}

/**
 * Read a URLSearchParams (or ReadonlyURLSearchParams from Next) into a
 * snapshot. Anything missing/invalid resolves to the empty default.
 */
export function readCheckoutSearch(
  params: URLSearchParams | { get: (key: string) => string | null },
): CheckoutUrlSnapshot {
  const rawStep = params.get(URL_PARAM_STEP);
  const rawOrder = params.get(URL_PARAM_ORDER);
  const step = isCheckoutUrlStep(rawStep) ? rawStep : null;
  // `step=confirmed` means something only with the order it names. Without a
  // valid one it is no step (the cart, if any, reads as usual); and `order`
  // without `step=confirmed` is ignored.
  const orderId =
    step === "confirmed" && isUrlOrderId(rawOrder) ? rawOrder : null;
  return {
    step: step === "confirmed" && !orderId ? null : step,
    quantities: parseQuantities(params.get(URL_PARAM_TICKETS)),
    promoCodes: parsePromoCodes(params.get(URL_PARAM_PROMO)),
    amountsToken: params.get(URL_PARAM_AMOUNTS),
    orderId,
  };
}
