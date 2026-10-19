"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { XStack, YStack, styled } from "tamagui";
import {
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  BookmarkCheck,
  BookmarkX,
  ExternalLink,
  Plus,
  Send,
  Timer,
} from "lucide-react";

import { trpc } from "@/trpc";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { HoldDatePicker } from "./HoldDatePicker";
import { formatErrorMessage } from "@/lib/format-error-message";
import { isoDateToLocal } from "@/lib/booking-requests";
import {
  holdBookingActions,
  type BookingEventState,
  type HoldBookingReason,
} from "./hold-booking-actions";
import {
  defaultChallengeDeadline,
  fromDateTimeLocalValue,
  holdCountdown,
  holdDateFromPreferred,
  HOLD_ACTION_TOUCH,
  holdPositionKey,
  isChallengeDeadlineTooLate,
  isChallengeDeadlineValid,
  isExtendDeadlineValid,
  maxChallengeDeadline,
  liveHolds,
  toDateTimeLocalValue,
  type BookingHoldSummary,
} from "./booking-holds";
import { DateTimeLocalInput } from "@/components/forms/DateTimeLocalInput";

// ─────────────────────────────────────────────────────────────────────────────
// HOLDS STRIP — the venue's line, per request (booking-holds spec 2026-08-25,
// FR-012). Sits directly under the stage rail in the expanded row: holds are
// a STATE of the request stage, not a leg of their own, so they read as an
// annotation on the rail rather than a fourth bar.
//
// ONE ROW PER LIVE HOLD: "Oct 13 · 2nd hold", the challenge clock when one is
// running, and the staff actions the server allows for that row —
//   · Reorder (up / down)   any live hold; the server renumbers the line
//   · Challenge             position 1, ACTIVE — starts the keep-or-release
//                           clock (24h by default, ≥ 1h, editable here)
//   · Extend                CHALLENGED and not lapsed — pushes the deadline
//   · Release               any live hold — the line moves up
//   · Send terms            1st hold, draft terms (booking-the-night FR-003)
//   · Book without terms    1st hold on a night the pitch asked for (FR-004):
//                           accepts the request if still open, mints the
//                           draft event, releases siblings and competitors
// The old hold "Confirm" is gone: the server refuses it for every
// request-linked hold (HOLD_CONFIRM_RETIRED, FR-005), and every hold today
// hangs off a request. Which of the two booking actions a row offers is
// `holdBookingActions` (hold-booking-actions.ts), which mirrors the server's
// refusals from the row's data and says why when one is withheld.
// plus "Place hold", which opens `HoldDatePicker` — a month grid that takes
// as many nights as one `placeMany` can carry. The old three-select form (one
// date, one calendar, one SPACE, one hold per submit) went with the
// 2026-08-31 rulings: a hold is a place in line for a DATE on a CALENDAR, and
// the room is chosen later, at confirm, on the draft event.
//
// THE ROW DATA IS THE LIST ROW'S. `holds` come from `bookingRequests.list`
// (already on every row), so opening a request issues no extra read; every
// mutation invalidates that list, the thread (each transition writes a ledger
// line), `bookingHolds.listForRequest` (the act-side reader) and the venue
// calendar (the overlay). Counts are the server's — nothing here does
// position arithmetic.
//
// BOOKING'S OUTCOME IS CALLER-OWNED, like CreateEventFromBookingAction's
// (the props keep their pre-FR-005 "confirm" names): booking moves the row to the Event tab and the DataTable remounts the
// row's subtree on that move, so state held here would vanish with it. The
// inbox keeps the outcome per row and hands it back through `confirmOutcome`.
//
// STAFF SIDE ONLY. The act's Keep / Release view (FR-013) is a separate
// surface; nothing here is reachable from the performer's list.
//
// EVERY ROW ACTION IS NAMED BY ITS DATE. A request holding two nights renders
// two rows, and the inbox keeps `expandedIds` as a SET, so several strips are
// mounted at once — bare verbs gave a page N buttons all called "Release",
// each releasing a different night. The reorder arrows always did this right
// (`bkHoldMoveUp` = "Move the {date} hold ({position}) up the line"); Challenge,
// Extend, Release, Send terms and Book without terms now follow it. The VISIBLE labels stay bare: each
// sits in a row headed by its own date, and only the accessible name was
// ambiguous. "Place hold" is the one control no date can qualify — it takes the
// counterparty through `nameSuffix`, exactly as `OpenAgreementButton` does.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingHoldConfirmOutcome = {
  holdId: string;
  eventId: string;
  releasedHoldIds: string[];
};

/** A hold row's action cluster: content-sized buttons that wrap, never a toolbar that clips. */
const Actions = styled(XStack, {
  gap: "$1",
  flexWrap: "wrap",
  alignItems: "center",
});

/**
 * "Place hold" is the LAST ROW OF THE LINE, not a button beside it.
 *
 * It used to be a `ghost` Button floating under the frame — visually
 * identical to the `Release` and `Challenge` ghosts inside the rows, which do
 * the opposite job. The strip's only creative action read as its weakest.
 * Now it shares the frame and the 1px ink rule with the holds above it, so
 * pressing it visibly EXTENDS the line, which is what placing a hold does.
 *
 * A real `<button>` rather than a restyled `Button`: `styled(Button)` with a
 * raw text child is a known antipattern here, and the row needs full-width
 * flex layout (glyph · label · position, pinned right) that a Button's
 * centred label box cannot express.
 *
 * `borderRadius: 0` is the house rule; `borderTopWidth` is a variant because
 * the rule belongs to the JOIN — the row draws no rule when it is the frame's
 * only child (the empty state), or it would look like a header for nothing.
 */
const AddHoldRow = styled(XStack, {
  name: "BookingHoldsAddRow",
  tag: "button",
  width: "100%",
  minHeight: 44,
  padding: "$3",
  alignItems: "center",
  gap: "$2",
  minWidth: 0,
  borderWidth: 0,
  borderRadius: 0,
  backgroundColor: "transparent",
  cursor: "pointer",
  // The ghost ladder's two fills from `button-variants.ts`, so the row answers
  // to touch the way the ghosts inside the rows above it do. Deliberately
  // WITHOUT that ladder's `scale: 0.98`: a content-sized button can shrink
  // toward its own centre harmlessly, but this row is the full width of the
  // frame and flush against its 1px border, so scaling it would pull all four
  // edges off that border and read as the row detaching from the line.
  hoverStyle: { backgroundColor: "$surfaceRaised" },
  pressStyle: { backgroundColor: "$accentSoft" },
  // The house focus ring, with a NEGATIVE offset: this row sits flush inside
  // the frame's own 1px border, so BookingIntentControl's +2 would be drawn
  // under (and clipped by) that border instead of around the row.
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: -2,
  },
  // v2 disabled treatment, same as the Button atom's.
  disabledStyle: { opacity: 0.45, cursor: "not-allowed" },
  variants: {
    divided: {
      true: { borderTopWidth: 1, borderTopColor: "$borderColor" },
    },
  } as const,
});

/**
 * The 20px boxed `+` — the row's leading object glyph, not an icon button.
 *
 * `tag: "span"`, not the default div: a <button>'s content model is phrasing
 * content only, and React does not warn about a div nested in one — it just
 * ships invalid markup. A span keeps `display: flex` and every style here.
 */
const AddHoldGlyph = styled(XStack, {
  name: "BookingHoldsAddGlyph",
  tag: "span",
  width: 20,
  height: 20,
  flexShrink: 0,
  alignItems: "center",
  justifyContent: "center",
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
});

type PendingForm =
  | { kind: "challenge"; holdId: string; value: string }
  | { kind: "extend"; holdId: string; value: string }
  | null;

export function BookingHoldsStrip({
  bookingRequestId,
  placeId,
  preferredDates,
  holds,
  eventAdminSlug,
  confirmOutcome = null,
  canPlace = true,
  nameSuffix = null,
  unclaimedInquiry = false,
  requestStatus,
  agreementId = null,
  agreementStatus = null,
  builtFromEvent = false,
  bookingEvent = null,
  termsNight = null,
  bookWithoutTermsPayee = null,
  hasBookedNight = null,
  placeName = null,
  onConfirmed,
  onHoldsChanged,
  testIdBase = "booking-holds",
}: {
  bookingRequestId: string;
  /** The venue — its named calendars and spaces seed the place form. */
  placeId: string | null;
  preferredDates: readonly string[];
  /** `askedFor` is the server's (`isAskedForNight`); absent = unknown. */
  holds: readonly (BookingHoldSummary & { askedFor?: boolean })[];
  /**
   * WHOSE line this is, for the accessible name of "Place hold" — the same
   * `nameSuffix` contract as `OpenAgreementButton` and `BookingTermsStrip`,
   * and for the same reason. The strip's own props name a venue, a request id
   * and a set of dates; none of them is a human-readable party, so the ONE
   * control that is not already qualified by a date cannot disambiguate
   * itself. Several strips mount at once — the inbox keeps `expandedIds` as a
   * set — and without this their add-rows are byte-identical.
   *
   * Optional, and absent means the bare visible label rather than a sentence
   * with a hole in it.
   */
  nameSuffix?: string | null;
  /**
   * The sender has not claimed this request yet (an embed inquiry whose
   * contact has no account). NOT the same question as "is the owner pair
   * null" — see `isUnclaimedBookingInquiry`.
   *
   * The line still exists and is still the venue's to manage; what changes is
   * that the act is not reachable. `notify-booking-hold-intents` SKIPS the act
   * leg for these (`booking_holds.notify.anonymous_act_skipped`), and
   * `confirmBookingHold` refuses outright with
   * `HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST`. So confirm is pre-disabled — this
   * strip genuinely knows the answer — and so is challenge, whose entire
   * mechanism is a clock the act is asked to answer: started here it would
   * lapse unanswered and release the hold with only the venue side ever told.
   * (`settle-lapsed-holds` pushes `hold.expired` for BOTH `audience: "act"`
   * and `audience: "staff"`; only the act leg is dropped, so the assignee,
   * the placer and the org's editors do hear about it. The act never learns
   * a clock ran at all — which is the part that makes it a trap.)
   *
   * Release, reorder and extend are untouched; the server honours all three.
   * Release's CONFIRM DIALOG forks, though: its claimed copy ends "The act is
   * notified", which is false here.
   */
  unclaimedInquiry?: boolean;
  /**
   * Whether "Place hold" is offered at all. The server only places on
   * PENDING / VIEWED / ACCEPTED requests; a declined, withdrawn or expired
   * one gets no button rather than a rejection toast.
   */
  canPlace?: boolean;
  /**
   * The request's stage, as the list row carries it — what the two booking
   * actions are gated on (see `holdBookingActions`). Every field is the
   * SERVER's answer (list-booking-requests.ts, P5-fixes); nothing here is
   * re-derived in the browser's timezone. `bookingEvent` null = the stage
   * read degraded: both actions are withheld, with the reason.
   */
  requestStatus: string;
  agreementId?: string | null;
  agreementStatus?: string | null;
  /** Built from an event (event-first) — picks the "event gone" wording. */
  builtFromEvent?: boolean;
  bookingEvent?: BookingEventState | null;
  /** The night of terms the sender has seen or agreed (place zone). */
  termsNight?: string | null;
  /** Who a booking without terms pays until terms are added (mint plan). */
  bookWithoutTermsPayee?: "place" | "requester" | null;
  /** The request already booked its night (server; null = could not tell). */
  hasBookedNight?: boolean | null;
  /** The place's name, for the money sentence when the place is paid. */
  placeName?: string | null;
  /** For the confirm outcome's event link (`/admin/{slug}/events/{id}`). */
  eventAdminSlug: string;
  confirmOutcome?: BookingHoldConfirmOutcome | null;
  onConfirmed?: (outcome: BookingHoldConfirmOutcome) => void;
  /**
   * Fired after ANY successful hold write. A hold moves the request between
   * tabs (Agreement → Holds on place, back again on the last release), so
   * the inbox uses this to follow the row rather than let it vanish from
   * under the operator.
   */
  onHoldsChanged?: () => void;
  testIdBase?: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const live = useMemo(() => liveHolds(holds), [holds]);
  const dayLabel = useCallback(
    (iso: string) => fmt.dateTime(isoDateToLocal(iso), { dateStyle: "medium" }),
    [fmt],
  );

  /**
   * Append the counterparty to an accessible name, `OpenAgreementButton`-style.
   *
   * DATE + ORDINAL IS ONLY UNIQUE WITHIN ONE REQUEST. In the org / human
   * multi-venue scopes two requests at DIFFERENT venues can both hold
   * 2026-10-13 at 1st, and the inbox can have both rows expanded at once
   * (`expandedIds` is a Set) — at which point "Release the Oct 13, 2026 hold
   * (1st)" names two different nights at two different venues again. The name
   * is what the caller passes; without one the label is returned untouched
   * rather than trailing an em dash into nothing.
   */
  const withName = useCallback(
    (label: string) => (nameSuffix ? `${label} — ${nameSuffix}` : label),
    [nameSuffix],
  );

  // The countdown re-renders once a minute while a challenge is running, so
  // "3 hours left" does not sit at 3 hours all afternoon. Cleared when no
  // hold is challenged — no timer for the common case.
  const [now, setNow] = useState(() => new Date());
  const hasClock = live.some((h) => h.status === "CHALLENGED");
  useEffect(() => {
    if (!hasClock) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [hasClock]);

  // FOCUS AFTER CONFIRM. The dialog closes, the row moves to the Event tab
  // and the DataTable remounts this subtree, so focus falls to <body>. The
  // outcome panel's Open-event link takes it on mount (CreateEventOutcomeNotice
  // does the same): the one thing to read next is where the event went.
  const outcomeLinkRef = useRef<HTMLAnchorElement | null>(null);
  const outcomeEventId = confirmOutcome?.eventId ?? null;
  useEffect(() => {
    if (outcomeEventId) outcomeLinkRef.current?.focus();
  }, [outcomeEventId]);

  // ── Place-hold form ──────────────────────────────────────────────────────
  const [placing, setPlacing] = useState(false);
  const preferred = useMemo(
    () =>
      Array.from(
        new Set(
          preferredDates
            .map(holdDateFromPreferred)
            .filter((d): d is string => d !== null),
        ),
      ),
    [preferredDates],
  );
  const invalidateAll = useCallback(() => {
    void utils.bookingRequests.list.invalidate();
    void utils.bookingRequests.messages.list.invalidate({ bookingRequestId });
    void utils.bookingHolds.listForRequest.invalidate({ bookingRequestId });
    void utils.places.getVenueCalendar.invalidate();
    // The picker's month is built from getCalendarEventsAdmin, which caches for
    // 30s. Without this, reopening "Place hold" inside that window rebuilds the
    // grid from the PRE-WRITE snapshot: the nights just taken render as open,
    // and every offered position is short by the holds just added.
    void utils.places.getCalendarEventsAdmin.invalidate();
  }, [bookingRequestId, utils]);
  /** Success path: refresh every reader, then let the inbox follow the row. */
  const afterWrite = useCallback(() => {
    invalidateAll();
    onHoldsChanged?.();
  }, [invalidateAll, onHoldsChanged]);

  const onError = useCallback(
    (err: unknown) => {
      // Only the RETRYABLE race gets the "changed under you" wording; every
      // other code (HOLD_ALREADY_PLACED, HOLD_DATE_MISMATCHES_EVENT, …)
      // carries its own `errors.*` copy via `formatErrorMessage`, which is
      // the sentence the operator needs.
      //
      // HOLD_LINE_HAS_OPEN_CHALLENGE is a rule, not a failure: another act's
      // reply clock is running on this date (owner ruling 2026-08-27), so
      // confirm and reorder both wait. It gets the rule's sentence as a
      // warning rather than "Couldn't update the hold". The button is NOT
      // pre-disabled: this strip only knows THIS request's holds, and the
      // challenge that blocks it sits on a competitor's hold in the same
      // line, which the strip never reads — so the server is the first to
      // know, and the refetch below is what brings the cluster up to date.
      const appCode = (err as { data?: { appCode?: string } | null })?.data?.appCode;
      if (appCode === "HOLD_LINE_CHANGED") {
        toast.warning({
          id: "booking-hold-conflict",
          title: String(t("admin.bkHoldConflict")),
        });
      } else if (appCode === "HOLD_LINE_HAS_OPEN_CHALLENGE") {
        toast.warning({
          id: "booking-hold-open-challenge",
          title: String(t("errors.holdLineHasOpenChallenge")),
        });
      } else {
        toast.danger({
          id: "booking-hold-failed",
          title: String(t("admin.bkHoldActionFailed")),
          message: formatErrorMessage(err, t),
        });
      }
      invalidateAll();
    },
    [invalidateAll, t, toast],
  );

  const mutationOpts = { retry: false, meta: { silent: true } } as const;
  const reorderMutation = trpc.bookingHolds.reorder.useMutation(mutationOpts);
  const challengeMutation = trpc.bookingHolds.challenge.useMutation(mutationOpts);
  const extendMutation = trpc.bookingHolds.extend.useMutation(mutationOpts);
  const releaseMutation = trpc.bookingHolds.release.useMutation(mutationOpts);
  const bookMutation = trpc.bookingHolds.bookNightWithoutTerms.useMutation(mutationOpts);
  const sendTermsMutation = trpc.bookingAgreements.sendTerms.useMutation(mutationOpts);

  const busy =
    reorderMutation.isPending ||
    challengeMutation.isPending ||
    extendMutation.isPending ||
    releaseMutation.isPending ||
    bookMutation.isPending ||
    sendTermsMutation.isPending;

  /**
   * The picker landed one or more holds.
   *
   * CLOSE ONLY ON A CLEAN SWEEP. Partial success is a designed outcome — each
   * date is its own transaction, so a rival confirming one night mid-press
   * takes exactly that night — and the refused dates exist NOWHERE ELSE: the
   * picker is holding them as marked chips so they can be swapped rather than
   * retyped. Closing on `placed > 0` computed that tray and threw it away in
   * the same React batch, leaving a toast saying "4 placed" and no sign at all
   * that a fifth was refused.
   *
   * Readers refresh on BOTH paths: four holds landing is four holds landing,
   * whether or not a fifth failed.
   */
  const handlePlaced = useCallback(
    (placedCount: number, failedCount: number) => {
      if (failedCount === 0) setPlacing(false);
      afterWrite();
      if (failedCount === 0) {
        toast.success({
          id: "booking-hold-placed",
          title: String(t("admin.bkHoldPickPlacedToast", { count: placedCount })),
        });
      } else {
        // Not a success toast: something the operator asked for did not happen,
        // and the sentence has to say so or the tray reads as decoration.
        toast.warning({
          id: "booking-hold-placed-partial",
          title: String(
            t("admin.bkHoldPickPlacedPartialToast", {
              placed: placedCount,
              failed: failedCount,
            }),
          ),
        });
      }
    },
    [afterWrite, t, toast],
  );

  // ── Challenge / extend inline form ───────────────────────────────────────
  const [form, setForm] = useState<PendingForm>(null);
  const deadlineInputRef = useRef<HTMLInputElement | null>(null);
  const deadlineEchoId = useId();
  // Focus when a form OPENS, never on an edit: `form` is a new object per
  // keystroke, and `focus()` on a focused native date/time field sends Chrome
  // back to its first segment, so typing "10" into the month came out "01"
  // (measured 2026-09-28).
  const openFormKey = form ? `${form.kind}:${form.holdId}` : null;
  useEffect(() => {
    if (openFormKey) deadlineInputRef.current?.focus();
  }, [openFormKey]);

  const formDeadline = form ? fromDateTimeLocalValue(form.value) : null;
  // A challenge's deadline is capped at 30 days (the server refuses later);
  // an extend's is not.
  const formTooLate =
    form?.kind === "challenge" && formDeadline !== null && isChallengeDeadlineTooLate(formDeadline, now);
  const formValid =
    formDeadline !== null &&
    (form?.kind === "challenge"
      ? isChallengeDeadlineValid(formDeadline, now)
      : isExtendDeadlineValid(formDeadline, now));

  const submitForm = useCallback(() => {
    if (!form || !formDeadline || !formValid || busy) return;
    // The same belt the add-row's `busy` check wears, for the same stated
    // reason: the Challenge button is a real `<button disabled>` today, so a
    // stale click cannot reach here — but this form outlives the button that
    // opened it (it replaces the whole action cluster while open), and one
    // prop flip away that is a live submit for a clock nobody can answer.
    // Extend is deliberately NOT guarded: the server honours it, and the only
    // way to reach it is a hold that was CHALLENGED while the sender still
    // counted as claimed.
    if (form.kind === "challenge" && unclaimedInquiry) return;
    const done = () => {
      setForm(null);
      afterWrite();
    };
    if (form.kind === "challenge") {
      challengeMutation.mutate(
        { holdId: form.holdId, respondBy: formDeadline },
        { onSuccess: done, onError },
      );
    } else {
      extendMutation.mutate(
        { holdId: form.holdId, respondBy: formDeadline },
        { onSuccess: done, onError },
      );
    }
  }, [afterWrite, busy, challengeMutation, extendMutation, form, formDeadline, formValid, onError, unclaimedInquiry]);

  // ── Release / book dialogs ───────────────────────────────────────────────
  const [releaseTarget, setReleaseTarget] = useState<BookingHoldSummary | null>(null);
  const [bookTarget, setBookTarget] = useState<BookingHoldSummary | null>(null);

  const handleRelease = useCallback(() => {
    if (!releaseTarget || busy) return;
    releaseMutation.mutate(
      { holdId: releaseTarget.id },
      {
        onSuccess: afterWrite,
        onError,
        onSettled: () => setReleaseTarget(null),
      },
    );
  }, [afterWrite, busy, onError, releaseMutation, releaseTarget]);

  const handleBook = useCallback(() => {
    // `unclaimedInquiry` alongside `busy`: the server refuses this outright
    // (HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST) and the row never offers it.
    if (!bookTarget || busy || unclaimedInquiry) return;
    bookMutation.mutate(
      { bookingRequestId, holdId: bookTarget.id },
      {
        onSuccess: (result) => {
          onConfirmed?.({
            holdId: result.hold.id,
            eventId: result.eventId,
            releasedHoldIds: result.releasedHoldIds,
          });
          invalidateAll();
          // Accept-if-open changes the Open count and the rail badge; the
          // accept drafts the terms "Add terms" opens later.
          void utils.bookingRequests.countOpen.invalidate();
          void utils.bookingAgreements.get.invalidate();
        },
        onError,
        onSettled: () => setBookTarget(null),
      },
    );
  }, [bookMutation, bookTarget, bookingRequestId, busy, invalidateAll, onConfirmed, onError, unclaimedInquiry, utils.bookingAgreements.get, utils.bookingRequests.countOpen]);

  // "Send terms" is one tap: the night is the hold's, the time the server's
  // default (the act's named time, else the calendar's, else 19:00). The
  // card that edits the deal lives in the agreement area, not here.
  // Which row's Send terms is in flight — only that row spins.
  const [sendingHoldId, setSendingHoldId] = useState<string | null>(null);
  const sendTerms = useCallback(
    (hold: BookingHoldSummary) => {
      if (busy || !agreementId) return;
      setSendingHoldId(hold.id);
      sendTermsMutation.mutate(
        { agreementId, night: hold.date },
        {
          onSuccess: () => {
            toast.success({
              id: "booking-hold-terms-sent",
              title: String(t("admin.bkHoldSendTermsToast", { date: dayLabel(hold.date) })),
            });
            afterWrite();
            void utils.bookingAgreements.get.invalidate();
          },
          onError,
          onSettled: () => setSendingHoldId(null),
        },
      );
    },
    [afterWrite, agreementId, busy, dayLabel, onError, sendTermsMutation, t, toast, utils.bookingAgreements.get],
  );

  const reasonLine = (reason: HoldBookingReason, date: string): string => {
    const name = nameSuffix ?? String(t("admin.bkHubActFallback"));
    switch (reason) {
      case "behind":
        return String(t("admin.bkHoldBehindReason", { date: dayLabel(date) }));
      case "not_asked":
        return String(t("admin.bkHoldNotAskedReason", { name }));
      case "accept_first":
        return String(t("admin.bkHoldAcceptFirstReason"));
      case "unknown":
        return String(t("admin.bkHoldStageUnknownReason"));
      case "booked":
        return String(t("admin.bkHoldBookedReason"));
      case "terms_finalized":
        return String(t("admin.bkHoldTermsFinalizedReason", { name }));
      case "terms_countered":
        return String(t("admin.bkHoldTermsCounteredReason", { name }));
      case "no_terms":
        return String(t("admin.bkHoldNoTermsReason"));
      case "terms_out":
        return String(t("admin.bkHoldTermsOutReason", { name }));
      case "terms_other_night":
        return String(t("admin.bkHoldTermsOtherNightReason", { name }));
      case "terms_agreed":
        return String(t("admin.bkHoldTermsAgreedReason", { name }));
      case "terms_in_progress":
        return String(t("admin.bkHoldTermsInProgressReason", { name }));
      case "event_gone":
        return String(
          t(builtFromEvent ? "admin.bkHoldEventGoneOriginReason" : "admin.bkHoldEventGoneReason"),
        );
      case "event_other_night":
        return String(t("admin.bkHoldEventOtherNightReason"));
      case "event_other_calendar":
        return String(t("admin.bkHoldEventOtherCalendarReason"));
    }
  };

  const reorder = useCallback(
    (hold: BookingHoldSummary, delta: -1 | 1) => {
      if (busy) return;
      reorderMutation.mutate(
        { holdId: hold.id, toPosition: Math.max(1, hold.position + delta) },
        {
          onSuccess: (result) => {
            // The line's length is the server's; "move down" past the end
            // is a no-op there, so say so instead of refreshing silently.
            const moved = result.line.find((h) => h.id === hold.id);
            if (delta === 1 && moved && moved.position === hold.position) {
              toast.info({
                id: "booking-hold-last",
                title: String(t("admin.bkHoldAlreadyLast", { date: dayLabel(hold.date) })),
              });
            }
            afterWrite();
          },
          onError,
        },
      );
    },
    [afterWrite, busy, dayLabel, onError, reorderMutation, t, toast],
  );

  const stampLabel = (d: Date) => fmt.dateTime(d, { dateStyle: "medium", timeStyle: "short" });

  // The add-row is the line's last row. Gated exactly as the old button was:
  // no venue (`placeId`) or a request the server will not place on
  // (`canPlace`) gets NO row at all rather than a rejection toast; while the
  // picker is open the row is replaced by it, below the frame.
  const showAddRow = placeId !== null && canPlace && !placing;
  // NO POSITION PREVIEW ON THIS ROW, and there is no right number to put
  // there. A line is keyed (calendarId, date) — `hold-date-grid.ts` computes
  // the real offer as that DAY's live holds + 1, across every request, and
  // the DB backs it with UNIQUE (calendarId, date) on the confirmed row.
  // `live` is this REQUEST's holds across possibly several dates, so
  // `live.length + 1` is a count of nights held, not a place in any line: a
  // request holding Oct 13 at 3rd and Oct 20 at 1st would have advertised
  // "3rd" while the picker offered 1st on every empty night. The header rule
  // at the top of this file already said it — counts are the server's, and
  // nothing here does position arithmetic. The picker, which reads the day,
  // is the first thing that can honestly name a position.

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <YStack gap="$2" minWidth={0} data-testid={testIdBase}>
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Bookmark size={13} strokeWidth={2} aria-hidden style={{ opacity: 0.7, flexShrink: 0 }} />
        <Text
          variant="caption"
          weight="bold"
          tone="muted"
          textTransform="uppercase"
          letterSpacing={0.6}
        >
          {String(t("admin.bkHoldsHeading"))}
        </Text>
        {live.length > 0 ? (
          <Text variant="caption" tone="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
            {String(t("admin.bkHoldsCount", { count: live.length }))}
          </Text>
        ) : null}
      </XStack>

      {/* Booking outcome — the one thing to read after booking: where the event is. */}
      {confirmOutcome ? (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surfaceMuted"
          role="status"
          data-testid={`${testIdBase}-confirmed`}
        >
          <Text variant="bodySmall" weight="bold">
            {String(t("admin.bkHoldBookedTitle"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(
              t("admin.bkHoldConfirmedDetail", {
                count: confirmOutcome.releasedHoldIds.length,
              }),
            )}
          </Text>
          <XStack>
            <NextLinkAnchor
              ref={outcomeLinkRef}
              href={`/admin/${eventAdminSlug}/events/${confirmOutcome.eventId}`}
              aria-label={String(t("admin.bkInboxOpenEventCta"))}
              style={{ textDecoration: "none" }}
              data-testid={`${testIdBase}-confirmed-link`}
            >
              <Button
                tag="span"
                variant="secondary"
                size="$2"
                $sm={HOLD_ACTION_TOUCH}
                aria-hidden
                tabIndex={-1}
                testID={`${testIdBase}-confirmed-open-event`}
              >
                {String(t("admin.bkInboxOpenEventCta"))}
                <ExternalLink size={13} strokeWidth={2} aria-hidden />
              </Button>
            </NextLinkAnchor>
          </XStack>
        </YStack>
      ) : null}

      {/* WHY TWO CONTROLS ARE DEAD, said once, above the line rather than on
          each row. A plain muted caption in the empty state's own slot — not a
          bordered panel: this is an annotation on the strip, and a box here
          would nest a card inside the expanded row's card. */}
      {unclaimedInquiry ? (
        <Text variant="caption" tone="muted" data-testid={`${testIdBase}-unclaimed`}>
          {String(t("admin.bkHoldsUnclaimedNoteBooking"))}
        </Text>
      ) : null}

      {live.length === 0 && !confirmOutcome ? (
        <Text variant="caption" tone="muted" data-testid={`${testIdBase}-empty`}>
          {String(t("admin.bkHoldsEmpty"))}
        </Text>
      ) : null}

      {/* THE FRAME, not the list. The bordered box wraps a `role="list"` of
          real holds PLUS the add-row, and a <button> cannot be a child of a
          list (nor a `listitem`, which would announce it as a hold). So the
          box carries the paint and the inner element carries the semantics —
          when there are no holds there is no list element at all, only the
          frame and the row that starts one. */}
      {live.length > 0 || showAddRow ? (
        <YStack
          gap={0}
          borderWidth={1}
          borderColor="$borderColor"
          backgroundColor="$surface"
          minWidth={0}
          data-testid={`${testIdBase}-frame`}
        >
          {/* Only real holds live under `role="list"`. */}
          {live.length > 0 ? (
            <YStack
              gap={0}
              role="list"
              // Same collision, one level up: two expanded rows otherwise
              // give a screen reader two lists both called "Holds".
              aria-label={withName(String(t("admin.bkHoldsHeading")))}
              data-testid={`${testIdBase}-list`}
            >
              {live.map((hold, index) => {
                const countdown = holdCountdown(hold, now);
                const ordinal = String(
                  t(holdPositionKey(hold.position), { position: String(hold.position) }),
                );
                const isChallenged = hold.status === "CHALLENGED";
                const formOpen = form?.holdId === hold.id ? form : null;
                const booking = holdBookingActions({
                  hold,
                  hasBookedNight,
                  requestStatus,
                  agreementId,
                  agreementStatus,
                  bookingEvent,
                  termsNight,
                  unclaimed: unclaimedInquiry,
                });
                return (
                  <YStack
                    key={hold.id}
                    role="listitem"
                    gap="$2"
                    padding="$3"
                    borderTopWidth={index === 0 ? 0 : 1}
                    borderTopColor="$borderColor"
                    minWidth={0}
                    data-testid={`${testIdBase}-row-${hold.id}`}
                    data-status={hold.status}
                  >
                    <XStack gap="$3" alignItems="center" flexWrap="wrap" minWidth={0}>
                      <Text variant="bodySmall" weight="bold" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {dayLabel(hold.date)}
                      </Text>
                      <Text variant="caption" tone="muted" aria-hidden>·</Text>
                      <Text variant="bodySmall">
                        {String(t("admin.bkHoldPositionLabel", { position: ordinal }))}
                      </Text>
                      {/* A night the pitch asked for — what makes "Book without
                          terms" possible (N3). Mono label idiom, hairline box. */}
                      {hold.askedFor === true ? (
                        <XStack
                          paddingHorizontal="$1"
                          paddingVertical={2}
                          borderWidth={1}
                          borderColor="$borderColorSoft"
                          data-testid={`${testIdBase}-asked-${hold.id}`}
                        >
                          <Text variant="overline">
                            {String(t("admin.bkHoldPickRailAskedLabel"))}
                          </Text>
                        </XStack>
                      ) : null}
                      {isChallenged && countdown ? (
                        <XStack
                          gap="$1"
                          alignItems="center"
                          paddingHorizontal="$2"
                          minHeight={22}
                          borderWidth={1}
                          borderColor={countdown.kind === "lapsed" ? "$borderColorSoft" : "$warning"}
                          data-testid={`${testIdBase}-clock-${hold.id}`}
                        >
                          <Timer size={11} strokeWidth={2} aria-hidden color="currentColor" />
                          <Text
                            variant="caption"
                            weight="bold"
                            fontSize={10}
                            letterSpacing={0.6}
                            textTransform="uppercase"
                            color={countdown.kind === "lapsed" ? "$colorMuted" : "$warning"}
                          >
                            {countdown.kind === "lapsed"
                              ? String(t("admin.bkHoldLapsed"))
                              : countdown.kind === "hours"
                                ? String(t("admin.bkHoldHoursLeft", { hours: countdown.hours }))
                                : String(t("admin.bkHoldMinutesLeft", { minutes: countdown.minutes }))}
                          </Text>
                        </XStack>
                      ) : null}
                    </XStack>
                    {isChallenged && hold.respondBy ? (
                      <Text variant="caption" tone="muted">
                        {String(t("admin.bkHoldReplyBy", { date: stampLabel(new Date(hold.respondBy)) }))}
                      </Text>
                    ) : null}

                    {formOpen ? (
                      <YStack
                        gap="$2"
                        padding="$3"
                        borderWidth={1}
                        borderColor="$borderColor"
                        backgroundColor="$surfaceMuted"
                        $sm={{ padding: "$2" }}
                        data-testid={`${testIdBase}-form-${formOpen.kind}`}
                      >
                        <Text variant="caption" weight="bold" textTransform="uppercase" letterSpacing={0.6}>
                          {String(
                            t(formOpen.kind === "challenge" ? "admin.bkHoldChallengeTitle" : "admin.bkHoldExtendTitle"),
                          )}
                        </Text>
                        {/* THE SECOND PROMISE THIS STRIP MAKES, forked for the
                            same reason as the release dialog's: "The act must
                            keep or release the hold by this time" names an
                            obligation on somebody the notifier never reaches
                            (`notify-booking-hold-intents` drops the act leg
                            wholesale for an unclaimed inquiry).

                            Only the EXTEND form can reach this on an unclaimed
                            row — challenge is disabled and handler-guarded —
                            which needs a hold that was CHALLENGED while the
                            sender still counted as claimed. Narrow, but it is
                            the same lens flip that stranded the hold this whole
                            change exists for, so it is not hypothetical. */}
                        <Text
                          variant="caption"
                          tone="muted"
                          data-testid={`${testIdBase}-deadline-hint`}
                        >
                          {String(
                            t(
                              unclaimedInquiry
                                ? "admin.bkHoldDeadlineHintUnclaimed"
                                : "admin.bkHoldDeadlineHint",
                            ),
                          )}
                        </Text>
                        <DateTimeLocalInput
                          ref={deadlineInputRef}
                          type="datetime-local"
                          variant="boxed"
                          value={formOpen.value}
                          max={
                            formOpen.kind === "challenge"
                              ? toDateTimeLocalValue(maxChallengeDeadline(now))
                              : undefined
                          }
                          onChange={(e) => setForm({ ...formOpen, value: e.target.value })}
                          aria-label={String(t("admin.bkHoldDeadlineLabel"))}
                          aria-describedby={formDeadline && formValid ? deadlineEchoId : undefined}
                          data-testid={`${testIdBase}-deadline`}
                        />
                        {/* The picked instant in words. At 320 this field is
                            ~126px and the native control needs ~241px, so it
                            scrolls and hides the date (measured 2026-09-28);
                            this line keeps the whole choice readable. */}
                        {formDeadline && formValid ? (
                          <Text
                            variant="caption"
                            weight="bold"
                            id={deadlineEchoId}
                            data-testid={`${testIdBase}-deadline-echo`}
                          >
                            {String(t("admin.bkHoldNewDeadline", { date: stampLabel(formDeadline) }))}
                          </Text>
                        ) : null}
                        {/* Only a real instant can be "too soon". A native date/time
                            field reports "" while a segment is half-typed, so an
                            empty value says nothing (submit stays disabled). */}
                        {formDeadline && !formValid ? (
                          <Text variant="caption" tone="error" role="alert">
                            {String(
                              t(formTooLate ? "admin.bkHoldDeadlineTooLate" : "admin.bkHoldDeadlineTooSoon"),
                            )}
                          </Text>
                        ) : null}
                        {/* Stacked below $sm: inside the expanded mobile card this
                            form has ~120px of content width, and a nowrap CTA
                            overflowed its own frame there (measured at 320). */}
                        <XStack
                          gap="$2"
                          justifyContent="flex-end"
                          flexWrap="wrap"
                          $sm={{ flexDirection: "column-reverse", alignItems: "stretch" }}
                        >
                          <Button variant="ghost" size="$2" $sm={HOLD_ACTION_TOUCH} disabled={busy} onPress={() => setForm(null)}>
                            {String(t("common.cancel"))}
                          </Button>
                          <Button
                            variant="secondary"
                            size="$2"
                            disabled={!formValid || busy}
                            onPress={submitForm}
                            testID={`${testIdBase}-form-submit`}
                            $sm={{ ...HOLD_ACTION_TOUCH, width: "100%", paddingHorizontal: "$2" }}
                            textProps={{ whiteSpace: "normal", textAlign: "center" }}
                          >
                            {busy ? (
                              <Spinner size="sm" />
                            ) : (
                              String(
                                t(formOpen.kind === "challenge" ? "admin.bkHoldChallengeCta" : "admin.bkHoldExtendCta"),
                              )
                            )}
                          </Button>
                        </XStack>
                      </YStack>
                    ) : (
                      <Actions>
                        <Button
                          variant="ghost"
                          size="$2"
                          $sm={HOLD_ACTION_TOUCH}
                          disabled={busy || hold.position <= 1}
                          onPress={() => reorder(hold, -1)}
                          aria-label={withName(
                            String(
                              t("admin.bkHoldMoveUp", { date: dayLabel(hold.date), position: ordinal }),
                            ),
                          )}
                          testID={`${testIdBase}-up-${hold.id}`}
                        >
                          <ArrowUp size={13} strokeWidth={2} aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="$2"
                          $sm={HOLD_ACTION_TOUCH}
                          disabled={busy}
                          onPress={() => reorder(hold, 1)}
                          aria-label={withName(
                            String(
                              t("admin.bkHoldMoveDown", { date: dayLabel(hold.date), position: ordinal }),
                            ),
                          )}
                          testID={`${testIdBase}-down-${hold.id}`}
                        >
                          <ArrowDown size={13} strokeWidth={2} aria-hidden />
                        </Button>
                        {hold.status === "ACTIVE" && hold.position === 1 ? (
                          <Button
                            variant="ghost"
                            size="$2"
                            $sm={HOLD_ACTION_TOUCH}
                            // Unclaimed sender: the clock has nobody to ring.
                            // See the `unclaimedInquiry` prop doc.
                            disabled={busy || unclaimedInquiry}
                            aria-label={withName(
                              String(
                                t("admin.bkHoldChallengeAction", {
                                  date: dayLabel(hold.date),
                                  position: ordinal,
                                }),
                              ),
                            )}
                            onPress={() => {
                              // Re-read the clock as the form opens: the floor
                              // ("≥ 1h from now") is validated against `now`,
                              // which otherwise only ticks while a challenge runs.
                              const opened = new Date();
                              setNow(opened);
                              setForm({
                                kind: "challenge",
                                holdId: hold.id,
                                value: toDateTimeLocalValue(defaultChallengeDeadline(opened)),
                              });
                            }}
                            testID={`${testIdBase}-challenge-${hold.id}`}
                          >
                            <Timer size={13} strokeWidth={2} aria-hidden />
                            {String(t("admin.bkHoldChallenge"))}
                          </Button>
                        ) : null}
                        {isChallenged && countdown?.kind !== "lapsed" ? (
                          <Button
                            variant="ghost"
                            size="$2"
                            $sm={HOLD_ACTION_TOUCH}
                            disabled={busy}
                            aria-label={withName(
                              String(
                                t("admin.bkHoldExtendAction", {
                                  date: dayLabel(hold.date),
                                  position: ordinal,
                                }),
                              ),
                            )}
                            onPress={() => {
                              const opened = new Date();
                              setNow(opened);
                              setForm({
                                kind: "extend",
                                holdId: hold.id,
                                value: toDateTimeLocalValue(
                                  new Date(
                                    Math.max(
                                      defaultChallengeDeadline(opened).getTime(),
                                      new Date(hold.respondBy ?? 0).getTime(),
                                    ),
                                  ),
                                ),
                              });
                            }}
                            testID={`${testIdBase}-extend-${hold.id}`}
                          >
                            {String(t("admin.bkHoldExtend"))}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="$2"
                          $sm={HOLD_ACTION_TOUCH}
                          disabled={busy}
                          aria-label={withName(
                            String(
                              t("admin.bkHoldReleaseAction", {
                                date: dayLabel(hold.date),
                                position: ordinal,
                              }),
                            ),
                          )}
                          onPress={() => setReleaseTarget(hold)}
                          testID={`${testIdBase}-release-${hold.id}`}
                        >
                          <BookmarkX size={13} strokeWidth={2} aria-hidden />
                          {String(t("admin.bkHoldRelease"))}
                        </Button>
                      </Actions>
                    )}
                    {/* THE TWO WAYS TO BOOK (board W1), on their own row under
                        the line controls: "Send terms" is the emphasized one;
                        "Book without terms" asks first. Hidden while the
                        challenge / extend form is open, like the cluster. */}
                    {!formOpen && (booking.sendTerms || booking.bookWithoutTerms) ? (
                      <Actions gap="$2">
                        {booking.sendTerms ? (
                          <Button
                            variant="primary"
                            size="$2"
                            $sm={HOLD_ACTION_TOUCH}
                            disabled={busy}
                            aria-label={withName(
                              String(t("admin.bkHoldSendTermsAction", { date: dayLabel(hold.date) })),
                            )}
                            onPress={() => sendTerms(hold)}
                            testID={`${testIdBase}-send-terms-${hold.id}`}
                          >
                            {sendingHoldId === hold.id ? (
                              <Spinner size="sm" />
                            ) : (
                              <>
                                <Send size={13} strokeWidth={2} aria-hidden />
                                {String(t("admin.bkHoldSendTerms"))}
                              </>
                            )}
                          </Button>
                        ) : null}
                        {booking.bookWithoutTerms ? (
                          <Button
                            variant="secondary"
                            size="$2"
                            $sm={HOLD_ACTION_TOUCH}
                            disabled={busy}
                            aria-haspopup="dialog"
                            aria-label={withName(
                              String(t("admin.bkHoldBookWithoutTermsAction", { date: dayLabel(hold.date) })),
                            )}
                            onPress={() => setBookTarget(hold)}
                            testID={`${testIdBase}-book-${hold.id}`}
                          >
                            <BookmarkCheck size={13} strokeWidth={2} aria-hidden />
                            {String(t("admin.bkHoldBookWithoutTerms"))}
                          </Button>
                        ) : null}
                      </Actions>
                    ) : null}
                    {/* Why an action is missing — one sentence per withheld
                        action, never a dead button with no reason. */}
                    {!formOpen
                      ? booking.reasons.map((reason) => (
                          <Text
                            key={reason}
                            variant="caption"
                            tone="muted"
                            data-testid={`${testIdBase}-reason-${reason}-${hold.id}`}
                          >
                            {reasonLine(reason, hold.date)}
                          </Text>
                        ))
                      : null}
                  </YStack>
                );
              })}
            </YStack>
          ) : null}

          {/* THE LINE GROWS. Last row of the frame, sharing its 1px rule with
              the holds above — pressing it extends the line. */}
          {showAddRow ? (
            <AddHoldRow
              divided={live.length > 0}
              disabled={busy}
              // The `busy` guard every other handler in this file carries
              // (see reorder / challenge / extend / release). Redundant while
              // Tamagui emits a real DOM `disabled` for `tag: "button"` — and
              // one tag change away from opening the picker mid-write.
              onPress={() => {
                if (busy) return;
                setPlacing(true);
              }}
              // The one control in this strip a date cannot qualify. Same
              // shape as OpenAgreementButton's: `label — counterparty`, and
              // no aria-label at all when the caller has no name, so the row
              // keeps its text content as its accessible name rather than
              // announcing "Place hold — ".
              aria-label={nameSuffix ? withName(String(t("admin.bkHoldPlace"))) : undefined}
              data-testid={`${testIdBase}-place`}
              // Web-only attributes, absent from Tamagui's RN-first prop
              // types. A styled `tag: "button"` defaults to SUBMIT inside a
              // form (see BookingIntentControl) — this strip is rendered
              // inside the inbox's expanded row, so say it explicitly.
              {...({ type: "button" } as object)}
            >
              <AddHoldGlyph>
                <Plus size={12} strokeWidth={2.5} aria-hidden />
              </AddHoldGlyph>
              {/* The house BUTTON-label grammar (11px / 700 / uppercase /
                  +1.5px tracking, per the Button atom) rather than the mono
                  `overline` label idiom: this row must read as a control next
                  to the Release and Send terms labels inside the same frame, and
                  those are Montserrat button labels. */}
              <Text
                variant="bodySmall"
                weight="bold"
                fontSize={11}
                lineHeight={14}
                letterSpacing={1.5}
                textTransform="uppercase"
                flexShrink={1}
                minWidth={0}
              >
                {String(t("admin.bkHoldPlace"))}
              </Text>
            </AddHoldRow>
          ) : null}
        </YStack>
      ) : null}

      {/* The picker takes the whole width BELOW the frame: a month grid
          nested inside the line would read as one hold's detail. */}
      {placing && placeId ? (
        <HoldDatePicker
          bookingRequestId={bookingRequestId}
          placeId={placeId}
          preferredDates={preferred}
          onPlaced={handlePlaced}
          onCancel={() => setPlacing(false)}
          onError={onError}
          adminSlug={eventAdminSlug}
          disabled={busy}
          testIdBase={`${testIdBase}-place`}
        />
      ) : null}

      <ConfirmDialog
        open={releaseTarget !== null}
        onConfirm={handleRelease}
        onCancel={() => setReleaseTarget(null)}
        title={String(t("admin.bkHoldReleaseConfirmTitle"))}
        // THE DIALOG'S BODY IS A CLAIM ABOUT WHAT HAPPENS NEXT, and half of it
        // stopped being true the moment Release became reachable on an
        // unclaimed row: the claimed copy ends "The act is notified", and
        // `notify-booking-hold-intents` returns [] for that act. Two inches
        // above it the strip's own note says the sender is NOT told — so the
        // operator got both sentences on screen at once, on the one
        // destructive action here that is still live for them.
        description={
          releaseTarget
            ? String(
                t(
                  unclaimedInquiry
                    ? "admin.bkHoldReleaseConfirmBodyUnclaimed"
                    : "admin.bkHoldReleaseConfirmBody",
                  { date: dayLabel(releaseTarget.date) },
                ),
              )
            : ""
        }
        confirmLabel={String(t("admin.bkHoldRelease"))}
        cancelLabel={String(t("common.cancel"))}
        loading={releaseMutation.isPending}
        loadingLabel={String(t("common.loading"))}
      />
      <ConfirmDialog
        open={bookTarget !== null}
        onConfirm={handleBook}
        onCancel={() => setBookTarget(null)}
        title={
          bookTarget
            ? String(t("admin.bkHoldBookTitle", { date: dayLabel(bookTarget.date) }))
            : ""
        }
        description={
          bookTarget ? (
            <YStack gap="$2" data-testid={`${testIdBase}-book-dialog`}>
              <Text variant="body" color="$colorMuted">
                {String(
                  t("admin.bkHoldBookBody", {
                    date: dayLabel(bookTarget.date),
                    name: nameSuffix ?? String(t("admin.bkHubActFallback")),
                  }),
                )}
              </Text>
              {/* The money sentence is the one that matters: with no terms
                  the event's money goes 100% to its OWNER — the server's
                  `bookWithoutTermsPayee` (the mint plan's own rule). Unknown
                  owner or name: the neutral sentence, never a guess. */}
              <Text variant="body" weight="bold" data-testid={`${testIdBase}-book-money`}>
                {bookWithoutTermsPayee === "place" && placeName
                  ? String(t("admin.bkHoldBookMoney", { place: placeName }))
                  : bookWithoutTermsPayee === "requester" && nameSuffix
                    ? String(t("admin.bkHoldBookMoneyRequester", { name: nameSuffix }))
                    : String(t("admin.bkHoldBookMoneyOrganiser"))}
              </Text>
              <Text variant="body" color="$colorMuted">
                {String(
                  t("admin.bkHoldBookReleases", {
                    date: dayLabel(bookTarget.date),
                    count: live.filter((h) => h.id !== bookTarget.id).length,
                  }),
                )}
              </Text>
            </YStack>
          ) : (
            ""
          )
        }
        confirmLabel={String(t("admin.bkHoldBookCta"))}
        cancelLabel={String(t("common.cancel"))}
        loading={bookMutation.isPending}
        loadingLabel={String(t("common.loading"))}
      />
    </YStack>
  );
}
