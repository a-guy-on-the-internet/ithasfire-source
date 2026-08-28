/**
 * Sell screen — POS Tap to Pay + Cash flow (spec FR-001..FR-015).
 *
 * Wired to:
 *   - `pos.recordCashSale` (tRPC mutation) — full cash + comp path
 *   - `pos.startSale` (tRPC mutation) — begins card flow, returns clientSecret
 *   - `pos.completeSale` (tRPC query) — polls for finalised state
 *   - `pos.connectionToken` — minted via createConnectionTokenProvider()
 *   - `promos.preview` — door-priced discount quote (see promo-entry.ts)
 *
 * The Stripe Terminal collection flow lives in <TapToPaySurface>, which
 * sell-tab-screen.tsx mounts inside <StripeTerminalProvider>.
 *
 * Promo quotes are ADVISORY. The server re-evaluates every code when the sale
 * posts, so a code can still be rejected at `startSale` / `recordCashSale`
 * time (revoked, or it hit its cap between the quote and the tap) — those
 * land in `saleError`, not in the promo block.
 *
 * Anti-tipping disclosure (FR-014): the disclosure copy is exported as a
 * locked constant — DO NOT inline-edit. The spec stance is part of the
 * product, not a runtime configurable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { formatOrderCode } from "@th/types";
import { Text } from "@th/ui";

import { binarySupportsTapToPay } from "../../lib/capabilities";
import { trpc } from "../../trpc";
import {
  SquarePrimaryButton,
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import {
  DEFAULT_SIMULATED_TEST_CARD,
  DevSimulatedCardPicker,
} from "./dev-simulated-card-picker";
import {
  EMPTY_PROMO_STATE,
  MAX_PROMO_CODES,
  cartKeyOf,
  createPromoController,
  normalizePromoCode,
  promoCodesForSale,
  saleErrorMessage,
  selectCartTotals,
  type PromoContext,
  type PromoController,
  type PromoState,
  type PromoTicketSelection,
} from "./promo-entry";
import { TapToPaySurface } from "./tap-to-pay-surface";

type CashSaleResult = {
  orderId: string;
  ticketCount: number;
  ticketCodes: string[];
  /** Seat labels in admission order; empty for unseated sales. */
  seatLabels: string[];
  /** What the operator actually collected — may differ from what was due. */
  amountCents: number;
  /** Promo discount the server applied, 0 when no codes were sent. */
  discountCents: number;
  /** Door total − discount. The operator is free to collect something else. */
  expectedDueCents: number;
  isComp: boolean;
  autoAdmitted: boolean;
};

type StartPosSaleResult = {
  orderId: string;
  clientSecret: string;
  /** NET of any promo discount — this is what the card is charged. */
  amountCents: number;
  discountCents: number;
  currency: string;
};

// tRPC infers the mutation return type from the router, but historically
// the sell-screen call sites cast through `unknown` to a hand-rolled
// shape. If the server ever drifts (extra field types, new variants,
// missing required field) the cast silently passes garbage to setStage.
// These tiny predicates validate the shape at runtime and throw a clear
// error before the bad data reaches React state. Cheaper than pulling
// the Zod schemas from @th/core for a dep we don't otherwise need.
function isStartPosSaleResult(value: unknown): value is StartPosSaleResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orderId === "string" &&
    typeof v.clientSecret === "string" &&
    typeof v.amountCents === "number" &&
    typeof v.discountCents === "number" &&
    typeof v.currency === "string"
  );
}

function isCashSaleResult(value: unknown): value is CashSaleResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orderId === "string" &&
    typeof v.ticketCount === "number" &&
    Array.isArray(v.ticketCodes) &&
    Array.isArray(v.seatLabels) &&
    typeof v.amountCents === "number" &&
    typeof v.discountCents === "number" &&
    typeof v.expectedDueCents === "number" &&
    typeof v.isComp === "boolean" &&
    typeof v.autoAdmitted === "boolean"
  );
}

/**
 * Integer-cents → "12.34" dollars string. Avoids float drift from
 * `cents / 100`; the trailing two digits are always present so the
 * input field never bounces between "10" and "10.00" between renders.
 */
function formatCentsAsDollars(cents: number): string {
  const safe = Math.max(0, Math.round(cents));
  const whole = Math.floor(safe / 100);
  const frac = safe % 100;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

/** FR-014 locked anti-tipping copy. Renders on every sale surface. */
export const POS_NO_TIP_DISCLOSURE =
  "We don't tip. Tipping is a mechanism for the rich to avoid paying their workers a living wage. The price you see is the price you pay; our staff are paid by us, not you.";

const POS_NO_TIP_SUMMARY =
  "No tips are collected. The posted price is the price paid.";

type TicketTypeRow = {
  id: string;
  name: string;
  unitPriceCents: number;
  capacityRemaining: number;
  /**
   * Per-tier sales-window state (time-based-ticket-pricing FR-010), already
   * turned into operator copy by `describeSaleState`. Optional: absent means
   * sellable, which is the pre-FR-010 behaviour and what every unwindowed tier
   * gets. SURFACING ONLY — `pos.startSale` / `pos.recordCashSale` re-check
   * server-side and are the only thing that may refuse a sale.
   */
  saleState?: { isSellable: boolean; note: string | null };
};

type CartLine = { ticketTypeId: string; qty: number };

/** Card-path result — the Terminal SDK only hands back an orderId. */
type CardSaleResult = { orderId: string; discountCents: number };

type Stage =
  | { kind: "browse" }
  | {
      kind: "cash-confirm";
      defaultAmountCents: number;
      /** Snapshotted with the amount so the sheet confirms one atomic quote. */
      promoCodes: string[] | undefined;
    }
  | {
      kind: "tap-to-pay";
      orderId: string;
      clientSecret: string;
      amountCents: number;
      discountCents: number;
    }
  | { kind: "result"; result: CashSaleResult | CardSaleResult };

export type SellScreenProps = {
  eventId: string;
  /**
   * Door-sellable TicketTypes for this event. The caller composes this
   * list (typically from `events.getEventTicketTypes` or similar) so
   * this screen stays pure-presentational.
   */
  ticketTypes: TicketTypeRow[];
  /** Generates a unique idempotency key per Charge press. */
  newClientKey: () => string;
  /**
   * Stripe Terminal Location ID (`tml_...`) on the platform account.
   * Threaded through to the TapToPaySurface so the SDK can connect.
   * When omitted, Tap to Pay surfaces a clear configuration error
   * (the Sell screen still works for cash).
   */
  tapToPayLocationId?: string;
};

export function SellScreen({
  eventId,
  ticketTypes,
  newClientKey,
  tapToPayLocationId,
}: SellScreenProps) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [stage, setStage] = useState<Stage>({ kind: "browse" });
  const [isStartingTapToPay, setIsStartingTapToPay] = useState(false);
  const [simulatedTestCard, setSimulatedTestCard] = useState<string>(
    DEFAULT_SIMULATED_TEST_CARD,
  );
  // Ref blocks same-tick double taps; state drives the visible loading UI.
  const startingTapToPayRef = useRef(false);
  const recordCash = trpc.pos.recordCashSale.useMutation();
  const startSale = trpc.pos.startSale.useMutation();

  // ── Promo codes ────────────────────────────────────────────────────────
  const [promo, setPromo] = useState<PromoState>(EMPTY_PROMO_STATE);
  const [promoInput, setPromoInput] = useState("");
  /** Server-side sale failure (incl. promo re-validation at sale time). */
  const [saleError, setSaleError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  // The tRPC client is provider-stable, but read it through a ref so the
  // controller (created once) never closes over a stale utils object.
  const utilsRef = useRef(utils);
  useEffect(() => {
    utilsRef.current = utils;
  }, [utils]);
  // Latest cart, for the controller's settle-time staleness reconcile. Kept
  // in a ref because the controller is created once and must never close over
  // a stale cart. Updated in the sync effect below, before syncCart runs.
  const promoContextRef = useRef<PromoContext>({ eventId, selections: [] });
  const promoControllerRef = useRef<PromoController | null>(null);
  if (promoControllerRef.current === null) {
    promoControllerRef.current = createPromoController({
      // `promos.preview` is a publicProcedure QUERY. Going through
      // `utils.client` rather than a react-query hook keeps it imperative
      // (no cache, no staleTime) so an Apply press always hits the server
      // and errors surface as thrown rejections we can render inline.
      preview: (request) =>
        utilsRef.current.client.promos.preview.query(request),
      onChange: setPromo,
      getCart: () => promoContextRef.current,
    });
  }
  const promoController = promoControllerRef.current;
  useEffect(() => () => promoControllerRef.current?.dispose(), []);

  const cartByTicketType = useMemo(() => {
    const m = new Map<string, number>();
    for (const line of cart)
      m.set(line.ticketTypeId, (m.get(line.ticketTypeId) ?? 0) + line.qty);
    return m;
  }, [cart]);

  const cartTotalCents = useMemo(
    () =>
      cart.reduce((sum, line) => {
        const tt = ticketTypes.find((t) => t.id === line.ticketTypeId);
        return sum + (tt?.unitPriceCents ?? 0) * line.qty;
      }, 0),
    [cart, ticketTypes],
  );

  const cartCount = cart.reduce((n, l) => n + l.qty, 0);
  const tapToPayStartBlocked = isStartingTapToPay || startSale.isPending;

  const selections = useMemo<PromoTicketSelection[]>(
    () => cart.map((l) => ({ ticketTypeId: l.ticketTypeId, qty: l.qty })),
    [cart],
  );
  const cartKey = useMemo(() => cartKeyOf(selections), [selections]);
  const promoContext = useMemo(
    () => ({ eventId, selections }),
    [eventId, selections],
  );

  // The discount depends on the cart — PERCENT promos scale with it,
  // TICKET_TYPE-scoped promos only match certain lines, and min-order rules
  // start/stop applying. Every cart mutation therefore re-previews (debounced
  // inside the controller); a stale discount next to a cash button is a money
  // bug, not a cosmetic one.
  useEffect(() => {
    promoContextRef.current = promoContext;
    promoController.syncCart(promoContext);
  }, [promoController, promoContext]);

  // Switching events must not carry a cart or a validated discount across:
  // the codes were quoted against the previous event's ticket types, and the
  // screen would show a settled-looking discount for the wrong show.
  useEffect(() => {
    setCart([]);
    setPromoInput("");
    setSaleError(null);
    promoController.reset();
    setStage({ kind: "browse" });
  }, [eventId, promoController]);

  const totals = selectCartTotals({
    subtotalCents: cartTotalCents,
    cartKey,
    promo,
  });
  // Blocks the sale CTAs whenever the number on screen isn't a proven quote.
  const promoUnsettled = promo.isPreviewing || totals.isStale;
  const promoCodes = promoCodesForSale(promo);
  // A promo that wipes the cart is a comp, not a card sale — Stripe can't
  // charge $0, so `startPosSale` throws AMOUNT_MUST_BE_POSITIVE. A cart of
  // genuinely free ticket types hits the same disable without this copy.
  const discountZeroedTotal =
    cartCount > 0 && totals.discountCents > 0 && totals.totalCents === 0;

  const onApplyPromo = useCallback(() => {
    const code = normalizePromoCode(promoInput);
    if (code === "") return; // empty / whitespace does nothing
    void (async () => {
      await promoController.apply(code, promoContext);
      // Clear only once the code actually landed — a rejected code stays in
      // the field so the operator can fix a typo instead of retyping it.
      if (promoController.getState().codes.includes(code)) setPromoInput("");
    })();
  }, [promoController, promoContext, promoInput]);

  const onRemovePromo = useCallback(
    (code: string) => {
      void promoController.remove(code, promoContext);
    },
    [promoController, promoContext],
  );

  const adjust = (ticketTypeId: string, delta: number) => {
    // The banner described the cart that just changed — "sold out" from the
    // previous attempt shouldn't hang over a different cart.
    setSaleError(null);
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.ticketTypeId === ticketTypeId);
      if (idx === -1) {
        if (delta <= 0) return prev;
        return [...prev, { ticketTypeId, qty: delta }];
      }
      const next = [...prev];
      const newQty = (next[idx]?.qty ?? 0) + delta;
      if (newQty <= 0) {
        next.splice(idx, 1);
      } else {
        next[idx] = { ticketTypeId, qty: newQty };
      }
      return next;
    });
  };

  /**
   * Everything a completed sale must leave behind. A promo code surviving
   * into the next walk-up's sale would silently discount a stranger.
   */
  const clearSaleState = () => {
    setCart([]);
    setPromoInput("");
    setSaleError(null);
    promoController.reset();
  };

  /**
   * A FRESH idempotency key per attempt — deliberately not memoised across a
   * failed sale, despite that looking like the obvious retry-safety win.
   *
   * `idempotency.fail()` does not release the key: it writes a `failed` record
   * that lives for 15 minutes (redis-adapter.ts / prisma-adapter.ts), and
   * `begin()` is SET-NX / reclaim-only-once-expired. So a retry carrying the
   * same key gets `begin() === false`, and `get()` returns null because the
   * record is `failed` rather than `succeeded` — the use case then throws
   * IDEMPOTENCY_LOCK_IN_PROGRESS. Reusing the key would therefore make every
   * failed sale unretryable for 15 minutes, at a door, with a queue.
   *
   * The residual risk this leaves — a response lost AFTER the server
   * succeeded, where a retry mints a second order — is pre-existing and needs
   * a server-side fix (release the key on failure, or reclaim `failed` rows in
   * `begin`), not a client-side key cache.
   */
  const saleClientKey = () => newClientKey();

  const onTapToPay = async () => {
    if (!binarySupportsTapToPay()) return; // button is hidden in this case
    // A discount that zeroes the cart makes startPosSale throw
    // AMOUNT_MUST_BE_POSITIVE (Stripe cannot charge $0). Cash handles those.
    if (totals.totalCents <= 0) return;
    if (promoUnsettled) return; // never charge against an unproven quote
    if (startingTapToPayRef.current || startSale.isPending) return;
    startingTapToPayRef.current = true;
    setIsStartingTapToPay(true);
    setSaleError(null);
    try {
      const raw = await startSale.mutateAsync({
        eventId,
        // Fresh key every attempt — see saleClientKey() for why reusing one
        // across a failure would brick this screen for 15 minutes.
        clientKey: saleClientKey(),
        items: cart.map((l) => ({ ticketTypeId: l.ticketTypeId, qty: l.qty })),
        ...(promoCodes ? { promoCodes } : {}),
      });
      if (!isStartPosSaleResult(raw)) {
        throw new Error(
          "Unexpected startSale response — server contract drifted; not advancing to tap-to-pay.",
        );
      }
      setStage({
        kind: "tap-to-pay",
        orderId: raw.orderId,
        clientSecret: raw.clientSecret,
        amountCents: raw.amountCents,
        discountCents: raw.discountCents,
      });
    } catch (err) {
      // The server re-evaluates promo codes at sale time, so a code revoked or
      // capped between preview and tap lands HERE. Without this the operator
      // sees a spinner flash and nothing at all.
      setSaleError(saleErrorMessage(err));
    } finally {
      startingTapToPayRef.current = false;
      setIsStartingTapToPay(false);
    }
  };

  const onCashStart = () => {
    if (promoUnsettled) return;
    // Snapshot BOTH the amount and the codes: the sheet must confirm one
    // atomic quote. Reading codes live at confirm time meant a debounced
    // re-preview could drop them after the sheet opened, posting the sale
    // with no codes while the sheet still showed the discounted amount.
    setSaleError(null);
    setStage({
      kind: "cash-confirm",
      defaultAmountCents: totals.totalCents,
      promoCodes,
    });
  };

  const onCashConfirm = async (
    amountCollectedCents: number,
    confirmedPromoCodes: string[] | undefined,
  ) => {
    setSaleError(null);
    try {
      const raw = await recordCash.mutateAsync({
        eventId,
        clientKey: saleClientKey(),
        items: cart.map((l) => ({ ticketTypeId: l.ticketTypeId, qty: l.qty })),
        amountCollectedCents,
        ...(confirmedPromoCodes ? { promoCodes: confirmedPromoCodes } : {}),
      });
      if (!isCashSaleResult(raw)) {
        throw new Error(
          "Unexpected recordCashSale response — server contract drifted; not opening the result view.",
        );
      }
      clearSaleState();
      setStage({ kind: "result", result: raw });
    } catch (err) {
      setSaleError(saleErrorMessage(err));
      setStage({ kind: "browse" });
    }
  };

  const onResetForNextSale = () => {
    clearSaleState();
    setStage({ kind: "browse" });
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {stage.kind === "browse" && (
        <>
          <Text
            variant="body"
            weight="bold"
            letterSpacing={2}
            textTransform="uppercase"
            style={styles.sectionLabel}
          >
            Sell
          </Text>
          {ticketTypes.length === 0 && (
            <Text
              variant="body"
              color={colors.colorMuted}
              testID="sell-empty-state"
            >
              No ticket types are currently on sale for this event.
            </Text>
          )}
          {ticketTypes.map((tt) => {
            const inCart = cartByTicketType.get(tt.id) ?? 0;
            // FR-010: a tier outside its sales window can never be added. The
            // server refuses it anyway; this stops the operator finding out at
            // the card reader. Deliberately ORed with capacity rather than
            // merged upstream — "sold out" and "not on sale yet" are separate
            // facts and a tier can be both.
            const isSellable = tt.saleState?.isSellable !== false;
            const atCapacity = !isSellable || inCart >= tt.capacityRemaining;
            return (
              <View
                key={tt.id}
                style={[styles.row, !isSellable && styles.rowUnavailable]}
                testID={`sell-door-item-${tt.id}`}
              >
                <View style={styles.rowMain}>
                  <Text variant="body" weight="bold" style={styles.ttName}>
                    {tt.name}
                  </Text>
                  <Text variant="bodySmall" color={colors.colorMuted}>
                    ${formatCentsAsDollars(tt.unitPriceCents)} ·{" "}
                    {tt.capacityRemaining} left
                  </Text>
                  {tt.saleState?.note && (
                    <Text
                      variant="bodySmall"
                      weight="bold"
                      color={colors.colorMuted}
                      testID={`sell-door-item-state-${tt.id}`}
                    >
                      {tt.saleState.note}
                    </Text>
                  )}
                </View>
                <View style={styles.stepper}>
                  <Pressable
                    accessibilityLabel={`Remove one ${tt.name}`}
                    accessibilityRole="button"
                    onPress={() => adjust(tt.id, -1)}
                    style={({ pressed }) => [
                      styles.stepperBtn,
                      pressed && inCart > 0 && styles.stepperBtnPressed,
                      inCart === 0 && styles.stepperBtnDisabled,
                    ]}
                    disabled={inCart === 0}
                  >
                    {({ pressed }) => (
                      <Text
                        variant="body"
                        weight="bold"
                        style={[
                          styles.stepperBtnText,
                          pressed &&
                            !(inCart === 0) &&
                            styles.stepperBtnTextPressed,
                          inCart === 0 && styles.stepperBtnTextDisabled,
                        ]}
                      >
                        −
                      </Text>
                    )}
                  </Pressable>
                  <Text variant="body" weight="bold" style={styles.stepperQty}>
                    {inCart}
                  </Text>
                  <Pressable
                    accessibilityLabel={`Add one ${tt.name}`}
                    accessibilityRole="button"
                    onPress={() => adjust(tt.id, 1)}
                    style={({ pressed }) => [
                      styles.stepperBtn,
                      pressed && !atCapacity && styles.stepperBtnPressed,
                      atCapacity && styles.stepperBtnDisabled,
                    ]}
                    disabled={atCapacity}
                  >
                    {({ pressed }) => (
                      <Text
                        variant="body"
                        weight="bold"
                        style={[
                          styles.stepperBtnText,
                          pressed &&
                            !atCapacity &&
                            styles.stepperBtnTextPressed,
                          atCapacity && styles.stepperBtnTextDisabled,
                        ]}
                      >
                        +
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            );
          })}

          <View style={styles.cartFooter}>
            <View style={styles.cartLine} testID="sell-cart-subtotal">
              <Text
                variant="bodySmall"
                weight="bold"
                letterSpacing={1.5}
                textTransform="uppercase"
                color={colors.colorMuted}
              >
                Subtotal · {cartCount} item{cartCount === 1 ? "" : "s"}
              </Text>
              <Text variant="body" weight="bold" style={styles.cartLineAmount}>
                ${formatCentsAsDollars(cartTotalCents)}
              </Text>
            </View>

            {/* Suppressed while unsettled: the rows come from the LAST quote
                while the subtotal is already live, so rendering both would
                show three numbers that don't add up — with the total in 28pt.
                Better to show no discount than arithmetic that lies. */}
            {promo.applications.length > 0 && !promoUnsettled && (
              <View
                style={styles.cartDiscountBlock}
                testID="sell-promo-discount"
              >
                {promo.applications.map((application) => (
                  <View key={application.promoId} style={styles.cartLine}>
                    <Text
                      variant="bodySmall"
                      weight="bold"
                      letterSpacing={1.5}
                      textTransform="uppercase"
                      color={colors.accentText}
                    >
                      {application.normalizedCode}
                    </Text>
                    <Text
                      variant="body"
                      weight="bold"
                      style={styles.cartDiscountAmount}
                    >
                      −${formatCentsAsDollars(application.discountCents)}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.cartTotalLine} testID="sell-cart-total">
              <Text
                variant="bodySmall"
                weight="bold"
                letterSpacing={1.5}
                textTransform="uppercase"
                color={colors.colorMuted}
              >
                {promoUnsettled ? "Total · updating" : "Total"}
              </Text>
              <Text variant="body" weight="bold" style={styles.cartTotalAmount}>
                {promoUnsettled
                  ? "—"
                  : `$${formatCentsAsDollars(totals.totalCents)}`}
              </Text>
            </View>
          </View>

          <PromoEntry
            state={promo}
            value={promoInput}
            onChangeValue={setPromoInput}
            onApply={onApplyPromo}
            onRemove={onRemovePromo}
            canApply={cartCount > 0}
          />

          {saleError !== null && (
            <View
              style={styles.saleError}
              accessibilityLiveRegion="polite"
              testID="sell-sale-error"
            >
              <Text variant="bodySmall" weight="bold" color={colors.dangerSoft}>
                {saleError}
              </Text>
            </View>
          )}

          {binarySupportsTapToPay() && (
            <DevSimulatedCardPicker
              selected={simulatedTestCard}
              onSelect={setSimulatedTestCard}
            />
          )}

          <View style={styles.ctaRow}>
            {binarySupportsTapToPay() && (
              <View style={styles.ctaSlot}>
                {tapToPayStartBlocked ? (
                  <View style={styles.ctaPending}>
                    <ActivityIndicator color={colors.color} />
                  </View>
                ) : (
                  <SquarePrimaryButton
                    testID="sell-tap-to-pay-button"
                    label="Tap to Pay"
                    onPress={onTapToPay}
                    // `totals.totalCents` (post-discount), not the raw cart:
                    // a promo that zeroes the total makes the card path throw
                    // AMOUNT_MUST_BE_POSITIVE server-side.
                    disabled={
                      cartCount === 0 ||
                      totals.totalCents === 0 ||
                      promoUnsettled ||
                      tapToPayStartBlocked
                    }
                    accessibilityHint={
                      discountZeroedTotal
                        ? "Total is zero after the discount. Use Cash to record a comp."
                        : undefined
                    }
                  />
                )}
              </View>
            )}
            <View style={styles.ctaSlot}>
              <SquareSecondaryButton
                testID="sell-cash-button"
                label="Cash"
                onPress={onCashStart}
                disabled={cartCount === 0 || promoUnsettled}
              />
            </View>
          </View>

          {discountZeroedTotal && (
            <Text
              variant="bodySmall"
              color={colors.colorMuted}
              testID="sell-zero-total-hint"
            >
              The discount covers the whole cart. Use Cash to record it as a $0
              comp — a card can't be charged for nothing.
            </Text>
          )}

          <NoTipDisclosure testID="sell-no-tip-disclosure" />
        </>
      )}

      {stage.kind === "cash-confirm" && (
        <CashConfirmSheet
          defaultAmountCents={stage.defaultAmountCents}
          promoCodes={stage.promoCodes}
          isPending={recordCash.isPending}
          onConfirm={onCashConfirm}
          onCancel={() => setStage({ kind: "browse" })}
        />
      )}

      {stage.kind === "tap-to-pay" && (
        <TapToPaySurface
          orderId={stage.orderId}
          clientSecret={stage.clientSecret}
          amountCents={stage.amountCents}
          locationId={tapToPayLocationId}
          simulatedTestCardNumber={simulatedTestCard}
          onSuccess={(orderId: string) => {
            // The discount the server quoted at startSale; the SDK only
            // hands back an orderId.
            const discountCents = stage.discountCents;
            clearSaleState();
            setStage({ kind: "result", result: { orderId, discountCents } });
          }}
          onCancel={() => setStage({ kind: "browse" })}
        />
      )}

      {stage.kind === "result" && (
        <SaleResultView result={stage.result} onNext={onResetForNextSale} />
      )}
    </ScrollView>
  );
}

/**
 * Promo-code entry for the browse stage: an input + Apply, and a removable
 * chip per applied code showing what it took off. Presentational only — all
 * validation, previewing and staleness live in `promo-entry.ts`.
 */
function PromoEntry({
  state,
  value,
  onChangeValue,
  onApply,
  onRemove,
  canApply,
}: {
  state: PromoState;
  value: string;
  onChangeValue: (next: string) => void;
  onApply: () => void;
  onRemove: (code: string) => void;
  canApply: boolean;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const atMax = state.codes.length >= MAX_PROMO_CODES;
  const applyDisabled =
    !canApply || state.isPreviewing || value.trim().length === 0;

  return (
    <View style={styles.promoBlock} testID="sell-promo-block">
      <Text
        variant="bodySmall"
        weight="bold"
        letterSpacing={1.5}
        textTransform="uppercase"
        color={colors.colorMuted}
      >
        Promo code
      </Text>

      {state.codes.length > 0 && (
        <View style={styles.promoChipRow}>
          {state.codes.map((code) => {
            const application = state.applications.find(
              (entry) => entry.normalizedCode === code,
            );
            return (
              <View
                key={code}
                style={styles.promoChip}
                testID={`sell-promo-chip-${code}`}
              >
                <Text
                  variant="bodySmall"
                  weight="bold"
                  style={styles.promoChipCode}
                >
                  {code}
                </Text>
                {application && (
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    style={styles.promoChipAmount}
                  >
                    −${formatCentsAsDollars(application.discountCents)}
                  </Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove promo code ${code}`}
                  testID={`sell-promo-remove-${code}`}
                  onPress={() => onRemove(code)}
                  style={({ pressed }) => [
                    styles.promoChipRemove,
                    pressed && styles.promoChipRemovePressed,
                  ]}
                >
                  {({ pressed }) => (
                    <Text
                      variant="body"
                      weight="bold"
                      style={[
                        styles.promoChipRemoveGlyph,
                        pressed && styles.promoChipRemoveGlyphPressed,
                      ]}
                    >
                      ×
                    </Text>
                  )}
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      {!atMax && (
        <View style={styles.promoEntryRow}>
          <TextInput
            // Distinct from the "Promo code" heading above so VoiceOver
            // doesn't announce the same name twice in a row.
            accessibilityLabel="promo code to apply"
            testID="sell-promo-input"
            value={value}
            onChangeText={onChangeValue}
            // Guarded: an unguarded keyboard "done" during an in-flight apply
            // would invalidate the first candidate code silently.
            onSubmitEditing={() => {
              if (!applyDisabled) onApply();
            }}
            // The server caps a code at 64 chars; without this a long paste
            // returns a Zod issue dump instead of a promo error.
            maxLength={64}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            returnKeyType="done"
            style={styles.promoInput}
            placeholder="ENTER CODE"
            placeholderTextColor={colors.placeholder}
          />
          <View style={styles.promoApplySlot}>
            {state.isPreviewing ? (
              <View style={styles.promoApplyPending}>
                <ActivityIndicator color={colors.color} />
              </View>
            ) : (
              <SquareSecondaryButton
                testID="sell-promo-apply-button"
                label="Apply"
                accessibilityLabel="Apply promo code"
                onPress={onApply}
                disabled={applyDisabled}
              />
            )}
          </View>
        </View>
      )}

      {atMax && (
        <Text variant="caption" color={colors.colorMuted}>
          Maximum of {MAX_PROMO_CODES} codes per sale.
        </Text>
      )}

      {state.error !== null && (
        <View
          style={styles.promoError}
          accessibilityLiveRegion="polite"
          testID="sell-promo-error"
        >
          {/* `dangerSoft`, not `danger` — the latter is the GRAPHIC rung
              (4.17:1) and is only used for this block's border. */}
          <Text variant="bodySmall" weight="bold" color={colors.dangerSoft}>
            {state.error}
          </Text>
        </View>
      )}
    </View>
  );
}

function CashConfirmSheet({
  defaultAmountCents,
  promoCodes,
  isPending,
  onConfirm,
  onCancel,
}: {
  defaultAmountCents: number;
  /** Snapshotted at open — confirmed verbatim, never re-read from live state. */
  promoCodes: string[] | undefined;
  isPending: boolean;
  onConfirm: (
    amountCents: number,
    promoCodes: string[] | undefined,
  ) => void | Promise<void>;
  onCancel: () => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  // Editable amount as a string for input UX; converts on confirm.
  // Seed from integer cents to avoid float-drift surprises like $19.99
  // showing up as 19.989999… after a round-trip through Number.
  const [amountStr, setAmountStr] = useState(
    formatCentsAsDollars(defaultAmountCents),
  );
  const [localPending, setLocalPending] = useState(false);
  const submitRef = useRef(false);
  const parsed = Math.max(0, Math.round(parseFloat(amountStr || "0") * 100));
  const isComp = parsed === 0;
  const submitDisabled = isPending || localPending;
  const differsFromCart =
    parsed !== defaultAmountCents && defaultAmountCents > 0 && parsed > 0;
  const quickAmounts = useMemo(() => {
    // Dedupe: a 0/5/10/20 cart total should never produce a duplicate chip.
    const cents = [0, 500, 1_000, 2_000];
    if (defaultAmountCents > 0 && !cents.includes(defaultAmountCents)) {
      cents.push(defaultAmountCents);
    }
    return Array.from(new Set(cents));
  }, [defaultAmountCents]);

  const handleConfirm = () => {
    if (submitRef.current || isPending) return;
    submitRef.current = true;
    setLocalPending(true);
    void (async () => {
      try {
        await onConfirm(parsed, promoCodes);
      } catch {
        submitRef.current = false;
        setLocalPending(false);
      }
    })();
  };

  return (
    <View style={styles.sheet}>
      <Text
        variant="body"
        weight="bold"
        letterSpacing={2}
        textTransform="uppercase"
        style={styles.sectionLabel}
      >
        Cash collected
      </Text>

      <View style={styles.amountField}>
        <View style={styles.amountCurrencySlot}>
          <Text variant="body" weight="bold" style={styles.amountCurrency}>
            $
          </Text>
        </View>
        <TextInput
          accessibilityLabel="cash amount in dollars"
          testID="sell-cash-amount-input"
          value={amountStr}
          onChangeText={(next) => {
            // Allow only digits + a single decimal point, max 2 decimals.
            const cleaned = next.replace(/[^0-9.]/g, "");
            const parts = cleaned.split(".");
            const normalised =
              parts.length <= 1
                ? cleaned
                : `${parts[0]}.${parts.slice(1).join("").slice(0, 2)}`;
            setAmountStr(normalised);
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          autoFocus
          selectTextOnFocus
          style={styles.amountInput}
          placeholder="0.00"
          placeholderTextColor={colors.placeholder}
        />
      </View>

      <View style={styles.chipRow}>
        {quickAmounts.map((cents) => {
          const active = parsed === cents;
          return (
            <Pressable
              key={cents}
              onPress={() => setAmountStr(formatCentsAsDollars(cents))}
              accessibilityRole="button"
              accessibilityLabel={`set amount to ${formatCentsAsDollars(cents)} dollars`}
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [
                styles.chip,
                (active || pressed) && styles.chipActive,
              ]}
            >
              <Text
                variant="bodySmall"
                weight="bold"
                color={active ? colors.color : colors.colorMuted}
                style={styles.chipText}
              >
                ${formatCentsAsDollars(cents)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {differsFromCart && (
        <View style={styles.cartDiff} testID="sell-cash-diff-banner">
          <Text
            variant="bodySmall"
            weight="bold"
            letterSpacing={1.5}
            textTransform="uppercase"
            color={colors.support}
          >
            Off cart
          </Text>
          <Text
            variant="bodySmall"
            color={colors.colorMuted}
            style={styles.cartDiffBody}
          >
            Cart is ${formatCentsAsDollars(defaultAmountCents)}. You're
            recording ${formatCentsAsDollars(parsed)}.
          </Text>
        </View>
      )}

      {isComp && (
        <View style={styles.compBadge} testID="sell-cash-comp-banner">
          <Text
            variant="bodySmall"
            weight="bold"
            letterSpacing={1.5}
            textTransform="uppercase"
            color={colors.accent}
          >
            Comp ticket
          </Text>
          <Text
            variant="bodySmall"
            color={colors.colorMuted}
            style={styles.compBadgeBody}
          >
            $0 collected. Operator will appear on the comp audit.
          </Text>
        </View>
      )}

      <NoTipDisclosure />

      <View style={styles.ctaRow}>
        <View style={styles.ctaSlot}>
          {submitDisabled ? (
            <View style={styles.ctaPending}>
              <ActivityIndicator color={colors.color} />
            </View>
          ) : (
            <SquarePrimaryButton
              testID="sell-cash-confirm-button"
              label={isComp ? "Comp ticket" : "Confirm cash"}
              onPress={handleConfirm}
            />
          )}
        </View>
        <View style={styles.ctaSlot}>
          <SquareSecondaryButton
            testID="sell-cash-back-button"
            label="Back"
            onPress={onCancel}
            disabled={submitDisabled}
          />
        </View>
      </View>
    </View>
  );
}

function SaleResultView({
  result,
  onNext,
}: {
  result: CashSaleResult | CardSaleResult;
  onNext: () => void;
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const cashResult = "ticketCount" in result ? result : null;
  const seatLabels = cashResult?.seatLabels ?? [];
  const discountCents = result.discountCents;
  // Legitimate, not an error: the operator can negotiate or short-collect at
  // the door. Both numbers are shown so the reconciliation is on the receipt
  // surface rather than a surprise in the settlement report.
  const collectedOffDue =
    cashResult !== null &&
    !cashResult.isComp &&
    cashResult.amountCents !== cashResult.expectedDueCents;

  return (
    <View style={styles.resultRoot}>
      <Text style={styles.admitH1}>ADMIT</Text>

      {cashResult && (
        <Text variant="body" weight="bold" style={styles.admitSubtitle}>
          {cashResult.ticketCount} ticket
          {cashResult.ticketCount === 1 ? "" : "s"} ·{" "}
          {cashResult.isComp
            ? "Comp"
            : `$${formatCentsAsDollars(cashResult.amountCents)} cash`}
        </Text>
      )}

      {discountCents > 0 && (
        <Text
          variant="bodySmall"
          weight="bold"
          color={colors.accentText}
          testID="sell-result-discount"
        >
          Discount applied −${formatCentsAsDollars(discountCents)}
        </Text>
      )}

      {collectedOffDue && (
        <Text
          variant="bodySmall"
          color={colors.colorMuted}
          testID="sell-result-collected-off-due"
        >
          Due ${formatCentsAsDollars(cashResult.expectedDueCents)} · collected $
          {formatCentsAsDollars(cashResult.amountCents)}
        </Text>
      )}

      {seatLabels.length > 0 && (
        <View style={styles.seatBlock} testID="sell-result-seats">
          <Text
            variant="bodySmall"
            weight="bold"
            letterSpacing={2}
            textTransform="uppercase"
            color={colors.colorMuted}
          >
            Seats
          </Text>
          <View style={styles.seatRow}>
            {seatLabels.map((label) => (
              <View key={label} style={styles.seatTag}>
                <Text variant="body" weight="bold" style={styles.seatTagText}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <Text variant="caption" color={colors.colorMuted} style={styles.orderRef}>
        Order #{formatOrderCode(result.orderId)}
      </Text>

      <View style={styles.resultCta}>
        <SquarePrimaryButton
          testID="sell-result-next"
          label="Next sale"
          onPress={onNext}
        />
      </View>
    </View>
  );
}

function NoTipDisclosure({ testID }: { testID?: string }) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.disclosure} testID={testID}>
      <Text
        variant="caption"
        color={colors.colorMuted}
        style={styles.disclosureText}
      >
        {expanded ? POS_NO_TIP_DISCLOSURE : POS_NO_TIP_SUMMARY}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={
          expanded ? "Hide no-tip policy details" : "Show no-tip policy details"
        }
        onPress={() => setExpanded((value) => !value)}
        style={styles.disclosureToggle}
      >
        <Text variant="caption" weight="bold" color={colors.color}>
          {expanded ? "Less" : "More info"}
        </Text>
      </Pressable>
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: { padding: 20, gap: 16 },

    // Swiss uppercase section label — replaces the soft `h1`/`h2`.
    sectionLabel: {
      fontSize: 14,
      color: colors.color,
      marginBottom: 4,
    },

    // Ticket-type rows separated by a 1px hairline, no radii.
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderColorSoft,
      gap: 12,
    },
    // FR-010: dimmed, never hidden. A door team that cannot see the 8pm tier
    // concludes it was never configured and starts improvising.
    rowUnavailable: { opacity: 0.5 },
    rowMain: { flex: 1, gap: 4 },
    ttName: { fontSize: 18, color: colors.color },

    // Square stepper buttons — 48px tap target, 2px border, no radius.
    stepper: { flexDirection: "row", alignItems: "center", gap: 8 },
    stepperBtn: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.borderColor,
    },
    // `structure` fill + `onStructure` glyph — the same inversion
    // `secondaryButtonPressed` uses. The previous value was `progressTrack`,
    // which (a) is documented as "track behind a progress bar", so retuning the
    // progress bar would have silently retuned this, and (b) REPLACED the rest
    // fill rather than compositing over it, resolving its alpha against the
    // canvas for a 1.08:1 Stub / 1.06:1 Ember state delta — no visible press on
    // the control that sets the quantity being charged.
    stepperBtnPressed: {
      backgroundColor: colors.structure,
      borderColor: colors.structure,
    },
    stepperBtnTextPressed: { color: colors.onStructure },
    // Tokens, not `opacity: 0.3` — at that alpha the +/- glyph measured
    // ~1.6:1 against its own washed-out fill, on the control an operator uses
    // to set the quantity they are about to charge for.
    stepperBtnDisabled: {
      backgroundColor: colors.surfaceMuted,
      borderColor: colors.borderColorSoft,
    },
    stepperBtnTextDisabled: { color: colors.colorMuted },
    stepperBtnText: { fontSize: 24, color: colors.color, lineHeight: 28 },
    stepperQty: {
      minWidth: 32,
      textAlign: "center",
      fontSize: 18,
      color: colors.color,
    },

    // Cart total — full-width band with a thick top border (Swiss separator).
    // Now a stack of lines (subtotal → per-code discounts → total) rather
    // than a single row, so the operator can read the arithmetic.
    cartFooter: {
      paddingVertical: 20,
      borderTopWidth: 2,
      borderTopColor: colors.borderColor,
      marginTop: 8,
      gap: 10,
    },
    cartLine: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
    },
    cartLineAmount: {
      fontSize: 18,
      color: colors.color,
      lineHeight: 24,
    },
    cartDiscountBlock: { gap: 8 },
    // Accent, not danger: a discount is a good outcome at the door. Uses the
    // `accentText` rung (the AA-cleared foreground form of `accent`).
    cartDiscountAmount: {
      fontSize: 18,
      color: colors.accentText,
      lineHeight: 24,
    },
    // Hairline above the grand total keeps it visually terminal even when
    // several discount lines sit between it and the subtotal.
    cartTotalLine: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.borderColorSoft,
    },
    cartTotalAmount: {
      fontSize: 28,
      color: colors.color,
      lineHeight: 34,
    },

    // ── Promo entry ────────────────────────────────────────────────────
    promoBlock: { gap: 12 },
    promoEntryRow: { flexDirection: "row", alignItems: "stretch", gap: 12 },
    // Matches the 52px Swiss button height so the input and Apply align.
    promoInput: {
      flex: 1,
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 0,
      fontSize: 18,
      fontWeight: "700",
      letterSpacing: 1,
      color: colors.color,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.borderColor,
      includeFontPadding: false,
    },
    promoApplySlot: { width: 120, justifyContent: "center" },
    promoApplyPending: {
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.borderColor,
    },

    promoChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    // Applied code + what it took off + a dedicated remove target. Outlined
    // in accent so it reads as an active modifier on the total above it.
    promoChip: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.accentTint,
      paddingLeft: 12,
      minHeight: 44,
      gap: 8,
    },
    promoChipCode: { fontSize: 14, letterSpacing: 1, color: colors.color },
    promoChipAmount: { fontSize: 14, color: colors.accentText },
    // 44×44 minimum tap target, separated by a hairline from the label so a
    // fat-fingered press can't be mistaken for tapping the chip itself.
    promoChipRemove: {
      width: 44,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      borderLeftWidth: 2,
      borderLeftColor: colors.accent,
    },
    promoChipRemovePressed: { backgroundColor: colors.structure },
    promoChipRemoveGlyph: {
      fontSize: 20,
      lineHeight: 24,
      color: colors.color,
    },
    promoChipRemoveGlyphPressed: { color: colors.onStructure },
    // Outlined block, matching the comp / off-cart banner convention: status
    // is border + text, never a coloured fill behind body copy.
    promoError: {
      borderWidth: 2,
      borderColor: colors.danger,
      backgroundColor: colors.dangerTint,
      padding: 12,
    },

    // Sale-time failure (server rejected startSale / recordCashSale). Same
    // treatment as a promo error: `danger` is the GRAPHIC contrast rung, so
    // the border uses it and the text uses the `dangerSoft` text rung.
    saleError: {
      borderWidth: 2,
      borderColor: colors.danger,
      backgroundColor: colors.dangerTint,
      padding: 12,
    },

    // CTA row — primary + cash side-by-side. Each slot wraps a
    // SquarePrimary/Secondary so they share the 52px Swiss button system.
    ctaRow: { flexDirection: "row", gap: 12, marginTop: 8 },
    ctaSlot: { flex: 1 },
    // Loading state stays neutral; orange is reserved for primary CTAs and
    // the comp/audit signal, never for "thinking" feedback.
    ctaPending: {
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.borderColor,
    },

    disclosure: {
      marginTop: 8,
      gap: 8,
    },
    disclosureText: {
      lineHeight: 18,
    },
    disclosureToggle: {
      alignSelf: "flex-start",
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderWidth: 2,
      borderColor: colors.borderColor,
      justifyContent: "center",
    },

    // ── Cash confirm sheet ─────────────────────────────────────────────
    sheet: { gap: 20 },

    // Amount field is a single Swiss-bordered rectangle with two slots:
    //   ┌──────┬───────────────────────────────────┐
    //   │  $   │                          345.00   │
    //   └──────┴───────────────────────────────────┘
    // Fixed-width currency slot keeps the `$` from ever colliding with
    // the value; the value right-aligns so digits flow toward the edge
    // like a calculator readout.
    amountField: {
      flexDirection: "row",
      alignItems: "stretch",
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surfaceRaised,
      minHeight: 96,
    },
    amountCurrencySlot: {
      width: 72,
      alignItems: "center",
      justifyContent: "center",
      borderRightWidth: 2,
      borderRightColor: colors.borderColor,
      backgroundColor: colors.surfaceRaised,
    },
    amountCurrency: {
      fontSize: 40,
      lineHeight: 48,
      color: colors.color,
      includeFontPadding: false,
    },
    amountInput: {
      flex: 1,
      fontSize: 40,
      fontWeight: "700",
      color: colors.color,
      textAlign: "right",
      paddingHorizontal: 20,
      paddingVertical: 0,
      includeFontPadding: false,
    },

    // Quick-amount chips — square, 2px border, no fill until active.
    chipRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    chip: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: "transparent",
      minHeight: 44,
      minWidth: 80,
      alignItems: "center",
      justifyContent: "center",
    },
    chipActive: {
      backgroundColor: colors.surfaceRaised,
      borderColor: colors.color,
    },
    chipText: {
      fontSize: 14,
      letterSpacing: 0.5,
    },

    // Comp banner — outlined block (not a coloured fill) so it follows the
    // "status states use border + icon + text" rule. Orange border signals
    // the operator-on-audit consequence without competing with the CTA.
    compBadge: {
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.accentTint,
      padding: 16,
      gap: 4,
    },
    compBadgeBody: { lineHeight: 18 },

    // "Off cart" hint — amber outlined block, distinct from the comp
    // banner so the operator can tell the two apart at a glance.
    cartDiff: {
      borderWidth: 2,
      borderColor: colors.support,
      backgroundColor: colors.supportTint,
      padding: 16,
      gap: 4,
    },
    cartDiffBody: { lineHeight: 18 },

    // ── Sale result ────────────────────────────────────────────────────
    resultRoot: {
      alignItems: "center",
      paddingVertical: 48,
      gap: 16,
    },
    admitH1: {
      fontSize: 64,
      lineHeight: 72,
      fontWeight: "800",
      letterSpacing: 4,
      color: colors.success,
      includeFontPadding: false,
    },
    admitSubtitle: {
      fontSize: 18,
      color: colors.color,
    },
    seatBlock: {
      alignSelf: "stretch",
      marginTop: 16,
      paddingTop: 16,
      borderTopWidth: 2,
      borderTopColor: colors.borderColor,
      gap: 10,
      alignItems: "center",
    },
    seatRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: 8,
    },
    // Each assigned seat gets its own outlined tile so the operator can
    // read them at arm's length while pointing the walk-up to their row.
    seatTag: {
      minWidth: 64,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 2,
      // Was the pre-v2 steel `accent` (#35589A), which is 2.46:1 on the navy
      // canvas — under the 3:1 non-text floor, on a tag meant to be legible at
      // arm's length. `borderColor` is 3.81:1 Ember / 14.89:1 Stub.
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
      alignItems: "center",
    },
    seatTagText: {
      fontSize: 18,
      letterSpacing: 1,
      color: colors.color,
    },
    orderRef: { marginTop: 4 },
    resultCta: {
      alignSelf: "stretch",
      marginTop: 24,
    },
  });
