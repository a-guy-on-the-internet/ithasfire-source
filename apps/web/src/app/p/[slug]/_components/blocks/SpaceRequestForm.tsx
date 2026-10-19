"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Money, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import {
  BookingDatePicker,
  bookingAvailabilityInput,
} from "./BookingDatePicker";
import { BookingSubmitButton } from "./BookingSubmitButton";
import {
  BOOKING_ATTENDANCE_MAX,
  BOOKING_PURPOSE_MAX,
  buildSpaceRequestPayload,
  defaultCalendarId,
  isOvernightWindow,
  mapCreateBookingRequestError,
  spaceStandardsPayload,
  type BookingOptionCalendar,
  type BookingSender,
  type SpaceIntent,
} from "./request-to-play-form.helpers";
import {
  resolveStandardsList,
  type BookingStandardField,
  type BookingStandardsByIntent,
} from "./booking-standards.helpers";
import { BookingStandardsRail } from "./BookingStandardsRail";
import { useBookingStandards } from "./use-booking-standards";
import formStyles from "./RequestToPlayBlock.module.css";
import standardsStyles from "./BookingStandards.module.css";

/**
 * The RENT / USE variant of the booking request (venue-confirmation-and-
 * booking-intents spec, "Intents & who asks"): calendar → date + start/end →
 * what it is → expected attendance → contact. No pitch, no genre, no links —
 * a room hire is not an audition.
 *
 * THE SPACE PICKER IS GONE (owner ruling, extending the hold picker's — see
 * the block comment atop `components/bookings/HoldDatePicker.tsx`). The
 * request is for a DATE on a CALENDAR; the room is chosen at accept/confirm,
 * on the draft event, where it is real. A room picker here promised a
 * reservation the system never made. The calendar's rooms are PRINTED under
 * its name, read-only, so the requester still knows what they are asking for.
 *
 * The date comes from the same availability calendar "Play here" uses. A bare
 * date field could not say whether the venue is even open that day — for a
 * room hire, that is the question. `calendarId` feeds the picker and the
 * mutation from ONE state value (the invariant on
 * `BookingDatePicker.calendarId`): showing calendar B's open nights while
 * routing the request to calendar A rejects a date the UI just offered.
 *
 * The window is entered as the VENUE's wall clock. The zone comes from the
 * same availability read the picker makes — one React Query entry, because
 * both sides build the input with `bookingAvailabilityInput` rather than
 * deriving `from` twice — never from the viewer's browser: a requester in
 * Denver asking
 * for a Nashville room at 7pm means 7pm in Nashville. Until that read lands
 * the submit waits; if it fails the browser zone stands in and the venue
 * still reads the window in its own zone on the thread.
 *
 * Themed through the same `--th-color-*` custom properties as the pitch form
 * so the two variants are visually one form.
 */
export function SpaceRequestForm({
  placeId,
  placeName = null,
  placeStandards = null,
  intent,
  calendars,
  senders,
  onSuccess,
}: {
  placeId: string;
  /** For the standards panel ("What Marrow Hall expects"). */
  placeName?: string | null;
  /** The place-wide standards (only read when a calendar carries none). */
  placeStandards?: BookingStandardsByIntent | null;
  intent: SpaceIntent;
  /** Only calendars accepting `intent` — the panel never mounts this empty. */
  calendars: BookingOptionCalendar[];
  senders: BookingSender[];
  onSuccess: (result: { intent: SpaceIntent }) => void;
}) {
  const t = useTranslations();
  const idBase = useId();

  const [senderKey, setSenderKey] = useState(0);
  const [calendarId, setCalendarId] = useState<string>(
    () => defaultCalendarId(calendars) ?? "",
  );
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [purpose, setPurpose] = useState("");
  const [expectedAttendance, setExpectedAttendance] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sender = senders[Math.min(senderKey, senders.length - 1)];

  // The calendar list changes under us: the panel re-filters on intent, and
  // `usePlaceBookingOptions` refetches on window focus, which can drop the
  // chosen calendar mid-form. Keep the selection on a calendar that still
  // accepts the intent — and DROP THE DAY with it, exactly as the select's
  // own onChange does. A day picked against calendar Main, left standing
  // while this moves the routing to Side, is the `BOOKING_DATE_UNAVAILABLE`
  // the picker's `calendarId` invariant exists to prevent.
  useEffect(() => {
    if (!calendars.some((c) => c.id === calendarId)) {
      setCalendarId(defaultCalendarId(calendars) ?? "");
      setDate("");
    }
  }, [calendars, calendarId]);

  const calendar = useMemo(
    () => calendars.find((c) => c.id === calendarId) ?? null,
    [calendars, calendarId],
  );
  const rooms = (calendar?.spaces ?? []).map((s) => s.name);

  // Venue zone for the wall clock — see the component note. The input comes
  // from the picker's own builder so the two land on ONE React Query entry
  // per calendar instead of computing 62 days of availability twice.
  const availabilityQuery = trpc.places.getBookingAvailability.useQuery(
    bookingAvailabilityInput({ placeId, calendarId }),
    { staleTime: 60_000, retry: false, meta: { silent: true } },
  );
  const timeZone =
    availabilityQuery.data?.timezone ??
    (availabilityQuery.isError
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : null);

  const createMutation = trpc.bookingRequests.create.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const rate =
    intent === "RENT" &&
    calendar?.rentalRateVisible &&
    calendar.rentalRateCents !== null
      ? Money.format(calendar.rentalRateCents, {
          currency: calendar.rentalRateCurrency ?? undefined,
        })
      : null;

  const overnight = isOvernightWindow(startTime, endTime);
  const pending = createMutation.isPending;

  // ── What the place expects (venue-booking-standards FR-005) ──────────────
  // Follows the calendar the request routes to; the intent swap remounts
  // this form (the panel keys it by intent), so it swaps too.
  const standardsList = resolveStandardsList({
    calendar,
    placeStandards,
    intent,
  });
  const livePayload = spaceStandardsPayload({
    date,
    startTime,
    endTime,
    purpose,
    expectedAttendance,
    contactPhone,
    timeZone,
  });
  const controlIds = useMemo<Partial<Record<BookingStandardField, string>>>(
    () => ({
      REQUESTED_WINDOW: `${idBase}-start`,
      PURPOSE: `${idBase}-purpose`,
      EXPECTED_ATTENDANCE: `${idBase}-attendance`,
    }),
    [idBase],
  );
  const std = useBookingStandards({
    placeId,
    idBase,
    list: standardsList,
    intent,
    payload: livePayload,
    placeName,
    controlIds,
  });
  const hasRail = std.checklist !== null;
  const partClass = hasRail ? standardsStyles.part : standardsStyles.partFlat;
  /** A field's label, with the place's marker beside it when it lists one. */
  const labelRow = (field: BookingStandardField, label: ReactNode) => {
    const marker = std.marker(field);
    return marker ? (
      <div className={standardsStyles.labelRow}>
        {label}
        {marker}
      </div>
    ) : (
      label
    );
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !sender || !timeZone) return;

    const result = buildSpaceRequestPayload({
      intent,
      calendarId,
      date,
      startTime,
      endTime,
      purpose,
      expectedAttendance,
      contactPhone,
      timeZone,
    });
    if (!result.ok) {
      std.flagLive();
      setError(String(t(result.errorKey)));
      return;
    }

    // V1: REQUIRED items block Send here too, over the BUILT payload.
    const unmet = std.gate(result.payload);
    if (unmet) {
      setError(unmet);
      return;
    }

    setError(null);
    createMutation.mutate(
      {
        performerOwnerType: sender.ownerType,
        performerOwnerId: sender.ownerId,
        placeId,
        ...result.payload,
      },
      {
        onSuccess: () => onSuccess({ intent }),
        onError: (err) => {
          setError(
            std.serverError(err) ??
              String(t(mapCreateBookingRequestError(err))),
          );
        },
      },
    );
  };

  const optional = ` · ${String(t("admin.bkFormOptional"))}`;

  return (
    <div className={standardsStyles.container}>
    <form
      className={
        hasRail
          ? `${formStyles.panel} ${standardsStyles.withRail}`
          : formStyles.panel
      }
      onSubmit={handleSubmit}
      aria-label={String(
        t(intent === "RENT" ? "admin.bkIntentRent" : "admin.bkIntentUse"),
      )}
    >
      <div className={`${partClass} ${standardsStyles.head}`}>
      {senders.length > 1 && (
        <div className={formStyles.fieldGroup}>
          <label className={formStyles.fieldLabel} htmlFor={`${idBase}-sender`}>
            {String(t("admin.bkFormSenderLabel"))}
          </label>
          <select
            id={`${idBase}-sender`}
            className={formStyles.select}
            value={senderKey}
            onChange={(e) => setSenderKey(Number(e.target.value))}
          >
            {senders.map((s, i) => (
              <option key={`${s.ownerType}-${s.ownerId}`} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      </div>

      {std.checklist && (
        <BookingStandardsRail
          idBase={idBase}
          placeId={placeId}
          placeName={placeName}
          calendarName={calendar?.name ?? null}
          checklist={std.checklist}
        />
      )}

      <div className={`${partClass} ${standardsStyles.body}`}>
      {/* ── The space ─────────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-space`}
      >
        <p className={formStyles.sectionHeading} id={`${idBase}-sec-space`}>
          {String(t("admin.bkFormSectionSpace"))}
        </p>

        {/* The calendar is the routing input now that the room is not one.
            Unlike the PERFORM form, a single calendar is PRINTED rather than
            hidden: the rental rate hangs off the calendar, so the requester
            has to see which one the price belongs to. */}
        <div className={formStyles.fieldGroup}>
          {calendars.length > 1 ? (
            <>
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-calendar`}
              >
                {String(t("admin.bkFormCalendarLabel"))}
              </label>
              <select
                id={`${idBase}-calendar`}
                className={formStyles.select}
                value={calendarId}
                onChange={(e) => {
                  setCalendarId(e.target.value);
                  // The day was picked against the old calendar's nights.
                  setDate("");
                }}
              >
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            calendar && (
              <>
                <span className={formStyles.fieldLabel}>
                  {String(t("admin.bkFormCalendarLabel"))}
                </span>
                <p className={formStyles.readOnlyValue}>{calendar.name}</p>
              </>
            )
          )}

          {/* Read-only on purpose: nothing downstream reads a room off a
              request, so a control here would promise a reservation the
              system never makes. Nothing at all when the calendar has no
              rooms — a bare "Rooms:" says less than silence. */}
          {rooms.length > 0 && (
            <>
              <p className={formStyles.roomsLine}>
                {String(
                  t("admin.bkFormRooms", { rooms: rooms.join(" · ") }),
                )}
              </p>
              <p className={formStyles.fieldHint}>
                {String(t("admin.bkFormRoomsHint"))}
              </p>
            </>
          )}
        </div>

        {rate && (
          <div className={formStyles.fieldGroup}>
            <p className={formStyles.rateLine}>
              {String(t("admin.bkFormRentalRate", { rate }))}
            </p>
            <p className={formStyles.fieldHint}>
              {String(t("admin.bkFormRentalRateHint"))}
            </p>
          </div>
        )}
      </div>

      {/* ── When ──────────────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-when`}
      >
        <p className={formStyles.sectionHeading} id={`${idBase}-sec-when`}>
          {String(t("admin.bkFormSectionWhen"))}
        </p>

        <div className={formStyles.fieldGroup}>
          {labelRow(
            "REQUESTED_WINDOW",
            <span className={formStyles.fieldLabel}>
              {String(t("admin.bkFormDateLabel"))}
            </span>,
          )}
          <BookingDatePicker
            placeId={placeId}
            {...(calendarId ? { calendarId } : {})}
            mode="date"
            value={date ? [date] : []}
            onChange={(next) => setDate(next[0] ?? "")}
            max={1}
            disabled={pending}
          />
        </div>

        <div className={formStyles.fieldRow}>
          <div className={formStyles.fieldGroup}>
            <label
              className={formStyles.fieldLabel}
              htmlFor={`${idBase}-start`}
            >
              {String(t("admin.bkFormStartLabel"))}
            </label>
            <input
              id={`${idBase}-start`}
              type="time"
              className={formStyles.input}
              value={startTime}
              required
              aria-describedby={std.describedBy("REQUESTED_WINDOW")}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div className={formStyles.fieldGroup}>
            <label className={formStyles.fieldLabel} htmlFor={`${idBase}-end`}>
              {String(t("admin.bkFormEndLabel"))}
            </label>
            <input
              id={`${idBase}-end`}
              type="time"
              className={formStyles.input}
              value={endTime}
              required
              aria-describedby={std.describedBy("REQUESTED_WINDOW")}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
        </div>
        <p className={formStyles.fieldHint}>
          {String(t("admin.bkFormWindowHint"))}
          {overnight ? ` ${String(t("admin.bkFormEndsNextDay"))}` : ""}
        </p>
        {std.line("REQUESTED_WINDOW")}
      </div>

      {/* ── What it's for ─────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-what`}
      >
        <p className={formStyles.sectionHeading} id={`${idBase}-sec-what`}>
          {String(t("admin.bkFormSectionWhat"))}
        </p>

        <div className={formStyles.fieldGroup}>
          {labelRow(
            "PURPOSE",
            <label
              className={formStyles.fieldLabel}
              htmlFor={`${idBase}-purpose`}
            >
              {String(t("admin.bkFormPurposeLabel"))}
            </label>,
          )}
          <input
            id={`${idBase}-purpose`}
            type="text"
            className={formStyles.input}
            maxLength={BOOKING_PURPOSE_MAX}
            value={purpose}
            required
            aria-describedby={std.describedBy("PURPOSE")}
            placeholder={String(t("admin.bkFormPurposePlaceholder"))}
            onChange={(e) => setPurpose(e.target.value)}
          />
          {std.line("PURPOSE")}
        </div>

        <div className={formStyles.fieldGroup}>
          {labelRow(
            "EXPECTED_ATTENDANCE",
            <label
              className={formStyles.fieldLabel}
              htmlFor={`${idBase}-attendance`}
            >
              {String(t("admin.bkFormAttendanceLabel"))}
              {std.optionalSuffix("EXPECTED_ATTENDANCE")}
            </label>,
          )}
          <input
            id={`${idBase}-attendance`}
            type="number"
            inputMode="numeric"
            min={1}
            max={BOOKING_ATTENDANCE_MAX}
            step={1}
            className={formStyles.input}
            value={expectedAttendance}
            aria-required={std.isRequired("EXPECTED_ATTENDANCE") || undefined}
            aria-invalid={std.invalid("EXPECTED_ATTENDANCE")}
            aria-describedby={std.describedBy("EXPECTED_ATTENDANCE")}
            onChange={(e) => {
              std.clear("EXPECTED_ATTENDANCE");
              setExpectedAttendance(e.target.value);
            }}
          />
          {std.line("EXPECTED_ATTENDANCE")}
        </div>
      </div>

      {/* ── Contact ───────────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-contact`}
      >
        <p className={formStyles.sectionHeading} id={`${idBase}-sec-contact`}>
          {String(t("admin.bkFormSectionContact"))}
        </p>

        <div className={formStyles.fieldGroup}>
          <label className={formStyles.fieldLabel} htmlFor={`${idBase}-phone`}>
            {String(t("admin.bkFormPhoneLabel"))}
            {optional}
          </label>
          <input
            id={`${idBase}-phone`}
            type="tel"
            inputMode="tel"
            maxLength={30}
            className={formStyles.input}
            value={contactPhone}
            placeholder={String(t("admin.bkFormPhonePlaceholder"))}
            onChange={(e) => setContactPhone(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <p className={formStyles.errorText} role="alert" aria-live="assertive">
          {error}
        </p>
      )}

      <div className={formStyles.submitRow}>
        <BookingSubmitButton pending={pending || !timeZone} />
      </div>
      </div>
    </form>
    </div>
  );
}
