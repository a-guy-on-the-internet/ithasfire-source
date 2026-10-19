/**
 * Sell screen: the scanner's door till (Tap to Pay + cash + comp).
 *
 * Render only. The state machine (cart, codes, the server quote, the sale's
 * idempotency key, every press) lives in `use-door-sale.ts`; the pure rules
 * it runs on live in `sell-quote.ts`, `sale-attempt.ts` and `cash-tender.ts`,
 * which carry the tests. Board refs: S2-OptionB (cart, Card | Cash columns),
 * S3 (cash sheet), S4 (tax lookup down), D1 (done).
 *
 * Anti-tipping (FR-014): the disclosure copy is a locked constant in
 * `no-tip-disclosure.tsx`. Do not inline-edit it.
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";

import { Text } from "@th/ui";
import {
  SquarePrimaryButton,
  SquareSecondaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { binarySupportsTapToPay } from "../../lib/capabilities";

import { BuyerEmailField } from "./buyer-email-field";
import { CardClosingView } from "./card-closing-view";
import { CashSheet } from "./cash-sheet";
import {
  DEFAULT_SIMULATED_TEST_CARD,
  DevSimulatedCardPicker,
} from "./dev-simulated-card-picker";
import { NoTipDisclosure } from "./no-tip-disclosure";
import { PromoEntry } from "./promo-entry-view";
import { QuoteBreakdown } from "./quote-breakdown";
import { unresolvedNotice } from "./sale-attempt";
import { SaleDoneView } from "./sale-done-view";
import { useAskToClearSale } from "./sale-guard";
import { CardClearedNotice, UnresolvedSaleNotice } from "./sale-notices";
import { cashDueSummary } from "./sell-quote";
import { TapToPaySurface } from "./tap-to-pay-surface";
import { TicketTypeRows, type TicketTypeRow } from "./ticket-type-rows";
import { useDoorSale } from "./use-door-sale";

export { POS_NO_TIP_DISCLOSURE } from "./no-tip-disclosure";

const SCROLL_TO_TOP_STAGES: ReadonlySet<string> = new Set([
  "cash",
  "tap-to-pay",
  "card-closing",
  "result",
]);

export type SellScreenProps = {
  eventId: string;
  /** The event's currency (`pos.listSellableItems`), for every amount shown. */
  currency: string;
  /** Door-sellable ticket types for this event, composed by the caller. */
  ticketTypes: TicketTypeRow[];
  /** Mints a new idempotency key; called once per SALE, not per press. */
  newClientKey: () => string;
  /**
   * Stripe Terminal Location ID (`tml_...`) on the platform account. When
   * omitted, Tap to Pay surfaces a configuration error (cash still works).
   */
  tapToPayLocationId?: string;
};

export function SellScreen({
  eventId,
  currency,
  ticketTypes,
  newClientKey,
  tapToPayLocationId,
}: SellScreenProps) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const sale = useDoorSale({ eventId, currency, ticketTypes, newClientKey });
  const { stage, attempt, busy, quote, cart, promo, open, actions } = sale;
  const [simulatedTestCard, setSimulatedTestCard] = useState<string>(
    DEFAULT_SIMULATED_TEST_CARD,
  );

  // The ScrollView keeps its offset across a stage change. Entering a stage
  // that replaces the cart starts at the top: the cash sheet, so the
  // card-cleared notice isn't scrolled off the top of a long cart; and Tap to
  // Pay, the card-closing screen and the result, so the big amount isn't
  // cut off under the header after the operator scrolled down to the button.
  // Not `browse`: a tax refusal sends cash → browse with its banner low on
  // the cart, and a jump to the top would hide it.
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    if (!SCROLL_TO_TOP_STAGES.has(stage.kind)) return;
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [stage.kind]);

  // "Start a new sale" on a dead-end card screen goes through the app root's
  // "Clear this sale?" confirm, like any other way off an open card sale.
  const askToClear = useAskToClearSale();

  const notice = unresolvedNotice(attempt);
  // "Don't take cash for the $X card sale you cleared": on the cart AND the cash sheet.
  const cardClearedNode =
    sale.cardCleared.kind !== null ? (
      <CardClearedNotice
        kind={sale.cardCleared.kind}
        amount={sale.cardCleared.amount}
        onDismiss={sale.cardCleared.dismiss}
      />
    ) : null;
  const noticeNode =
    notice !== null ? (
      <UnresolvedSaleNotice
        message={notice}
        canClear={attempt.mayAlreadyBeRecorded}
        onClear={actions.resetSale}
        testID="sell-unresolved"
      />
    ) : null;

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
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
          {cardClearedNode}
          {ticketTypes.length === 0 && (
            <Text variant="body" color={colors.colorMuted} testID="sell-empty-state">
              No ticket types are currently on sale for this event.
            </Text>
          )}
          <TicketTypeRows
            ticketTypes={ticketTypes}
            cartByTicketType={cart.cartByTicketType}
            currency={currency}
            locked={sale.unresolved || busy}
            onAdjust={cart.adjust}
          />

          {cart.cartCount > 0 && (
            <QuoteBreakdown
              state={quote.state}
              cartCount={cart.cartCount}
              currency={currency}
              onRetry={quote.refetch}
            />
          )}

          <PromoEntry
            state={promo.state}
            value={promo.input}
            onChangeValue={promo.setInput}
            onApply={promo.apply}
            onRemove={promo.remove}
            canApply={cart.cartCount > 0}
            locked={sale.unresolved}
            currency={currency}
          />

          <BuyerEmailField
            value={sale.buyerEmail}
            onChange={sale.setBuyerEmail}
            locked={attempt.lock !== null || busy}
          />

          {noticeNode}
          {sale.saleError !== null && <SaleErrorBanner message={sale.saleError} />}

          {binarySupportsTapToPay() && (
            <DevSimulatedCardPicker
              selected={simulatedTestCard}
              onSelect={setSimulatedTestCard}
            />
          )}

          <View style={styles.ctaRow}>
            {binarySupportsTapToPay() && (
              <View style={styles.ctaSlot}>
                {busy ? (
                  <View style={styles.ctaPending}>
                    <ActivityIndicator color={colors.color} />
                  </View>
                ) : (
                  <SquarePrimaryButton
                    testID="sell-tap-to-pay-button"
                    label="Tap to Pay"
                    onPress={actions.tapToPay}
                    disabled={cart.cartCount === 0 || !open.card}
                    accessibilityHint={
                      sale.freeWithCode
                        ? "Nothing to charge to a card. Take it through Cash as a $0 sale."
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
                onPress={actions.startCash}
                disabled={cart.cartCount === 0 || !open.cash}
              />
            </View>
          </View>

          {sale.freeWithCode && (
            <Text variant="bodySmall" color={colors.colorMuted} testID="sell-zero-total-hint">
              The code covers the whole cart. Take it through Cash as a $0
              sale: a card can't be charged $0.
            </Text>
          )}

          {quote.state.kind === "tax-refused" && cart.cartCount > 0 && (
            <View style={styles.compInstead}>
              <Text variant="bodySmall" color={colors.colorMuted} style={styles.copy}>
                Comps still work: a comp charges no tax.
              </Text>
              <SquareSecondaryButton
                testID="sell-tax-refused-comp"
                label="Comp instead"
                onPress={actions.compInstead}
                disabled={!open.compInstead}
              />
            </View>
          )}

          <NoTipDisclosure testID="sell-no-tip-disclosure" />
        </>
      )}

      {stage.kind === "cash" && (
        <>
          {cardClearedNode}
          <CashSheet
            // No re-key on a new figure: what the operator typed stays, so a
            // total that went UP reads "$X short" until they collect it.
            currency={currency}
            dueCents={stage.dueOverride ?? stage.sale.quote?.cash.totalCents ?? null}
            dueSummary={
              stage.sale.quote
                ? cashDueSummary(stage.sale.quote, cart.ticketNames)
                : null
            }
            dueChanged={stage.dueOverride !== null}
            ticketCount={stage.sale.items.reduce((n, l) => n + l.qty, 0)}
            buyerEmail={sale.buyerEmail}
            onBuyerEmailChange={sale.setBuyerEmail}
            cashOpen={open.sheetCash}
            compOpen={open.sheetComp}
            lock={attempt.lock}
            notice={noticeNode}
            busy={busy}
            onConfirmCash={actions.confirmCash}
            onComp={actions.comp}
            onBack={actions.backToCart}
          />
          {sale.saleError !== null && <SaleErrorBanner message={sale.saleError} />}
        </>
      )}

      {stage.kind === "tap-to-pay" && (
        <TapToPaySurface
          orderId={stage.orderId}
          clientSecret={stage.clientSecret}
          amountCents={stage.amountCents}
          quotedCents={stage.quotedCents}
          currency={currency}
          locationId={tapToPayLocationId}
          simulatedTestCardNumber={simulatedTestCard}
          onSuccess={actions.finishCardSale}
          onCancel={actions.cancelCard}
        />
      )}

      {stage.kind === "card-closing" && (
        <CardClosingView
          amountCents={stage.amountCents}
          currency={currency}
          view={stage.view}
          busy={busy}
          onCheckAgain={actions.checkCardAgain}
          onStartNewSale={askToClear}
        />
      )}

      {stage.kind === "result" && (
        <SaleDoneView sale={stage.sale} currency={currency} onNext={actions.resetSale} />
      )}
    </ScrollView>
  );
}

function SaleErrorBanner({ message }: { message: string }) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <View style={styles.saleError} accessibilityLiveRegion="polite" testID="sell-sale-error">
      {/* `dangerSoft` is the text rung; `danger` (graphic) is the border. */}
      <Text variant="bodySmall" weight="bold" color={colors.dangerSoft}>
        {message}
      </Text>
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: { padding: 20, gap: 16 },
    sectionLabel: { fontSize: 14, color: colors.color, marginBottom: 4 },
    copy: { lineHeight: 20 },
    saleError: {
      borderWidth: 2,
      borderColor: colors.danger,
      backgroundColor: colors.dangerTint,
      padding: 12,
    },
    ctaRow: { flexDirection: "row", gap: 12, marginTop: 8 },
    ctaSlot: { flex: 1 },
    // Loading stays neutral; orange is for primary CTAs, never "thinking".
    ctaPending: {
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.borderColor,
    },
    compInstead: { gap: 10 },
  });
