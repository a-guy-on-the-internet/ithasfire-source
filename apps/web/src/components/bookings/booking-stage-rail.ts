import {
  BOOKING_STATUS_LABEL_KEYS,
  isoDateToLocal,
  type BookingRequestStatus,
} from "@/lib/booking-requests";

// ─────────────────────────────────────────────────────────────────────────────
// A booking travels REQUEST → AGREEMENT → EVENT.
//
// `BookingRequest.status` describes only the FIRST leg of that arc, and it is
// the only thing the list rows ever showed: a lone `PENDING` chip, with nothing
// to say whether an agreement exists, whether it is out for review, whether
// terms were agreed, or whether an event was created. You had to open the
// request, read the thread, and reconstruct "we're booked" yourself.
//
// This module turns the four projected fields on `BookingRequestSummary`
// (`agreementStatus` / `eventId` / `eventStatus` / `eventStartsAt`) into the
// three-stage view a rail renders.
//
// PURE ON PURPOSE. No JSX, no hooks, no lucide — the whole decision table is a
// function of (row, translator, date formatter), which is what makes every
// stage combination cheap to pin in a test. `BookingStageRail.tsx` is the only
// renderer, and it renders nothing this file did not decide.
//
// DEGRADES, NEVER THROWS. The server resolves the stage projection in one
// batched pass and drops EVERY row's four fields to null when that pass fails
// (see `resolveBookingStages` in `list-booking-requests.ts`). So null means
// "not there yet OR we could not tell" — it is rendered as "nothing to show
// here", never as a definite negative and never as a wrong stage. Statuses this
// build has never heard of (a rollback behind a newer writer) fall through to a
// neutral in-progress label rather than crashing the inbox.
// ─────────────────────────────────────────────────────────────────────────────

/** The three legs, in arc order. */
export type BookingStageKey = "request" | "agreement" | "event";

/**
 * How a stage renders.
 *
 * - `done` — happened, and the booking has moved past it — OR the stage
 *   reached its terminal-GOOD state (a FULFILLED agreement, a COMPLETED
 *   event). "Current" means "this is where the booking is waiting", and a
 *   settled stage is not waiting on anything.
 * - `current` — the furthest point the booking has reached and is still
 *   moving through. At most one stage carries this on a live booking; a
 *   fully settled booking (event COMPLETED) has none.
 * - `upcoming` — not reached. Reads as "not yet", never as a failure.
 * - `stopped` — the arc ended. On a stopped booking EVERY reached stage takes
 *   this state, so the whole rail goes quiet at once instead of leaving a
 *   half-lit rail that still reads as progress.
 */
export type BookingStageState = "done" | "current" | "upcoming" | "stopped";

export type BookingStageView = {
  key: BookingStageKey;
  /** Stage name — "Request" / "Agreement" / "Event". */
  label: string;
  /** What that stage is at — "Pending", "Out for review", "Published". */
  value: string;
  /**
   * A quieter second line. Today this is the booked date on the event stage;
   * null on every stage that has nothing to add.
   */
  meta: string | null;
  state: BookingStageState;
};

export type BookingStageRailView = {
  /** Always three, always in arc order. */
  stages: BookingStageView[];
  /**
   * The stage the compact form leads with — where the booking IS. The last
   * stage reached, or the stage the arc stopped at.
   */
  focusIndex: number;
  /** The arc ended (declined / withdrawn / expired, at any stage). */
  stopped: boolean;
  /**
   * The booked date is not one of the dates the act asked for.
   *
   * LOAD-BEARING, not decoration. `createEventFromAgreement` seeds the event's
   * start from the act's FIRST preferred date, which is frequently not the
   * night the two sides settled on in the thread — a real booking agreed
   * Sep 25 in conversation and produced an event dated Sep 18, silently. This
   * flag is the venue's only chance to catch that from a list row.
   *
   * Compared in the VIEWER'S LOCAL FRAME, deliberately: `eventStartsAt` is an
   * instant, `preferredDates` are wall-clock date strings, and both are
   * rendered here with the viewer's locale. Comparing in any other frame lets
   * the rail contradict the two dates printed next to it. False on an
   * unparseable start, and false when there are no preferred dates to compare
   * against — an absent comparison is not a mismatch.
   */
  dateOffPitch: boolean;
  /**
   * The whole arc as one sentence — the ONLY thing assistive tech is given.
   * See the docblock on `BookingStageRail` for why the bars and their labels
   * are aria-hidden rather than described piecemeal.
   */
  summary: string;
};

/**
 * Values are `string` only: every interpolation here is pre-formatted (a
 * locale date, an already-localized stage value), so nothing is left for
 * IntlMessageFormat to number/date-format and the catalogs need no skeletons.
 */
type Translate = (key: string, values?: Record<string, string>) => string;

/** Internal per-stage verdict, before cross-stage state resolution. */
type StageFact = {
  /** Whether this leg exists at all. An unreached stage has no facts. */
  reached: boolean;
  /** Terminal-negative: the arc ended here. */
  stopped: boolean;
  /**
   * Terminal-GOOD: this leg is finished and nothing is pending on it, so it
   * renders `done` even when it is the furthest leg reached. Absent means
   * "in progress" (the default).
   */
  settled?: boolean;
  /** Message key for the state word, when reached. */
  valueKey: string;
};

const UNREACHED: StageFact = {
  reached: false,
  stopped: false,
  valueKey: "",
};

/**
 * Request-leg verdict. The state words are the SAME six the status chip used
 * (`BOOKING_STATUS_LABEL_KEYS`) — this stage absorbs that chip rather than
 * repeating it, which is why the inbox's Status column is now a Stage column
 * with no separate badge.
 */
function requestFact(status: BookingRequestStatus): StageFact {
  const valueKey =
    BOOKING_STATUS_LABEL_KEYS[status] ?? "admin.bkStageUnknownState";
  switch (status) {
    case "DECLINED":
    case "WITHDRAWN":
    case "EXPIRED":
      return { reached: true, stopped: true, valueKey };
    default:
      // PENDING / VIEWED / ACCEPTED — and anything a newer writer adds.
      return { reached: true, stopped: false, valueKey };
  }
}

/**
 * Agreement-leg verdict.
 *
 * SIX of the nine enum members are written today — `DRAFT`, `PROPOSED`,
 * `ACCEPTED`, `DECLINED`, `CANCELLED`, and `FULFILLED`. CANCELLED is the
 * terms editor's walk-away (`cancelBookingAgreement`, from DRAFT / PROPOSED /
 * unfinalized ACCEPTED): terminal-BAD like DECLINED, so the leg stops.
 * FULFILLED has exactly one writer:
 * `completeEvent` moves the linked ACCEPTED agreement to FULFILLED when the
 * event is marked COMPLETED (money settles per payee, not per event, so "the
 * show happened" is the trigger — see `appendBookingEventCompletedEntry` in
 * core). It is terminal-GOOD: the leg is `settled`, so it renders `done`
 * rather than `current` — a fulfilled agreement is not waiting on anyone.
 *
 * `COUNTERED`, `EXPIRED` and `DISPUTED` still exist in the enum with nothing
 * writing them, so they are handled (a future row must not crash a venue's
 * inbox) but the happy path is not designed around them.
 */
function agreementFact(status: string | null): StageFact {
  // Falsy, NOT `=== null`. `undefined` is precisely what a row builder that
  // forgot the field hands us, and a strict null check let it through as
  // "reached" — a booking with no agreement at all then drew a lit agreement
  // leg reading "In progress". CAUGHT by an existing inbox fixture, not
  // hypothesised. The empty string is covered by the same guard.
  if (!status) return UNREACHED;
  switch (status) {
    case "DRAFT":
      return {
        reached: true,
        stopped: false,
        valueKey: "admin.bkStageAgrDraft",
      };
    case "PROPOSED":
      return {
        reached: true,
        stopped: false,
        valueKey: "admin.bkStageAgrProposed",
      };
    case "COUNTERED":
      return {
        reached: true,
        stopped: false,
        valueKey: "admin.bkStageAgrCountered",
      };
    case "ACCEPTED":
      return {
        reached: true,
        stopped: false,
        valueKey: "admin.bkStageAgrAccepted",
      };
    case "FULFILLED":
      return {
        reached: true,
        stopped: false,
        settled: true,
        valueKey: "admin.bkStageAgrFulfilled",
      };
    case "DECLINED":
      return {
        reached: true,
        stopped: true,
        valueKey: "admin.bkStageAgrDeclined",
      };
    case "CANCELLED":
      return {
        reached: true,
        stopped: true,
        valueKey: "admin.bkStageAgrCancelled",
      };
    case "EXPIRED":
      return {
        reached: true,
        stopped: true,
        valueKey: "admin.bkStageAgrExpired",
      };
    case "DISPUTED":
      return {
        reached: true,
        stopped: true,
        valueKey: "admin.bkStageAgrDisputed",
      };
    default:
      // A status this build has never heard of. It exists — say so plainly,
      // and never guess whether it is good or bad news.
      return {
        reached: true,
        stopped: false,
        valueKey: "admin.bkStageUnknownState",
      };
  }
}

/**
 * Event-leg verdict.
 *
 * Keyed on `eventId`, because that is the field the contract guarantees: the
 * event triple is all-or-nothing, so a non-null id means the status and start
 * are present too. The `eventId && !eventStatus` branch is therefore
 * unreachable by contract and exists only so a contract change degrades to a
 * vague label instead of a blank stage.
 *
 * `DRAFT` vs `PUBLISHED` is the difference between "we made a placeholder" and
 * "it is live and selling", so the stage says which — an "an event exists"
 * label would waste the one field that carries the news. `COMPLETED` is the
 * show having happened: terminal-good, `settled`, so the whole rail reads
 * done-done-done with nothing left "current".
 */
function eventFact(eventId: string | null, status: string | null): StageFact {
  // Falsy, NOT `=== null` — see the note in `agreementFact`.
  if (!eventId) return UNREACHED;
  switch (status) {
    case "DRAFT":
      return {
        reached: true,
        stopped: false,
        valueKey: "admin.eventStatusDraft",
      };
    case "PUBLISHED":
      return {
        reached: true,
        stopped: false,
        valueKey: "admin.eventStatusPublished",
      };
    case "COMPLETED":
      return {
        reached: true,
        stopped: false,
        settled: true,
        valueKey: "admin.eventStatusCompleted",
      };
    case "CANCELLED":
      return {
        reached: true,
        stopped: true,
        valueKey: "admin.eventStatusCancelled",
      };
    case "ARCHIVED":
      return {
        reached: true,
        stopped: true,
        valueKey: "admin.eventStatusArchived",
      };
    default:
      return {
        reached: true,
        stopped: false,
        valueKey: "admin.bkStageUnknownState",
      };
  }
}

/** Local `YYYY-MM-DD`, or null for an unparseable date. */
function localDayKey(value: Date): string | null {
  const time = value.getTime();
  if (!Number.isFinite(time)) return null;
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function isDateOffPitch(
  eventStartsAt: Date | null,
  preferredDates: string[],
): boolean {
  if (eventStartsAt === null) return false;
  const booked = localDayKey(eventStartsAt);
  if (booked === null) return false;
  const asked = preferredDates
    .map((raw) => localDayKey(isoDateToLocal(raw)))
    .filter((key): key is string => key !== null);
  // No dates to compare against is not a mismatch — it is an absent
  // comparison, and a warning nobody can act on is worse than no warning.
  if (asked.length === 0) return false;
  return !asked.includes(booked);
}

/**
 * The venue's stance on the booking's event, as the list row projects it
 * (`BookingRequestSummary.venueConfirmation.state`). Plain `string` for the
 * same reason the statuses are: a state this build has never heard of must
 * render as "nothing to add", not crash the inbox.
 */
export type BookingVenueConfirmationState =
  | "none"
  | "confirmed"
  | "withdrawn"
  | "unconfirmed";

/**
 * The state word for each vouch state — shared with the thread's
 * confirmation action so the rail and the action can never disagree about
 * what "confirmed" is called. `none` has no word: nothing to say.
 */
export const VENUE_CONFIRMATION_LABEL_KEYS: Record<
  Exclude<BookingVenueConfirmationState, "none">,
  string
> = {
  confirmed: "admin.bkStageVcConfirmed",
  unconfirmed: "admin.bkStageVcAwaiting",
  withdrawn: "admin.bkStageVcWithdrawn",
};

export type DescribeBookingStagesArgs = {
  status: BookingRequestStatus;
  agreementStatus: string | null;
  eventId: string | null;
  eventStatus: string | null;
  eventStartsAt: Date | string | null;
  preferredDates: string[];
  /**
   * The venue's vouch (venue-confirmation spec, docs/specs/2026-08-27 "The
   * existing stage rail gains the confirmation state"). Optional and
   * nullable: older callers and degraded projections pass nothing, and the
   * event leg then reads exactly as it did before this existed.
   */
  venueConfirmation?: { state: BookingVenueConfirmationState | string } | null;
  t: Translate;
  /** The app's locale-aware date formatter (`useFormatters().dateTime`). */
  formatDate: (value: Date) => string;
};

const STAGE_LABEL_KEYS: Record<BookingStageKey, string> = {
  request: "admin.bkStageRequest",
  agreement: "admin.bkStageAgreement",
  event: "admin.bkStageEvent",
};

const STAGE_ORDER: BookingStageKey[] = ["request", "agreement", "event"];

export function describeBookingStages({
  status,
  agreementStatus,
  eventId,
  eventStatus,
  eventStartsAt,
  preferredDates,
  venueConfirmation,
  t,
  formatDate,
}: DescribeBookingStagesArgs): BookingStageRailView {
  // The vouch rides the EVENT leg's value line — "Draft · Confirmed by
  // venue" — so one line says both what the event is and whether the venue
  // stands behind it, and the caption sentence inherits it for free. Only a
  // state with a word (never `none`, never an unknown) changes anything.
  const confirmationKey =
    venueConfirmation &&
    venueConfirmation.state in VENUE_CONFIRMATION_LABEL_KEYS
      ? VENUE_CONFIRMATION_LABEL_KEYS[
          venueConfirmation.state as keyof typeof VENUE_CONFIRMATION_LABEL_KEYS
        ]
      : null;
  const facts: Record<BookingStageKey, StageFact> = {
    request: requestFact(status),
    agreement: agreementFact(agreementStatus),
    event: eventFact(eventId, eventStatus),
  };

  const startsAt = !eventStartsAt
    ? null
    : eventStartsAt instanceof Date
      ? eventStartsAt
      : new Date(eventStartsAt);
  const validStartsAt =
    startsAt !== null && Number.isFinite(startsAt.getTime()) ? startsAt : null;
  const dateOffPitch = isDateOffPitch(validStartsAt, preferredDates);

  const reachedIndexes = STAGE_ORDER.map((key, index) =>
    facts[key]!.reached ? index : -1,
  ).filter((index) => index >= 0);
  const stoppedIndexes = STAGE_ORDER.map((key, index) =>
    facts[key]!.stopped ? index : -1,
  ).filter((index) => index >= 0);

  const stopped = stoppedIndexes.length > 0;
  // Where the booking IS: the point it died, or the furthest point it reached.
  // `?? 0` is unreachable (the request stage is always reached) and is there so
  // a future stage set cannot produce an out-of-range index.
  const focusIndex = stopped
    ? stoppedIndexes[0]!
    : (reachedIndexes[reachedIndexes.length - 1] ?? 0);

  const stages: BookingStageView[] = STAGE_ORDER.map((key, index) => {
    const fact = facts[key]!;
    const label = t(STAGE_LABEL_KEYS[key]!);
    if (!fact.reached) {
      return {
        key,
        label,
        // "Not yet" on a live booking is a promise; on a dead one it is a
        // lie. A stopped arc says the stage was never reached instead.
        value: t(stopped ? "admin.bkStageNotReached" : "admin.bkStageNotYet"),
        meta: null,
        state: "upcoming" as const,
      };
    }
    const value =
      key === "event" && confirmationKey !== null
        ? t("admin.bkStageEventWithConfirmation", {
            status: t(fact.valueKey),
            confirmation: t(confirmationKey),
          })
        : t(fact.valueKey);
    return {
      key,
      label,
      value,
      meta:
        key === "event" && validStartsAt !== null
          ? formatDate(validStartsAt)
          : null,
      // On a stopped arc every reached stage goes quiet together — see
      // `BookingStageState`. A settled (terminal-good) leg is `done` even
      // when it is the focus: `focusIndex` still points at it (it IS where
      // the booking is), but nothing there is pending.
      state: stopped
        ? ("stopped" as const)
        : index < focusIndex || fact.settled
          ? ("done" as const)
          : ("current" as const),
    };
  });

  const eventStage = stages[2]!;
  const summary =
    t("admin.bkStageSummary", {
      request: stages[0]!.value,
      agreement: stages[1]!.value,
      event:
        eventStage.meta === null
          ? eventStage.value
          : t("admin.bkStageEventWithDate", {
              status: eventStage.value,
              date: eventStage.meta,
            }),
    }) + (dateOffPitch ? ` ${t("admin.bkStageDateOffPitch")}` : "");

  return { stages, focusIndex, stopped, dateOffPitch, summary };
}
