"use client";

import { XStack, YStack } from "tamagui";
import { Button, QuantityStepper, Separator, Text } from "@th/ui";

import { formatCents } from "@/lib/format";
import { PayWhatYouCanControl } from "./PayWhatYouCanControl";
import {
  QuoteErrorPanel,
  SaleQuoteSummary,
  TaxRefusedPanel,
} from "./SaleQuoteSummary";
import {
  cartEntries,
  isItemSellable,
  lineUnitPriceCents,
  type Cart,
  type SellableItem,
} from "./sell-cart";
import type { QuoteState } from "./sell-quote";

/**
 * Why a tier can't be sold right now, in words an operator can say out loud.
 *
 * Windowed and sold-out tiers stay LISTED rather than being filtered away —
 * `listSellableItems` is deliberate about this, and so is the row. "VIP opens
 * at 8pm" is information; a missing row is how a door team concludes the tier
 * was never configured and starts phoning the promoter.
 */
function unsellableReason(item: SellableItem): string | null {
  if (!item.sellability.available) {
    const { reason, opensAt, closedAt } = item.sellability;
    if (reason === "not_yet_on_sale") {
      // Name the time when we have it. "Opens at 8:00 PM" is something the
      // operator can say to the person in front of them; "not on sale yet"
      // just moves the question along.
      return opensAt
        ? `Opens ${new Date(opensAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}`
        : "Not on sale yet";
    }
    if (reason === "sales_ended") {
      return closedAt
        ? `Sales ended ${new Date(closedAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}`
        : "Sales ended";
    }
    return "Not on sale";
  }
  if (item.capacityRemaining <= 0) return "Sold out";
  return null;
}

function TicketTypeRow({
  item,
  cart,
  onStep,
  onSetAmount,
}: {
  item: SellableItem;
  cart: Cart;
  onStep: (item: SellableItem, delta: number) => void;
  onSetAmount: (item: SellableItem, cents: number) => void;
}) {
  const line = cart[item.ticketTypeId];
  const qty = line?.qty ?? 0;
  const blocked = unsellableReason(item);
  const sellable = isItemSellable(item);
  const isAdjustable = item.pricingMode === "ADJUSTABLE";
  const unitPriceCents = line
    ? lineUnitPriceCents(item, line)
    : isAdjustable
      ? (item.suggestedCents ?? item.minimumCents ?? 0)
      : item.unitPriceCents;

  /**
   * The caption under the name. The door sells at the same price the event
   * page shows (there is no separate door price), so a FIXED row just says
   * how many are left.
   */
  const caption = blocked
    ? blocked
    : isAdjustable
      ? `PAY WHAT YOU CAN · FLOOR ${formatCents(item.minimumCents ?? 0)} · ${item.capacityRemaining} LEFT`
      : `${item.capacityRemaining} LEFT`;

  return (
    <YStack
      gap="$2"
      paddingVertical="$3"
      opacity={sellable ? 1 : 0.55}
      data-testid={`sell-row-${item.ticketTypeId}`}
    >
      <XStack gap="$3" alignItems="center" flexWrap="wrap">
        <YStack flex={1} minWidth={140} gap="$1">
          <Text variant="body" weight="bold">
            {item.name}
          </Text>
          <Text variant="caption" tone="muted">
            {caption}
          </Text>
        </YStack>

        <Text variant="h5" weight="bold">
          {formatCents(unitPriceCents)}
        </Text>

        <QuantityStepper
          value={qty}
          min={0}
          max={item.capacityRemaining}
          disabled={!sellable}
          onStep={(delta) => onStep(item, delta)}
          aria-label={item.name}
          // Two steppers on one screen with a bare "Increase" each is an
          // accessible-name collision — the exact class of defect unit tests
          // here cannot see, because they render components without the rest
          // of the page around them.
          incrementLabel={`Add one — ${item.name}`}
          decrementLabel={`Remove one — ${item.name}`}
        />
      </XStack>

      {isAdjustable && qty > 0 ? (
        <PayWhatYouCanControl
          item={item}
          qty={qty}
          amountCents={unitPriceCents}
          onChange={(cents) => onSetAmount(item, cents)}
        />
      ) : null}
    </YStack>
  );
}

/**
 * The nightly screen. Someone is standing in front of the operator, so the
 * total and the charge button are the only things that need to be found
 * without looking.
 *
 * Steppers rather than a keypad: door sales are one to four tickets, and a
 * keypad optimises for a case that barely happens while costing a tap on the
 * case that always does.
 *
 * Every total on this screen is the server's quote (`pos.quoteCart`), never a
 * sum worked out here. Charge stays off until the quote for THIS cart is in,
 * so nobody reads out a number the till won't charge.
 */
export function SellCatalogue({
  items,
  cart,
  quote,
  currency,
  eventTitle,
  onStep,
  onSetAmount,
  onClear,
  onCharge,
  onRetryQuote,
  onEnterTaxRate,
  onCompInstead,
}: {
  items: SellableItem[];
  cart: Cart;
  quote: QuoteState;
  currency: string;
  eventTitle: string;
  onStep: (item: SellableItem, delta: number) => void;
  onSetAmount: (item: SellableItem, cents: number) => void;
  onClear: () => void;
  onCharge: () => void;
  onRetryQuote: () => void;
  onEnterTaxRate: () => void;
  /** A comp needs no tax, so it still works while the lookup is down. */
  onCompInstead: () => void;
}) {
  const entries = cartEntries(cart, items);
  const hasCart = entries.length > 0;
  const canCharge = hasCart && quote.kind === "ready";
  const taxRefused = hasCart && quote.kind === "tax-refused";

  return (
    <YStack gap="$4">
      <YStack
        borderWidth={1}
        borderColor="$borderColor"
        backgroundColor="$background"
        paddingHorizontal="$3"
      >
        {items.map((item, index) => (
          <YStack key={item.ticketTypeId}>
            {index > 0 ? <Separator /> : null}
            <TicketTypeRow
              item={item}
              cart={cart}
              onStep={onStep}
              onSetAmount={onSetAmount}
            />
          </YStack>
        ))}
      </YStack>

      {hasCart ? (
        <SaleQuoteSummary entries={entries} quote={quote} currency={currency} />
      ) : null}

      {hasCart && quote.kind === "tax-refused" ? (
        <TaxRefusedPanel
          eventTitle={eventTitle}
          canEnterManualTaxRate={quote.canEnterManualTaxRate}
          retrying={quote.retrying}
          onEnterTaxRate={onEnterTaxRate}
          onRetry={onRetryQuote}
        />
      ) : null}

      {hasCart && quote.kind === "error" ? (
        <QuoteErrorPanel
          error={quote.error}
          retrying={quote.retrying}
          onRetry={onRetryQuote}
        />
      ) : null}

      {taxRefused ? (
        // No Charge while tax is refused: the panel above carries the one
        // primary action (enter the rate), and a disabled primary beside it
        // reads as a second way forward that isn't there. A comp charges no
        // tax, so it still works, through the tender screen like any comp
        // (where the buyer's email can go on it).
        <YStack gap="$2">
          <Text variant="caption" tone="muted">
            Comps still work: a comp charges no tax.
          </Text>
          <XStack gap="$2" flexWrap="wrap">
            <Button
              variant="secondary"
              size="$3"
              minHeight={44}
              onPress={onCompInstead}
              data-testid="sell-comp-instead"
            >
              Comp instead
            </Button>
            <Button variant="ghost" size="$3" minHeight={44} onPress={onClear}>
              Clear sale
            </Button>
          </XStack>
        </YStack>
      ) : (
        <XStack gap="$2" flexWrap="wrap">
          <Button
            variant="primary"
            size="$4"
            flex={1}
            minWidth={180}
            disabled={!canCharge}
            onPress={onCharge}
            data-testid="sell-charge"
          >
            Charge
          </Button>
          {hasCart ? (
            <Button variant="ghost" size="$4" onPress={onClear}>
              Clear sale
            </Button>
          ) : null}
        </XStack>
      )}
    </YStack>
  );
}
