"use client";

import { YStack, XStack, Card, Spinner } from "tamagui";

import { Text, Button, useTranslations, useFormatters } from "@th/ui";
import type { EstimateResaleListingOutput } from "@th/core/use-cases/resale";

import { fmtCurrency } from "@/lib/format";

type ResaleSplitCardProps = {
  /** The server's answer for the ask in the field, or null while there is none. */
  split: EstimateResaleListingOutput | null;
  /** An ask is in the field and its answer has not landed. */
  pending: boolean;
  /** The read failed: the refusal, in words. */
  errorMessage: string | null;
  /** What the seller paid for this ticket. */
  paidCents: number;
  /** The seller took the highest ask that fits. */
  onUseAsk: (cents: number) => void;
};

/** One line of the split: a label (with an optional note under it) and an amount. */
function SplitRow({
  label,
  note,
  amount,
  strong = false,
  first = false,
}: {
  label: string;
  note?: string | null;
  amount: string;
  strong?: boolean;
  first?: boolean;
}) {
  return (
    <XStack
      alignItems="center"
      flexWrap="wrap"
      columnGap="$3"
      rowGap="$1"
      paddingVertical="$2"
      borderTopWidth={first ? 0 : 1}
      borderTopColor="$borderColor"
    >
      <YStack flexGrow={1} flexShrink={1} flexBasis={130} minWidth={0}>
        <Text variant="bodySmall" weight={strong ? "bold" : "medium"}>
          {label}
        </Text>
        {note ? (
          <Text variant="caption" tone="muted">
            {note}
          </Text>
        ) : null}
      </YStack>
      <Text
        variant="bodySmall"
        weight={strong ? "bold" : "medium"}
        flexShrink={0}
        style={{ whiteSpace: "nowrap" }}
      >
        {amount}
      </Text>
    </XStack>
  );
}

/**
 * What a listing at this ask would do (organiser-resale-share FR-008, NFR-002):
 * the ask, the share to the people who put on the night, what the seller
 * receives. Every figure is the server's (`resale.estimateListing`); this card
 * only lays them out. Over the ticket's limit it names the highest ask that
 * fits and offers it.
 */
export function ResaleSplitCard({
  split,
  pending,
  errorMessage,
  paidCents,
  onUseAsk,
}: ResaleSplitCardProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  if (errorMessage) {
    return (
      <Text variant="bodySmall" tone="muted" role="alert">
        {errorMessage}
      </Text>
    );
  }

  if (!split) {
    if (!pending) return null;
    return (
      <XStack gap="$2" alignItems="center" data-testid="resell-split-pending">
        <Spinner size="small" />
        <Text variant="bodySmall" tone="muted">
          {String(t("resell.splitLoading"))}
        </Text>
      </XStack>
    );
  }

  const money = (cents: number) => fmtCurrency(fmt, cents, split.currency);
  const sellerPays = split.payer === "SELLER";
  const lessThanPaid = split.sellerReceivesCents < paidCents;

  return (
    <Card
      padding="$3"
      $gtXs={{ padding: "$4" }}
      gap="$2"
      borderRadius={0}
      role="group"
      aria-labelledby="resell-split-title"
      data-testid="resell-split"
    >
      <Text
        id="resell-split-title"
        variant="bodySmall"
        tag="h3"
        weight="bold"
        textTransform="uppercase"
        letterSpacing={1}
      >
        {String(t("resell.splitTitle"))}
      </Text>

      <YStack>
        <SplitRow
          first
          label={String(t("resell.askingPriceLabel"))}
          amount={money(split.askPriceCents)}
        />
        <SplitRow
          label={String(t("resell.shareLineLabel"))}
          note={
            split.shareHeld && split.heldFromCents !== null
              ? String(
                  t("resell.shareHeldNote", {
                    amount: money(split.heldFromCents),
                  }),
                )
              : String(
                  t(
                    sellerPays
                      ? "resell.shareNoteSeller"
                      : "resell.shareNoteBuyer",
                  ),
                )
          }
          amount={`${sellerPays ? "−" : "+"}${money(split.shareCents)}`}
        />
        <SplitRow
          strong
          label={String(t("resell.youReceive"))}
          amount={money(split.sellerReceivesCents)}
        />
      </YStack>

      <Text variant="caption" tone="muted">
        {String(
          t(sellerPays ? "resell.buyerPaysSeller" : "resell.buyerPaysBuyer", {
            amount: money(split.basisCents),
          }),
        )}{" "}
        {String(t("resell.noPlatformCut"))}
      </Text>

      {lessThanPaid ? (
        <Text variant="caption" tone="muted">
          {String(
            t("resell.lessThanPaid", {
              amount: money(paidCents - split.sellerReceivesCents),
            }),
          )}
        </Text>
      ) : null}

      {!split.withinCap ? (
        <YStack gap="$2" role="alert" id="resell-split-overcap">
          <Text variant="bodySmall" color="$red10" weight="bold">
            {String(
              t("resell.overLimit", {
                amount: money(split.capCents ?? 0),
              }),
            )}
          </Text>
          {split.highestFittingAskCents ? (
            <XStack width="100%">
              <Button
                variant="secondary"
                size="$2"
                minHeight={44}
                height="auto"
                width="100%"
                paddingVertical="$2"
                textProps={{ whiteSpace: "normal", textAlign: "center" }}
                onPress={() => onUseAsk(split.highestFittingAskCents ?? 0)}
              >
                {String(
                  t("resell.useHighestAsk", {
                    amount: money(split.highestFittingAskCents),
                  }),
                )}
              </Button>
            </XStack>
          ) : null}
        </YStack>
      ) : null}
    </Card>
  );
}
