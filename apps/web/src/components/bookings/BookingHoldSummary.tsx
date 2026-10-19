"use client";

import { useMemo } from "react";
import { XStack, YStack } from "tamagui";
import { Text, useFormatters, useTranslations } from "@th/ui";
import { Bookmark, Timer } from "lucide-react";

import { isoDateToLocal } from "@/lib/booking-requests";
import {
  holdCountdown,
  holdPositionKey,
  liveHolds,
  type BookingHoldSummary as HoldSummary,
} from "./booking-holds";

// ─────────────────────────────────────────────────────────────────────────────
// THE LIST-ROW HOLD LINE (booking-holds FR-011): one line per live hold —
// "Oct 13 · 2nd hold" — with the challenge clock as a chip when it is
// running and a muted "lapsed" when it has run out. Stacked under the stage
// rail, in the same slot the unread chip uses: a different KIND of fact from
// the stage, and the one a booker scans the Holds tab for.
//
// Renders NOTHING for a row with no live hold — an empty line would read as
// "no holds" on every row of every other tab, which is noise, not signal.
// ─────────────────────────────────────────────────────────────────────────────

export function BookingHoldSummary({
  holds,
  now,
  testIdBase,
}: {
  holds: readonly HoldSummary[];
  /** Injected so the table's rows share one clock and stay pure to render. */
  now: Date;
  testIdBase: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const live = useMemo(() => liveHolds(holds), [holds]);
  if (live.length === 0) return null;

  return (
    <YStack gap="$1" minWidth={0} data-testid={`${testIdBase}-holds`}>
      {live.map((hold) => {
        const countdown = holdCountdown(hold, now);
        const ordinal = String(
          t(holdPositionKey(hold.position), { position: String(hold.position) }),
        );
        return (
          <XStack
            key={hold.id}
            gap="$2"
            alignItems="center"
            flexWrap="wrap"
            minWidth={0}
            data-testid={`${testIdBase}-hold-${hold.id}`}
          >
            <Bookmark size={11} strokeWidth={2} aria-hidden style={{ opacity: 0.6, flexShrink: 0 }} />
            <Text variant="caption" style={{ fontVariantNumeric: "tabular-nums" }}>
              {String(
                t("admin.bkHoldSummary", {
                  date: fmt.dateTime(isoDateToLocal(hold.date), { dateStyle: "medium" }),
                  position: ordinal,
                }),
              )}
            </Text>
            {countdown?.kind === "lapsed" ? (
              <Text variant="caption" tone="muted" fontSize={10} textTransform="uppercase" letterSpacing={0.6}>
                {String(t("admin.bkHoldLapsed"))}
              </Text>
            ) : countdown ? (
              <XStack
                gap={3}
                alignItems="center"
                paddingHorizontal={6}
                minHeight={18}
                borderWidth={1}
                borderColor="$warning"
                data-testid={`${testIdBase}-hold-${hold.id}-clock`}
              >
                <Timer size={10} strokeWidth={2} aria-hidden color="currentColor" />
                <Text
                  variant="caption"
                  weight="bold"
                  fontSize={10}
                  letterSpacing={0.6}
                  textTransform="uppercase"
                  color="$warning"
                >
                  {countdown.kind === "hours"
                    ? String(t("admin.bkHoldHoursLeft", { hours: countdown.hours }))
                    : String(t("admin.bkHoldMinutesLeft", { minutes: countdown.minutes }))}
                </Text>
              </XStack>
            ) : null}
          </XStack>
        );
      })}
    </YStack>
  );
}
