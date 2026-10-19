import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import {
  createSpace,
  listSpaces,
  setSpaceStatus,
  updateSpace,
  type ManageSpacesDeps,
} from "../manage-spaces";

// Spaces are the physical resources conflicts resolve to. The #1 bug class this
// suite defends against is CROSS-PLACE ISOLATION: nothing in the schema stops
// addressing org A's space through org B's place, so every spaceId-accepting
// operation must re-fetch and assert `space.placeId` inside its transaction.

const PLACE_ID = "00000000-0000-4000-8000-00000000d001";
const OTHER_PLACE_ID = "00000000-0000-4000-8000-00000000d002";
const OWNER_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_HUMAN_ID = "33333333-3333-4333-8333-333333333333";
const BASE_DATE = new Date("2026-08-01T00:00:00.000Z");

/**
 * A DISTINCT object that delegates every method to `target`, recording
 * `<label>.<method>` on `log` first.
 *
 * Why this exists: the old harness spread ONE repo bag into both `repos` and
 * the tx bag, so `repos.calendars === tx.calendars` and no spy could tell a
 * transactional read from a non-transactional one. A test named "runs inside
 * the transaction" that cannot fail is worse than no test — swapping the use
 * case to `deps.repos.calendars` would have kept it green while reintroducing
 * the TOCTOU. Identity differs here; the underlying fake (and therefore all
 * seeded state) is shared, and methods are looked up at CALL time so
 * `vi.spyOn(fake, …)` still works through the wrapper.
 */
function trackingHandle<T extends object>(
  target: T,
  label: string,
  log: string[],
): T {
  const handle: Record<string, unknown> = {};
  for (const key of Object.keys(target)) {
    const value = (target as Record<string, unknown>)[key];
    handle[key] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            log.push(`${label}.${key}`);
            return (
              (target as Record<string, (...a: unknown[]) => unknown>)[key]
            ).apply(target, args);
          }
        : value;
  }
  return handle as T;
}

function buildDeps(ownerHumanIds: string[] = [OWNER_HUMAN_ID]) {
  const spaces = createFakeSpacesRepo();
  const calendars = createFakeCalendarsRepo({ spaces });
  const audit = { log: vi.fn(async () => undefined) };
  const authz = {
    getPlaceAccessContext: vi.fn(async () => ({
      owningOrgIds: [],
      verifiedHumanOwnerIds: ownerHumanIds,
    })),
    getOrgMembership: vi.fn(async () => null),
  };

  /** Calls that arrived through the TRANSACTIONAL handles, in order. */
  const txCalls: string[] = [];
  /** Calls that arrived through the non-transactional aggregate, in order. */
  const rootCalls: string[] = [];

  const txRepos = {
    spaces: trackingHandle(spaces, "spaces", txCalls),
    calendars: trackingHandle(calendars, "calendars", txCalls),
    audit,
    authz,
  } as unknown as TxRepos;
  const repos = {
    spaces: trackingHandle(spaces, "spaces", rootCalls),
    calendars: trackingHandle(calendars, "calendars", rootCalls),
    audit,
    authz,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as ManageSpacesDeps["repos"];

  const deps: ManageSpacesDeps = {
    repos,
    clock: { now: () => BASE_DATE },
  };

  return { deps, spaces, calendars, audit, authz, txCalls, rootCalls };
}

describe("manage spaces", () => {
  it("creates a space and audits inside the transaction", async () => {
    const { deps, spaces, audit } = buildDeps();

    const space = await createSpace(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      name: "Back Bar",
      capacity: 80,
    });

    expect(space).toMatchObject({
      placeId: PLACE_ID,
      name: "Back Bar",
      capacity: 80,
      status: "ACTIVE",
    });
    expect(spaces.rows.get(space.id)).toBeDefined();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "space",
        entityId: space.id,
        action: "created",
        at: BASE_DATE,
      }),
    );
  });

  it("lists ACTIVE spaces by default and retired ones on request", async () => {
    const { deps, spaces } = buildDeps();
    spaces.seed({ placeId: PLACE_ID, name: "Main", sortOrder: 0 });
    spaces.seed({
      placeId: PLACE_ID,
      name: "Old Patio",
      sortOrder: 1,
      status: "RETIRED",
    });
    spaces.seed({ placeId: OTHER_PLACE_ID, name: "Foreign Space" });

    const active = await listSpaces(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
    });
    expect(active.map((r) => r.name)).toEqual(["Main"]);

    const all = await listSpaces(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      includeRetired: true,
    });
    expect(all.map((r) => r.name)).toEqual(["Main", "Old Patio"]);
  });

  it("refuses space writes from a non-owner", async () => {
    const { deps, spaces } = buildDeps();

    await expect(
      createSpace(deps, {
        actorHumanId: STRANGER_HUMAN_ID,
        placeId: PLACE_ID,
        name: "Sneaky Space",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(spaces.rows.size).toBe(0);
  });

  it("updates a space of the same place", async () => {
    const { deps, spaces } = buildDeps();
    const space = spaces.seed({ placeId: PLACE_ID, name: "Main" });

    const updated = await updateSpace(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: space.id,
      patch: { name: "Main Stage", capacity: 500 },
    });

    expect(updated).toMatchObject({ name: "Main Stage", capacity: 500 });
  });

  it("fake patch semantics: present-but-undefined leaves the field untouched, explicit null clears (Prisma parity)", async () => {
    const { spaces } = buildDeps();
    const space = spaces.seed({ placeId: PLACE_ID, name: "Main", capacity: 150 });

    // `{ capacity: undefined }` is how Prisma spells "untouched" — the fake
    // must match the future Step-5 adapter, not hasOwnProperty semantics.
    const untouched = await spaces.update({ id: space.id, capacity: undefined });
    expect(untouched.capacity).toBe(150);

    const cleared = await spaces.update({ id: space.id, capacity: null });
    expect(cleared.capacity).toBeNull();
  });

  it("rejects an update addressing another place's space (cross-place isolation)", async () => {
    const { deps, spaces } = buildDeps();
    const foreign = spaces.seed({ placeId: OTHER_PLACE_ID, name: "Foreign" });

    // The actor legitimately owns PLACE_ID but hands us a space id from a
    // different place — indistinguishable from a missing space on purpose.
    await expect(
      updateSpace(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceId: foreign.id,
        patch: { name: "Hijacked" },
      }),
    ).rejects.toMatchObject({ code: "SPACE_NOT_FOUND" });
    expect(spaces.rows.get(foreign.id)?.name).toBe("Foreign");
  });

  it("rejects a status change addressing another place's space", async () => {
    const { deps, spaces } = buildDeps();
    const foreign = spaces.seed({ placeId: OTHER_PLACE_ID, name: "Foreign" });
    spaces.seed({ placeId: OTHER_PLACE_ID, name: "Foreign 2" });

    await expect(
      setSpaceStatus(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceId: foreign.id,
        status: "RETIRED",
      }),
    ).rejects.toMatchObject({ code: "SPACE_NOT_FOUND" });
    expect(spaces.rows.get(foreign.id)?.status).toBe("ACTIVE");
  });

  it("retires one of two active spaces", async () => {
    const { deps, spaces } = buildDeps();
    spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });

    const updated = await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: patio.id,
      status: "RETIRED",
    });

    expect(updated.status).toBe("RETIRED");
  });

  it("refuses to retire the last ACTIVE space (≥1-active-space invariant)", async () => {
    const { deps, spaces } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
    // A retired sibling must NOT count toward the invariant.
    spaces.seed({ placeId: PLACE_ID, name: "Old", status: "RETIRED" });
    // Another place's active space must NOT count either.
    spaces.seed({ placeId: OTHER_PLACE_ID, name: "Foreign" });

    await expect(
      setSpaceStatus(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceId: main.id,
        status: "RETIRED",
      }),
    ).rejects.toMatchObject({ code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE" });
    expect(spaces.rows.get(main.id)?.status).toBe("ACTIVE");
  });

  it("reactivates a retired space", async () => {
    const { deps, spaces } = buildDeps();
    spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const old = spaces.seed({
      placeId: PLACE_ID,
      name: "Old",
      status: "RETIRED",
    });

    const updated = await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: old.id,
      status: "ACTIVE",
    });

    expect(updated.status).toBe("ACTIVE");
  });

  it("retiring a space keeps its CalendarSpace joins (reactivation restores wiring)", async () => {
    const { deps, spaces, calendars } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });
    const calendar = calendars.seedCalendar({
      placeId: PLACE_ID,
      name: "Patio Sessions",
    });
    // TWO rooms on the calendar, so retiring one is legal under the
    // ≥1-active-space-per-calendar ruling and this test can say what it is
    // actually about: the JOIN row surviving.
    calendars.seedJoins(calendar.id, [main.id, patio.id]);

    await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: patio.id,
      status: "RETIRED",
    });

    // Deliberate: the join survives retirement, so reactivating the room
    // restores the calendar wiring exactly as it was.
    expect(calendars.joins.get(calendar.id)).toEqual([main.id, patio.id]);
  });

  // ── ≥1 ACTIVE space per CALENDAR (owner ruling 2026-09-23) ─────────────────
  // "Roomless calendars shouldn't be legal anywhere." The place-level count
  // does not imply this: the place below keeps two active rooms throughout.

  it("refuses to retire a space that is some calendar's LAST active one, naming the calendar", async () => {
    const { deps, spaces, calendars } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });
    spaces.seed({ placeId: PLACE_ID, name: "Cellar" });
    const patioOnly = calendars.seedCalendar({
      placeId: PLACE_ID,
      name: "Patio Sessions",
    });
    calendars.seedJoins(patioOnly.id, [patio.id]);

    await expect(
      setSpaceStatus(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceId: patio.id,
        status: "RETIRED",
      }),
    ).rejects.toMatchObject({
      code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
      meta: {
        placeId: PLACE_ID,
        spaceId: patio.id,
        // The names are the whole point — a bare refusal on a place with a
        // dozen calendars is a dead end for the venue.
        calendars: [{ id: patioOnly.id, name: "Patio Sessions" }],
      },
    });
    // The place still had two other active rooms, so the PLACE-level guard
    // would have let this through. Nothing was written.
    expect(spaces.rows.get(patio.id)?.status).toBe("ACTIVE");
    expect(await spaces.countActiveForPlace(PLACE_ID)).toBe(3);
    expect(main.id).not.toBe(patio.id);
  });

  it("allows the retirement when every joined calendar keeps another active room", async () => {
    const { deps, spaces, calendars } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });
    const both = calendars.seedCalendar({ placeId: PLACE_ID, name: "Everything" });
    calendars.seedJoins(both.id, [main.id, patio.id]);

    const updated = await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: patio.id,
      status: "RETIRED",
    });

    expect(updated.status).toBe("RETIRED");
  });

  it("names EVERY blocked calendar, and ignores ones the space is not joined to", async () => {
    const { deps, spaces, calendars } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });
    spaces.seed({ placeId: PLACE_ID, name: "Cellar" });
    const sessions = calendars.seedCalendar({
      placeId: PLACE_ID,
      name: "Patio Sessions",
    });
    const brunch = calendars.seedCalendar({
      placeId: PLACE_ID,
      name: "Brunch",
    });
    const unrelated = calendars.seedCalendar({
      placeId: PLACE_ID,
      name: "Main Room Bookings",
    });
    calendars.seedJoins(sessions.id, [patio.id]);
    calendars.seedJoins(brunch.id, [patio.id]);
    calendars.seedJoins(unrelated.id, [main.id]);

    const err = await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: patio.id,
      status: "RETIRED",
    }).catch((e: unknown) => e as { meta?: { calendars?: { name: string }[] } });

    expect(
      (err.meta?.calendars ?? []).map((c) => c.name).sort(),
    ).toEqual(["Brunch", "Patio Sessions"]);
  });

  it("an ALREADY-roomless calendar does not block an unrelated retirement", async () => {
    // Pre-ruling data exists; repairing it is the owner's call, not a side
    // effect of someone retiring a different room.
    const { deps, spaces, calendars } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });
    const ghost = spaces.seed({
      placeId: PLACE_ID,
      name: "Demolished Annex",
      status: "RETIRED",
    });
    const stranded = calendars.seedCalendar({
      placeId: PLACE_ID,
      name: "Annex Nights",
    });
    calendars.seedJoins(stranded.id, [ghost.id]);
    const healthy = calendars.seedCalendar({ placeId: PLACE_ID, name: "Main Room" });
    calendars.seedJoins(healthy.id, [main.id, patio.id]);

    const updated = await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: patio.id,
      status: "RETIRED",
    });

    expect(updated.status).toBe("RETIRED");
  });

  it("another place's calendar never blocks this place's retirement", async () => {
    const { deps, spaces, calendars } = buildDeps();
    spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });
    const foreign = calendars.seedCalendar({
      placeId: OTHER_PLACE_ID,
      name: "Foreign Calendar",
    });
    // A cross-place join is not schema-prevented — the guard must scope by
    // place all the same.
    calendars.seedJoins(foreign.id, [patio.id]);

    const updated = await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: patio.id,
      status: "RETIRED",
    });

    expect(updated.status).toBe("RETIRED");
  });

  it("the per-calendar guard reads through the TRANSACTIONAL handle, never the root aggregate", async () => {
    // The point of this test is the HANDLE, not the call: reading the same
    // data off `deps.repos.calendars` would answer identically and reintroduce
    // the TOCTOU. `buildDeps` gives the tx bag distinct objects so the two are
    // distinguishable — plant `deps.repos.calendars.listByPlace(...)` in
    // manage-spaces.ts and this goes red.
    const { deps, spaces, calendars, txCalls, rootCalls } = buildDeps();
    spaces.seed({ placeId: PLACE_ID, name: "Main" });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });
    spaces.seed({ placeId: PLACE_ID, name: "Cellar" });
    const patioOnly = calendars.seedCalendar({
      placeId: PLACE_ID,
      name: "Patio Sessions",
    });
    calendars.seedJoins(patioOnly.id, [patio.id]);
    txCalls.length = 0;
    rootCalls.length = 0;

    await expect(
      setSpaceStatus(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceId: patio.id,
        status: "RETIRED",
      }),
    ).rejects.toMatchObject({
      code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
    });

    expect(deps.repos.tx).toHaveBeenCalled();
    expect(txCalls).toContain("calendars.listByPlace");
    expect(txCalls).toContain("spaces.countActiveForPlace");
    // NOTHING reached the non-transactional aggregate during the mutation.
    expect(rootCalls).toEqual([]);
    // …and the write never fired.
    expect(txCalls).not.toContain("spaces.setStatus");
    expect(spaces.rows.get(patio.id)?.status).toBe("ACTIVE");
  });

  // ── AUTO-PROMOTION + the ORDERING that makes it sound (2026-09-24) ────────
  // The place-scoped advisory lock this use case used to take FIRST is gone:
  // the invariant is a DB constraint now, and the FK's row locks serialize the
  // writers. What replaces the lock-ordering assertion is the WRITE ordering —
  // promote, then retire, then re-read and refuse. See the doc on
  // `setSpaceStatus`; the concurrency proof itself is in
  // adapters/test/integration/calendar-primary-space-race.test.ts.

  it("PROMOTES the calendar's next active room rather than refusing", async () => {
    const { deps, spaces, calendars } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main", sortOrder: 0 });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio", sortOrder: 1 });
    const both = calendars.seedCalendar({ placeId: PLACE_ID, name: "Both" });
    calendars.seedJoins(both.id, [main.id, patio.id]);
    // `seedJoins` pointed the primary at Main (lowest sortOrder) — the room
    // about to be retired.
    expect(calendars.calendars.get(both.id)!.primarySpaceId).toBe(main.id);

    const updated = await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: main.id,
      status: "RETIRED",
    });

    expect(updated.status).toBe("RETIRED");
    expect(calendars.calendars.get(both.id)!.primarySpaceId).toBe(patio.id);
  });

  it("promotes EVERY calendar the room was primary of, in ONE transaction", async () => {
    const { deps, spaces, calendars } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main", sortOrder: 0 });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio", sortOrder: 1 });
    const cellar = spaces.seed({
      placeId: PLACE_ID,
      name: "Cellar",
      sortOrder: 2,
    });
    const a = calendars.seedCalendar({ placeId: PLACE_ID, name: "A" });
    const b = calendars.seedCalendar({ placeId: PLACE_ID, name: "B" });
    calendars.seedJoins(a.id, [main.id, patio.id]);
    calendars.seedJoins(b.id, [main.id, cellar.id]);

    await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: main.id,
      status: "RETIRED",
    });

    // Each promotes to ITS OWN next active room, not to a shared one.
    expect(calendars.calendars.get(a.id)!.primarySpaceId).toBe(patio.id);
    expect(calendars.calendars.get(b.id)!.primarySpaceId).toBe(cellar.id);
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
  });

  it("promotes BEFORE the status write — the FK refuses a retire anything still names", async () => {
    // Order, not just outcome: `setStatus` on a space some calendar still names
    // as its primary is refused by the database outright, so a promotion that
    // ran afterwards would never get the chance to run at all.
    const { deps, spaces, calendars, txCalls } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main", sortOrder: 0 });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio", sortOrder: 1 });
    const both = calendars.seedCalendar({ placeId: PLACE_ID, name: "Both" });
    calendars.seedJoins(both.id, [main.id, patio.id]);
    txCalls.length = 0;

    await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: main.id,
      status: "RETIRED",
    });

    expect(txCalls.indexOf("calendars.setPrimarySpace")).toBeGreaterThan(-1);
    expect(txCalls.indexOf("calendars.setPrimarySpace")).toBeLessThan(
      txCalls.indexOf("spaces.setStatus"),
    );
  });

  it("re-reads the calendars AFTER the write — the check that survives a race", async () => {
    // The PRE-write stranded check runs on a read a concurrent transaction can
    // overtake; it exists for the error message. The POST-write one runs on a
    // fresh statement snapshot, after this transaction has queued behind every
    // writer it collided with, and is the one the invariant actually rests on.
    // A single `listByPlace` would mean the sound half was dropped.
    const { deps, spaces, calendars, txCalls } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main", sortOrder: 0 });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio", sortOrder: 1 });
    const both = calendars.seedCalendar({ placeId: PLACE_ID, name: "Both" });
    calendars.seedJoins(both.id, [main.id, patio.id]);
    txCalls.length = 0;

    await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: main.id,
      status: "RETIRED",
    });

    const reads = txCalls.filter((call) => call === "calendars.listByPlace");
    expect(reads).toHaveLength(2);
    expect(txCalls.lastIndexOf("calendars.listByPlace")).toBeGreaterThan(
      txCalls.indexOf("spaces.setStatus"),
    );
  });

  it("REFUSES (rather than promoting) when the room is a calendar's last active one", async () => {
    const { deps, spaces, calendars } = buildDeps();
    spaces.seed({ placeId: PLACE_ID, name: "Main", sortOrder: 0 });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio", sortOrder: 1 });
    const patioOnly = calendars.seedCalendar({
      placeId: PLACE_ID,
      name: "Patio Sessions",
    });
    calendars.seedJoins(patioOnly.id, [patio.id]);

    await expect(
      setSpaceStatus(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceId: patio.id,
        status: "RETIRED",
      }),
    ).rejects.toMatchObject({
      code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
      meta: { calendars: [{ id: patioOnly.id, name: "Patio Sessions" }] },
    });

    // Nothing was promoted and nothing was written.
    expect(calendars.calendars.get(patioOnly.id)!.primarySpaceId).toBe(patio.id);
    expect(spaces.rows.get(patio.id)?.status).toBe("ACTIVE");
  });

  it("promotes nothing on a REACTIVATE, and records that in the audit row", async () => {
    const { deps, spaces, calendars, audit } = buildDeps();
    spaces.seed({ placeId: PLACE_ID, name: "Main", sortOrder: 0 });
    const ghost = spaces.seed({
      placeId: PLACE_ID,
      name: "Annex",
      sortOrder: 1,
      status: "RETIRED",
    });
    const setPrimarySpy = vi.spyOn(calendars, "setPrimarySpace");

    await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: ghost.id,
      status: "ACTIVE",
    });

    expect(setPrimarySpy).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ promotedPrimaries: [] }),
      }),
    );
  });

  it("names the promoted calendars in the audit row", async () => {
    const { deps, spaces, calendars, audit } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main", sortOrder: 0 });
    const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio", sortOrder: 1 });
    const both = calendars.seedCalendar({ placeId: PLACE_ID, name: "Both" });
    calendars.seedJoins(both.id, [main.id, patio.id]);

    await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: main.id,
      status: "RETIRED",
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          promotedPrimaries: [{ calendarId: both.id, spaceId: patio.id }],
        }),
      }),
    );
  });

  it("no-ops (without auditing) when the status is unchanged", async () => {
    const { deps, spaces, audit } = buildDeps();
    const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });

    const result = await setSpaceStatus(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceId: main.id,
      status: "ACTIVE",
    });

    expect(result.status).toBe("ACTIVE");
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("rejects unknown input keys (.strict boundary)", async () => {
    const { deps } = buildDeps();

    await expect(
      createSpace(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        name: "Space",
        status: "RETIRED", // not creatable-as-retired; unknown key
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
