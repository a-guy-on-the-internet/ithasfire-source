"use client";

import { useMemo } from "react";
import { styled, useTheme, XStack, YStack } from "tamagui";
import { Banknote } from "lucide-react";
import { Text, Link, useFormatters, useTranslations } from "@th/ui";
import { useParams } from "next/navigation";
import type { PayoutSchedule } from "@th/types";

import {
  PAYOUT_DATE_FORMAT,
  expectedPayoutDate,
} from "@/lib/payouts/expected-payout-date";
import { getPreviewDateTimeIso } from "./event-builder-helpers";

const Container = styled(YStack, {
  gap: 24,
  padding: 32,
  backgroundColor: "$surface",
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
});

const SectionTitle = styled(Text, {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "$color",
  tag: "span",
});

const InfoCard = styled(XStack, {
  padding: 14,
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  gap: 12,
  alignItems: "flex-start",
  backgroundColor: "$surfaceMuted",
});

const IconContainer = styled(XStack, {
  width: 36,
  height: 36,
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$surface",
});

/**
 * Default payout schedule applied to new payout terms (mirrors the
 * `PayoutTerms.payoutSchedule` DB default). Used as the display fallback before
 * terms are snapshotted for an event.
 */
const DEFAULT_PAYOUT_SCHEDULE: PayoutSchedule = "TWO_WEEKS_AFTER";

export type EventFinanceSettingsProps = {
  eventId: string;
  payoutSchedule: PayoutSchedule | null;
  /**
   * The builder's wall-clock start and end (`YYYY-MM-DDTHH:mm` in
   * `eventTimezone`). The expected date is core's own rule, from the END
   * (start when there is none), the same basis the credit writer uses.
   */
  eventStartsAt?: string | null;
  eventEndsAt?: string | null;
  /** IANA zone the wall-clock values are in. Without it there is no date. */
  eventTimezone?: string;
};

export function EventFinanceSettings({
  eventId,
  payoutSchedule,
  eventStartsAt,
  eventEndsAt,
  eventTimezone,
}: EventFinanceSettingsProps) {
  const theme = useTheme();
  const t = useTranslations();
  const fmt = useFormatters();
  const { slug } = useParams<{ slug: string }>();

  const scheduleLabel = (schedule: PayoutSchedule): string => {
    switch (schedule) {
      case "ASAP":
        return String(t("admin.ebPayoutSchedAsapNextDay"));
      case "WEEK_OF_EVENT":
        return String(t("admin.ebPayoutSchedWeekOf"));
      case "ONE_WEEK_AFTER":
        return String(t("admin.ebPayoutSchedOneWeek"));
      case "TWO_WEEKS_AFTER":
        return String(t("admin.ebPayoutSchedTwoWeeks"));
      case "FOUR_WEEKS_AFTER":
        return String(t("admin.ebPayoutSchedFourWeeks"));
    }
  };
  const effectiveSchedule = payoutSchedule ?? DEFAULT_PAYOUT_SCHEDULE;

  const expectedDate = useMemo(() => {
    if (!eventTimezone) return null;
    try {
      return expectedPayoutDate(effectiveSchedule, {
        startsAt: getPreviewDateTimeIso(eventStartsAt ?? undefined, eventTimezone),
        endsAt: getPreviewDateTimeIso(eventEndsAt ?? undefined, eventTimezone),
      });
    } catch {
      // A half-typed date or an unknown zone mid-edit: show the "set a
      // date" line rather than crash the builder. Not a swallowed failure,
      // just input that isn't a date yet.
      return null;
    }
  }, [effectiveSchedule, eventStartsAt, eventEndsAt, eventTimezone]);

  return (
    <Container data-testid="event-finance-settings">
      <YStack gap={12}>
        <SectionTitle>{String(t("admin.ebPayoutSchedule"))}</SectionTitle>

        {/* Primary schedule card */}
        <InfoCard>
          <IconContainer>
            <Banknote size={18} color={theme.success?.val} />
          </IconContainer>
          <YStack flex={1} gap={4}>
            <Text
              tag="span"
              style={{ fontSize: 15, fontWeight: "700" }}
              color="$color"
            >
              {String(
                t("admin.ebPayoutValue", {
                  label: scheduleLabel(effectiveSchedule),
                }),
              )}
            </Text>
            {expectedDate ? (
              <Text tag="span" style={{ fontSize: 13 }} tone="muted">
                {String(
                  t("admin.ebPayoutExpected", {
                    date: fmt.dateTime(expectedDate, PAYOUT_DATE_FORMAT),
                  }),
                )}
              </Text>
            ) : (
              <Text tag="span" style={{ fontSize: 13 }} tone="muted">
                {String(t("admin.ebPayoutSetDate"))}
              </Text>
            )}
          </YStack>
        </InfoCard>

        <Link
          href={`/admin/${slug}/payouts`}
          color="$accent"
          style={{
            fontSize: 13,
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          {String(t("admin.ebPayoutManageInPayouts"))}
        </Link>
      </YStack>
    </Container>
  );
}

export default EventFinanceSettings;
