"use client";

import { useCallback, useMemo, useState } from "react";
import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import type {
  CommunityEventDate,
  CommunityRecurrenceSummary,
} from "@/server/events";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";

/** One date row as the list renders it (Date instants, not ISO strings). */
export type DateRsvpRow = {
  eventDateId: string;
  startsAt: Date;
  endsAt: Date | null;
  viewerRsvped: boolean;
  /**
   * `CANCELLED` — a moderator called this night off. The row stays in the list,
   * struck through, until it passes; it carries no RSVP control, and
   * `rsvpToEventDate` refuses it server-side (`EVENT_DATE_NOT_RSVPABLE`) so a
   * stale toggle fails loudly rather than pretending to work.
   */
  status: "SCHEDULED" | "CANCELLED";
};

/**
 * A recurring rule's cadence as the LIST consumes it: {@link
 * CommunityRecurrenceSummary} with `until` revived from its ISO wire form, which
 * is the shape `listEventDates` answers with.
 */
export type DateRsvpRecurrence = Omit<CommunityRecurrenceSummary, "until"> & {
  until: Date | null;
};

export type DateRsvpList = {
  rows: DateRsvpRow[];
  /**
   * The cadence behind those rows, and whether they run to the END of the
   * series. Resolved from the SAME source as `rows` — see the return statement:
   * the seed rides an edge-cached document and the payload does not, so a
   * consumer that reads one from the prop and the other from here can print a
   * sentence neither source ever said.
   */
  recurrence: DateRsvpRecurrence | null;
  truncated: boolean;
  /**
   * The row the section must LEAD with — the first upcoming one still
   * SCHEDULED, `null` when every upcoming night is called off (or there are
   * none). Resolved from the same source as `rows` for the same reason
   * `truncated` is: `rows[0]` is now routinely the wrong answer, and a lead
   * date read off a stale cached seed points at a different night than the rows
   * beside it.
   */
  nextScheduledEventDateId: string | null;
  /**
   * The listing has a stored recurrence rule at all. With no upcoming SCHEDULED
   * date this is what tells "drained but live" and "genuinely ended" apart from
   * an ordinary single-date listing — see the zero-dates branch in
   * `CommunityDateList`.
   */
  hasRecurrenceRule: boolean;
  /** Better Auth session still resolving (toggles inert until known). */
  sessionPending: boolean;
  isSignedIn: boolean;
  /** Per-date in-flight set (disable + busy that one row only). */
  pendingIds: ReadonlySet<string>;
  /** Toggle a single date's RSVP. Signed-out viewers route through sign-in. */
  toggle: (row: DateRsvpRow) => void;
};

/**
 * Controller for the per-date "I'm going" toggles on a recurring COMMUNITY
 * listing (recurring-dates spec, slice 4). Shows the server-fetched dates
 * immediately (no loading flash), applies optimistic flips
 * on `rsvpToDate` / `cancelDateRsvp`, rolls back on error, and invalidates the
 * query on settle so the viewer's own state stays truthful.
 *
 * FR-004: reflects ONLY the viewer's own per-date state — never a count.
 */
export function useDateRsvpList({
  eventId,
  initialDates,
  initialRecurrence = null,
  initialTruncated = false,
  initialNextScheduledEventDateId = null,
  initialHasRecurrenceRule = false,
}: {
  eventId: string;
  initialDates: CommunityEventDate[];
  /**
   * The server-fetched cadence, seeded alongside the dates and handed straight
   * back out as {@link DateRsvpList.recurrence} until the query has real data of
   * its own. `listEventDates` answers `{ dates, recurrence, truncated }`, so all
   * three travel together: seeding one and reading another from a prop is how a
   * page ends up describing two different lists at once.
   */
  initialRecurrence?: CommunityRecurrenceSummary | null;
  /** Same deal — the seed for {@link DateRsvpList.truncated}. */
  initialTruncated?: boolean;
  /** Same deal — the seed for {@link DateRsvpList.nextScheduledEventDateId}. */
  initialNextScheduledEventDateId?: string | null;
  /** Same deal — the seed for {@link DateRsvpList.hasRecurrenceRule}. */
  initialHasRecurrenceRule?: boolean;
}): DateRsvpList {
  const t = useTranslations();
  const { toast } = useNotify();
  const { showSignInOverlay } = useAppOverlay();
  const utils = trpc.useUtils();

  const sessionQuery = authClient.useSession();
  const isSignedIn = Boolean(sessionQuery.data?.user);

  const seeded = useMemo(
    () => ({
      dates: initialDates.map((d) => ({
        eventDateId: d.eventDateId,
        startsAt: new Date(d.startsAt),
        endsAt: d.endsAt ? new Date(d.endsAt) : null,
        viewerRsvped: d.viewerRsvped,
        status: d.status,
      })),
      // ISO on the RSC → island boundary, a Date over the wire — revive it so
      // the seed is assignable to the query's own output type.
      recurrence: initialRecurrence
        ? {
            ...initialRecurrence,
            until: initialRecurrence.until
              ? new Date(initialRecurrence.until)
              : null,
          }
        : null,
      truncated: initialTruncated,
      nextScheduledEventDateId: initialNextScheduledEventDateId,
      hasRecurrenceRule: initialHasRecurrenceRule,
      // The stored rule is for the moderator's editor, not this list: the
      // page has no seed for it and never reads it. `null` is the honest
      // placeholder ("not in hand"), not a claim that there is no rule.
      storedRule: null,
    }),
    [
      initialDates,
      initialRecurrence,
      initialTruncated,
      initialNextScheduledEventDateId,
      initialHasRecurrenceRule,
    ],
  );

  /**
   * `placeholderData`, NOT `initialData` — the seed arrives TWICE, and the
   * second arrival carries the only copy of the viewer's own RSVPs.
   *
   * The event page document is edge-cacheable, so `viewerRsvped` is STRIPPED out
   * of it (`PublicCommunityEventDate`): the first render hands this hook 60 dates
   * that are all `viewerRsvped: false`, for everyone, by construction. The real
   * flags land a moment later, when `POST /api/events/[id]/viewer-state` resolves
   * and `EventPageBody` recomputes `communityDates` — a NEW `initialDates`.
   *
   * react-query consumes `initialData` only while the cache entry has no data,
   * so that second seed was dropped on the floor, and with `staleTime: 30_000`,
   * `refetchOnWindowFocus: false` and no interval, nothing ever refetched it
   * either. A signed-in viewer who had already said yes to Sep 23 saw every chip
   * unpressed and labelled "I'm going" until they toggled something.
   *
   * A PLACEHOLDER is never written to the cache, so the query still counts as
   * having no data and fetches — once, on mount. `enabled` limits that fetch to
   * a signed-in viewer: that is the only reader whose flags can differ from the
   * seed, and a signed-out one would be paying a round trip to be told the same
   * 60 false flags the document already carries. `staleTime` then keeps a
   * remount inside 30s off the wire, exactly as before.
   */
  const query = trpc.community.listEventDates.useQuery(
    { eventId },
    {
      placeholderData: seeded,
      enabled: isSignedIn,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );

  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const addPending = useCallback((id: string) => {
    setPendingIds((prev) => new Set(prev).add(id));
  }, []);
  const removePending = useCallback((id: string) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const writeGoing = useCallback(
    (eventDateId: string, going: boolean) => {
      utils.community.listEventDates.setData({ eventId }, (prev) => {
        const base = prev ?? seeded;
        // Spread `base` first: this writer owns `dates` only, and dropping
        // `recurrence` here would wipe the cadence out of the cache on the
        // first toggle.
        return {
          ...base,
          dates: base.dates.map((d) =>
            d.eventDateId === eventDateId ? { ...d, viewerRsvped: going } : d,
          ),
        };
      });
    },
    [eventId, seeded, utils],
  );

  const rsvpMut = trpc.community.rsvpToDate.useMutation();
  const cancelMut = trpc.community.cancelDateRsvp.useMutation();

  const toggle = useCallback(
    (row: DateRsvpRow) => {
      if (sessionQuery.isPending) return;
      if (pendingIds.has(row.eventDateId)) return;
      // A called-off night renders no RSVP control, so this is only reachable
      // from a render that has gone stale under a moderator's call-off. The
      // server refuses it either way (`EVENT_DATE_NOT_RSVPABLE`); returning
      // here keeps the optimistic flip from painting a "you're going" the
      // server will never agree with, and from rolling it back a beat later.
      if (row.status === "CANCELLED") return;

      if (!isSignedIn) {
        // No anonymous RSVPs — route through sign-in, back to this page.
        const redirect =
          typeof window !== "undefined"
            ? `${window.location.pathname}${window.location.search}`
            : "/";
        showSignInOverlay({ redirect: redirect || "/" });
        return;
      }

      const next = !row.viewerRsvped;
      // Busy immediately — this press is real even though the write below lands
      // a microtask later, and a second press must find it in `pendingIds`.
      addPending(row.eventDateId);

      /**
       * The optimistic prelude react-query documents, and the reason it exists:
       * ABORT whatever is already on the wire for this query BEFORE writing the
       * flip.
       *
       * Since the switch to `placeholderData` a signed-in viewer always issues
       * one fetch as the session resolves. On a slow connection that fetch can
       * land AFTER the press, carrying the pre-press server view, and overwrite
       * the optimistic flip. `onSettled`'s invalidate repairs it a moment later
       * (`cancelRefetch` defaults to true), so the flip is never lost for good —
       * but the viewer watches their chip fill, empty, and fill again.
       *
       * The promise is AWAITED, not dropped: a cancelled query reverts to its
       * pre-fetch state, and the write has to land after that revert rather than
       * under it. The cost is one microtask — the abort itself is synchronous,
       * and the awaited promise is the already-settled retryer's — and there is
       * no rejection path, because query-core swallows the CancelledError.
       */
      void (async () => {
        await utils.community.listEventDates.cancel({ eventId });
        writeGoing(row.eventDateId, next);

        const mutation = next ? rsvpMut : cancelMut;
        mutation.mutate(
          { eventDateId: row.eventDateId },
          {
            onError: () => {
              writeGoing(row.eventDateId, row.viewerRsvped);
              toast.danger({ title: String(t("rsvp.errToggleFailed")) });
            },
            onSettled: () => {
              removePending(row.eventDateId);
              void utils.community.listEventDates.invalidate({ eventId });
            },
          },
        );
      })();
    },
    [
      addPending,
      cancelMut,
      eventId,
      isSignedIn,
      pendingIds,
      removePending,
      rsvpMut,
      sessionQuery.isPending,
      showSignInOverlay,
      t,
      toast,
      utils,
      writeGoing,
    ],
  );

  /**
   * `dates`, `recurrence` and `truncated` all come from whichever source is
   * CURRENT, together. The two sources disagree for a measurable window: the
   * seed rides the event-page document, which is edge-cached
   * (`s-maxage=120, stale-while-revalidate=300`), while this query is not cached
   * at all. Swap a bounded rule for an open-ended one and for up to ~5 minutes a
   * signed-in viewer holds a stale `truncated: false` beside 60 fresh rows —
   * enough to print "60 DATES THROUGH SEP 2027" over a night that never ends,
   * which is the one sentence this section must never say.
   *
   * `isPlaceholderData` is the only honest test for "is there real data yet":
   * with `placeholderData` set, `query.data` is never undefined, so
   * `query.data?.truncated ?? initialTruncated` would read the seed's value out
   * of the placeholder and look like it had consulted the payload. While the
   * data IS the placeholder every field comes from `seeded`, so the three agree
   * in that state too — including after an optimistic `setData`, which makes the
   * entry real with `seeded` as its base.
   */
  const live = query.isPlaceholderData ? null : query.data;

  return {
    rows: live?.dates ?? seeded.dates,
    recurrence: live ? live.recurrence : seeded.recurrence,
    truncated: live ? live.truncated : seeded.truncated,
    nextScheduledEventDateId: live
      ? live.nextScheduledEventDateId
      : seeded.nextScheduledEventDateId,
    hasRecurrenceRule: live
      ? live.hasRecurrenceRule
      : seeded.hasRecurrenceRule,
    sessionPending: sessionQuery.isPending,
    isSignedIn,
    pendingIds,
    toggle,
  };
}
