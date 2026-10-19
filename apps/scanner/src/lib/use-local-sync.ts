import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { narrowAccessibleEvents } from "../features/auth/use-scanner-session";
import { trpc } from "../trpc";
import {
  dropPeopleForEvent,
  dropEventsNotIn,
  dropStalePeople,
  upsertEvents,
  upsertPeople,
  upsertTickets,
  type LocalEvent,
  type LocalTicketInput,
  type ManifestPerson,
} from "./local-db";
import { reportRetentionIssue } from "./report";

const MANIFEST_INTERVAL_MS = 60_000;
const EVENTS_STALE_MS = 10 * 60_000;
const PEOPLE_STALE_MS = 24 * 60 * 60_000;
const ENDED_EVENT_GRACE_MS = 24 * 60 * 60_000;

type ManifestTicket = {
  ticketId: string;
  code: string;
  eventId: string;
  status: string;
  ownerHumanId: string;
  scannedAt: string | null;
  ticketTypeName: string | null;
  orderId: string | null;
};

const isManifestTicket = (x: unknown): x is ManifestTicket =>
  !!x &&
  typeof x === "object" &&
  typeof (x as { ticketId?: unknown }).ticketId === "string" &&
  typeof (x as { code?: unknown }).code === "string" &&
  typeof (x as { eventId?: unknown }).eventId === "string";

const isManifestPerson = (x: unknown): x is ManifestPerson => {
  if (!x || typeof x !== "object") return false;
  const o = x as {
    humanId?: unknown;
    kind?: unknown;
    displayName?: unknown;
    email?: unknown;
    signupStatus?: unknown;
  };
  return (
    typeof o.humanId === "string" &&
    (o.kind === "attendee" || o.kind === "volunteer") &&
    (o.displayName === null || typeof o.displayName === "string") &&
    (o.email === null || typeof o.email === "string")
  );
};

const narrowManifest = (
  data: unknown,
): {
  eventId: string;
  tickets: ManifestTicket[];
  people: ManifestPerson[];
} | null => {
  if (!data || typeof data !== "object") return null;
  const eventId = (data as { eventId?: unknown }).eventId;
  const tickets = (data as { tickets?: unknown }).tickets;
  const people = (data as { people?: unknown }).people;
  if (typeof eventId !== "string" || !Array.isArray(tickets)) return null;
  return {
    eventId,
    tickets: tickets.filter(isManifestTicket),
    people: Array.isArray(people) ? people.filter(isManifestPerson) : [],
  };
};

/**
 * A manifest that arrived but could not be written to SQLite. Reported once
 * per app run: the same failure would otherwise send an event for every listed
 * event every minute. Network failures never reach this (the fetch wrapper in
 * `trpc.ts` captures those).
 */
let manifestWriteFailureReported = false;

/**
 * Report a failure of a step that runs on every sync tick, once per app run
 * per branch. Each tick would otherwise send the same failure every minute.
 */
const reportedTickBranches = new Set<string>();
const reportTickFailureOnce = (branch: string, err: unknown): void => {
  if (reportedTickBranches.has(branch)) return;
  reportedTickBranches.add(branch);
  reportRetentionIssue(err, { branch });
};

/**
 * The raw `events` array of a `listAccessibleEvents` answer, or null when the
 * answer does not have one. `narrowAccessibleEvents` turns any other shape
 * into `[]`, which must never be read as "this operator has no events".
 */
const listedEvents = (data: unknown): unknown[] | null => {
  const events = (data as { events?: unknown } | null | undefined)?.events;
  return Array.isArray(events) ? events : null;
};

export function useLocalSync(enabled: boolean) {
  const utils = trpc.useUtils();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventIdsRef = useRef<string[]>([]);
  const previousEventIdsRef = useRef<string[]>([]);
  // False until the first confirmed event list of this signed-in stretch has
  // been compared with what SQLite holds. `previousEventIdsRef` lives in
  // memory and starts empty on a cold start, so without this an event the
  // operator lost while the app was closed kept its people rows until the 24h
  // sweep. Reset whenever sync is switched off (sign-out, access denied).
  const reconciledWithDbRef = useRef(false);
  // When sync was last switched on. A list the query cache already held at
  // that moment was answered for an earlier stretch (possibly another
  // operator), so it is not an answer for this one.
  const enabledAtRef = useRef<number | null>(null);
  // True once a list of this stretch has filled `eventIdsRef`; starts the
  // manifest sync. `accessibleEvents` cannot stand in for it: it also shows a
  // cached list that `eventIdsRef` was never filled from.
  const [hasListedEvents, setHasListedEvents] = useState(false);
  const eventEndsAtRef = useRef<Map<string, number | null>>(new Map());

  const eventsQuery = trpc.scanner.listAccessibleEvents.useQuery(
    {},
    { enabled, staleTime: EVENTS_STALE_MS, refetchInterval: EVENTS_STALE_MS },
  );

  const accessibleEvents = narrowAccessibleEvents(eventsQuery.data);

  // Declared before the list effect below: on the render that switches sync
  // on, `enabledAtRef` must be set before that effect reads it.
  useEffect(() => {
    if (!enabled) {
      enabledAtRef.current = null;
      reconciledWithDbRef.current = false;
      // Nothing listed any more: a manifest still on the wire is not written.
      eventIdsRef.current = [];
      previousEventIdsRef.current = [];
      setHasListedEvents(false);
      return;
    }
    enabledAtRef.current = Date.now();
    // A list left in the cache is not trusted (see `enabledAtRef`); ask for
    // this stretch's own instead of waiting out the 10 minute refresh.
    if (utils.scanner.listAccessibleEvents.getData({}) !== undefined) {
      void utils.scanner.listAccessibleEvents.invalidate();
    }
  }, [enabled, utils]);

  // Keep a stable ref of current event IDs for the interval callback. Detect
  // events that disappeared from the accessible list (FR-008 case b: operator
  // lost access OR event ENDED/CLOSED so the API stopped returning it) and
  // wipe their cached people rows immediately.
  useEffect(() => {
    // Guard against transient empty states. If the query is pending, errored,
    // or refetching with no data yet, `accessibleEvents` will be `[]` even
    // though the user still has access. Running the diff in that window
    // would mass-drop people PII for every cached event on every token
    // rotation or cache invalidation. Only diff against a confirmed-fresh
    // success result.
    if (!eventsQuery.isSuccess) return;
    // Nor against a list answered before sync was switched on, or an answer
    // that is not a list of events at all (a wrong-shape 200 narrows to `[]`).
    const enabledAt = enabledAtRef.current;
    if (enabledAt === null || eventsQuery.dataUpdatedAt < enabledAt) return;
    const rawEvents = listedEvents(eventsQuery.data);
    if (!rawEvents) return;
    // An entry that failed to narrow would read as an event that left. Such a
    // list still drives the sync, but nothing is dropped on its word.
    const everyEntryRead = rawEvents.length === accessibleEvents.length;

    const nextIds = accessibleEvents.map((e) => e.eventId);
    const prev = previousEventIdsRef.current;
    const removed = prev.filter((id) => !nextIds.includes(id));
    // The first confirmed list is compared with SQLite itself, later ones with
    // the list before them. Either way everything outside the list goes in one
    // call, and a successful EMPTY list is a real answer: it drops everyone.
    const firstAnswer = !reconciledWithDbRef.current;
    if (everyEntryRead && (firstAnswer || removed.length > 0)) {
      reconciledWithDbRef.current = true;
      try {
        dropEventsNotIn(nextIds);
      } catch (err) {
        if (__DEV__) {
          console.warn("[sync] dropEventsNotIn failed", err);
        }
        reportRetentionIssue(err, {
          branch: "event_list_people_drop",
          extra: { listedEvents: nextIds.length, firstAnswer },
        });
      }
    }
    previousEventIdsRef.current = nextIds;
    eventIdsRef.current = nextIds;
    setHasListedEvents(nextIds.length > 0);

    // Cache endsAt for FR-008 case c (end-time + 24h grace wipe).
    const map = new Map<string, number | null>();
    for (const e of accessibleEvents) {
      const ts =
        e.endAt instanceof Date
          ? e.endAt.getTime()
          : typeof e.endAt === "string"
            ? Date.parse(e.endAt)
            : null;
      map.set(e.eventId, Number.isFinite(ts as number) ? (ts as number) : null);
    }
    eventEndsAtRef.current = map;
  }, [
    enabled,
    accessibleEvents,
    eventsQuery.isSuccess,
    eventsQuery.dataUpdatedAt,
    eventsQuery.data,
  ]);

  // Persist events to SQLite whenever the list changes.
  useEffect(() => {
    if (!enabled || accessibleEvents.length === 0) return;

    const localEvents: LocalEvent[] = accessibleEvents.map((e) => ({
      eventId: e.eventId,
      eventName: e.eventName,
      orgId: e.orgId,
      startAt: e.startAt instanceof Date ? e.startAt.toISOString() : e.startAt,
      endAt: e.endAt instanceof Date ? e.endAt.toISOString() : e.endAt,
      status: e.status,
      role: e.role,
      lat: e.lat ?? null,
      lng: e.lng ?? null,
    }));
    upsertEvents(localEvents);
  }, [enabled, accessibleEvents]);

  const syncManifests = useCallback(() => {
    const ids = eventIdsRef.current;
    const now = Date.now();
    const endsAtMap = eventEndsAtRef.current;

    for (const eventId of ids) {
      // FR-008 case c: event has ended more than 24h ago — purge cached
      // people for it and skip the manifest fetch this cycle. Tickets remain
      // (existing behaviour) since slice 2 only touches the people cache.
      const endsAt = endsAtMap.get(eventId);
      if (
        endsAt !== undefined &&
        endsAt !== null &&
        now > endsAt + ENDED_EVENT_GRACE_MS
      ) {
        try {
          dropPeopleForEvent(eventId);
        } catch (err) {
          if (__DEV__) {
            console.warn(
              `[sync] dropPeopleForEvent (ended) failed for ${eventId}`,
              err,
            );
          }
          reportTickFailureOnce("ended_event_people_drop", err);
        }
        continue;
      }

      void utils.scanner.getEventManifest
        .fetch({ eventId })
        .then((manifest) => {
          const data = narrowManifest(manifest);
          if (!data) return;
          // The event left the list (or sync was switched off) while this
          // was on the wire: its people have been dropped, so do not write
          // them back.
          if (!eventIdsRef.current.includes(eventId)) return;
          const localTickets: LocalTicketInput[] = data.tickets.map((t) => ({
            ticketId: t.ticketId,
            code: t.code,
            eventId: t.eventId,
            status: t.status,
            ownerHuman: t.ownerHumanId,
            scannedAt: t.scannedAt,
            ticketTypeName: t.ticketTypeName ?? null,
            orderId: t.orderId ?? null,
          }));
          // A local write that fails is not a fetch failure: the `.catch`
          // below only warns in dev, which is how `upsertPeople` throwing on
          // every re-sync went unseen in production.
          try {
            upsertTickets(localTickets);
            upsertPeople(eventId, data.people);
          } catch (err) {
            if (__DEV__) {
              console.warn(`[sync] manifest write failed for ${eventId}`, err);
            }
            if (!manifestWriteFailureReported) {
              manifestWriteFailureReported = true;
              reportRetentionIssue(err, { branch: "manifest_local_write" });
            }
          }
        })
        .catch((err: unknown) => {
          if (__DEV__) {
            console.warn(`[sync] manifest fetch failed for ${eventId}`, err);
          }
        });
    }

    // FR-008 case d: stale-event sweep. Drop any people rows older than 24h
    // whose event is no longer in the active list.
    //
    // Only against a confirmed list. Before one (a cold start, offline, or
    // Home's refresh at mount) `ids` is empty, and an empty list here means
    // "no active events": every person synced more than 24h ago would go, so
    // an offline start the day after the last sync would empty the cache.
    if (!reconciledWithDbRef.current) return;
    try {
      dropStalePeople({
        staleAfterMs: PEOPLE_STALE_MS,
        activeEventIds: ids,
      });
    } catch (err) {
      if (__DEV__) {
        console.warn("[sync] dropStalePeople failed", err);
      }
      reportTickFailureOnce("stale_people_sweep", err);
    }
  }, [utils]);

  // Initial sync + recurring interval.
  useEffect(() => {
    if (!enabled || !hasListedEvents) return;

    syncManifests();

    intervalRef.current = setInterval(syncManifests, MANIFEST_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, hasListedEvents, syncManifests]);

  // Re-sync immediately when the app comes back to foreground.
  useEffect(() => {
    if (!enabled) return;

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && eventIdsRef.current.length > 0) {
        syncManifests();
      }
    });

    return () => sub.remove();
  }, [enabled, syncManifests]);

  return {
    isSyncing: eventsQuery.isFetching,
    accessibleEvents,
    refresh: syncManifests,
  };
}
