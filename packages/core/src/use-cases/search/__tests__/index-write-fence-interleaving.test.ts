import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../../../lib/location/obfuscation-key";
import { updateEventAccessControls } from "../../events/update-event-access-controls";
import { upsertPlace } from "../../places/upsert-place";
import { buildSearchIndex } from "../build-search-index";
import { reindexAfterMutation } from "../reindex-after-mutation";

/**
 * THE RACE the index-write fence closes (`withIndexWriteFence`):
 *
 *   indexer reads the venue (EXACT) ─┐
 *                                    │  owner hides the venue: upsertPlace
 *                                    │  deletes the documents, commits
 *   indexer writes its (EXACT) doc ──┘  ← the old pin is back in search
 *
 * The fakes below model the three things the argument depends on and nothing
 * else: advisory locks (shared/exclusive), row locks (share/update), and
 * commit-time visibility (a write inside a transaction is invisible to other
 * readers until it commits). The indexer is paused mid-write with a gate, and
 * the tightening starts while it is paused.
 */

const NOW = new Date("2026-09-29T12:00:00.000Z");
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const TRUE_LAT = 36.1775;
const TRUE_LNG = -86.7412;

/** Advisory + row locks with Postgres's shared/exclusive compatibility. */
class FakeLocks {
  private held = new Map<string, Map<number, "S" | "X">>();
  private waiters: Array<() => void> = [];

  async acquire(key: string, mode: "S" | "X", owner: number): Promise<void> {
    for (;;) {
      const holders = this.held.get(key) ?? new Map<number, "S" | "X">();
      const others = [...holders.entries()].filter(([o]) => o !== owner);
      const ok =
        others.length === 0 ||
        (mode === "S" && others.every(([, m]) => m === "S"));
      if (ok) {
        const mine = holders.get(owner);
        holders.set(owner, mine === "X" ? "X" : mode);
        this.held.set(key, holders);
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  releaseAll(owner: number): void {
    for (const holders of this.held.values()) holders.delete(owner);
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  }
}

function house(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Shelby House",
    formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
    addressLine1: "1417 Shelby Ave",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    addressHash: "1417 shelby ave, nashville, tn 37206",
    timezone: "America/Chicago",
    capacity: 60,
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: true,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [ACTOR_ID],
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PlaceRecord;
}

function world() {
  const locks = new FakeLocks();
  let committedPlace = house();
  let nextOwner = 1;
  const docs = new Map<string, Record<string, unknown>>();

  /** The indexer's FIRST document write waits here until released. */
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => (releaseGate = resolve));
  let gated = false;
  const upsertDocuments = vi.fn(
    async ({ documents }: { documents: Array<Record<string, unknown>> }) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      for (const d of documents) docs.set(String(d.id), d);
      return { ok: true as const, value: { indexed: documents.length, failed: 0 } };
    },
  );
  const deleteDocuments = vi.fn(async ({ ids }: { ids?: string[] }) => {
    for (const id of ids ?? []) docs.delete(id);
    return { ok: true as const, value: { deleted: ids?.length ?? 0 } };
  });
  const search = {
    ensureIndexes: vi.fn(async () => ({ ok: true as const, value: undefined })),
    upsertDocuments,
    deleteDocuments,
  } as unknown as MultiSearchPort;

  function reposFor(owner: number | null, staged: { place?: PlaceRecord }) {
    const readPlace = () => staged.place ?? committedPlace;
    return {
      places: {
        getById: vi.fn(async (id: string) => (id === PLACE_ID ? readPlace() : null)),
        upsert: vi.fn(async (input: Record<string, unknown>) => {
          const next = { ...readPlace() };
          for (const k of ["locationMode", "locationRadiusMeters", "locationLabel"]) {
            if (k in input) (next as Record<string, unknown>)[k] = input[k];
          }
          staged.place = next;
          return next;
        }),
        updateTaxRate: vi.fn(async () => undefined),
        updateTimezone: vi.fn(async () => undefined),
      },
      events: {
        lockLocationsAtPlace: vi.fn(
          async ({ placeId, mode }: { placeId: string; mode: string }) => {
            if (owner === null) throw new Error("lock outside a transaction");
            await locks.acquire(`adv:${placeId}`, mode === "shared" ? "S" : "X", owner);
          },
        ),
        lockRows: vi.fn(async ({ ids, mode }: { ids: string[]; mode: string }) => {
          if (owner === null) throw new Error("lock outside a transaction");
          for (const id of [...ids].sort()) {
            await locks.acquire(`row:${id}`, mode === "share" ? "S" : "X", owner);
          }
        }),
        reprojectLocationForPlace: vi.fn(async () => [] as string[]),
        findManyByIds: vi.fn(async () => []),
      },
      entityPages: { getByOwner: vi.fn(async () => null) },
      humans: { getById: vi.fn(async () => ({ id: ACTOR_ID })) },
      audit: { log: vi.fn(async () => undefined) },
    };
  }

  const repos = {
    ...reposFor(null, {}),
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>): Promise<T> => {
      const owner = nextOwner++;
      const staged: { place?: PlaceRecord } = {};
      try {
        const out = await fn(reposFor(owner, staged) as unknown as TxRepos);
        if (staged.place) committedPlace = staged.place; // COMMIT
        return out;
      } finally {
        locks.releaseAll(owner);
      }
    },
  } as unknown as Repos;

  return {
    repos,
    search,
    docs,
    releaseGate,
    upsertDocuments,
    deleteDocuments,
    committed: () => committedPlace,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  configureLocationObfuscation({ secret: "fence-interleaving-secret" });
});
afterEach(() => {
  resetLocationObfuscationForTests();
});

describe("index-write fence: a stale indexer racing a venue being hidden", () => {
  it("the old pin never survives: the hide waits for the in-flight write, then deletes it", async () => {
    const w = world();
    const deps = { repos: w.repos, search: w.search, clock: { now: () => NOW } };

    // 1. An indexer starts, reads the venue while it is still EXACT, and is
    //    paused on its document write, fence held.
    const indexing = buildSearchIndex(deps, { placeIds: [PLACE_ID] });
    await settle();
    expect(w.upsertDocuments).toHaveBeenCalledTimes(1);

    // 2. The owner hides the venue while that write is in flight.
    let hideDone = false;
    const hiding = upsertPlace(
      {
        repos: w.repos,
        idempotency: createFakeIdempotencyPort(),
        clock: { now: () => NOW },
        search: w.search,
      },
      {
        placeId: PLACE_ID,
        actorHumanId: ACTOR_ID,
        owner: { kind: "human", humanId: ACTOR_ID },
        name: "The Shelby House",
        address: {
          formatted: "1417 Shelby Ave, Nashville, TN 37206",
          countryCode: "US",
        },
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        clientKey: "fence-interleaving-hide",
      },
    ).then((r) => {
      hideDone = true;
      return r;
    });
    await settle();

    // The hide is BLOCKED on the fence: nothing committed, nothing deleted.
    expect(hideDone).toBe(false);
    expect(w.committed().locationMode).toBe("EXACT");
    expect(w.deleteDocuments).not.toHaveBeenCalled();

    // 3. The stale write lands, the fence commits, and only then does the
    //    hide run: its scrub deletes what the indexer just wrote.
    w.releaseGate();
    await indexing;
    await hiding;
    expect(w.committed().locationMode).toBe("OBSCURED");
    expect(w.deleteDocuments).toHaveBeenCalledWith({
      ids: [`place_${PLACE_ID}`],
    });

    // 4. The post-commit reindex writes the redacted document back.
    await vi.waitFor(() => expect(w.docs.has(`place_${PLACE_ID}`)).toBe(true));
    const doc = w.docs.get(`place_${PLACE_ID}`)!;
    expect(doc.lat).toBeNull();
    expect(doc.lng).toBeNull();
    expect(doc.locationIsExact).toBe(false);
  });

  it("the other order: a hide already holding the lock makes the indexer read the NEW state", async () => {
    const w = world();
    // Hold the exclusive venue lock in an open "tightening" transaction.
    let finishTightening!: () => void;
    const tightening = w.repos.tx(async (tx) => {
      await tx.events.lockLocationsAtPlace({ placeId: PLACE_ID, mode: "exclusive" });
      await tx.places.upsert({
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
      } as never);
      await new Promise<void>((resolve) => (finishTightening = resolve));
    });
    await settle();

    w.releaseGate(); // no pause for this indexer
    const indexing = buildSearchIndex(
      { repos: w.repos, search: w.search, clock: { now: () => NOW } },
      { placeIds: [PLACE_ID] },
    );
    await settle();
    // Blocked behind the tightening: no read of the uncommitted state, and
    // no write of the old one.
    expect(w.upsertDocuments).not.toHaveBeenCalled();

    finishTightening();
    await tightening;
    await indexing;

    const doc = w.docs.get(`place_${PLACE_ID}`)!;
    expect(doc.lat).toBeNull();
    expect(doc.locationIsExact).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event-level: the fence's FOR SHARE on the event row vs a change that UPDATEs
// that row (here: adding a gate, which makes the location label only).
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "55555555-5555-4555-8555-555555555555";
const ORG_ID = "99999999-9999-4999-8999-999999999999";

function eventWorld() {
  const locks = new FakeLocks();
  let nextOwner = 1;
  let committedEvent: Record<string, unknown> = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    placeId: null,
    title: "Late Show",
    slug: "late-show",
    status: "PUBLISHED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    addressText: "1604 8th Ave S, Nashville, TN 37203",
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    categoryId: null,
    admissionTaxRateBps: 0,
    waitlistStatus: "DISABLED",
    passwordHash: null,
    startsAt: new Date("2026-12-10T01:00:00.000Z"),
    endsAt: new Date("2026-12-10T04:00:00.000Z"),
  };
  const docs = new Map<string, Record<string, unknown>>();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => (releaseGate = resolve));
  let gated = false;
  const upsertDocuments = vi.fn(
    async ({ documents }: { documents: Array<Record<string, unknown>> }) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      for (const d of documents) docs.set(String(d.id), d);
      return { ok: true as const, value: { indexed: documents.length, failed: 0 } };
    },
  );
  const deleteDocuments = vi.fn(async ({ ids }: { ids?: string[] }) => {
    for (const id of ids ?? []) docs.delete(id);
    return { ok: true as const, value: { deleted: ids?.length ?? 0 } };
  });
  const search = {
    ensureIndexes: vi.fn(async () => ({ ok: true as const, value: undefined })),
    upsertDocuments,
    deleteDocuments,
  } as unknown as MultiSearchPort;

  function reposFor(
    owner: number | null,
    staged: { event?: Record<string, unknown> },
  ) {
    const read = () => staged.event ?? committedEvent;
    const needTx = () => {
      if (owner === null) throw new Error("lock outside a transaction");
      return owner;
    };
    return {
      events: {
        getById: vi.fn(async (id: string) => (id === EVENT_ID ? read() : null)),
        findManyByIds: vi.fn(async (ids: string[]) =>
          ids.includes(EVENT_ID) ? [read()] : [],
        ),
        lockLocationsAtPlace: vi.fn(
          async ({ placeId, mode }: { placeId: string; mode: string }) => {
            await locks.acquire(`adv:${placeId}`, mode === "shared" ? "S" : "X", needTx());
          },
        ),
        lockRows: vi.fn(async ({ ids, mode }: { ids: string[]; mode: string }) => {
          for (const id of [...ids].sort()) {
            await locks.acquire(`row:${id}`, mode === "share" ? "S" : "X", needTx());
          }
        }),
        // An UPDATE takes the row's exclusive lock, like Postgres.
        updateGateType: vi.fn(async ({ gateType }: { gateType: string }) => {
          await locks.acquire(`row:${EVENT_ID}`, "X", needTx());
          staged.event = { ...read(), gateType };
          return staged.event;
        }),
        getPopularityStats: vi.fn(async () => []),
        listTicketTypesForEventIds: vi.fn(async () => []),
      },
      places: { getById: vi.fn(async () => null) },
      payoutTerms: { listByEvent: vi.fn(async () => []) },
      feePolicies: { resolveEffective: vi.fn(async () => null) },
      images: {
        getPrimaryImageRefs: vi.fn(
          async () => new Map<string, { publicUrl: string; key: string }>(),
        ),
      },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
      categories: { getById: vi.fn(async () => null) },
      authz: {
        getOrgMembership: vi.fn(async () => ({
          orgId: ORG_ID,
          humanId: ACTOR_ID,
          role: "OWNER",
        })),
      },
      audit: { log: vi.fn(async () => undefined) },
    };
  }

  const repos = {
    ...reposFor(null, {}),
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>): Promise<T> => {
      const owner = nextOwner++;
      const staged: { event?: Record<string, unknown> } = {};
      try {
        const out = await fn(reposFor(owner, staged) as unknown as TxRepos);
        if (staged.event) committedEvent = staged.event; // COMMIT
        return out;
      } finally {
        locks.releaseAll(owner);
      }
    },
  } as unknown as Repos;

  return {
    repos,
    search,
    docs,
    releaseGate,
    upsertDocuments,
    deleteDocuments,
    committed: () => committedEvent,
  };
}

describe("index-write fence: a stale EVENT indexer racing a gate being added", () => {
  it("the gate change waits on the fenced row, then deletes the pin the fence wrote", async () => {
    const w = eventWorld();

    // 1. The indexer reads the event (ungated, exact pin) and pauses on its
    //    write, holding FOR SHARE on the row.
    const indexing = buildSearchIndex(
      { repos: w.repos, search: w.search, clock: { now: () => NOW } },
      { eventIds: [EVENT_ID] },
    );
    await settle();
    expect(w.upsertDocuments).toHaveBeenCalledTimes(1);

    // 2. The organizer adds a gate: its UPDATE needs the row exclusively.
    let gateDone = false;
    const gating = updateEventAccessControls(
      {
        repos: w.repos,
        clock: { now: () => NOW },
        search: w.search,
        reportError: vi.fn(),
      },
      { actorHumanId: ACTOR_ID, eventId: EVENT_ID, gateType: "APPLICATION" },
    ).then((r) => {
      gateDone = true;
      return r;
    });
    await settle();
    expect(gateDone).toBe(false);
    expect(w.committed().gateType).toBe("NONE");
    expect(w.deleteDocuments).not.toHaveBeenCalled();

    // 3. The stale write lands and commits; only then does the gate change
    //    run, and its scrub removes that document.
    w.releaseGate();
    await indexing;
    await gating;
    expect(w.committed().gateType).toBe("APPLICATION");
    expect(w.deleteDocuments).toHaveBeenCalledWith({ ids: [`event_${EVENT_ID}`] });

    // 4. The post-commit reindex writes the label-only document.
    await vi.waitFor(() => expect(w.docs.has(`event_${EVENT_ID}`)).toBe(true));
    const doc = w.docs.get(`event_${EVENT_ID}`)!;
    expect(doc.lat).toBeNull();
    expect(doc.lng).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The venue moved between the hint read and the fence.
// ─────────────────────────────────────────────────────────────────────────────

const VENUE_A = "a0000000-0000-4000-8000-00000000000a";
const VENUE_B = "b0000000-0000-4000-8000-00000000000b";

/**
 * An unpublished event (the indexer only has to REMOVE its document, so no
 * document build is involved) whose venue, as read inside the fence, comes
 * from `venueForRead(n)` — n counts the in-fence re-reads.
 */
function movingVenue(venueForRead: (n: number) => string, hintVenue: string) {
  const lockCalls: string[][] = [];
  let current: string[] = [];
  let rereads = 0;
  const row = (placeId: string) => ({
    id: EVENT_ID,
    placeId,
    status: "DRAFT",
    gateType: "NONE",
  });
  const txRepos = {
    events: {
      lockLocationsAtPlace: vi.fn(async ({ placeId }: { placeId: string }) => {
        current.push(placeId);
      }),
      lockRows: vi.fn(async () => undefined),
      findManyByIds: vi.fn(async () => [row(venueForRead(++rereads))]),
      getById: vi.fn(async () => row(venueForRead(rereads))),
    },
  };
  const repos = {
    events: {
      // The hint, read outside the fence.
      findManyByIds: vi.fn(async () => [row(hintVenue)]),
    },
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      current = [];
      try {
        return await fn(txRepos);
      } finally {
        lockCalls.push(current);
      }
    }),
  } as unknown as Repos;
  const search = {
    ensureIndexes: vi.fn(async () => ({ ok: true as const, value: undefined })),
    upsertDocuments: vi.fn(),
    deleteDocuments: vi.fn(async () => ({ ok: true as const, value: { deleted: 1 } })),
  } as unknown as MultiSearchPort;
  return { repos, search, lockCalls };
}

describe("index-write fence: the venue changed under the indexer", () => {
  it("moved once: the fence retries and locks BOTH venues, in sorted order", async () => {
    // Hint says B; inside the fence the event is at A.
    const m = movingVenue(() => VENUE_A, VENUE_B);

    const result = await buildSearchIndex(
      { repos: m.repos, search: m.search, clock: { now: () => NOW } },
      { eventIds: [EVENT_ID] },
    );

    expect(result.errors).toEqual([]);
    expect(m.lockCalls).toEqual([[VENUE_B], [VENUE_A, VENUE_B]]);
    // Nothing was written from the first (wrongly locked) attempt.
    expect(m.search.deleteDocuments).toHaveBeenCalledTimes(1);
  });

  it("keeps moving: the fence gives up, and the incremental path REPORTS it", async () => {
    let n = 0;
    const venues = [VENUE_A, VENUE_B, "c0000000-0000-4000-8000-00000000000c",
      "d0000000-0000-4000-8000-00000000000d"];
    const m = movingVenue(() => venues[n++ % venues.length]!, "e0000000-0000-4000-8000-00000000000e");
    const reportError = vi.fn();

    reindexAfterMutation(
      {
        repos: m.repos,
        search: m.search,
        clock: { now: () => NOW },
        reportError,
      },
      "fenceTest",
      { kind: "event", id: EVENT_ID },
    );

    await vi.waitFor(() => expect(reportError).toHaveBeenCalled());
    const [err, ctx] = reportError.mock.calls[0]!;
    expect(String((err as Error).message)).toContain("index write fence");
    expect(ctx).toMatchObject({
      tags: { useCase: "fenceTest", op: "reindexAfterMutation" },
    });
    expect(m.lockCalls).toHaveLength(3);
    expect(m.search.deleteDocuments).not.toHaveBeenCalled();
  });
});
