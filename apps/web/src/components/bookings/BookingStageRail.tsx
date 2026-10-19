"use client";

import type { CSSProperties } from "react";
import { XStack, YStack, styled } from "tamagui";
import { Text, useFormatters, useTranslations } from "@th/ui";
import { AlertTriangle } from "lucide-react";

import type { BookingRequestStatus } from "@/lib/booking-requests";
import {
  describeBookingStages,
  type BookingStageState,
  type DescribeBookingStagesArgs,
} from "./booking-stage-rail";

/**
 * Visually hidden but read aloud. Local rather than a shared utility because
 * the app's only `.sr-only` class lives in `event-content.css`, which is not
 * loaded on admin or account routes — the same reason `PlaceAutocomplete`,
 * `CountryCombobox` and `AddressAutocompleteInput` each carry their own copy.
 */
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * One leg of the arc, as a 4px rule.
 *
 * A rule rather than a dot-and-line timeline: the same 4px track + lead-segment
 * grammar `DashboardContent`'s `SectionDivider` already uses, so the rail reads
 * as house structure instead of a new widget. `radius: 0` is inherited from the
 * content contract — this is content, not chrome.
 *
 * `accent` carries the CURRENT leg. Legal here and nowhere near the text rule:
 * it is a 4px graphic (the 3:1 non-text floor), never a label, and exactly one
 * segment per rail takes it, so twenty rows spend well under the 5% budget.
 */
const StageBar = styled(YStack, {
  name: "BookingStageBar",
  height: 4,
  borderRadius: 0,
  variants: {
    state: {
      done: { backgroundColor: "$color" },
      current: { backgroundColor: "$accent" },
      upcoming: { backgroundColor: "$borderColorSoft" },
      stopped: { backgroundColor: "$colorMuted" },
    },
  } as const,
});

export interface BookingStageRailProps {
  status: BookingRequestStatus;
  agreementStatus: string | null;
  eventId: string | null;
  eventStatus: string | null;
  eventStartsAt: Date | string | null;
  preferredDates: string[];
  /** The venue's vouch for the event — see `DescribeBookingStagesArgs`. */
  venueConfirmation?: DescribeBookingStagesArgs["venueConfirmation"];
  /**
   * - `compact` — the LIST form (table cell + mobile card). Leads with the one
   *   stage the booking is at, because twenty of these are being scanned at
   *   once and three stacked stage readouts per row is a wall.
   * - `full` — the expanded detail and the performer's own list, where there
   *   is room to show all three legs side by side.
   */
  variant?: "compact" | "full";
  /** Row-scoped testID base. The rail appends `-stage-rail`. */
  testIdBase: string;
}

/**
 * REQUEST → AGREEMENT → EVENT, made visible.
 *
 * WHY IT EXISTS: the list row used to compress the entire arc into one chip
 * reading `PENDING` — a word that describes only the first leg. Nothing said an
 * agreement existed, that it was out for review, that terms were agreed, or
 * that an event had been created; the thread logged all of it as a flat list of
 * events you had to read nine lines of and reconstruct "we're booked" from.
 *
 * IT REPLACES THE STATUS CHIP, it does not sit beside it. The request leg's
 * state word IS the chip's word (`BOOKING_STATUS_LABEL_KEYS`), so keeping both
 * would print the same fact twice — the inbox's Status column is now a Stage
 * column with the badge removed.
 *
 * ACCESSIBILITY — a rail is a PICTURE of state, so it is captioned, not
 * described piecemeal. Every visual part (the bars, the stage labels, the state
 * words, the date) is `aria-hidden`, and the whole arc is announced once as a
 * single visually-hidden sentence built by the SAME pure function that draws
 * the bars, so the two cannot drift. It is deliberately NOT a `progressbar`
 * (that role promises a measurable value and announces percentages, and a
 * declined booking has no percentage) and NOT a `tablist` (nothing here is
 * interactive). It takes no role at all: it is text in the flow, which is what
 * a caption is.
 */
export function BookingStageRail({
  status,
  agreementStatus,
  eventId,
  eventStatus,
  eventStartsAt,
  preferredDates,
  venueConfirmation,
  variant = "compact",
  testIdBase,
}: BookingStageRailProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  const view = describeBookingStages({
    status,
    agreementStatus,
    eventId,
    eventStatus,
    eventStartsAt,
    preferredDates,
    venueConfirmation,
    t: (key, values) => String(t(key, values)),
    formatDate: (value) => fmt.dateTime(value, { dateStyle: "medium" }),
  });

  const testId = `${testIdBase}-stage-rail`;

  // The caption. Rendered FIRST so it is what a screen reader reaches when it
  // enters the cell, and carried by a plain span so no role has to be invented
  // for a non-interactive graphic.
  const summary = (
    <span style={srOnly} data-testid={`${testId}-summary`}>
      {view.summary}
    </span>
  );

  const bars = (
    <XStack gap={2} aria-hidden minWidth={0}>
      {view.stages.map((stage) => (
        <StageBar
          key={stage.key}
          state={stage.state as BookingStageState}
          // Explicit, because Tamagui defaults `flexShrink: 0` (RN semantics):
          // without it three content-sized bars sit at their intrinsic width
          // and push the cell instead of dividing it.
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
          data-testid={`${testId}-bar-${stage.key}`}
          data-state={stage.state}
        />
      ))}
    </XStack>
  );

  if (variant === "compact") {
    const focus = view.stages[view.focusIndex] ?? view.stages[0]!;
    return (
      <YStack
        gap="$1"
        minWidth={0}
        // MEASURED at 1440px: the Stage cell renders 190px, but both inboxes
        // wrap this in a `YStack alignItems="flex-start"` (the unread chip
        // below needs it, or a stretched chip reads as a banner). That pins
        // the rail at its content width — 73px — so the three bars became a
        // stub in a 190px column instead of a scannable rule across it.
        // `alignSelf` overrides the parent's cross-axis for this child only.
        alignSelf="stretch"
        data-testid={testId}
      >
        {summary}
        {bars}
        <YStack gap="$1" minWidth={0} aria-hidden>
          <Text
            variant="caption"
            tone="muted"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={0.6}
          >
            {focus.label}
          </Text>
          <Text
            variant="bodySmall"
            weight="bold"
            tone={view.stopped ? "muted" : "default"}
          >
            {focus.value}
          </Text>
          {focus.meta ? (
            <XStack gap="$1" alignItems="center" minWidth={0}>
              {/* The booked date is on the row on purpose: the event's start
                  is seeded from the act's FIRST preferred date, which is
                  routinely not the night the two sides settled on, and this
                  line is the only place a venue can catch that without
                  opening the booking. */}
              <Text variant="caption" tone="muted">
                {focus.meta}
              </Text>
              {view.dateOffPitch ? (
                <span
                  title={String(t("admin.bkStageDateOffPitch"))}
                  style={{ display: "inline-flex", flexShrink: 0 }}
                  data-testid={`${testId}-off-pitch`}
                >
                  <AlertTriangle
                    size={12}
                    strokeWidth={2}
                    color="var(--warning, #92400E)"
                    aria-hidden
                  />
                </span>
              ) : null}
            </XStack>
          ) : null}
        </YStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$2" minWidth={0} data-testid={testId}>
      {summary}
      <div
        aria-hidden
        // GRID, not flex: three legs whose labels and state words must line up
        // across the row. `auto-fit` collapses to two columns and then one as
        // the panel narrows — at 320px inside the admin shell there is ~178px
        // of content, so the rail becomes a vertical timeline rather than
        // three unreadable slivers.
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 12,
          minWidth: 0,
        }}
      >
        {view.stages.map((stage) => (
          <YStack key={stage.key} gap="$1" minWidth={0}>
            <StageBar
              state={stage.state as BookingStageState}
              alignSelf="stretch"
              data-testid={`${testId}-bar-${stage.key}`}
              data-state={stage.state}
            />
            <Text
              variant="caption"
              tone="muted"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={0.6}
            >
              {stage.label}
            </Text>
            <Text
              variant="bodySmall"
              weight="bold"
              tone={
                stage.state === "upcoming" || stage.state === "stopped"
                  ? "muted"
                  : "default"
              }
            >
              {stage.value}
            </Text>
            {stage.meta ? (
              <Text variant="caption" tone="muted">
                {stage.meta}
              </Text>
            ) : null}
          </YStack>
        ))}
      </div>
      {view.dateOffPitch ? (
        <XStack
          gap="$2"
          alignItems="flex-start"
          minWidth={0}
          aria-hidden
          data-testid={`${testId}-off-pitch`}
        >
          <AlertTriangle
            size={13}
            strokeWidth={2}
            color="var(--warning, #92400E)"
            aria-hidden
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <Text
            variant="caption"
            tone="warning"
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            minWidth={0}
          >
            {String(t("admin.bkStageDateOffPitch"))}
          </Text>
        </XStack>
      ) : null}
    </YStack>
  );
}
