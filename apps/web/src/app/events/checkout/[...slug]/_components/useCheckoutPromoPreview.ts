import { useEffect, useMemo, useRef } from "react";

import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { isPayWhatYouWant } from "@/lib/pricing/pay-what-you-want";

export type UseCheckoutPromoPreviewArgs = {
  eventId: string;
  /** Promo codes pulled from the URL on first mount. */
  initialUrlPromoCodes: string[];
  /** Live ticket quantities — drives the preview query. */
  quantities: Record<string, number>;
  /**
   * Buyer-chosen amounts for pay-what-you-want tiers (debounced upstream).
   * Sent as each line's `donationAmountCents` so a promo on a PWYW line
   * discounts the amount the buyer will be charged, not the tier's stored $0.
   */
  donationAmounts?: Record<string, number>;
  /**
   * The seats picked per tier (the ones step 1 prices the cart from). Sent as
   * each fixed-price line's `seatIds`, so a seat with a price override is
   * discounted at its own price, as checkout charges it. Never sent for a
   * pay-what-you-want tier (an override does not apply there) or a tier
   * `ticketTypes` does not list.
   */
  selectedSeatIds?: Readonly<Record<string, readonly string[]>>;
  /** The event's tiers: which ones are fixed-price (see `selectedSeatIds`). */
  ticketTypes?: ReadonlyArray<PromoPreviewTicketType>;
  /**
   * True while any selected pay-what-you-want amount is one the hold would
   * refuse (over the cap, under the minimum, empty). The live preview is then
   * PAUSED and nothing is pruned: the cart it would price is not the cart the
   * buyer means, and pricing it at the tier's floor instead made a code fail
   * its minimum order (or have nothing eligible) and get deleted. The last
   * good preview stays on screen until the amount is fixed.
   */
  paused?: boolean;
  /** Currently queued promo codes (manual entry / URL apply). */
  promoCodes: string[];
  /**
   * Whether the buyer has a signed-in session. When true the live preview
   * runs even with ZERO queued codes and asks the server to include the
   * buyer's membership benefits (`includeMemberBenefits`) — a member should
   * see their discount before typing anything. The identity itself is
   * session-derived server-side, never sent from here.
   */
  isSignedIn: boolean;
  /**
   * The buyer's own pending order once one exists (payment step reached,
   * holds taken). Sent as `excludeOrderId` so the live preview does not count
   * the buyer's OWN promo hold against a per-person / global cap while they
   * edit the cart they already hold. Null before any order exists.
   */
  pendingOrderId: string | null;
  /** Apply a code to the cart (used to seed URL-supplied public codes). */
  onApplyPromoCode: (code: string) => string | null;
  /** Remove a code that the server rejected after preview. */
  onRemovePromoCode: (code: string) => void;
};

/**
 * Rejections that mean the CODE itself can never apply — it conflicts with
 * another code, does not exist, or is used up. Only these prune. Anything
 * else (an `invalid_input` from an over-cap PWYW amount, a transport failure)
 * says nothing about the codes and never removes one.
 */
const PRUNING_REJECTION_KEYS: Readonly<Record<string, string>> = {
  promo_not_stackable: "errors.promoNotStackable",
  promo_not_found: "errors.promoNotFound",
  promo_max_redeemed: "errors.promoMaxRedeemed",
  promo_redeemed_by_human: "errors.promoRedeemedByHuman",
};

/**
 * Rejections about the CART, not the code: nothing eligible, or the minimum
 * order not met. They change as the buyer edits the cart — clearing a $0-floor
 * PWYW field made every code "not applicable" for a moment, and pruning then
 * wiped them all. The code is KEPT, shown with this reason next to it, and
 * contributes a $0 discount; the charge still refuses it exactly as the
 * server does today if the cart is not fixed.
 */
const ELIGIBILITY_REJECTION_KEYS: Readonly<Record<string, string>> = {
  promo_not_applicable: "errors.promoNotApplicable",
  promo_min_order_not_met: "errors.promoMinOrderNotMet",
};

const normalizeCode = (code: string) => code.trim().toUpperCase();

type PromoPreviewTicketType = {
  id: string;
  pricingMode?: "FIXED" | "ADJUSTABLE" | null;
};

export type PromoPreviewSelection = {
  ticketTypeId: string;
  qty: number;
  donationAmountCents?: number;
  seatIds?: string[];
};

/**
 * The cart as `promos.preview` prices it: each tier with a quantity, the
 * buyer's amount on a pay-what-you-want tier, and the picked seats on a
 * fixed-price tier (at most `qty` of them, each once — what the server
 * accepts), so the preview discounts each override seat at its own price.
 */
export function promoPreviewSelections(
  quantities: Readonly<Record<string, number>>,
  donationAmounts: Readonly<Record<string, number>> | undefined,
  selectedSeatIds: Readonly<Record<string, readonly string[]>> | undefined,
  ticketTypes: ReadonlyArray<PromoPreviewTicketType> | undefined,
): PromoPreviewSelection[] {
  const fixedPrice = new Set(
    (ticketTypes ?? []).filter((tt) => !isPayWhatYouWant(tt)).map((tt) => tt.id),
  );
  return Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([ticketTypeId, qty]) => {
      const seatIds = fixedPrice.has(ticketTypeId)
        ? [...new Set(selectedSeatIds?.[ticketTypeId] ?? [])].slice(0, qty)
        : [];
      return {
        ticketTypeId,
        qty,
        ...(donationAmounts && ticketTypeId in donationAmounts
          ? { donationAmountCents: donationAmounts[ticketTypeId] }
          : {}),
        ...(seatIds.length > 0 ? { seatIds } : {}),
      };
    });
}

/**
 * Is this preview error a PROMO rejection — one this hook surfaces itself
 * (inline, or as a named "Promo code removed" toast)? Those are silenced in
 * the global query-error logger entirely. Anything else (a 5xx, the API
 * unreachable) is still reported to Sentry and explained inline as "couldn't
 * check your code right now".
 */
export function isPromoRejectionError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return (
    typeof message === "string" &&
    (Object.hasOwn(PRUNING_REJECTION_KEYS, message) ||
      Object.hasOwn(ELIGIBILITY_REJECTION_KEYS, message))
  );
}

/**
 * May a previous preview result stand in for the current input while it
 * loads? Only when the CART and CODES are the same — i.e. only the
 * `excludeOrderId` re-key (taking the hold) changed. Removing a code, or
 * changing a quantity under a % code, must never show the old discount:
 * signed in, the preview stays enabled (member benefits), so a blanket
 * `keepPreviousData` kept the removed code's discount on screen until the
 * refetch landed. `queryKey` is tRPC's `[path, { input, type }]`.
 */
export function previewKeyMatchesCart(
  queryKey: unknown,
  input: {
    eventId: string;
    codes: readonly string[];
    ticketSelections: readonly unknown[];
  },
): boolean {
  const previous = (
    Array.isArray(queryKey) ? (queryKey[1] as { input?: unknown }) : undefined
  )?.input as
    | { eventId?: unknown; codes?: unknown; ticketSelections?: unknown }
    | undefined;
  if (!previous) return false;
  return (
    previous.eventId === input.eventId &&
    JSON.stringify(previous.codes) === JSON.stringify(input.codes) &&
    JSON.stringify(previous.ticketSelections) ===
      JSON.stringify(input.ticketSelections)
  );
}

/** Logger meta for both preview queries — see `isPromoRejectionError`. */
const PREVIEW_QUERY_META = {
  silentWhen: isPromoRejectionError,
  noToast: true,
} as const;

/** The code a promo rejection names, from the wire's `data.meta.promoCode`. */
function rejectedPromoCodeOf(error: unknown): string | null {
  const meta = (error as { data?: { meta?: unknown } } | null)?.data?.meta;
  const code =
    meta && typeof meta === "object"
      ? (meta as { promoCode?: unknown }).promoCode
      : undefined;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** One membership-granted discount line, labelled for the order summary. */
export type MemberDiscountLine = {
  tierName: string | null;
  /**
   * The owner's override for this line's label, when they set one. Null keeps
   * the default "Member discount — {tier}".
   */
  label: string | null;
  discountCents: number;
};

/**
 * Drives the promo discount the buyer sees in the order summary, plus the
 * URL-applied promo seeding and post-preview rejection pruning.
 *
 * Three concerns under one roof:
 *   1. URL-applied promos — fetch a preview for codes pulled off the URL,
 *      apply the public ones once. Private codes are silently skipped to
 *      avoid leaking their existence via the URL.
 *   2. Live preview — query the server for the current queued `promoCodes`
 *      so the discount/total in OrderSummary tracks what the buyer will
 *      actually be charged.
 *   3. Rejection pruning — if the server can't stack a code, drop the
 *      most-recently-added one and toast a single "couldn't combine"
 *      message per offending code (tracked so re-renders don't double-fire).
 *
 * Pulled out of Checkout.tsx so the 130-line promo lifecycle isn't inline
 * in the render body.
 */
export function useCheckoutPromoPreview({
  eventId,
  initialUrlPromoCodes,
  quantities,
  donationAmounts,
  selectedSeatIds,
  ticketTypes,
  paused = false,
  promoCodes,
  isSignedIn,
  pendingOrderId,
  onApplyPromoCode,
  onRemovePromoCode,
}: UseCheckoutPromoPreviewArgs): {
  livePromoDiscountCents: number;
  /**
   * BEFORE THE HOLD: how much of the estimate's platform fee the charge will
   * not take, because the discount brings one or more tickets down to $0
   * (the preview's `platformFeeReductionCents`). From the SAME preview result
   * as `livePromoDiscountCents`, so the two are always for one cart and one
   * set of codes. Feed both to `estimateCartTotal`. Never applied to a held
   * order: see `liveHeldCartFees`.
   */
  livePromoFeeReductionCents: number;
  /**
   * ON THE HELD STEP: the platform fee to show for the buyer's pending cart.
   * The fee `createCheckout` will charge with the codes as they stand (the
   * preview's `heldCartFees`). While there is no answer for these codes (in
   * flight, or failed) and so no discount on screen, the cart's NO-DISCOUNT
   * fee from the last statement made for this same cart. Null when the
   * server has stated nothing for this cart yet, and before the hold. Put it
   * on the held order with `withStatedHeldFees`; on null the order keeps the
   * fee it has.
   */
  liveHeldCartFees: {
    buyerPlatformFeeCents: number;
    platformFeeWaivedCents: number;
  } | null;
  /**
   * The live preview failed for a reason that is NOT a promo rejection (a
   * 5xx, the API unreachable): the codes stay applied at $0, and the page
   * says it couldn't check them rather than leaving them unexplained.
   */
  promoPreviewUnavailable: boolean;
  /**
   * The code from the buyer's LINK couldn't be checked (5xx / unreachable —
   * not a promo rejection), so it was not applied. The page says so.
   */
  urlPromoCheckUnavailable: boolean;
  /**
   * Codes KEPT but not applying to the cart right now (eligibility
   * rejections), keyed by normalized code → the i18n key of the reason.
   */
  promoCodeRejections: Record<string, string>;
  /** Membership-granted portion of the discount, one line per benefit. */
  memberDiscounts: MemberDiscountLine[];
} {
  const { toast } = useNotify();
  const t = useTranslations();

  const ticketSelections = useMemo(
    () =>
      promoPreviewSelections(
        quantities,
        donationAmounts,
        selectedSeatIds,
        ticketTypes,
      ),
    [quantities, donationAmounts, selectedSeatIds, ticketTypes],
  );

  // ── URL-applied promos: fetch a one-shot preview to learn which codes
  //    are public, then apply only those. ────────────────────────────────
  const urlPromoPreviewQuery = trpc.promos.preview.useQuery(
    {
      eventId,
      codes: initialUrlPromoCodes,
      ticketSelections,
      source: "url",
    },
    {
      enabled:
        initialUrlPromoCodes.length > 0 && ticketSelections.length > 0,
      retry: false,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // Its failures are handled here (a rejected URL code is simply not
      // applied) — never the global "Something went wrong" toast. Outages
      // are still reported to Sentry.
      meta: PREVIEW_QUERY_META,
    },
  );
  const urlPromoApplications = urlPromoPreviewQuery.data?.applications;
  // A URL code the preview couldn't CHECK (5xx / unreachable — not a promo
  // rejection) is never applied; say so instead of dropping it silently.
  const urlPromoCheckUnavailable =
    initialUrlPromoCodes.length > 0 &&
    urlPromoPreviewQuery.isError &&
    !isPromoRejectionError(urlPromoPreviewQuery.error);
  const hasAppliedUrlPromoCodesRef = useRef(false);
  useEffect(() => {
    if (hasAppliedUrlPromoCodesRef.current) return;
    if (initialUrlPromoCodes.length === 0) {
      hasAppliedUrlPromoCodesRef.current = true;
      return;
    }
    if (urlPromoPreviewQuery.isError) {
      hasAppliedUrlPromoCodesRef.current = true;
      return;
    }
    if (!urlPromoApplications) return;

    hasAppliedUrlPromoCodesRef.current = true;
    const publicCodes = new Set(
      urlPromoApplications
        .filter((application) => application.isPublic)
        .map((application) => application.normalizedCode),
    );

    for (const code of initialUrlPromoCodes) {
      if (publicCodes.has(code.trim().toUpperCase())) {
        onApplyPromoCode(code);
      }
    }
  }, [
    onApplyPromoCode,
    initialUrlPromoCodes,
    urlPromoApplications,
    urlPromoPreviewQuery.isError,
  ]);

  // ── Live preview for the CURRENT queued promoCodes. ───────────────────
  // Drives:
  //   1. The "Discount" line + correct total in OrderSummary (so the buyer
  //      can see savings BEFORE submitting checkout).
  //   2. Stackability / eligibility enforcement: if the server rejects a
  //      code (e.g. trying to stack two non-stackable promos), the code
  //      won't appear in `applications` and we surface that as a toast +
  //      auto-remove from `promoCodes`.
  // Signed-in buyers preview even with an empty code list so membership
  // benefits (server-resolved from the session) surface before checkout.
  //
  // While `paused`, the query keeps its LAST unpaused input and is disabled,
  // so react-query keeps serving that input's cached result: the buyer still
  // sees the discount they had, and no request runs on a cart they don't mean.
  const liveInput = {
    eventId,
    codes: promoCodes,
    ticketSelections,
    source: "manual" as const,
    includeMemberBenefits: true,
    // Server-verified against the session before it is honoured.
    excludeOrderId: pendingOrderId ?? undefined,
  };
  const lastUnpausedInputRef = useRef(liveInput);
  if (!paused) lastUnpausedInputRef.current = liveInput;
  const liveEnabled =
    !paused &&
    (promoCodes.length > 0 || isSignedIn) &&
    ticketSelections.length > 0;
  const livePromoPreviewQuery = trpc.promos.preview.useQuery(
    paused ? lastUnpausedInputRef.current : liveInput,
    {
      enabled: liveEnabled,
      retry: false,
      staleTime: 0,
      refetchOnWindowFocus: false,
      // Every PROMO rejection this query can return is surfaced HERE —
      // inline beside the code (eligibility; a lone code) or as a named
      // "Promo code removed" toast (a hard prune) — so those are silenced in
      // the global logger. The global toast fired "Something went wrong" for
      // a code that merely hadn't met its minimum yet. Other failures (5xx,
      // unreachable) still go to Sentry, and are explained inline
      // (`promoPreviewUnavailable`) instead of toasted.
      meta: PREVIEW_QUERY_META,
      // Taking the hold adds `excludeOrderId` to the key; without this the
      // discount blinked to $0 on step 2 until the re-keyed preview landed.
      // Each input keeps its own cache entry, so an older response can never
      // be served as a newer input's result — this only bridges the gap.
      //
      // ONLY while enabled: React Query applies placeholder data to a
      // pending query even when it is DISABLED, so removing the last code
      // (key → `codes: []`, query off) kept showing the removed code's
      // discount while the charge was full price. And only across the hold
      // re-key — see `previewKeyMatchesCart`.
      placeholderData: liveEnabled
        ? (previous, previousQuery) =>
            previewKeyMatchesCart(previousQuery?.queryKey, liveInput)
              ? previous
              : undefined
        : undefined,
    },
  );
  // The last SETTLED result (not a placeholder) and the cart it priced:
  // what a pause shows when the paused key never settled — pausing
  // mid-fetch (the buyer started typing an amount while the previous
  // amount's preview was in flight) used to flash $0. Used only for the
  // SAME codes and the SAME tiers × quantities — only a PWYW amount may
  // differ (that is what a pause is for) — so a removed code's discount, or
  // a 3-ticket % discount on a 1-ticket cart, is never brought back.
  // The picked seats are part of the cart: a discount priced for other seats
  // (another override price) is not this cart's.
  const pausableCartKey = (input: typeof liveInput) =>
    JSON.stringify({
      codes: input.codes,
      lines: input.ticketSelections.map(({ ticketTypeId, qty, seatIds }) => [
        ticketTypeId,
        qty,
        seatIds ?? [],
      ]),
    });
  const lastSettledPreviewRef = useRef<{
    cartKey: string;
    data: NonNullable<typeof livePromoPreviewQuery.data>;
  } | null>(null);
  if (
    livePromoPreviewQuery.data !== undefined &&
    !livePromoPreviewQuery.isPlaceholderData
  ) {
    lastSettledPreviewRef.current = {
      cartKey: pausableCartKey(
        paused ? lastUnpausedInputRef.current : liveInput,
      ),
      data: livePromoPreviewQuery.data,
    };
  }
  const settledForPausedCodes =
    lastSettledPreviewRef.current?.cartKey ===
    pausableCartKey(lastUnpausedInputRef.current)
      ? lastSettledPreviewRef.current.data
      : undefined;
  // A disabled (and not paused) preview prices NOTHING: no codes, or no
  // tickets, means no discount — whatever the cache or a placeholder holds.
  // A PAUSED preview keeps its last good result on screen (see `paused`).
  const livePreviewData = liveEnabled
    ? livePromoPreviewQuery.data
    : paused
      ? (livePromoPreviewQuery.data ?? settledForPausedCodes)
      : undefined;
  const livePromoDiscountCents = livePreviewData?.totalDiscountCents ?? 0;
  // Read off the same result as the discount, so a fee figure can never be
  // from another cart or another set of codes than the discount beside it.
  // `?? 0` / `?? null` also cover an API older than these fields (web and
  // API deploy apart): no reduction and no statement, as before them.
  const livePromoFeeReductionCents =
    livePreviewData?.platformFeeReductionCents ?? 0;
  // The held cart's fee with NO discount, from the last statement the server
  // made for this order and these tickets. A statement is for one set of
  // codes: the moment the buyer changes them there is none for the new set
  // until the server answers, and the discount above reads 0 meanwhile. The
  // fee that belongs beside "no discount" is the no-discount fee, which
  // depends on the tickets and the allowance, not on the codes. Without it,
  // removing a code that had freed a ticket from a cart `createCheckout`
  // already priced showed that charge's smaller fee beside the full price.
  // Keyed by the input the query actually ran with (a paused query runs the
  // last unpaused input), so it is never read for another order or cart.
  const heldCartKey = (input: {
    excludeOrderId?: string;
    ticketSelections: readonly unknown[];
  }) =>
    input.excludeOrderId
      ? JSON.stringify([input.excludeOrderId, input.ticketSelections])
      : null;
  const undiscountedHeldFeesRef = useRef<{
    cartKey: string;
    fees: { buyerPlatformFeeCents: number; platformFeeWaivedCents: number };
  } | null>(null);
  const settledHeldCartFees = livePromoPreviewQuery.isPlaceholderData
    ? undefined
    : livePromoPreviewQuery.data?.heldCartFees;
  const queriedHeldCartKey = heldCartKey(
    paused ? lastUnpausedInputRef.current : liveInput,
  );
  // `withoutDiscounts` is absent from an API older than the field.
  if (settledHeldCartFees?.withoutDiscounts && queriedHeldCartKey) {
    undiscountedHeldFeesRef.current = {
      cartKey: queriedHeldCartKey,
      fees: settledHeldCartFees.withoutDiscounts,
    };
  }
  // The statement for the codes as they stand; else, when the page is showing
  // NO discount (no result at all for this key: in flight, or failed), the
  // no-discount fee for this same cart; else none, and the held order keeps
  // the fee it has. A result WITHOUT a statement (the pre-hold result that
  // bridges the hold's re-key) still shows its discount, so it gets no
  // no-discount fee beside it. The objects are the query's own, so their
  // identity is stable across renders.
  const liveHeldCartFees: {
    buyerPlatformFeeCents: number;
    platformFeeWaivedCents: number;
  } | null =
    livePreviewData?.heldCartFees ??
    (livePreviewData === undefined &&
    undiscountedHeldFeesRef.current !== null &&
    undiscountedHeldFeesRef.current.cartKey === heldCartKey(liveInput)
      ? undiscountedHeldFeesRef.current.fees
      : null);
  const livePromoApplications = livePreviewData?.applications;
  const promoPreviewUnavailable =
    liveEnabled &&
    livePromoPreviewQuery.isError &&
    !isPromoRejectionError(livePromoPreviewQuery.error);
  const memberDiscounts = useMemo<MemberDiscountLine[]>(
    () =>
      (livePromoApplications ?? [])
        .filter((application) => application.source?.kind === "membership")
        .map((application) => ({
          tierName: application.source?.tierName ?? null,
          label: application.source?.label ?? null,
          discountCents: application.discountCents,
        })),
    [livePromoApplications],
  );

  // ── Which code a hard rejection is about ─────────────────────────────
  // The server names it (`data.meta.promoCode`). A STACKING rejection is the
  // exception: it names the stored non-stackable code, which may be the
  // older, bigger discount the buyer already had — so the conflict is always
  // resolved against the code just added (the newest; apply appends).
  const rejection = useMemo(() => {
    if (paused || !liveEnabled || !livePromoPreviewQuery.isError) return null;
    const message = livePromoPreviewQuery.error?.message ?? "";
    const newest = promoCodes[promoCodes.length - 1];
    if (!newest) return null;
    const named = rejectedPromoCodeOf(livePromoPreviewQuery.error);
    const namedInCart =
      named &&
      promoCodes.find((code) => normalizeCode(code) === normalizeCode(named));
    const code =
      message === "promo_not_stackable" ? newest : (namedInCart ?? newest);
    return { message, code };
  }, [
    paused,
    liveEnabled,
    livePromoPreviewQuery.isError,
    livePromoPreviewQuery.error,
    promoCodes,
  ]);

  // Reasons shown beside a code that stays applied: every eligibility
  // rejection, and a PRUNING rejection of a LONE code — there is no other
  // code to fall back to, so it stays in the cart with its reason (a
  // mistyped single code used to sit there "applied" at $0, unexplained).
  const promoCodeRejections = useMemo<Record<string, string>>(() => {
    if (!rejection) return {};
    const key =
      ELIGIBILITY_REJECTION_KEYS[rejection.message] ??
      (promoCodes.length === 1
        ? PRUNING_REJECTION_KEYS[rejection.message]
        : undefined);
    return key ? { [normalizeCode(rejection.code)]: key } : {};
  }, [rejection, promoCodes.length]);

  // ── Rejection pruning. Two failure modes:
  //   1. Soft rejection — preview succeeds, but a subset of supplied codes
  //      don't appear in `applications`. Rare; today the server throws on
  //      any rejection rather than returning a partial result.
  //   2. Hard rejection — preview throws. Only a PRUNING rejection (see
  //      `PRUNING_REJECTION_CODES`) drops a code, and only with more than one
  //      code queued; eligibility rejections keep theirs (see above).
  // Per-code dedupe so a re-render doesn't double-toast / double-prune. A
  // code the buyer applies AGAIN is cleared from it, so a second rejection of
  // a re-added code prunes it again instead of leaving the preview in error.
  const announcedRejectionsRef = useRef<Set<string>>(new Set());
  const previousCodesRef = useRef<string[]>(promoCodes);
  useEffect(() => {
    const before = new Set(previousCodesRef.current.map(normalizeCode));
    for (const code of promoCodes) {
      const normalized = normalizeCode(code);
      if (!before.has(normalized)) {
        announcedRejectionsRef.current.delete(normalized);
      }
    }
    previousCodesRef.current = promoCodes;

    if (promoCodes.length === 0) return;
    // Never prune off a paused (stale) preview — see `paused`.
    if (paused) return;

    if (rejection) {
      const reasonKey = PRUNING_REJECTION_KEYS[rejection.message];
      if (promoCodes.length > 1 && reasonKey) {
        const normalized = normalizeCode(rejection.code);
        if (announcedRejectionsRef.current.has(normalized)) return;
        announcedRejectionsRef.current.add(normalized);
        onRemovePromoCode(rejection.code);
        // Never silently: say which code went and why (existing copy).
        toast.warning(`${normalized}: ${String(t(reasonKey))}`, {
          title: String(t("checkout.promoCodeRemovedTitle")),
        });
      }
      return;
    }

    if (!livePromoApplications) return;
    // Placeholder data is the PREVIOUS input's result (see `placeholderData`):
    // a code the buyer just added is naturally absent from it, and treating
    // that as a rejection would prune the code before it was even previewed.
    if (livePromoPreviewQuery.isPlaceholderData) return;
    const accepted = new Set(
      livePromoApplications.map((a) => a.normalizedCode),
    );
    const rejected = promoCodes.filter((c) => !accepted.has(normalizeCode(c)));
    if (rejected.length === 0) return;
    for (const code of rejected) {
      const normalized = normalizeCode(code);
      if (announcedRejectionsRef.current.has(normalized)) continue;
      announcedRejectionsRef.current.add(normalized);
      toast.warning(
        `${normalized} couldn't be combined with your other promo codes.`,
        { title: "PROMO NOT APPLIED" },
      );
    }
    onRemovePromoCode(rejected[0]!);
  }, [
    livePromoApplications,
    livePromoPreviewQuery.isPlaceholderData,
    rejection,
    paused,
    promoCodes,
    onRemovePromoCode,
    toast,
    t,
  ]);

  return {
    livePromoDiscountCents,
    livePromoFeeReductionCents,
    liveHeldCartFees,
    memberDiscounts,
    promoCodeRejections,
    promoPreviewUnavailable,
    urlPromoCheckUnavailable,
  };
}
