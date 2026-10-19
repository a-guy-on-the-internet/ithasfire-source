"use client";

import { XStack, YStack } from "tamagui";
import { Button, Separator, Spinner, Text, useTranslations } from "@th/ui";

import { formatCents } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";
import { PoliteRegion } from "./SaleStates";
import { breakdownRows, type CartQuote, type QuoteState } from "./sell-quote";
import type { CartEntry } from "./sell-cart";

const DASH = "—";
const tabular = { fontVariantNumeric: "tabular-nums" } as const;

/**
 * One money column. A set width so the Card and Cash figures line up down
 * every row (rows are table-like, so columns must align across them).
 *
 * On a phone it is a MINIMUM: 64px holds "$165.00" in a 14px row and leaves
 * the label column ~76px at a 320px screen, enough for "Processing" whole.
 * A wider figure (a four-figure total) widens its cell rather than run into
 * the next one. From `$gtSm` up, 112px gives the 22px desktop totals a
 * visible gap (the board's 96px let "$237.34" and "$228.65" touch in the
 * real font).
 */
const MONEY_COL = 64;
function MoneyCell({
  children,
  strong,
  muted,
}: {
  children: React.ReactNode;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <YStack
      minWidth={MONEY_COL}
      $gtSm={{ minWidth: 112 }}
      alignItems="flex-end"
      flexShrink={0}
    >
      <Text
        variant={strong ? "body" : "bodySmall"}
        weight={strong ? "black" : "regular"}
        tone={muted ? "muted" : "default"}
        textAlign="right"
        // 14px black on a phone so "$186.36" still fits its 64px column
        // (15px pushed the card total 3px out of line with the rows above).
        fontSize={strong ? 14 : undefined}
        $gtSm={strong ? { fontSize: 22 } : undefined}
        style={tabular}
      >
        {children}
      </Text>
    </YStack>
  );
}

/** Whole words only: a label never breaks mid-word ("Subtot / al"). */
const keepWords = { overflowWrap: "normal", wordBreak: "normal" } as const;

/**
 * One row of the table: label | Card | Cash, on ONE line at every width, as
 * the board draws it. The label column takes what's left (min 0) and wraps
 * inside itself, word by word ("Processing / fee"); the two money columns
 * keep their fixed width so the figures line up down the table.
 */
function TableRow({
  label,
  children,
  testId,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <XStack alignItems="baseline" gap="$2" $gtSm={{ gap: "$3" }} data-testid={testId}>
      <YStack flex={1} minWidth={0}>
        {label}
      </YStack>
      {children}
    </XStack>
  );
}

function ColumnHeads() {
  return (
    <TableRow label={null}>
      <YStack minWidth={MONEY_COL} $gtSm={{ minWidth: 112 }} alignItems="flex-end">
        <Text variant="overline" tone="muted">
          Card
        </Text>
      </YStack>
      <YStack minWidth={MONEY_COL} $gtSm={{ minWidth: 112 }} alignItems="flex-end">
        <Text variant="overline" tone="muted">
          Cash
        </Text>
      </YStack>
    </TableRow>
  );
}

function Breakdown({
  quote,
  pending,
}: {
  quote: Pick<CartQuote, "card" | "cash" | "currency">;
  /** Keep the rows but blank every figure: a fresh quote is on its way. */
  pending: boolean;
}) {
  const money = (cents: number | null) =>
    pending || cents == null ? DASH : formatCents(cents, quote.currency);
  return (
    <YStack gap="$1">
      <ColumnHeads />
      {breakdownRows(quote).map((row) => (
        <TableRow
          key={row.key}
          label={
            <Text variant="bodySmall" style={keepWords}>
              {row.label}
            </Text>
          }
        >
          <MoneyCell muted={pending || row.card == null}>{money(row.card)}</MoneyCell>
          <MoneyCell muted={pending || row.cash == null}>{money(row.cash)}</MoneyCell>
        </TableRow>
      ))}
    </YStack>
  );
}

function TotalRow({
  label,
  card,
  cash,
}: {
  label: string;
  /** Omit both figures for the single-column "—" (the till can't total). */
  card?: string;
  cash?: string;
}) {
  const labelText = (
    <Text variant="body" weight="bold" style={keepWords}>
      {label}
    </Text>
  );
  if (card === undefined && cash === undefined) {
    return (
      <TableRow label={labelText} testId="sell-cart-total">
        <Text variant="body" weight="black" fontSize={22}>
          {DASH}
        </Text>
      </TableRow>
    );
  }
  return (
    <TableRow label={labelText} testId="sell-cart-total">
      <MoneyCell strong>{card}</MoneyCell>
      <MoneyCell strong>{cash}</MoneyCell>
    </TableRow>
  );
}

/**
 * "THIS SALE": the lines, then the card and cash breakdown from the server's
 * quote, side by side (owner pick W2 option B). The operator reads both
 * totals out before the buyer says how they're paying, and neither total
 * changes when they pick.
 */
export function SaleQuoteSummary({
  entries,
  quote,
  currency: catalogueCurrency,
}: {
  entries: CartEntry[];
  quote: QuoteState;
  /** The catalogue's currency, for the lines while no quote is in hand. */
  currency: string;
}) {
  const ready = quote.kind === "ready" ? quote.quote : null;
  const currency = ready?.currency ?? catalogueCurrency;

  return (
    <YStack
      gap="$2"
      // $2 on a phone buys the label column the room it needs at 320px.
      padding="$2"
      $gtSm={{ padding: "$3" }}
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surfaceMuted"
      data-testid="sell-cart-summary"
    >
      <Text variant="overline" tone="muted">
        This sale
      </Text>
      {entries.map(({ item, line, unitPriceCents }) => {
        // The line's amount is the server's word too: "—" until the quote
        // for this cart is in, never a client-side qty × price.
        const quoted = ready?.lines.find(
          (l) => l.ticketTypeId === item.ticketTypeId,
        );
        return (
          <XStack key={item.ticketTypeId} justifyContent="space-between" gap="$3">
            <Text variant="bodySmall" flex={1} minWidth={0}>
              {line.qty} × {item.name}
              {item.pricingMode === "ADJUSTABLE"
                ? ` @ ${formatCents(unitPriceCents, currency)}`
                : ""}
            </Text>
            <Text variant="bodySmall" weight="bold" style={tabular}>
              {quoted ? formatCents(quoted.amountCents, currency) : DASH}
            </Text>
          </XStack>
        );
      })}
      <Separator />

      {quote.kind === "ready" ? (
        <>
          <Breakdown quote={quote.quote} pending={false} />
          <Separator />
        </>
      ) : quote.kind === "updating" && quote.last ? (
        <>
          <Breakdown quote={quote.last} pending />
          <Separator />
        </>
      ) : null}
      {/* Always mounted, so a total arriving (or going back to "—") is
          announced: the operator reads it out, and so should a screen
          reader. */}
      <PoliteRegion atomic>
        {quote.kind === "ready" ? (
          <TotalRow
            label="Total"
            card={
              quote.quote.card
                ? formatCents(quote.quote.card.totalCents, currency)
                : DASH
            }
            cash={formatCents(quote.quote.cash.totalCents, currency)}
          />
        ) : quote.kind === "updating" ? (
          <TotalRow label="Total · updating" card={DASH} cash={DASH} />
        ) : (
          <TotalRow label="Total" />
        )}
      </PoliteRegion>
    </YStack>
  );
}

/**
 * The tax lookup can't answer, so the sale stops here rather than charge no
 * tax (owner board M1). An Owner, Admin or Editor can enter the rate by hand;
 * anyone else is told who can. Both can try again.
 */
export function TaxRefusedPanel({
  eventTitle,
  canEnterManualTaxRate,
  retrying,
  onEnterTaxRate,
  onRetry,
}: {
  eventTitle: string;
  canEnterManualTaxRate: boolean;
  retrying: boolean;
  onEnterTaxRate: () => void;
  onRetry: () => void;
}) {
  return (
    <YStack
      role="alert"
      gap="$2"
      padding="$4"
      borderWidth={2}
      borderColor="$danger"
      backgroundColor="$surface"
      data-testid="sell-tax-refused"
    >
      <Text variant="body" weight="bold">
        Tax can&rsquo;t be worked out right now
      </Text>
      <Text variant="bodySmall">
        The tax lookup for {eventTitle} isn&rsquo;t answering. The sale stops
        here rather than charge no tax. Nothing was charged.
      </Text>
      {canEnterManualTaxRate ? null : (
        <Text variant="bodySmall">
          Ask an Owner, Admin or Editor of this group to enter the rate. Then
          try again.
        </Text>
      )}
      <XStack gap="$2" flexWrap="wrap" paddingTop="$1">
        {canEnterManualTaxRate ? (
          <Button
            variant="primary"
            size="$3"
            minHeight={44}
            onPress={onEnterTaxRate}
            data-testid="sell-enter-tax-rate"
          >
            Enter tax rate
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="$3"
          minHeight={44}
          disabled={retrying}
          onPress={onRetry}
          data-testid="sell-retry-quote"
        >
          {retrying ? <Spinner size="small" /> : null}
          Try again
        </Button>
      </XStack>
      {canEnterManualTaxRate ? (
        <Text variant="caption" tone="muted">
          The rate you enter applies to every sale of this event, at the door
          and online, until the lookup answers again.
        </Text>
      ) : null}
    </YStack>
  );
}

/** Any other refusal of the quote: say what the server said, offer a retry. */
export function QuoteErrorPanel({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations();
  return (
    <YStack
      role="alert"
      gap="$2"
      padding="$4"
      borderWidth={2}
      borderColor="$danger"
      backgroundColor="$surface"
      data-testid="sell-quote-error"
    >
      <Text variant="body" weight="bold">
        This sale can&rsquo;t be totalled
      </Text>
      <Text variant="bodySmall">{formatErrorMessage(error, t)}</Text>
      <XStack paddingTop="$1">
        <Button
          variant="secondary"
          size="$3"
          minHeight={44}
          disabled={retrying}
          onPress={onRetry}
        >
          {retrying ? <Spinner size="small" /> : null}
          Try again
        </Button>
      </XStack>
    </YStack>
  );
}
