"use client";

import { useId, type CSSProperties } from "react";
import { YStack, styled } from "tamagui";

import { Money, StyledSelect, Text, useTranslations } from "@th/ui";

import { calendarsForIntent } from "@/app/p/[slug]/_components/blocks/request-to-play-form.helpers";

import { Field, FieldLabel } from "./_form-bits";
import { BookingIntentControl } from "./BookingIntentControl";
import {
  INTENT_LABEL_KEYS,
  intentIsOffered,
  BOOKING_INTENTS,
  type BookingIntent,
  type BookingOptionCalendar,
  type BuilderPlacement,
} from "./builder-placement.helpers";

/**
 * The inline cascade under a THIRD-PARTY venue in the event builder
 * (Direction A, owner decision 2026-09-08): intent → calendar.
 *
 * THE SPACE PICKER IS GONE (owner ruling, extending the hold picker's — see
 * the block comment atop `components/bookings/HoldDatePicker.tsx`). The
 * organizer asks for a DATE on a CALENDAR; the venue names the room when it
 * accepts, on the draft event. The calendar's rooms are PRINTED under the
 * select, read-only, so the organizer still sees what the calendar covers.
 *
 * Presentational. `LocationSection` owns the options read
 * (`usePlaceBookingOptions`), the authority gate (owners and grant-holders
 * never mount this; a FAILED read mounts nothing either — fail-closed, the
 * event saves as an address), and the placement state; this component
 * renders one of three states from what it is handed:
 *
 *   · loading  — a skeleton line, not a spinner: the venue is already
 *                chosen and the picker above it is live, so nothing here
 *                should read as "the form is busy".
 *   · ready, no placement — the venue accepts nothing through Ithas Fire
 *                (opted out, or no calendar accepts any intent). One muted
 *                line, no controls.
 *   · ready    — the cascade. Unavailable intents render DISABLED with a
 *                one-line hint, never hidden. The calendar select lists only
 *                calendars accepting the chosen intent, with that calendar's
 *                rooms printed under it.
 *
 * Spacing comes from the parent's `gap` (LocationSection's place-mode
 * column), never from margins here. Labels use the builder's own
 * `FieldLabel` (`_form-bits`) so the cascade reads as part of the Location
 * field it sits under, and the select is named by a real `<label htmlFor>`
 * pointing at `StyledSelect`'s hidden native `<select>`.
 */

const SkeletonBar = styled(YStack, {
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
});

/** `minWidth: 0` so a long calendar name cannot push the select wider than
    its column — the cascade has to hold at 320px. */
const SelectField = styled(Field, { minWidth: 0 });

/** House idiom for "this string is user-typed and may not break on its own". */
const BREAK_ANYWHERE: CSSProperties = { overflowWrap: "anywhere" };

export type VenueBookingCascadeStatus = "loading" | "ready";

export type VenueBookingCascadeProps = {
  status: VenueBookingCascadeStatus;
  calendars: readonly BookingOptionCalendar[];
  /**
   * The placement to DISPLAY (the organizer's, the stored one on a hydrated
   * venue, or the derived defaults). Null with `status: "ready"` means the
   * venue is not taking requests.
   */
  placement: BuilderPlacement | null;
  onIntentChange: (intent: BookingIntent) => void;
  onCalendarChange: (calendarId: string) => void;
  testIdBase?: string;
};

export function VenueBookingCascade({
  status,
  calendars,
  placement,
  onIntentChange,
  onCalendarChange,
  testIdBase = "venue-booking",
}: VenueBookingCascadeProps) {
  const t = useTranslations();
  const idBase = useId();
  const intentLabelId = `${idBase}-intent-label`;
  const calendarSelectId = `${idBase}-calendar`;

  if (status === "loading") {
    return (
      <YStack gap={8} aria-busy data-testid={`${testIdBase}-loading`}>
        <SkeletonBar width={140} height={12} />
        <SkeletonBar height={44} />
      </YStack>
    );
  }

  if (!placement) {
    return (
      <Text
        variant="bodySmall"
        tone="muted"
        data-testid={`${testIdBase}-not-taking-requests`}
      >
        {String(t("admin.ebVenueNotTakingRequests"))}
      </Text>
    );
  }

  const offered = BOOKING_INTENTS.filter((intent) =>
    intentIsOffered(calendars, intent),
  );
  const someUnavailable = offered.length < BOOKING_INTENTS.length;
  const labels: Record<BookingIntent, string> = {
    PERFORM: String(t(INTENT_LABEL_KEYS.PERFORM)),
    RENT: String(t(INTENT_LABEL_KEYS.RENT)),
    USE: String(t(INTENT_LABEL_KEYS.USE)),
  };

  const acceptingCalendars = calendarsForIntent(
    calendars,
    placement.bookingIntent,
  );
  const calendar =
    calendars.find((c) => c.id === placement.calendarId) ?? null;
  const rooms = (calendar?.spaces ?? []).map((s) => s.name);
  const showRate =
    placement.bookingIntent === "RENT" &&
    calendar?.rentalRateVisible === true &&
    calendar.rentalRateCents !== null;

  return (
    <YStack gap={12} data-testid={`${testIdBase}-cascade`}>
      <Field>
        <FieldLabel id={intentLabelId}>{String(t("admin.ebIntentLabel"))}</FieldLabel>
        <BookingIntentControl
          value={placement.bookingIntent}
          offered={offered}
          onChange={onIntentChange}
          labels={labels}
          labelledBy={intentLabelId}
          idBase={idBase}
          testIdBase={`${testIdBase}-intent`}
        />
        {someUnavailable ? (
          <Text
            variant="caption"
            tone="muted"
            data-testid={`${testIdBase}-intent-hint`}
          >
            {String(t("admin.ebIntentUnavailableHint"))}
          </Text>
        ) : null}
      </Field>

      <SelectField>
        <label htmlFor={calendarSelectId} style={{ display: "block" }}>
          <FieldLabel>{String(t("admin.ebCalendar"))}</FieldLabel>
        </label>
        <StyledSelect
          selectId={calendarSelectId}
          testId={`${testIdBase}-calendar`}
          value={placement.calendarId}
          options={acceptingCalendars.map((c) => ({
            value: c.id,
            label: c.name,
          }))}
          onChange={onCalendarChange}
          size="lg"
          fullWidth
          borderRadius={0}
          minHeight={44}
          height={44}
        />
        {showRate && calendar ? (
          <Text
            variant="caption"
            tone="muted"
            data-testid={`${testIdBase}-rental-rate`}
          >
            {String(
              t("admin.ebRentalRate", {
                rate: Money.format(calendar.rentalRateCents ?? 0, {
                  currency: calendar.rentalRateCurrency ?? "USD",
                  showCents: "auto",
                }),
              }),
            )}
          </Text>
        ) : null}

        {/* Read-only on purpose: nothing downstream reads a room off a
            request, so a control here would promise a reservation the system
            never makes. Nothing at all when the calendar has no rooms — a
            bare "Rooms:" says less than silence. */}
        {rooms.length > 0 ? (
          <>
            <Text
              variant="bodySmall"
              tone="muted"
              // The " · " joins give break opportunities between names, but a
              // single long unbroken room name has none — and room names are
              // whatever the venue typed. Matches `.roomsLine` on the public
              // form (RequestToPlayBlock.module.css).
              style={BREAK_ANYWHERE}
              data-testid={`${testIdBase}-rooms`}
            >
              {String(t("admin.ebRooms", { rooms: rooms.join(" · ") }))}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("admin.ebRoomsHint"))}
            </Text>
          </>
        ) : null}
      </SelectField>

      <Text variant="caption" tone="muted">
        {String(t("admin.ebPlacementEditLater"))}
      </Text>
    </YStack>
  );
}

VenueBookingCascade.displayName = "VenueBookingCascade";
