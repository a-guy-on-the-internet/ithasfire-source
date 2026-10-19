import { vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type {
  ArrivalAreaGeometry,
  ArrivalAreaParent,
  ArrivalAreaRow,
  CreateArrivalAreaInput,
  UpdateArrivalAreaPatch,
} from "@th/types/repos/arrival-areas";

/**
 * An in-memory world for the arrival-area mutation / editor tests: one
 * place (owned by PLACE_ORG unless `unowned`), one event (owned by
 * EVENT_ORG, at the place unless `eventPlaceId: null`), org memberships, a
 * moderator, and an ArrivalAreasRepo fake that records its call order.
 */

export const NOW = new Date("2026-10-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

export const PLACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_PLACE_ID = "abababab-abab-4bab-8bab-abababababab";
export const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const PLACE_ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
export const EVENT_ORG = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

export const PLACE_MANAGER = "11111111-1111-4111-8111-111111111111";
export const EVENT_EDITOR = "22222222-2222-4222-8222-222222222222";
export const MODERATOR = "33333333-3333-4333-8333-333333333333";
export const STRANGER = "44444444-4444-4444-8444-444444444444";
/** Manages the place AND edits the event. */
export const BOTH = "55555555-5555-4555-8555-555555555555";

export const TRUE_LAT = 36.1862;
export const TRUE_LNG = -86.7291;

const M_PER_DEG = (Math.PI * 6_371_000) / 180;

/** The point `dx` metres east and `dy` metres north of (lat, lng). */
export function offset(
  lat: number,
  lng: number,
  dx: number,
  dy: number,
): { lat: number; lng: number } {
  return {
    lat: lat + dy / M_PER_DEG,
    lng: lng + dx / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)),
  };
}

/** A ~40 m square lot centred on (lat, lng). */
export function squareAt(lat: number, lng: number, half = 20): ArrivalAreaGeometry {
  const sw = offset(lat, lng, -half, -half);
  const ne = offset(lat, lng, half, half);
  return {
    type: "Polygon",
    coordinates: [
      [
        [sw.lng, sw.lat],
        [ne.lng, sw.lat],
        [ne.lng, ne.lat],
        [sw.lng, ne.lat],
        [sw.lng, sw.lat],
      ],
    ],
  };
}

export function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Porter House",
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
    orgIdsWithAccess: [PLACE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
    listedInDirectory: true,
    ...overrides,
  } as unknown as PlaceRecord;
}

/** A third party's show at the place (no stamp): the place has not vouched. */
export function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    status: "DRAFT",
    publishedAt: null,
    ownerBanned: false,
    orgId: EVENT_ORG,
    humanId: null,
    stewardship: "ORGANIZATION",
    placeId: PLACE_ID,
    gateType: "NONE",
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    addressRevealPreset: "DAY_BEFORE",
    addressRevealAt: new Date(NOW.getTime() + 7 * DAY),
    addressText: "East Nashville",
    locality: "Nashville",
    region: "TN",
    postalCode: null,
    locationLabel: "East Nashville",
    // A STALE row that still carries the house: the pin rule must never
    // read it for a viewer who cannot see the address.
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    startsAt: new Date(NOW.getTime() + 8 * DAY),
    endsAt: new Date(NOW.getTime() + 8 * DAY + 3 * 60 * 60 * 1000),
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
    venueConfirmedStartsAt: null,
    ...overrides,
  } as unknown as EventRecord;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  return `cccccccc-cccc-4ccc-8ccc-${hex}`;
}

export function areaRow(
  overrides: Partial<ArrivalAreaRow> & Pick<ArrivalAreaRow, "id">,
): ArrivalAreaRow {
  return {
    placeId: PLACE_ID,
    eventId: null,
    kind: "PARKING",
    geometry: squareAt(TRUE_LAT + 0.001, TRUE_LNG),
    label: `Area ${overrides.id}`,
    cost: "FREE",
    priceText: null,
    note: null,
    accessibleSpots: false,
    sortOrder: 0,
    disabledAt: null,
    createdByHumanId: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

export type WorldOptions = {
  place?: PlaceRecord | null;
  event?: EventRecord | null;
  /** The place has no owner at all (moderator territory). */
  unowned?: boolean;
  areas?: ArrivalAreaRow[];
  hides?: Array<{ eventId: string; arrivalAreaId: string }>;
};

export function makeWorld(options: WorldOptions = {}) {
  const place =
    options.place === undefined
      ? makePlace(options.unowned ? { orgIdsWithAccess: [] } : {})
      : options.place;
  const event = options.event === undefined ? makeEvent() : options.event;
  const memberships = new Map<string, string>([
    [`${PLACE_ORG}:${PLACE_MANAGER}`, "EDITOR"],
    [`${EVENT_ORG}:${EVENT_EDITOR}`, "EDITOR"],
    [`${PLACE_ORG}:${BOTH}`, "ADMIN"],
    [`${EVENT_ORG}:${BOTH}`, "ADMIN"],
  ]);
  const owningOrgs = () => (options.unowned ? [] : [PLACE_ORG]);
  const store = new Map<string, ArrivalAreaRow>(
    (options.areas ?? []).map((row) => [row.id, { ...row }]),
  );
  const hides = [...(options.hides ?? [])];
  const calls: string[] = [];
  const audit: Array<{
    entity: string;
    entityId?: string | null;
    action: string;
    data?: unknown;
  }> = [];
  let clockMs = NOW.getTime();
  /**
   * Set while a `repos.tx` callback runs. The root-pool authz probes THROW
   * while it is set: calling them inside a transaction holds a second pool
   * connection under the Event row lock (step 4 review, BLOCKING).
   */
  let inTx = false;
  const rootPoolOnly = (name: string) => {
    calls.push(`authz:${name}`);
    if (inTx) throw new Error(`root-pool authz.${name} called inside a transaction`);
  };
  const tick = () => {
    clockMs += 1000;
    return new Date(clockMs);
  };

  const byParent = (parent: ArrivalAreaParent) =>
    [...store.values()]
      .filter((row) =>
        parent.placeId !== undefined
          ? row.placeId === parent.placeId
          : row.eventId === parent.eventId,
      )
      .sort((a, b) => a.sortOrder - b.sortOrder);

  const arrivalAreas = {
    listForPlace: vi.fn(async (placeId: string) => {
      calls.push("listForPlace");
      return byParent({ placeId });
    }),
    listForPlaces: vi.fn(async () => []),
    listForEvent: vi.fn(async (eventId: string) => {
      calls.push("listForEvent");
      return byParent({ eventId });
    }),
    getById: vi.fn(async (id: string) => {
      calls.push("getById");
      const row = store.get(id);
      return row ? { ...row } : null;
    }),
    countForPlace: vi.fn(async (placeId: string) => {
      calls.push("countForPlace");
      return byParent({ placeId }).length;
    }),
    countForEvent: vi.fn(async (eventId: string) => {
      calls.push("countForEvent");
      return byParent({ eventId }).length;
    }),
    lockParent: vi.fn(async (parent: ArrivalAreaParent) => {
      calls.push(`lockParent:${parent.placeId ? "place" : "event"}`);
      return parent.placeId !== undefined
        ? place?.id === parent.placeId
        : event?.id === parent.eventId;
    }),
    create: vi.fn(async (input: CreateArrivalAreaInput) => {
      calls.push("create");
      const at = tick();
      const row: ArrivalAreaRow = {
        id: nextId(),
        placeId: input.placeId ?? null,
        eventId: input.eventId ?? null,
        kind: input.kind,
        geometry: input.geometry,
        label: input.label,
        cost: input.cost ?? "UNKNOWN",
        priceText: input.priceText ?? null,
        note: input.note ?? null,
        accessibleSpots: input.accessibleSpots ?? false,
        sortOrder: input.sortOrder ?? 0,
        disabledAt: null,
        createdByHumanId: input.createdByHumanId ?? null,
        createdAt: at,
        updatedAt: at,
      };
      store.set(row.id, row);
      return { ...row };
    }),
    update: vi.fn(
      async (
        id: string,
        patch: UpdateArrivalAreaPatch,
        opts: { expectedUpdatedAt: Date },
      ) => {
        calls.push("update");
        const row = store.get(id);
        if (!row) return { status: "not_found" as const };
        if (row.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
          return { status: "conflict" as const, current: { ...row } };
        }
        const next = { ...row, ...patch, updatedAt: tick() } as ArrivalAreaRow;
        store.set(id, next);
        return { status: "updated" as const, row: { ...next } };
      },
    ),
    delete: vi.fn(async (id: string, opts: { expectedUpdatedAt: Date }) => {
      calls.push("delete");
      const row = store.get(id);
      if (!row) return { status: "not_found" as const };
      if (row.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
        return { status: "conflict" as const, current: { ...row } };
      }
      store.delete(id);
      for (let i = hides.length - 1; i >= 0; i -= 1) {
        if (hides[i]!.arrivalAreaId === id) hides.splice(i, 1);
      }
      return { status: "deleted" as const, row: { ...row } };
    }),
    reorder: vi.fn(async (parent: ArrivalAreaParent, orderedIds: readonly string[]) => {
      calls.push("reorder");
      const current = byParent(parent).map((row) => row.id);
      const same =
        current.length === orderedIds.length &&
        new Set(orderedIds).size === orderedIds.length &&
        orderedIds.every((id) => current.includes(id));
      if (!same) return { status: "mismatch" as const, currentIds: current };
      orderedIds.forEach((id, i) => {
        store.set(id, { ...store.get(id)!, sortOrder: i });
      });
      return { status: "reordered" as const, rows: byParent(parent) };
    }),
    setDisabledForEvent: vi.fn(async (eventId: string, at: Date | null) => {
      calls.push("setDisabledForEvent");
      let n = 0;
      for (const row of byParent({ eventId })) {
        if (at !== null && row.disabledAt !== null) continue;
        store.set(row.id, { ...row, disabledAt: at, updatedAt: tick() });
        n += 1;
      }
      return n;
    }),
    listHidesForEvent: vi.fn(async (eventId: string) =>
      hides.filter((h) => h.eventId === eventId).map((h) => h.arrivalAreaId),
    ),
    hide: vi.fn(async (eventId: string, arrivalAreaId: string) => {
      calls.push("hide");
      if (hides.some((h) => h.eventId === eventId && h.arrivalAreaId === arrivalAreaId)) {
        return false;
      }
      hides.push({ eventId, arrivalAreaId });
      return true;
    }),
    unhide: vi.fn(async (eventId: string, arrivalAreaId: string) => {
      calls.push("unhide");
      const i = hides.findIndex(
        (h) => h.eventId === eventId && h.arrivalAreaId === arrivalAreaId,
      );
      if (i < 0) return false;
      hides.splice(i, 1);
      return true;
    }),
    deleteHidesForEventNotInPlace: vi.fn(async (eventId: string, placeId: string | null) => {
      calls.push("deleteHidesForEventNotInPlace");
      const removed = hides.filter(
        (h) =>
          h.eventId === eventId &&
          (placeId === null || store.get(h.arrivalAreaId)?.placeId !== placeId),
      );
      for (const r of removed) hides.splice(hides.indexOf(r), 1);
      return removed.map((r) => ({ ...r }));
    }),
    movePlaceAreas: vi.fn(async () => []),
  };

  const membership = (orgId: string, humanId: string) => {
    const role = memberships.get(`${orgId}:${humanId}`);
    return role ? { orgId, humanId, role } : null;
  };

  const repos = {
    arrivalAreas,
    places: {
      getById: vi.fn(async (id: string) => (place && place.id === id ? place : null)),
      lockPlaceForClaim: vi.fn(async () => {
        calls.push("lockPlaceForClaim");
      }),
      listActiveOwnershipsForPlace: vi.fn(async () => []),
    },
    events: {
      getById: vi.fn(async (id: string) => (event && event.id === id ? event : null)),
      hasOwnedLiveEventsAtPlace: vi.fn(async () => false),
    },
    eventHumans: { listByEvent: vi.fn(async () => []) },
    tickets: { viewerHoldsActiveTicketForEvent: vi.fn(async () => false) },
    eventRsvps: { existsForUser: vi.fn(async () => false) },
    eventDateRsvps: { existsForUserOnEvent: vi.fn(async () => false) },
    authz: {
      getPlaceAccessContext: vi.fn(async (id: string) =>
        place && place.id === id
          ? { owningOrgIds: owningOrgs(), verifiedHumanOwnerIds: [] }
          : null,
      ),
      getOrgMembership: vi.fn(async (input: { orgId: string; humanId: string }) =>
        membership(input.orgId, input.humanId),
      ),
      getHumanDelegation: vi.fn(async () => null),
    },
    audit: {
      log: vi.fn(async (entry: (typeof audit)[number]) => {
        calls.push(`audit:${entry.action}`);
        audit.push(entry);
      }),
    },
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      inTx = true;
      try {
        return await fn(repos);
      } finally {
        inTx = false;
      }
    }),
  };

  const authz = {
    canManagePlace: vi.fn(async (input: { actorHumanId: string; placeId: string }) => {
      rootPoolOnly("canManagePlace");
      return {
      allowed:
        !!place &&
        place.id === input.placeId &&
        owningOrgs().some((org) => !!membership(org, input.actorHumanId)),
      };
    }),
    canEditEvent: vi.fn(async (input: { actorHumanId: string; eventId: string }) => {
      rootPoolOnly("canEditEvent");
      return {
      allowed:
        !!event &&
        event.id === input.eventId &&
        !!event.orgId &&
        !!membership(event.orgId, input.actorHumanId),
      };
    }),
    hasStaffRole: vi.fn(async (input: { actorHumanId: string }) => {
      rootPoolOnly("hasStaffRole");
      return { allowed: input.actorHumanId === MODERATOR };
    }),
    requireOrgRole: vi.fn(async () => {
      throw new Error("not used");
    }),
  };

  const deps = {
    repos,
    authz,
    clock: { now: () => NOW },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };

  return {
    // The use cases take the full Repos aggregate; the fake covers what
    // they call.
    deps: deps as never,
    repos,
    authz,
    store,
    hides,
    calls,
    audit,
    logger: deps.logger,
  };
}

/** The AppError a promise rejects with. */
export async function errorOf(promise: Promise<unknown>): Promise<{
  code: string;
  meta?: Record<string, unknown>;
}> {
  try {
    await promise;
  } catch (err) {
    return err as { code: string; meta?: Record<string, unknown> };
  }
  throw new Error("expected a rejection");
}
