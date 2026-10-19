import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { BookingIntent } from "@th/types/repos/booking-requests";
import type {
  BookingStandardOwnerKey,
  BookingStandardsForOwners,
} from "@th/types/repos/booking-standards";
import type { CalendarRow } from "@th/types/repos/calendars";

import {
  resolveBookingStandards,
  type EffectiveBookingStandards,
  type OwnerBookingStandardRows,
} from "./resolve-booking-standards";

// ─────────────────────────────────────────────────────────────────────────────
// Effective booking standards for a place's calendars, from storage
// (venue-booking-standards spec, FR-003 / FR-004 / FR-006, NFR-002).
//
// The ONE loader behind every reader that needs resolved standards: the
// public booking-options read, the signed-in create gate, and the anonymous
// embed inquiry. It makes ONE `listForOwners` call for the place and every
// target calendar, then runs the pure resolver per (calendar, intent).
//
// Two rules live here and nowhere else (the third, "an unclaimed place
// resolves without venue rows", went with parking in the 2026-09-25
// amendment — FR-004 v1.1 / V8: an unclaimed place takes no requests, so
// no reader resolves standards for one):
//   1. DEGRADE, never fail. A throwing read (the table not migrated yet, a
//      dropped connection) returns the platform defaults for every target,
//      `degraded: true`, logged at error and reported. Platform defaults are
//      SUGGESTED-only (NFR-002), so a degraded read can never block a
//      request — the create gate fails OPEN on it by construction.
//   2. A STALE CATALOGUE IS VISIBLE. When the winning level had items the
//      intent's form no longer has (`droppedCount`), the read still succeeds
//      and ONE warning report names the first drop and lists all — at most
//      once per PLACE per process (see `reportDroppedItems`), because this
//      read sits behind every public dialog open.
//
// CALL IT OUTSIDE A TRANSACTION. Rule 1 swallows the read's failure, but
// inside a Postgres transaction a failed statement aborts the whole
// transaction: the fallback would "succeed" and the caller's next statement
// would fail with 25P02 (in_failed_sql_transaction). Every caller today reads
// before its `repos.tx()`; keep it that way.
// ─────────────────────────────────────────────────────────────────────────────

export type LoadEffectiveBookingStandardsDeps = {
  /** The ROOT repos — never a tx bag (see the module header). */
  repos: Pick<Repos, "bookingStandards">;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/** One calendar and the intents to resolve for it. */
export type BookingStandardsTarget = {
  /**
   * Null = the request routes to NO calendar (a place with none; PERFORM
   * only): resolves place → platform.
   */
  calendarId: string | null;
  intents: readonly BookingIntent[];
};

export type LoadEffectiveBookingStandardsInput = {
  place: Pick<
    PlaceRecord,
    "id" | "status" | "verificationStatus" | "humanIdsWithAccess" | "orgIdsWithAccess"
  >;
  targets: readonly BookingStandardsTarget[];
};

export type EffectiveBookingStandardsByIntent = Partial<
  Record<BookingIntent, EffectiveBookingStandards>
>;

export type LoadedBookingStandards = {
  /** True when the read failed and every target fell to the platform defaults. */
  degraded: boolean;
  /** One entry per input target, in the same order. */
  targets: { calendarId: string | null; byIntent: EffectiveBookingStandardsByIntent }[];
};

const USE_CASE = "loadEffectiveBookingStandards";

const ownerKey = (key: BookingStandardOwnerKey) =>
  `${key.ownerType}|${key.ownerId}`;

/**
 * The intents a calendar takes REQUESTS for — the options read's folded
 * rule: RENT only while `rentalMode` is REQUEST (INSTANT excludes rental
 * requests, the create gate's rule too). Standards are shown and enforced
 * only where a request can be made, and the calendar write refuses an
 * intent outside this list.
 */
export function calendarRequestIntents(
  calendar: Pick<
    CalendarRow,
    "acceptsPerform" | "acceptsRent" | "acceptsUse" | "rentalMode"
  >,
): BookingIntent[] {
  const intents: BookingIntent[] = [];
  if (calendar.acceptsPerform) intents.push("PERFORM");
  if (calendar.acceptsRent && calendar.rentalMode === "REQUEST") {
    intents.push("RENT");
  }
  if (calendar.acceptsUse) intents.push("USE");
  return intents;
}

/** Group one `listForOwners` result by owner. */
function groupByOwner(
  rows: BookingStandardsForOwners,
): Map<string, OwnerBookingStandardRows> {
  const grouped = new Map<
    string,
    { items: OwnerBookingStandardRows["items"][number][]; examples: OwnerBookingStandardRows["examples"][number][] }
  >();
  const bucket = (key: string) => {
    let entry = grouped.get(key);
    if (!entry) {
      entry = { items: [], examples: [] };
      grouped.set(key, entry);
    }
    return entry;
  };
  for (const item of rows.items) bucket(ownerKey(item)).items.push(item);
  for (const example of rows.examples) {
    bucket(ownerKey(example)).examples.push(example);
  }
  return grouped;
}

/** Every target resolved with no venue rows: calendar/place → platform. */
function resolveWithoutRows(
  targets: readonly BookingStandardsTarget[],
): LoadedBookingStandards["targets"] {
  return targets.map((target) => ({
    calendarId: target.calendarId,
    byIntent: Object.fromEntries(
      target.intents.map((intent) => [
        intent,
        resolveBookingStandards({ intent, calendarRows: null, placeRows: null }),
      ]),
    ) as EffectiveBookingStandardsByIntent,
  }));
}

/**
 * Resolve the effective standards + examples for every (calendar, intent)
 * in `targets` at `place`. Never throws for a storage failure — see the
 * module header for the degrade contract.
 */
export async function loadEffectiveBookingStandards(
  deps: LoadEffectiveBookingStandardsDeps,
  input: LoadEffectiveBookingStandardsInput,
): Promise<LoadedBookingStandards> {
  const { place, targets } = input;

  const wantsAnything = targets.some((target) => target.intents.length > 0);
  if (!wantsAnything) {
    return { degraded: false, targets: resolveWithoutRows(targets) };
  }

  const owners: BookingStandardOwnerKey[] = [
    { ownerType: "PLACE", ownerId: place.id },
  ];
  const calendarIds = new Set<string>();
  for (const target of targets) {
    if (target.calendarId !== null && !calendarIds.has(target.calendarId)) {
      calendarIds.add(target.calendarId);
      owners.push({ ownerType: "CALENDAR", ownerId: target.calendarId });
    }
  }
  const intents = new Set(targets.flatMap((target) => target.intents));
  const onlyIntent = intents.size === 1 ? [...intents][0] : undefined;

  let rows: BookingStandardsForOwners;
  try {
    rows = await deps.repos.bookingStandards.listForOwners({
      owners,
      ...(onlyIntent !== undefined ? { intent: onlyIntent } : {}),
    });
  } catch (error) {
    // Deliberate swallow (NFR-002): standards are guidance layered on a
    // request flow that predates them, so a failed read must never take the
    // dialog or a submission down with it. Platform defaults are
    // SUGGESTED-only, so the fallback blocks nothing.
    deps.logger?.error("booking_standards.load_failed", {
      placeId: place.id,
      calendarIds: [...calendarIds],
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: USE_CASE },
        extra: { placeId: place.id, calendarIds: [...calendarIds] },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // degraded read into a failed one.
    }
    return { degraded: true, targets: resolveWithoutRows(targets) };
  }

  const grouped = groupByOwner(rows);
  const placeRows = grouped.get(ownerKey({ ownerType: "PLACE", ownerId: place.id })) ?? null;

  const drops: {
    calendarId: string | null;
    intent: BookingIntent;
    droppedCount: number;
  }[] = [];

  const resolved = targets.map((target) => {
    const calendarRows =
      target.calendarId === null
        ? null
        : (grouped.get(
            ownerKey({ ownerType: "CALENDAR", ownerId: target.calendarId }),
          ) ?? null);
    const byIntent: EffectiveBookingStandardsByIntent = {};
    for (const intent of target.intents) {
      const effective = resolveBookingStandards({
        intent,
        calendarRows,
        placeRows,
      });
      if (effective.droppedCount > 0) {
        drops.push({
          calendarId: target.calendarId,
          intent,
          droppedCount: effective.droppedCount,
        });
      }
      byIntent[intent] = effective;
    }
    return { calendarId: target.calendarId, byIntent };
  });

  if (drops.length > 0) reportDroppedItems(deps, place.id, drops);

  return { degraded: false, targets: resolved };
}

/** How many places the dropped-items dedupe remembers per process. */
export const DROPPED_ITEMS_REPORT_DEDUPE_CAP = 500;

/**
 * Places already reported for dropped items by THIS process. Best-effort,
 * per instance: a restart or another Cloud Run instance reports again, and
 * past the cap the oldest place is forgotten (a Set iterates in insertion
 * order, so the first key is the oldest). Stale rows persist until the venue
 * edits them, so one report per place per instance is enough signal — the
 * read runs on every public dialog open and would otherwise report each time.
 */
const reportedDroppedItemsPlaces = new Set<string>();

/**
 * Stored items the catalogue no longer applies to the intent were dropped.
 * Not an exception — the read is fine — but a signal that stored data and
 * the catalogue disagree, so ONE report per load (the first drop in the
 * extra's top level, every drop in `drops`), and none for a place this
 * process already reported. Warning-level by TAG only: `ReporterPort`'s
 * context is `{ tags, extra }` with no level field, so `tags.severity`
 * carries it. Guarded end to end: this must never turn a successful read
 * into a failed one.
 */
function reportDroppedItems(
  deps: LoadEffectiveBookingStandardsDeps,
  placeId: string,
  drops: { calendarId: string | null; intent: BookingIntent; droppedCount: number }[],
): void {
  if (reportedDroppedItemsPlaces.has(placeId)) return;
  if (reportedDroppedItemsPlaces.size >= DROPPED_ITEMS_REPORT_DEDUPE_CAP) {
    const oldest = reportedDroppedItemsPlaces.values().next().value;
    if (oldest !== undefined) reportedDroppedItemsPlaces.delete(oldest);
  }
  // Marked BEFORE reporting: a throwing reporter must not make every later
  // load retry it.
  reportedDroppedItemsPlaces.add(placeId);

  const first = drops[0]!;
  const extra = {
    placeId,
    calendarId: first.calendarId,
    intent: first.intent,
    droppedCount: first.droppedCount,
    drops,
  };
  try {
    deps.logger?.warn("booking_standards.dropped_items", extra);
    deps.reportError?.(new Error("booking_standards_dropped_items"), {
      tags: { useCase: USE_CASE, step: "dropped_items", severity: "warning" },
      extra,
    });
  } catch {
    // Intentionally empty — reporting must never manufacture a new failure.
  }
}

/**
 * The single-target form the create paths use: the effective standards for
 * the ROUTED calendar (null = none) and one intent.
 */
export async function loadEffectiveBookingStandardsForCalendar(
  deps: LoadEffectiveBookingStandardsDeps,
  input: {
    place: LoadEffectiveBookingStandardsInput["place"];
    calendarId: string | null;
    intent: BookingIntent;
  },
): Promise<{ effective: EffectiveBookingStandards; degraded: boolean }> {
  const loaded = await loadEffectiveBookingStandards(deps, {
    place: input.place,
    targets: [{ calendarId: input.calendarId, intents: [input.intent] }],
  });
  return {
    effective: loaded.targets[0]!.byIntent[input.intent]!,
    degraded: loaded.degraded,
  };
}
