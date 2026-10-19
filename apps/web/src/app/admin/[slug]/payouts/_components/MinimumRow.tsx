"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { fmtCurrency } from "@/lib/format";
import { BORDER, FOREGROUND, WARNING } from "@/lib/design-tokens";

import {
  minimumMeterFraction,
  minimumVerdict,
  type PayoutHeadline,
} from "./payout-headline";

// ─────────────────────────────────────────────────────────────────────────────
// The minimum row: label · meter · "$X of $Y", then the one sentence
// the state needs. Four states, four different looks, on purpose:
//
//   below              amber rule + amber value, a plain explanation. Not an
//                      error — the rule working.
//   minimum-unresolved red "Couldn't check" chip, value "—". The balance is
//                      right; the verdict is unavailable.
//   payable-unresolved "Can't say" — the cascade from the panel's red Ready
//                      figure; this row cannot measure a number it lacks.
//   overdue            a separate red row beneath. An incident, and it says
//                      so — but the money is still theirs.
//
// A missing number is never a zero: the meter stays empty and the value
// goes blank whenever the verdict cannot be reached.
//
// CLEAR is one fact line ("Minimum $10.00 · clear", board B 2026-10-14): the
// minimum is a rule the organiser is subject to, so it stays on the page in
// every state, but a cleared rule needs no meter. The full row comes back
// only while the verdict is anything else.
// ─────────────────────────────────────────────────────────────────────────────

const EM_DASH = "—";

const meterTrackStyle = {
  position: "relative",
  flex: 1,
  minWidth: 80,
  height: 6,
  backgroundColor: BORDER,
} as const;

const figureStyle = { fontVariantNumeric: "tabular-nums" } as const;

export function MinimumRow({ headline }: { headline: PayoutHeadline }) {
  const t = useTranslations();
  const fmt = useFormatters();
  const money = (cents: number) => fmtCurrency(fmt, cents, headline.currency);

  const verdict = minimumVerdict(headline);
  const fraction = minimumMeterFraction(verdict);
  const measured = verdict.kind === "below" || verdict.kind === "clear";
  const below = verdict.kind === "below";

  const measuredText = measured
    ? String(
        t("admin.payoutsMinimumOf", {
          payable: money(verdict.payableCents),
          minimum: money(verdict.payoutMinimumCents),
        }),
      )
    : null;

  const valueText = (() => {
    switch (verdict.kind) {
      // Clear never reaches the full row (the fact line below returns
      // first); listed so the switch stays exhaustive.
      case "clear":
      case "below":
        return measuredText!;
      case "minimum-unresolved":
        return EM_DASH;
      default:
        return String(t("admin.payoutsCantSay"));
    }
  })();

  const sentence = (() => {
    switch (verdict.kind) {
      case "below":
        return String(
          t("admin.payoutsBelowMinimumReadyNote", {
            minimum: money(verdict.payoutMinimumCents),
          }),
        );
      case "minimum-unresolved":
        return String(t("admin.payoutsMinimumUnresolvedNote"));
      case "payable-unresolved":
        return String(t("admin.payoutsReadyUnresolvedNote"));
      case "unknown":
        // Unreachable by construction (see `MinimumVerdict`); if the server
        // ever widens the null this reads as the verdict being unavailable,
        // which is exactly what it would be.
        return String(t("admin.payoutsMinimumUnresolvedNote"));
      default:
        return null;
    }
  })();

  // A real meter only when there is a real range: valuemax equal to valuemin
  // is invalid ARIA, so a zero minimum (and every unmeasured state) is
  // decorative.
  const meterAria =
    measured && verdict.payoutMinimumCents > 0
      ? {
          role: "meter" as const,
          "aria-label": String(t("admin.payoutsMinimumLabel")),
          "aria-valuemin": 0,
          "aria-valuemax": verdict.payoutMinimumCents,
          "aria-valuenow": Math.max(
            0,
            Math.min(verdict.payableCents, verdict.payoutMinimumCents),
          ),
          "aria-valuetext": measuredText!,
        }
      : { "aria-hidden": true };

  const overdue = headline.payoutOverdue === true && (
    <YStack
      gap="$2"
      paddingVertical="$3"
      paddingHorizontal="$4"
      borderWidth={2}
      borderColor="$danger"
      borderRadius={0}
      data-testid="payout-overdue"
    >
      <Text variant="overline" tone="error">
        {String(t("admin.payoutsOverdueRow"))}
      </Text>
      <Text variant="bodySmall">{String(t("admin.payoutsOverdueNote"))}</Text>
    </YStack>
  );

  if (verdict.kind === "clear") {
    return (
      <YStack gap="$3" data-testid="payout-minimum-row">
        <Text
          variant="overline"
          tone="muted"
          style={figureStyle}
          data-testid="payout-minimum"
          data-state="clear"
        >
          {String(
            t("admin.payoutsMinimumFactClear", {
              minimum: money(verdict.payoutMinimumCents),
            }),
          )}
        </Text>
        {overdue}
      </YStack>
    );
  }

  return (
    <YStack gap="$3" data-testid="payout-minimum-row">
      <YStack
        gap="$2"
        paddingVertical="$3"
        paddingHorizontal="$4"
        borderWidth={2}
        borderColor={below ? "$warning" : "$borderColorSoft"}
        borderRadius={0}
        data-testid="payout-minimum"
        data-state={verdict.kind}
      >
        <XStack gap="$4" alignItems="center" flexWrap="wrap">
          <Text variant="overline" tone="muted">
            {String(t("admin.payoutsMinimumLabel"))}
          </Text>
          <div style={meterTrackStyle} {...meterAria}>
            <div
              style={{
                position: "absolute",
                inset: 0,
                width: `${Math.round(fraction * 100)}%`,
                backgroundColor: below ? WARNING : FOREGROUND,
              }}
            />
          </div>
          {verdict.kind === "minimum-unresolved" && (
            <Badge tone="danger" size="sm">
              {String(t("admin.payoutsCouldntCheck"))}
            </Badge>
          )}
          <Text
            variant="overline"
            tone={below ? "warning" : measured ? "default" : "muted"}
            style={figureStyle}
            data-testid="payout-minimum-value"
          >
            {valueText}
          </Text>
        </XStack>
        {sentence && (
          <Text variant="bodySmall" tone={below ? "warning" : "muted"}>
            {sentence}
          </Text>
        )}
      </YStack>

      {overdue}
    </YStack>
  );
}
