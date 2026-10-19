"use client";

import { XStack, YStack } from "tamagui";
import { Button, Spinner, Text } from "@th/ui";

import { formatCents } from "@/lib/format";
import { maskEmail } from "./sell-quote";

/**
 * A polite live region that is ALWAYS mounted, for content that appears or
 * changes in place (a total going from "—" to a figure, a notice showing up).
 * Screen readers announce changes INSIDE a region they already know about; a
 * region that mounts together with its text is often read as nothing at all.
 * So the caller renders this unconditionally and puts the conditional inside.
 */
export function PoliteRegion({
  children,
  atomic = false,
  testId,
}: {
  children?: React.ReactNode;
  /** Read the whole region on any change (a total row), not just the diff. */
  atomic?: boolean;
  testId?: string;
}) {
  return (
    <YStack aria-live="polite" aria-atomic={atomic} data-testid={testId}>
      {children}
    </YStack>
  );
}

/**
 * The amber "tell the buyer" notice (`$support` rule on its own tint), for a
 * number that moved after the operator read it out. Amber, not red: nothing
 * failed, the operator just has something to say before the buyer pays.
 *
 * Not a live region itself: one that mounts with its text often goes
 * unannounced. Where it appears in place, wrap it in an always-mounted
 * `PoliteRegion`.
 */
export function SupportNotice({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <YStack
      borderWidth={2}
      borderColor="$support"
      // A tint of the support amber. No theme token carries it yet; the
      // fallback is the Stub value, so first paint matches.
      backgroundColor="color-mix(in srgb, var(--support, #F59E0B) 14%, transparent)"
      paddingVertical="$2"
      paddingHorizontal="$3"
      maxWidth={460}
      width="100%"
      data-testid={testId}
    >
      <Text variant="bodySmall">{children}</Text>
    </YStack>
  );
}

/**
 * Waiting on the reader.
 *
 * This has to be readable across a dark, loud room at arm's length, so THE
 * AMOUNT IS THE INTERFACE and everything else is caption. If the operator
 * glances once, they should confirm the number and nothing else.
 *
 * The reader is NAMED before the prompt: with three readers on one bar, "it's
 * not doing anything" is usually the wrong reader.
 *
 * Cancelling here clears the READER ACTION, not the order. The cart survives so
 * it can go to another reader or fall back to cash — which is the whole reason
 * dispatch is a separate step from starting the sale.
 */
export function ReaderWaitingView({
  readerLabel,
  amountCents,
  quotedCents,
  currency,
  onCancel,
  cancelling,
}: {
  readerLabel: string;
  /** What the reader asks for: the server's charge, `startSale.amountCents`. */
  amountCents: number;
  /** The card total the quote showed, or null when there was none. */
  quotedCents: number | null;
  currency: string;
  onCancel: () => void;
  cancelling: boolean;
}) {
  // The reader asks for the server's number. If that moved after the
  // operator read the quote out, the buyer is about to tap for a total
  // nobody told them. No cause is given: a tax rate update is one, a ticket
  // price or fee change is another, and the screen can't tell which.
  const moved = quotedCents != null && quotedCents !== amountCents;
  return (
    <YStack gap="$4" alignItems="center" paddingVertical="$6" data-testid="sell-waiting">
      <Text variant="overline" tone="muted">
        {readerLabel}
      </Text>

      <Text variant="display" weight="bold" textAlign="center">
        {formatCents(amountCents, currency)}
      </Text>

      {moved ? (
        <SupportNotice testId="sell-waiting-total-moved">
          The total changed since the quote. The reader is asking for{" "}
          {formatCents(amountCents, currency)}. Tell the buyer before they tap.
        </SupportNotice>
      ) : null}

      <XStack gap="$2" alignItems="center">
        <Spinner size="small" />
        <Text variant="body" tone="muted">
          Tap, insert or swipe on the reader
        </Text>
      </XStack>

      <Button
        variant="secondary"
        size="$3"
        onPress={onCancel}
        disabled={cancelling}
        data-testid="sell-cancel-charge"
      >
        {cancelling ? <Spinner size="small" /> : null}
        Cancel this charge
      </Button>

      <Text variant="caption" tone="muted" textAlign="center" maxWidth={380}>
        Cancelling clears the reader. The sale stays open — you can send it to
        another reader or switch to cash.
      </Text>
    </YStack>
  );
}

/**
 * The reader didn't take it.
 *
 * Venue wifi is the least reliable thing in the building, so this state's job
 * is to KEEP THE QUEUE MOVING. Three ways out — retry, switch reader, fall
 * back to cash — none of which rebuild the cart.
 *
 * It answers "did it take the money twice?" in the detail line, BEFORE offering
 * any buttons, because that is the operator's actual first thought.
 */
export function ReaderOpenSaleView({
  headline,
  detail,
  cashAmountCents,
  currency,
  readerLabel,
  otherReaders,
  onRetry,
  onSendTo,
  onTakeCash,
  onAbandon,
  busy,
}: {
  headline: string;
  detail: string;
  /**
   * What the cash fallback records: the quote's CASH total, the same number
   * the Cash tile takes (ticket + tax, no platform or processing fee). Not
   * the card sale's amount, which carries the card's fees.
   */
  cashAmountCents: number;
  currency: string;
  readerLabel: string;
  otherReaders: Array<{ id: string; label: string }>;
  onRetry: () => void;
  onSendTo: (readerId: string) => void;
  onTakeCash: () => void;
  onAbandon: () => void;
  busy: boolean;
}) {
  return (
    <YStack gap="$4" paddingVertical="$4" maxWidth={520} data-testid="sell-card-open">
      <YStack gap="$2">
        <Text variant="h4" weight="bold">
          {headline}
        </Text>
        <Text variant="body" tone="muted">
          {detail}
        </Text>
      </YStack>

      <YStack gap="$2">
        <Button
          variant="primary"
          size="$4"
          onPress={onRetry}
          disabled={busy}
          data-testid="sell-retry-reader"
        >
          {busy ? <Spinner size="small" /> : null}
          Try {readerLabel} again
        </Button>

        {otherReaders.map((reader) => (
          <Button
            key={reader.id}
            variant="secondary"
            size="$4"
            disabled={busy}
            onPress={() => onSendTo(reader.id)}
          >
            Send to {reader.label} instead
          </Button>
        ))}

        <Button
          variant="secondary"
          size="$4"
          disabled={busy}
          onPress={onTakeCash}
          data-testid="sell-fallback-cash"
        >
          {/* One string: the DS Button spaces each text child apart. */}
          {`Take ${formatCents(cashAmountCents, currency)} in cash`}
        </Button>

        <Button variant="ghost" size="$3" disabled={busy} onPress={onAbandon}>
          Cancel this sale
        </Button>
      </YStack>
    </YStack>
  );
}

/**
 * Done. Paid, minted, admitted.
 *
 * "Admitted" is STATED rather than left implicit: POS sales auto-admit on
 * payment, so this person does not need a ticket scanned to get in, and saying
 * so stops the operator hunting for a QR that has already been honoured.
 *
 * ONE MEANING FOR "COMP". Only the Comp button comps. A cash sale a promo code
 * took to $0 is still a sale (the code was redeemed, the till counts it under
 * "Free with a code"), so it shows "$0.00", never "Comped".
 *
 * "Next sale" is the primary action because there is a queue and this screen's
 * job is to get out of the way.
 */
export function SaleDoneView({
  amountCents,
  currency,
  ticketCount,
  tender,
  discountCents,
  promoCodes = [],
  buyerEmail,
  changeCents,
  autoAdmitted,
  seatLabels,
  onNextSale,
}: {
  amountCents: number;
  currency: string;
  ticketCount: number;
  tender: "card" | "cash" | "comp";
  discountCents: number;
  /** The codes the sale redeemed; names the code on a $0 sale. */
  promoCodes?: readonly string[];
  buyerEmail: string | null;
  /**
   * Cash to hand back: what was taken minus what the server charged. Only
   * above 0 when the sale came out lower than the quote the operator took.
   */
  changeCents: number;
  autoAdmitted: boolean;
  seatLabels: string[];
  onNextSale: () => void;
}) {
  const tickets = `${ticketCount} ${ticketCount === 1 ? "ticket" : "tickets"}`;
  const isComp = tender === "comp";
  // A paid sale at $0 only happens when a promo code took the whole cart.
  // `recordCashSale` returns the codes it redeemed; "a code" is the fallback
  // for a replayed result cached before it did.
  const freeWithCode = !isComp && amountCents === 0 && discountCents > 0;
  const freeWith =
    promoCodes.length > 0 ? `Free with ${promoCodes.join(", ")}` : "Free with a code";

  const headline = isComp ? "Comped" : formatCents(amountCents, currency);
  const summary = isComp
    ? `Guest list — ${tickets}`
    : freeWithCode
      ? `${freeWith} — ${tickets}`
      : tender === "card"
        ? `Paid by card — ${tickets}`
        : `Paid cash — ${tickets}`;

  return (
    <YStack
      gap="$4"
      alignItems="center"
      paddingVertical="$6"
      data-testid="sell-done"
    >
      <Text
        variant="display"
        weight="bold"
        textAlign="center"
        textTransform="uppercase"
      >
        {headline}
      </Text>

      <Text variant="body" weight="bold" textAlign="center">
        {summary}
      </Text>

      {autoAdmitted ? (
        <Text variant="body" tone="success" textAlign="center">
          Admitted · walk straight in
        </Text>
      ) : (
        <Text variant="body" tone="muted" textAlign="center">
          Tickets issued — scan at the door
        </Text>
      )}

      {changeCents > 0 ? (
        // The till took the quote's cash total and the server charged less
        // (a hand-entered tax rate gave way to a lower looked-up one). The
        // buyer is owed the difference, and only this screen knows it.
        <SupportNotice testId="sell-done-change">
          <Text variant="bodySmall" weight="bold">
            Give back {formatCents(changeCents, currency)}
          </Text>
          : the total came out lower than quoted.
        </SupportNotice>
      ) : null}

      {seatLabels.length > 0 ? (
        <YStack gap="$1" alignItems="center">
          <Text variant="caption" tone="muted">
            Seats
          </Text>
          <Text variant="h5" weight="bold">
            {seatLabels.join(", ")}
          </Text>
        </YStack>
      ) : null}

      {isComp ? (
        <Text variant="caption" tone="muted" textAlign="center">
          No fee, no tax
        </Text>
      ) : freeWithCode ? (
        <Text variant="caption" tone="muted" textAlign="center">
          Counted as a sale, not a comp
        </Text>
      ) : null}

      {buyerEmail ? (
        <Text
          variant="caption"
          tone="muted"
          textAlign="center"
          data-testid="sell-done-receipt"
        >
          Receipt sent to {maskEmail(buyerEmail)}
        </Text>
      ) : null}

      <Button
        variant="primary"
        size="$4"
        onPress={onNextSale}
        data-testid="sell-next-sale"
      >
        Next sale
      </Button>
    </YStack>
  );
}
