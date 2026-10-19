import type { BookingSystemEntryKind } from "@th/types";
import { normalizeLegacySystemEntry } from "@th/core/lib/legacy-place-values";

import { holdPositionKey } from "./booking-holds";
import { lookupOwn } from "@/lib/lookup-own";

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM ENTRIES → one ledger line.
//
// The booking thread is the booking's TIMELINE: human messages interleaved
// with rows recording every lifecycle transition. A row is a KIND plus PARAMS
// (`systemKind` / `systemData`), never a sentence — the sentence is built here
// from the en/es catalogs so it localizes and can carry a link.
//
// PURE ON PURPOSE. No JSX, no lucide, no hooks: the whole per-kind decision
// table is a function of (kind, params, translator), which is what makes every
// kind cheap to pin in a test. The renderer maps `icon` to a glyph.
//
// FORWARD-COMPATIBLE BY CONSTRUCTION. A row can carry a kind this build has
// never heard of (a rollback behind a newer writer — see the READ POSTURE note
// on `BookingSystemEntryKind`), so an unrecognized kind returns `null` and the
// caller skips the row. Params are read DEFENSIVELY for the same reason: every
// field is `unknown` until proven, and a malformed one degrades to a shorter
// sentence rather than throwing or printing "undefined".
//
// NO NAMES. `authorHumanId` on the row is an id, and the messages list does not
// project a display name for it. Every string here is therefore written to read
// without one ("Agreement sent for review", never "Sent for review by Dana").
// `actorSide` is a SIDE, not a person, and rides the meta line as its own
// label so it can simply be omitted when the row does not carry a valid one.
// ─────────────────────────────────────────────────────────────────────────────

/** Glyph vocabulary — resolved to a Lucide component by the renderer. */
export type BookingEntryIcon =
  | "send"
  | "eye"
  | "clock"
  | "undo"
  | "check"
  | "x"
  | "file"
  | "fileCheck"
  | "fileX"
  | "calendarPlus"
  | "calendarClock"
  | "calendarCheck"
  | "calendarX"
  | "circleCheck"
  | "hold"
  | "holdReorder"
  | "holdClock"
  | "holdX"
  | "holdCheck"
  | "assigned";

export type BookingSystemEntryView = {
  icon: BookingEntryIcon;
  /** The log sentence, already localized. */
  text: string;
  /**
   * A second, quieter line: the decline reason, or the before/after of a
   * reschedule. Null when the entry has nothing to add.
   */
  detail: string | null;
  /** "by the venue" / "by the performer". Null when the row names no side. */
  actorLabel: string | null;
  /** `/agreements/{id}` target, when the entry is about a document. */
  agreementId: string | null;
  /**
   * The event this entry is about. A LINK only if the caller can build one —
   * the thread alone cannot (see `eventAdminSlug` on BookingThread).
   */
  eventId: string | null;
};

/**
 * Values are `string` only — every interpolation here is pre-formatted (a
 * locale date, a joined field list, a decline reason), so nothing is left for
 * IntlMessageFormat to number/date-format and the catalogs never need a `date`
 * or `number` skeleton.
 */
type Translate = (key: string, values?: Record<string, string>) => string;

export type DescribeBookingSystemEntryArgs = {
  systemKind: string | null;
  systemData: Record<string, unknown> | null;
  t: Translate;
  /** The app's locale-aware date formatter (`useFormatters().dateTime`). */
  formatDateTime: (value: Date) => string;
  /**
   * Formatter for a place-local CALENDAR DAY (a hold's `date`, `YYYY-MM-DD`)
   * — date only, no clock. Optional so older callers keep working; without it
   * the day is formatted through `formatDateTime`, which would print a
   * midnight that the hold never had.
   */
  formatDate?: (value: Date) => string;
  /** Viewer locale, for the changed-field list. */
  locale: string;
  /**
   * WHICH SIDE IS READING (booking-holds FR-013). The hold entries are the
   * one family whose sentence changes with the reader: the venue's ledger
   * says "Hold placed for Oct 13 — 2nd in line" (a line it keeps), the act's
   * says "You're 2nd in line for Oct 13" (a place it holds). Same row, same
   * params, two sentences. Optional so every other caller — and every
   * non-hold kind — keeps the venue wording unchanged.
   */
  viewerSide?: "VENUE" | "PERFORMER";
};

// ── Defensive param readers ──────────────────────────────────────────────────

function readString(
  data: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 8-4-4-4-12 hex. Not a version/variant check — this is a SHAPE guard, and the
 * shape is what makes the value safe to interpolate.
 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id read off `systemData`, or null. `systemData` is NOT re-validated on
 * read (port doc on `BookingRequestMessageRow.systemData`) and `readString`
 * only proves `typeof === "string"` — but these two ids are interpolated into
 * URL PATHS (`/agreements/{id}`, `/admin/{slug}/events/{id}`), which is the sink
 * the house `safeHref` rule exists for. `safeHref` alone would not help here:
 * the path it would see already starts with `/admin/`, so a traversal or
 * query-injecting segment inside the id passes its scheme check untouched.
 *
 * The only writer validates with `z.string().uuid()`, so a non-uuid is
 * unreachable today; the guard is what keeps it unreachable if a future writer
 * (or a hand-edited row) is looser. An id that fails is DROPPED, which degrades
 * the entry to no link — the same posture every other reader in this file
 * takes.
 */
function readId(
  data: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = readString(data, key);
  return value && UUID_SHAPE.test(value) ? value : null;
}

/**
 * Timestamps in `systemData` are ISO-8601 STRINGS, never Dates — the column is
 * Json, which has no date type. An unparseable one yields null and the caller
 * falls back to a date-free sentence.
 */
function readDate(
  data: Record<string, unknown> | null,
  key: string,
): Date | null {
  const raw = readString(data, key);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A hold's `date` is an ISO calendar day (`YYYY-MM-DD`), place-local, with no
 * clock. Parsed as a LOCAL date (`T00:00:00`) — a bare `new Date("2026-10-13")`
 * is UTC midnight and renders as the previous day west of Greenwich.
 */
function readCalendarDay(
  data: Record<string, unknown> | null,
  key: string,
): Date | null {
  const raw = readString(data, key);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readPosition(
  data: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = data?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

/**
 * Position → the catalog key for its ordinal. ONE table for every hold
 * surface (`admin.bkHoldPosition*`, incl. the CLDR ordinal category past 3
 * so 21 is "21st", never "21th") — the thread used to carry a duplicate.
 */
const positionKey = (position: number): string => holdPositionKey(position);

/**
 * `reason` on `booking_hold.released` mirrors the Prisma release-reason enum.
 * Unknown values are DROPPED (a future reason must not print its identifier).
 */
const HOLD_RELEASE_REASON_KEYS: Record<string, string> = {
  MANUAL: "booking.entryHoldReleasedManual",
  EXPIRED: "booking.entryHoldReleasedExpired",
  CONFIRMED_OTHER: "booking.entryHoldReleasedConfirmedOther",
  REQUEST_CLOSED: "booking.entryHoldReleasedRequestClosed",
  SIBLING_CONFIRMED: "booking.entryHoldReleasedSiblingConfirmed",
  PAST_DATE: "booking.entryHoldReleasedPastDate",
  EVENT_SCHEDULED: "booking.entryHoldReleasedEventScheduled",
};

/**
 * Reasons whose act-side detail is its own sentence (FR-018): the act is told
 * the venue scheduled an event and that their request survives, not the
 * venue's terse ledger line. Reasons absent here reuse the venue key.
 */
const HOLD_RELEASE_REASON_ACT_KEYS: Record<string, string> = {
  EVENT_SCHEDULED: "booking.entryHoldReleasedEventScheduledAct",
};

function readStringArray(
  data: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = data?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * The two sides a transition can be attributed to. Anything else — a corrupt
 * row, a side this build does not know — reads as "no attribution", which
 * simply drops the label rather than guessing a party.
 */
function readActorSide(
  data: Record<string, unknown> | null,
): "PLACE" | "PERFORMER" | null {
  const value = data?.actorSide;
  return value === "PLACE" || value === "PERFORMER" ? value : null;
}

/**
 * `changedFields` is drawn from a known set, but it is a bounded array of free
 * strings on the wire. Unknown names are DROPPED rather than printed raw: a
 * column name is not copy, and a future field would otherwise leak its
 * identifier into the UI.
 */
const CHANGED_FIELD_KEYS: Record<string, string> = {
  title: "booking.entryEventFieldTitle",
  startsAt: "booking.entryEventFieldStartsAt",
  endsAt: "booking.entryEventFieldEndsAt",
  location: "booking.entryEventFieldLocation",
  calendar: "booking.entryEventFieldCalendar",
  space: "booking.entryEventFieldSpace",
  timezone: "booking.entryEventFieldTimezone",
};

/**
 * Locale-correct "a, b and c". `Intl.ListFormat` is in every runtime this ships
 * to, but it is guarded anyway — a formatter throwing inside a render would
 * take the whole thread down over a cosmetic join.
 */
function joinFields(items: string[], locale: string): string {
  if (items.length <= 1) return items[0] ?? "";
  try {
    return new Intl.ListFormat(locale || "en", {
      style: "long",
      type: "conjunction",
    }).format(items);
  } catch {
    return items.join(", ");
  }
}

/**
 * Build the one line a system entry renders as, or `null` when the kind is not
 * one this build knows (skip the row — never print the raw kind).
 */
export function describeBookingSystemEntry({
  systemKind: rawKind,
  systemData: rawData,
  t,
  formatDateTime,
  formatDate,
  locale,
  viewerSide,
}: DescribeBookingSystemEntryArgs): BookingSystemEntryView | null {
  // The API already sends the current spelling; this also reads a row in its
  // pre-2026-10-18 spelling (an API build from before the rename, for the
  // length of a deploy) exactly as the new one.
  const { systemKind, systemData } = normalizeLegacySystemEntry({
    systemKind: rawKind,
    systemData: rawData,
  });
  if (!systemKind) return null;
  const formatDay = formatDate ?? formatDateTime;
  const asAct = viewerSide === "PERFORMER";
  /** The act-side key when the act is reading, else the venue's. */
  const sided = (key: string) => (asAct ? `${key}Act` : key);

  const actorSide = readActorSide(systemData);
  const actorLabel =
    actorSide === "PLACE"
      ? t("booking.entryActorVenue")
      : actorSide === "PERFORMER"
        ? t("booking.entryActorPerformer")
        : null;

  const agreementId = readId(systemData, "agreementId");
  const eventId = readId(systemData, "eventId");
  const reason = readString(systemData, "reason");
  const reasonDetail = reason ? t("booking.entryReason", { reason }) : null;

  const base = {
    detail: null as string | null,
    actorLabel,
    agreementId,
    eventId: null as string | null,
  };

  // The switch is over a WIDENED string, not the union, so an unknown kind is a
  // runtime `default` rather than a type error — but `kind` is typed as the
  // union inside each arm, so adding a kind upstream without a case here still
  // shows up as a missing branch in review.
  const kind = systemKind as BookingSystemEntryKind;
  switch (kind) {
    // ── Request lifecycle ────────────────────────────────────────────────────
    case "booking_request.opened": {
      // DEGRADE, DON'T GUESS. `direction` decides WHO the request went to,
      // which is the entire content of this sentence — so an unreadable one
      // drops to the direction-free line rather than defaulting to "to the
      // venue" and asserting a party the row never named. (`!== "TO_PERFORMER"`
      // did exactly that: a null `systemData` read as a venue request.)
      // `source` is different — it only says HOW it arrived, so anything but an
      // explicit "EMBED" correctly falls back to the plain wording, which stays
      // true either way.
      const direction = systemData?.direction;
      const embed = systemData?.source === "EMBED";
      const key =
        direction === "TO_PLACE"
          ? embed
            ? "booking.entryRequestOpenedToVenueEmbed"
            : "booking.entryRequestOpenedToVenue"
          : direction === "TO_PERFORMER"
            ? embed
              ? "booking.entryRequestOpenedToPerformerEmbed"
              : "booking.entryRequestOpenedToPerformer"
            : "booking.entryRequestOpened";
      return { ...base, icon: "send", text: t(key) };
    }
    case "booking_request.viewed":
      return { ...base, icon: "eye", text: t("booking.entryRequestViewed") };
    case "booking_request.expired": {
      const expiresAt = readDate(systemData, "expiresAt");
      return {
        ...base,
        icon: "clock",
        text: expiresAt
          ? t("booking.entryRequestExpired", {
              date: formatDateTime(expiresAt),
            })
          : t("booking.entryRequestExpiredNoDate"),
      };
    }
    case "booking_request.withdrawn":
      return { ...base, icon: "undo", text: t("booking.entryRequestWithdrawn") };
    case "booking_request.accepted":
      return { ...base, icon: "check", text: t("booking.entryRequestAccepted") };
    case "booking_request.declined":
      return {
        ...base,
        icon: "x",
        text: t("booking.entryRequestDeclined"),
        detail: reasonDetail,
      };

    // ── Agreement negotiation ────────────────────────────────────────────────
    case "booking_agreement.drafted":
      return { ...base, icon: "file", text: t("booking.entryAgreementDrafted") };
    case "booking_agreement.sent_for_review":
      return {
        ...base,
        icon: "file",
        text: t("booking.entryAgreementSentForReview"),
      };
    case "booking_agreement.countered":
      return {
        ...base,
        icon: "file",
        text: t("booking.entryAgreementCountered"),
      };
    case "booking_agreement.accepted":
      return {
        ...base,
        icon: "fileCheck",
        text: t("booking.entryAgreementAccepted"),
      };
    case "booking_agreement.declined":
      return {
        ...base,
        icon: "fileX",
        text: t("booking.entryAgreementDeclined"),
        detail: reasonDetail,
      };
    case "booking_agreement.cancelled":
      // The editor's walk-away; the reason is the whole point of the row.
      return {
        ...base,
        icon: "fileX",
        text: t("booking.entryAgreementCancelled"),
        detail: reasonDetail,
      };
    case "booking_agreement.pulled_back":
      return {
        ...base,
        icon: "file",
        text: t("booking.entryAgreementPulledBack"),
      };
    case "booking_agreement.reopened":
      return {
        ...base,
        icon: "file",
        text: t("booking.entryAgreementReopened"),
      };
    case "booking_agreement.finalized":
      return {
        ...base,
        icon: "fileCheck",
        text: t("booking.entryAgreementFinalized"),
      };
    case "booking_agreement.fulfilled":
      return {
        ...base,
        icon: "fileCheck",
        text: t("booking.entryAgreementFulfilled"),
      };

    // ── Event ────────────────────────────────────────────────────────────────
    // Event entries link the EVENT, never the agreement, even though
    // `booking_event.created` carries both: one link per line, and the
    // agreement is already linked from the entries above it.
    case "booking_event.created": {
      const startsAt = readDate(systemData, "startsAt");
      return {
        ...base,
        icon: "calendarPlus",
        agreementId: null,
        eventId,
        text: startsAt
          ? t("booking.entryEventCreated", { date: formatDateTime(startsAt) })
          : t("booking.entryEventCreatedNoDate"),
      };
    }
    case "booking_event.modified": {
      const labels = readStringArray(systemData, "changedFields")
        .map((field) => CHANGED_FIELD_KEYS[field])
        .filter((key): key is string => Boolean(key))
        .map((key) => t(key));
      const previous = readDate(systemData, "previousStartsAt");
      const next = readDate(systemData, "nextStartsAt");
      return {
        ...base,
        icon: "calendarClock",
        agreementId: null,
        eventId,
        text: labels.length
          ? t("booking.entryEventModified", {
              fields: joinFields(labels, locale),
            })
          : t("booking.entryEventModifiedGeneric"),
        detail:
          previous && next
            ? t("booking.entryEventMoved", {
                from: formatDateTime(previous),
                to: formatDateTime(next),
              })
            : null,
      };
    }
    case "booking_event.published": {
      const startsAt = readDate(systemData, "startsAt");
      return {
        ...base,
        icon: "calendarCheck",
        agreementId: null,
        eventId,
        text: startsAt
          ? t("booking.entryEventPublished", { date: formatDateTime(startsAt) })
          : t("booking.entryEventPublishedNoDate"),
      };
    }
    case "booking_event.cancelled":
      return {
        ...base,
        icon: "calendarX",
        agreementId: null,
        eventId,
        text: t("booking.entryEventCancelled"),
      };
    case "booking_event.completed":
      return {
        ...base,
        icon: "circleCheck",
        agreementId: null,
        eventId,
        text: t("booking.entryEventCompleted"),
      };

    // ── Venue confirmation (docs/specs/2026-08-27) ───────────────────────────
    // The venue vouching for the event at its place, or taking that back.
    // `ownerSide` is whose event it is; the sentence is the same either way
    // (the thread already knows who the parties are). The withdrawal's reason
    // rides `detail`, like a decline's.
    case "booking_event.place_confirmed":
      return {
        ...base,
        icon: "calendarCheck",
        agreementId: null,
        eventId,
        text: t("booking.entryEventVenueConfirmed"),
      };
    case "booking_event.place_confirmation_withdrawn":
      return {
        ...base,
        icon: "calendarX",
        agreementId: null,
        eventId,
        text: t("booking.entryEventVenueConfirmationWithdrawn"),
        detail: reasonDetail,
      };

    // ── Holds (booking-holds spec 2026-08-25, FR-012) ────────────────────────
    // Hold entries are about a DATE and a PLACE IN LINE, never about who else
    // is in it — the act reads this same ledger (FR-013) and must never learn
    // another act's name or the line's length from it. `holdId` is carried by
    // every kind but is not a link target (holds have no page).
    //
    // SIDED COPY. Every hold key has an `…Act` twin, picked by `sided()` when
    // `viewerSide` is PERFORMER: the venue reads "Hold challenged — keep or
    // release by …", the act reads "The venue asked you to keep or release
    // your hold by …". Same params either way, so a catalog miss on one side
    // is caught by the same exhaustive test as the other.
    case "booking_hold.placed": {
      const day = readCalendarDay(systemData, "date");
      const position = readPosition(systemData, "position");
      const ordinal = position
        ? t(positionKey(position), { position: String(position) })
        : null;
      return {
        ...base,
        icon: "hold",
        text:
          day && ordinal
            ? t(sided("booking.entryHoldPlaced"), { date: formatDay(day), position: ordinal })
            : day
              ? t(sided("booking.entryHoldPlacedNoPosition"), { date: formatDay(day) })
              : t(sided("booking.entryHoldPlacedNoDate")),
      };
    }
    case "booking_hold.reordered": {
      const from = readPosition(systemData, "from");
      const to = readPosition(systemData, "to");
      return {
        ...base,
        icon: "holdReorder",
        text:
          from && to
            ? t(sided("booking.entryHoldReordered"), {
                from: t(positionKey(from), { position: String(from) }),
                to: t(positionKey(to), { position: String(to) }),
              })
            : t(sided("booking.entryHoldReorderedGeneric")),
      };
    }
    case "booking_hold.challenged": {
      const respondBy = readDate(systemData, "respondBy");
      return {
        ...base,
        icon: "holdClock",
        text: respondBy
          ? t(sided("booking.entryHoldChallenged"), { date: formatDateTime(respondBy) })
          : t(sided("booking.entryHoldChallengedNoDate")),
      };
    }
    case "booking_hold.extended": {
      const respondBy = readDate(systemData, "respondBy");
      return {
        ...base,
        icon: "holdClock",
        text: respondBy
          ? t(sided("booking.entryHoldExtended"), { date: formatDateTime(respondBy) })
          : t(sided("booking.entryHoldExtendedNoDate")),
      };
    }
    case "booking_hold.kept":
      return { ...base, icon: "holdCheck", text: t(sided("booking.entryHoldKept")) };
    case "booking_hold.released": {
      const reasonKey = lookupOwn(HOLD_RELEASE_REASON_KEYS, reason);
      // MANUAL is written for BOTH a staff release and the act's own release
      // (answer-booking-hold-challenge writes the same reason). Newer rows
      // carry `by: "act" | "staff"` so the copy can name the author
      // truthfully; older rows (and every non-manual cause) omit it, and then
      // the sentence must not guess — the act gets the reason for every
      // OTHER cause and nothing for MANUAL.
      const byRaw = readString(systemData, "by");
      const by = byRaw === "act" || byRaw === "staff" ? byRaw : undefined;
      const manualByKey =
        reason === "MANUAL" && by === "act"
          ? "booking.entryHoldReleasedManualByAct"
          : reason === "MANUAL" && by === "staff"
            ? "booking.entryHoldReleasedManual"
            : null;
      const detailKey = asAct
        ? reasonKey && reason !== "MANUAL"
          ? (lookupOwn(HOLD_RELEASE_REASON_ACT_KEYS, reason) ?? reasonKey)
          : null
        : (manualByKey ?? reasonKey ?? null);
      const actTextKey =
        by === "act"
          ? "booking.entryHoldReleasedByYouAct"
          : by === "staff"
            ? "booking.entryHoldReleasedByVenueAct"
            : "booking.entryHoldReleasedAct";
      return {
        ...base,
        icon: "holdX",
        text: asAct ? t(actTextKey) : t("booking.entryHoldReleased"),
        // `reason` here is an enum word, not prose — never the generic
        // "Reason: {reason}" line, which would print "Reason: MANUAL".
        detail: detailKey ? t(detailKey) : null,
      };
    }
    case "booking_hold.confirmed":
      return {
        ...base,
        icon: "holdCheck",
        agreementId: null,
        // Nullable on the wire: the entry is written before the event mints.
        eventId,
        text: t(sided("booking.entryHoldConfirmed")),
      };

    // ── Assignment (FR-015) ──────────────────────────────────────────────────
    // Venue-internal. The row carries ids only and the ledger names nobody, so
    // this says "assigned" / "unassigned" and leaves the who to the picker.
    case "booking_request.assigned": {
      const assignee = readId(systemData, "assigneeHumanId");
      return {
        ...base,
        icon: "assigned",
        text: assignee
          ? t("booking.entryRequestAssigned")
          : t("booking.entryRequestUnassigned"),
      };
    }

    // ── Parked at an unclaimed venue (venue-confirmation spec 2026-08-27) ──
    // The request is complete but nobody can answer it until the place is
    // claimed. Neither row carries params; the sentence is the whole state,
    // and it reads the same from either side.
    case "booking_request.parked_unclaimed":
      return {
        ...base,
        icon: "clock",
        text: t("booking.entryRequestParkedUnclaimed"),
      };
    case "booking_request.unparked":
      return {
        ...base,
        icon: "send",
        text: t("booking.entryRequestUnparked"),
      };
    // ── P3a (unclaimed venues) ── the cleanup expired a request parked
    // before the 2026-09-25 amendment. The place name is a snapshot, shown
    // as text; without one the sentence says "This place".
    case "booking_request.expired_unclaimed": {
      const place = readString(systemData, "placeName");
      return {
        ...base,
        icon: "clock",
        text: place
          ? t("booking.entryRequestExpiredUnclaimed", { place })
          : t("booking.entryRequestExpiredUnclaimedNoName"),
      };
    }

    // ── The bill (lineup-booking-requests v2, FR-003) ────────────────────────
    // Minimal rendering; the full bill UI (incl. hiding declined acts from
    // the venue, FR-004) is a later step. `actName` is a snapshot string,
    // interpolated as text. Without it there is nothing honest to say, so the
    // entry renders as nothing rather than "undefined confirmed…".
    case "booking_request.act_confirmed":
    case "booking_request.act_declined": {
      const actName = readString(systemData, "actName");
      if (!actName) return null;
      const confirmed = kind === "booking_request.act_confirmed";
      return {
        ...base,
        icon: confirmed ? "circleCheck" : "x",
        text: t(
          confirmed
            ? "booking.entryRequestActConfirmed"
            : "booking.entryRequestActDeclined",
          { actName },
        ),
      };
    }
    default:
      // A kind from a newer build. Renderable as nothing — never as a raw key.
      return null;
  }
}
