import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { narrowAccessibleEvents } from "../features/auth/use-scanner-session";
import { trpc } from "../trpc";
import {
  clearAll,
  dropPeopleForEvent,
  dropStalePeople,
  upsertEvents,
  upsertPeople,
  upsertTickets,
  type LocalEvent,
  type LocalTicketInput,
  type ManifestPerson,
} from "./local-db";

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

export function useLocalSync(enabled: boolean) {
  const utils = trpc.useUtils();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventIdsRef = useRef<string[]>([]);
  const previousEventIdsRef = useRef<string[]>([]);
  const eventEndsAtRef = useRef<Map<string, number | null>>(new Map());

  const eventsQuery = trpc.scanner.listAccessibleEvents.useQuery(
    {},
    { enabled, staleTime: EVENTS_STALE_MS, refetchInterval: EVENTS_STALE_MS },
  );

  const accessibleEvents = narrowAccessibleEvents(eventsQuery.data);

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

    const nextIds = accessibleEvents.map((e) => e.eventId);
    const prev = previousEventIdsRef.current;
    const removed = prev.filter((id) => !nextIds.includes(id));
    for (const removedId of removed) {
      try {
        dropPeopleForEvent(removedId);
      } catch (err) {
        if (__DEV__) {
          console.warn(
            `[sync] dropPeopleForEvent failed for ${removedId}`,
            err,
          );
        }
      }
    }
    previousEventIdsRef.current = nextIds;
    eventIdsRef.current = nextIds;

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
  }, [accessibleEvents, eventsQuery.isSuccess]);

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
        }
        continue;
      }

      void utils.scanner.getEventManifest
        .fetch({ eventId })
        .then((manifest) => {
          const data = narrowManifest(manifest);
          if (!data) return;
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
          upsertTickets(localTickets);
          upsertPeople(eventId, data.people);
        })
        .catch((err: unknown) => {
          if (__DEV__) {
            console.warn(`[sync] manifest fetch failed for ${eventId}`, err);
          }
        });
    }

    // FR-008 case d: stale-event sweep. Drop any people rows older than 24h
    // whose event is no longer in the active list (catches anything that
    // escaped the per-event diff above, e.g. across cold starts).
    try {
      dropStalePeople({
        staleAfterMs: PEOPLE_STALE_MS,
        activeEventIds: ids,
      });
    } catch (err) {
      if (__DEV__) {
        console.warn("[sync] dropStalePeople failed", err);
      }
    }
  }, [utils]);

  // Initial sync + recurring interval.
  useEffect(() => {
    if (!enabled || accessibleEvents.length === 0) return;

    syncManifests();

    intervalRef.current = setInterval(syncManifests, MANIFEST_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, accessibleEvents.length > 0, syncManifests]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const reset = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    clearAll();
    eventIdsRef.current = [];
  }, []);

  return {
    isSyncing: eventsQuery.isFetching,
    accessibleEvents,
    reset,
    refresh: syncManifests,
  };
}
