"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { XStack, YStack } from "tamagui";
import {
  Button,
  DateTime,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { AlertTriangle, ArrowUpRight, Repeat } from "lucide-react";
import { RECURRENCE_MAX_OCCURRENCES } from "@th/types/repos/event-dates";

import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { cadenceMessage } from "@/components/community/cadence-message";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";
import { getAppErrorCode } from "@/lib/app-error";
import {
  listingClosedKind,
  listingClosedKindFromAppCode,
  type ListingClosedKind,
} from "@/lib/listing-closed";
import { trpc } from "@/trpc";
import {
  RecurrenceBuilder,
  type OccurrenceCopyKeys,
} from "@/app/admin/[slug]/events/new/_components/RecurrenceBuilder";
import { toDateTimeLocalValue } from "@/app/admin/[slug]/events/new/_components/event-builder-helpers";
import type { RecurrenceConfig } from "@/app/admin/[slug]/events/new/_components/recurrence-helpers";

import {
  droppedRsvpSummary,
  normaliseAnchor,
  prefillFromStoredRule,
  reconcileDiff,
  scheduleToApply,
  type ReconcileDiff,
} from "./schedule-reconcile";

import { ScheduleDateList, type ScheduleRow } from "./ScheduleDateList";

/**
 * How many rows `community.listEventDates` will return before it stops — its
 * `MAX_DATES` is the write path's per-pass cap, by definition. A full page
 * means the read stopped early, which is what makes the drop count a floor
 * rather than a total — see {@link ReconcileDiff.partial}.
 */
const READ_CAP = RECURRENCE_MAX_OCCURRENCES;

/**
 * The builder's occurrence vocabulary, retranslated for a community listing.
 *
 * The builder says "shows", which is right for a ticketed series and wrong
 * here: nobody buys a ticket to a night of an open mic, and a moderator
 * reading "creates 52 draft shows" would be reading about a feature this
 * listing does not have. `consequence: null` drops the builder's own caption
 * outright — this page states its consequences in the band below, against the
 * dates that actually exist, which is a stronger claim than the builder can
 * make from the rule alone.
 */
const OCCURRENCE_COPY: OccurrenceCopyKeys = {
  unit: "moderation.schedOccurrenceUnit",
  total: "moderation.schedOccurrenceTotal",
  totalCapped: "moderation.schedOccurrenceTotalCapped",
  last: "moderation.schedOccurrenceLast",
  consequence: null,
};

export type ListingScheduleProps = {
  eventId: string;
  /** Listing title, resolved on the server. */
  title: string;
  /** IANA zone. Every date on this page is venue-local. */
  timezone: string;
  /**
   * The listing's current `Event.startsAt` as an ISO instant. The server
   * re-pins it to the first UPCOMING occurrence on every date write, so it is
   * both the schedule's anchor and the `dtstart` every rule on this page —
   * prefilled or composed — is built on. See `prefillFromStoredRule` for why
   * the stored rule is carried across to it rather than the other way round.
   */
  startsAtIso: string;
  /** Public listing href — the "View listing" way back out. */
  listingHref: string;
  /** Event status. CANCELLED, ARCHIVED and COMPLETED make the schedule read-only. */
  listingStatus?: string;
};

/**
 * `/moderate/listings/[eventId]/schedule` — the full schedule of one community
 * listing, and the only UI for `community.updateRecurrence`.
 *
 * ── HOW THIS PAGE IS REACHED ───────────────────────────────────────────────
 *
 * From the listing itself: the moderator bar inside the public event page's
 * "Upcoming dates" section links here ("Manage schedule"). There is NO
 * listings index, and that is a decision rather than an omission — a moderator
 * arrives at a schedule because they were looking at that listing, so the
 * index was shelved instead of built. If one ever lands, it links here too;
 * nothing on this page assumes where the reader came from.
 *
 * ── ACCESS ─────────────────────────────────────────────────────────────────
 *
 * Three layers, none of them this component's: the edge gate
 * (`middleware/staff-route-gate.ts`) fronts `/moderate/**` with
 * `community.checkModeratorAccess` AND the step-up 2FA requirement;
 * `moderate/layout.tsx` re-checks server-side; `ModerateShell` re-checks
 * client-side. So unlike the inline controls on the public event page, this
 * surface can assume its reader is a moderator with a second factor.
 *
 * It still handles `SECOND_FACTOR_REQUIRED` on every write, because enrolment
 * state can change mid-session and all three mutations carry the step-up at
 * the transport (`SECOND_FACTOR_GATED_MODERATION_PATHS`). The read carries it
 * too: `moderatorView` on `listEventDates` steps up inside the procedure,
 * since the public read it shares has no actor to gate; a refused read lands
 * in the error panel below rather than as a blank flag.
 */
export function ListingSchedule({
  eventId,
  title,
  timezone,
  startsAtIso,
  listingHref,
  listingStatus,
}: ListingScheduleProps) {
  const t = useTranslations();
  const closedKind = listingClosedKind(listingStatus);
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();
  const router = useRouter();

  /**
   * `listingStatus` is read once, on the server. When a write is refused
   * because the listing was taken down or ended since the page loaded, say so
   * and re-render the server half so the closed state takes over. Returns
   * whether it handled the error.
   */
  const noticeRef = useRef<HTMLDivElement>(null);
  const focusNoticeRef = useRef(false);
  // The control focus was on (Apply, Put back) unmounts when the closed state
  // takes over, so the notice that explains the refusal takes focus instead.
  useEffect(() => {
    if (!closedKind || !focusNoticeRef.current) return;
    focusNoticeRef.current = false;
    // Only when focus has nowhere else to be: a moderator who moved on while
    // the refresh was in flight keeps their place.
    const active = document.activeElement;
    if (active === null || active === document.body) noticeRef.current?.focus();
  }, [closedKind]);

  const handleListingClosed = useCallback(
    (err: unknown, failureTitle: string) => {
      const kind = listingClosedKindFromAppCode(getAppErrorCode(err));
      if (!kind) return false;
      focusNoticeRef.current = true;
      // The flag must not outlive a refresh that never changes the status.
      window.setTimeout(() => {
        focusNoticeRef.current = false;
      }, 5000);
      // Title only: the closed notice carries the sentence, and is focused.
      toast.warning({ title: failureTitle });
      router.refresh();
      return true;
    },
    [router, t, toast],
  );

  const datesQuery = trpc.community.listEventDates.useQuery(
    // `moderatorView` adds the per-date RSVP presence flag. The use case
    // refuses it for anyone without a moderation role, which this page's
    // reader always has (see ACCESS above).
    { eventId, moderatorView: true },
    { retry: false, refetchOnWindowFocus: false },
  );

  const rows = useMemo<ScheduleRow[]>(
    () =>
      (datesQuery.data?.dates ?? []).map((d) => ({
        eventDateId: d.eventDateId,
        startsAt: d.startsAt,
        status: d.status,
        viewerRsvped: d.viewerRsvped,
        ...(d.hasRsvp !== undefined ? { hasRsvp: d.hasRsvp } : {}),
      })),
    [datesQuery.data],
  );

  // ── Editor state ────────────────────────────────────────────────────────
  const [editorOpen, setEditorOpen] = useState(false);
  const [candidate, setCandidate] = useState<RecurrenceConfig | null>(null);
  /**
   * `now` is FROZEN when the editor opens rather than read per render.
   *
   * Two reasons. It is the origin of the 12-month materialisation horizon the
   * counts are computed against, and a horizon that slides between renders
   * makes the numbers flicker by one while nothing on screen changed. And it
   * keeps `Date.now()` out of the render path, where it is a hydration
   * mismatch waiting to happen.
   */
  const [openedAt, setOpenedAt] = useState<Date | null>(null);
  /**
   * The config the editor OPENED with, or `null` if it opened on defaults.
   * Kept so Apply can tell an untouched prefill from a composed rule — the
   * former is written as the STORED rule, verbatim (see `scheduleToApply`) —
   * and so the caption above the editor only claims a prefill when there is
   * one.
   */
  const [prefill, setPrefill] = useState<RecurrenceConfig | null>(null);
  const [confirmingApply, setConfirmingApply] = useState(false);
  const [confirmingCallOff, setConfirmingCallOff] = useState<ScheduleRow | null>(
    null,
  );
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Instance-scoped so `aria-controls` resolves to THIS page's panel. */
  const editorPanelId = `schedule-rule-editor-${useId()}`;

  const recurrence = datesQuery.data?.recurrence ?? null;
  const storedRule = datesQuery.data?.storedRule ?? null;
  const truncated = datesQuery.data?.truncated ?? false;
  const hasRule = datesQuery.data?.hasRecurrenceRule ?? false;

  /**
   * `Event.startsAt` as the builder will read it back — the `dtstart` of every
   * rule on this page. Normalised up front (see `normaliseAnchor`) so the
   * config seeded into the builder carries the very string the builder derives
   * for itself; the builder rewrites a loaded config whose `dtstart` disagrees
   * with its own, and the prefill would not survive its first render.
   */
  const anchorIso = useMemo(
    () => normaliseAnchor(startsAtIso, timezone),
    [startsAtIso, timezone],
  );

  /** Wall-clock reading of the anchor, in the listing's zone — the builder's basis. */
  const eventStartsAtLocal = useMemo(
    () => toDateTimeLocalValue(anchorIso, timezone),
    [anchorIso, timezone],
  );

  const openEditor = useCallback(() => {
    // The stored rule, carried to this page's anchor — see the helper for
    // why. Nothing is rebuilt from the summary any more: the summary drops
    // COUNT and any monthly ordinal, and an editor seeded from it opened on a
    // rule WIDER than the real one, which drops nothing, so the band below
    // read clean while Apply rewrote the series. A rule the builder cannot
    // express structurally shows as its raw text instead.
    const seeded = prefillFromStoredRule(storedRule, { anchorIso, timezone });
    setCandidate(seeded);
    setPrefill(seeded);
    setOpenedAt(new Date());
    setEditorOpen(true);
  }, [storedRule, anchorIso, timezone]);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setCandidate(null);
    setPrefill(null);
    setOpenedAt(null);
  }, []);

  // ── The consequence arithmetic ──────────────────────────────────────────
  const diff = useMemo<ReconcileDiff | null>(() => {
    if (!editorOpen || !candidate || !openedAt) return null;
    return reconcileDiff(candidate, {
      dates: rows.map((row) => ({
        eventDateId: row.eventDateId,
        startsAtMs: row.startsAt.getTime(),
        status: row.status,
      })),
      now: openedAt,
      timezone,
      partial: rows.length >= READ_CAP,
    });
  }, [editorOpen, candidate, openedAt, rows, timezone]);

  const doomedIds = diff?.droppedIds ?? EMPTY_IDS;
  const outOfReachIds = diff?.droppedBeyondHorizonIds ?? EMPTY_IDS;
  /** How many of the doomed dates someone has RSVP'd to — dates, not people. */
  const droppedRsvps = useMemo(
    () => (diff ? droppedRsvpSummary(diff, rows) : null),
    [diff, rows],
  );

  // ── Writes ──────────────────────────────────────────────────────────────
  const updateMut = trpc.community.updateRecurrence.useMutation();
  const cancelMut = trpc.community.cancelEventDate.useMutation();
  const restoreMut = trpc.community.restoreEventDate.useMutation();

  const applyRule = useCallback(() => {
    if (!candidate || updateMut.isPending) return;
    updateMut.mutate(
      {
        eventId,
        recurrenceSchedule: scheduleToApply(candidate, prefill, storedRule),
      },
      {
        onSuccess: (result) => {
          toast.success({
            title: String(t("moderation.schedApplyOk")),
            message: String(
              t("moderation.schedApplyOkBody", {
                count: result.scheduledCount,
              }),
            ),
          });
          closeEditor();
        },
        onError: (err) => {
          if (handleSecondFactorRequired(err)) return;
          if (handleListingClosed(err, String(t("moderation.schedApplyFailed")))) {
            closeEditor();
            return;
          }
          const code = getAppErrorCode(err);
          toast.danger({
            title: String(
              code === "RECURRENCE_HAS_NO_UPCOMING_DATES"
                ? t("moderation.schedApplyEmpty")
                : t("moderation.schedApplyFailed"),
            ),
          });
        },
        onSettled: () => {
          void utils.community.listEventDates.invalidate({ eventId });
        },
      },
    );
  }, [
    candidate,
    prefill,
    storedRule,
    closeEditor,
    eventId,
    handleListingClosed,
    handleSecondFactorRequired,
    t,
    toast,
    updateMut,
    utils,
  ]);

  /**
   * Both per-date writes share one shape, and it is deliberately NOT
   * optimistic: a call-off moves the row's status AND `Event.startsAt` (the
   * server re-pins it in the same transaction), so the row goes busy, the
   * write lands, and the list is re-read.
   */
  const runDateWrite = useCallback(
    (
      row: ScheduleRow,
      mutation: typeof cancelMut | typeof restoreMut,
      failureTitle: string,
    ) => {
      if (pendingIds.has(row.eventDateId)) return;
      setPendingIds((prev) => new Set(prev).add(row.eventDateId));
      mutation.mutate(
        { eventDateId: row.eventDateId },
        {
          onError: (err) => {
            if (handleSecondFactorRequired(err)) return;
            if (handleListingClosed(err, failureTitle)) return;
            toast.danger({ title: failureTitle });
          },
          onSettled: () => {
            setPendingIds((prev) => {
              const next = new Set(prev);
              next.delete(row.eventDateId);
              return next;
            });
            void utils.community.listEventDates.invalidate({ eventId });
          },
        },
      );
    },
    [
      eventId,
      handleListingClosed,
      handleSecondFactorRequired,
      pendingIds,
      toast,
      utils,
    ],
  );

  const putBack = useCallback(
    (row: ScheduleRow) =>
      // Additive and reversible, so it goes straight through with no confirm.
      runDateWrite(row, restoreMut, String(t("rsvp.errPutBackFailed"))),
    [restoreMut, runDateWrite, t],
  );

  // ── Copy ────────────────────────────────────────────────────────────────
  const firstRow = rows[0];
  const cadence = useMemo(() => {
    if (!firstRow) return null;
    return cadenceMessage({
      recurrence,
      dates: rows,
      time: DateTime.format(firstRow.startsAt, "time", {
        timeZone: timezone,
        locale: fmt.locale,
      }),
      timezone,
      locale: fmt.locale,
    });
  }, [recurrence, rows, firstRow, timezone, fmt.locale]);

  const cadenceLine = cadence ? String(t(cadence.key, cadence.values)) : null;

  const confirmDate = confirmingCallOff
    ? DateTime.format(confirmingCallOff.startsAt, "meta", {
        timeZone: timezone,
        locale: fmt.locale,
      })
    : "";

  // ── Loading / error ─────────────────────────────────────────────────────
  if (datesQuery.isLoading) {
    return (
      <YStack
        minHeight="40vh"
        alignItems="center"
        justifyContent="center"
        padding="$6"
        aria-busy
      >
        <Spinner size="large" />
      </YStack>
    );
  }

  if (datesQuery.isError) {
    return (
      <YStack
        gap="$3"
        padding="$4"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
      >
        <Text variant="body" tone="error">
          {String(t("moderation.loadError"))}
        </Text>
        <XStack>
          <Button
            variant="secondary"
            size="$3"
            onPress={() => void datesQuery.refetch()}
          >
            {String(t("moderation.retry"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$4" data-testid="listing-schedule">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <YStack gap="$2">
        <Text variant="overline" tone="muted">
          {String(t("moderation.schedKicker"))}
        </Text>
        <Text variant="h4" tag="h2" weight="bold">
          {title}
        </Text>
        {closedKind ? (
          <div
            ref={noticeRef}
            tabIndex={-1}
            data-testid="schedule-closed-notice"
            style={{ outline: "none" }}
          >
            <Text variant="bodySmall">{String(t(CLOSED_COPY[closedKind]))}</Text>
          </div>
        ) : null}
      </YStack>

      {/* ── The rule box — the page's one emphasised block ───────────── */}
      <YStack
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
        padding="$4"
        gap="$3"
        data-testid="schedule-rule-box"
      >
        <XStack gap="$2" alignItems="center">
          <Repeat size={14} aria-hidden />
          <Text variant="overline" tone="muted">
            {String(t("moderation.schedRuleLabel"))}
          </Text>
        </XStack>

        <Text variant="h5" tag="p" weight="bold" data-testid="schedule-cadence">
          {cadenceLine ?? String(t("moderation.schedRuleUnsummarisable"))}
        </Text>

        <XStack gap="$2" flexWrap="wrap" alignItems="baseline">
          <Text variant="overline" tone="muted">
            {recurrence?.until
              ? String(
                  t("moderation.schedEndsOn", {
                    date: DateTime.format(recurrence.until, "date", {
                      timeZone: timezone,
                      locale: fmt.locale,
                    }),
                  }),
                )
              : String(t("moderation.schedNoEndDate"))}
          </Text>
          <Text variant="overline" tone="muted" aria-hidden>
            ·
          </Text>
          <Text
            variant="overline"
            tone="muted"
            style={TABULAR}
            data-testid="schedule-materialised"
          >
            {String(
              t("moderation.schedMaterialised", { count: rows.length }),
            )}
          </Text>
        </XStack>

        {/* The list is capped twice over (row cap, materialisation window), so
            the count above is what EXISTS, never the length of the series. */}
        {truncated ? (
          <Text variant="caption" tone="muted">
            {String(t("moderation.schedMaterialisedMore"))}
          </Text>
        ) : null}

        <XStack gap="$3" flexWrap="wrap" alignItems="center">
          {/* ONE button for both states, deliberately. Rendering two different
              buttons would unmount the one that was just pressed, dropping
              keyboard focus to <body> at exactly the moment the moderator
              wants to see whether the editor opened. Same element, swapped
              label, handler and weight. */}
          {closedKind ? null : (
            <Button
              variant={editorOpen ? "outlined" : "secondary"}
              size="$3"
              onPress={editorOpen ? closeEditor : openEditor}
              aria-expanded={editorOpen}
              // Only while the panel EXISTS. The alternative — always render it
              // and hide it with the `hidden` attribute, the way the public
              // page's date disclosure does — is right for a static list and
              // wrong here: this panel holds a stateful form with its own
              // emission guard, and mounting it on every page load to satisfy an
              // ARIA reference trades a real behaviour for a pointer. A
              // disclosure is valid on `aria-expanded` alone.
              {...(editorOpen ? { "aria-controls": editorPanelId } : {})}
              data-testid="schedule-change-rule"
            >
              {String(
                editorOpen
                  ? t("moderation.schedDiscard")
                  : t("moderation.schedChangeRule"),
              )}
            </Button>
          )}
          <NextLinkAnchor
            href={listingHref}
            textDecorationLine="none"
            display="inline-flex"
            alignItems="center"
            gap={4}
            minHeight={44}
            focusVisibleStyle={{
              outlineWidth: 2,
              outlineStyle: "solid",
              outlineColor: "$accent",
              outlineOffset: 2,
            }}
            data-testid="schedule-view-listing"
          >
            <Text variant="overline" color="$accentText" tag="span">
              {String(t("moderation.schedViewListing"))}
            </Text>
            {/* Trailing icon — this one takes you somewhere. */}
            <ArrowUpRight size={13} strokeWidth={2.5} aria-hidden />
          </NextLinkAnchor>
        </XStack>
      </YStack>

      {/* ── The editor ───────────────────────────────────────────────── */}
      {editorOpen && !closedKind ? (
        <YStack
          id={editorPanelId}
          gap="$3"
          padding="$4"
          borderWidth={1}
          borderColor="$borderColorSoft"
          backgroundColor="$surface"
          // Named, so landing in here from the rotor says what it is rather
          // than "group".
          role="group"
          aria-label={String(t("moderation.schedEditorTitle"))}
          data-testid="schedule-rule-editor"
        >
          <Text variant="overline" tone="muted" aria-hidden>
            {String(t("moderation.schedEditorTitle"))}
          </Text>
          {/* Only when something WAS prefilled. With no rule to carry — a
              listing with nothing upcoming, or one the anchor cannot express
              — the editor opens on its own defaults, and a caption claiming
              "the current rule" would be describing a rule that is not
              there. */}
          {prefill ? (
            <Text variant="caption" tone="muted">
              {String(t("moderation.schedEditorPrefillNote"))}
            </Text>
          ) : null}
          <RecurrenceBuilder
            enabled={candidate != null}
            onEnabledChange={() => {
              /* The emitted config is the authority — a `null` config already
                 says "no rule", and clearing recurrence is refused by the
                 server anyway, so there is nothing separate to track. */
            }}
            value={candidate}
            onChange={setCandidate}
            eventStartsAt={eventStartsAtLocal}
            eventTimezone={timezone}
            allowNeverEnds
            occurrenceCopyKeys={OCCURRENCE_COPY}
          />
        </YStack>
      ) : null}

      {/* ── The consequence band — the ONLY route to the write ────────── */}
      {/* Not on a closed listing: the rule cannot change there, and a band
          explaining what a change would do invites one. */}
      {closedKind ? null : (
        <YStack
          gap="$2"
          padding="$4"
          backgroundColor="$surfaceMuted"
          borderLeftWidth={4}
          borderLeftColor="$accent"
          data-testid="schedule-consequence"
        >
          <XStack gap="$2" alignItems="center">
            <AlertTriangle size={14} aria-hidden />
            <Text variant="overline" tone="muted">
              {String(t("moderation.schedConsequenceLabel"))}
            </Text>
          </XStack>

          <Text variant="bodySmall">
            {String(t("moderation.schedConsequenceMechanism"))}
          </Text>

          {diff === null ? (
            <Text variant="caption" tone="muted">
              {String(
                editorOpen
                  ? t("moderation.schedRuleIncomplete")
                  : t("moderation.schedConsequenceIdle"),
              )}
            </Text>
          ) : diff.producesNothing ? (
            /* No counts here. "52 of the 52 dates would come off" is true but
               leads with a number nobody can act on, above the refusal that is
               the only thing worth reading. */
            <Text variant="bodySmall" tone="error" data-testid="schedule-refused">
              {String(t("moderation.schedProducesNothing"))}
            </Text>
          ) : (
            <>
              {/* THE LIVE REGION IS THE TWO COUNTS AND NOTHING ELSE. Enclosing
                  the Apply button — as this did — makes a screen reader read
                  "Apply new rule" out again on every keystroke that moves a
                  number. The static guidance below is not in here either: it
                  does not change, so announcing it is noise. */}
              <YStack gap="$2" role="status">
                <Text
                  variant="body"
                  weight="bold"
                  style={TABULAR}
                  data-testid="schedule-would-drop"
                >
                  {String(
                    t("moderation.schedWouldDrop", {
                      count: diff.droppedCount,
                      total: diff.scheduledCount,
                    }),
                  )}
                </Text>
                {/* The drops nobody asked for, in their own sentence — the rule
                    still wants these dates, the pass just cannot reach them. */}
                {diff.droppedBeyondHorizonCount > 0 ? (
                  <Text
                    variant="bodySmall"
                    style={TABULAR}
                    data-testid="schedule-would-drop-beyond"
                  >
                    {String(
                      t("moderation.schedWouldDropBeyondHorizon", {
                        count: diff.droppedBeyondHorizonCount,
                        max: RECURRENCE_MAX_OCCURRENCES,
                      }),
                    )}
                  </Text>
                ) : null}
                <Text variant="bodySmall" style={TABULAR}>
                  {String(
                    t("moderation.schedWouldAdd", { count: diff.addedCount }),
                  )}
                </Text>
              </YStack>

              {diff.capReached ? (
                <Text variant="caption" tone="muted">
                  {String(
                    t("moderation.schedCapReached", {
                      max: RECURRENCE_MAX_OCCURRENCES,
                    }),
                  )}
                </Text>
              ) : null}
              {/* Which of the drops carry RSVPs — the difference between
                  removing empty nights and calling off nights people said they
                  would come to. A count of DATES: FR-004 forbids a going-count,
                  and the flag behind this is presence per date, moderator-only.
                  Only worth a sentence when something drops. */}
              {diff.droppedCount > 0 ? (
                droppedRsvps?.known ? (
                  <Text
                    variant="bodySmall"
                    style={TABULAR}
                    data-testid="schedule-dropped-with-rsvps"
                  >
                    {String(
                      t("moderation.schedDroppedWithRsvps", {
                        count: droppedRsvps.count,
                      }),
                    )}
                  </Text>
                ) : (
                  <Text variant="caption" tone="muted">
                    {String(t("moderation.schedRsvpUnknown"))}
                  </Text>
                )
              ) : null}
              <Text variant="caption" tone="muted">
                {String(t("moderation.schedAddApprox"))}
              </Text>
              {diff.partial ? (
                <Text variant="caption" tone="muted">
                  {String(
                    t("moderation.schedDropFloor", { count: rows.length }),
                  )}
                </Text>
              ) : null}
              <XStack paddingTop="$2">
                <Button
                  variant="primary"
                  size="$3"
                  onPress={() => setConfirmingApply(true)}
                  disabled={updateMut.isPending}
                  data-testid="schedule-apply"
                >
                  {String(
                    updateMut.isPending
                      ? t("moderation.schedApplying")
                      : t("moderation.schedApply"),
                  )}
                </Button>
              </XStack>
            </>
          )}
        </YStack>
      )}

      {/* ── The schedule ─────────────────────────────────────────────── */}
      <YStack gap="$2">
        <XStack justifyContent="space-between" alignItems="baseline" gap="$2" flexWrap="wrap">
          <Text variant="overline" tone="muted" tag="h3">
            {String(t("moderation.schedDatesLabel"))}
          </Text>
          {/* Never a series total — the list is capped twice over. */}
          <Text variant="overline" tone="muted" style={TABULAR}>
            {String(t("rsvp.monthDateCount", { count: rows.length }))}
          </Text>
        </XStack>
        {!hasRule && rows.length === 0 ? (
          <YStack
            padding="$5"
            gap="$2"
            borderWidth={1}
            borderColor="$borderColorSoft"
            backgroundColor="$surface"
            alignItems="center"
          >
            <Text variant="body">{String(t("moderation.schedNoDates"))}</Text>
            {/* The hint says to set a rule, which a closed listing cannot. */}
            {closedKind ? null : (
              <Text
                variant="bodySmall"
                tone="muted"
                textAlign="center"
                data-testid="schedule-no-dates-hint"
              >
                {String(t("moderation.schedNoDatesHint"))}
              </Text>
            )}
          </YStack>
        ) : (
          <ScheduleDateList
            rows={rows}
            timezone={timezone}
            locale={fmt.locale}
            doomedIds={doomedIds}
            outOfReachIds={outOfReachIds}
            pendingIds={pendingIds}
            onCallOff={setConfirmingCallOff}
            onPutBack={putBack}
            canPutBack={!closedKind}
            callOffConfirmOpen={confirmingCallOff !== null}
          />
        )}
      </YStack>

      {/* Calling a night off emails everyone holding a live RSVP on it. The
          confirm states that outcome rather than asking "are you sure". */}
      <ConfirmDialog
        open={confirmingCallOff !== null}
        tone="danger"
        title={String(t("rsvp.callOffConfirmTitle"))}
        description={String(
          t("rsvp.callOffConfirmBody", { date: confirmDate }),
        )}
        confirmLabel={String(t("rsvp.callOffConfirmAction"))}
        cancelLabel={String(t("rsvp.callOffConfirmKeep"))}
        onCancel={() => setConfirmingCallOff(null)}
        onConfirm={() => {
          if (confirmingCallOff) {
            runDateWrite(
              confirmingCallOff,
              cancelMut,
              String(t("rsvp.errCallOffFailed")),
            );
          }
          // Closed immediately rather than held on a spinner: the ROW goes
          // busy, which keeps the progress beside the date the moderator is
          // looking at, and lets the modal hand focus back before the re-read.
          setConfirmingCallOff(null);
        }}
      />

      <ConfirmDialog
        open={confirmingApply}
        tone="danger"
        title={String(t("moderation.schedApplyConfirmTitle"))}
        description={String(
          t("moderation.schedApplyConfirmBody", {
            dropped: diff?.droppedCount ?? 0,
          }),
        )}
        confirmLabel={String(t("moderation.schedApplyConfirmAction"))}
        cancelLabel={String(t("moderation.schedApplyConfirmKeep"))}
        loading={updateMut.isPending}
        loadingLabel={String(t("moderation.schedApplying"))}
        onCancel={() => setConfirmingApply(false)}
        onConfirm={() => {
          setConfirmingApply(false);
          applyRule();
        }}
      />
    </YStack>
  );
}

const CLOSED_COPY = {
  takenDown: "moderation.schedClosedTakenDown",
  ended: "moderation.schedClosedEnded",
} as const satisfies Record<ListingClosedKind, string>;

/** Stable empty set — a fresh `new Set()` per render would re-render the list. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Column-aligned digits on the Montserrat face. */
const TABULAR: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

ListingSchedule.displayName = "ListingSchedule";
