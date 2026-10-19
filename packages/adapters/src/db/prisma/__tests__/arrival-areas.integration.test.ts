import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import type {
  ArrivalAreaGeometry,
  CreateArrivalAreaInput,
} from "@th/ports/repos/arrival-areas";

import { makeArrivalAreasRepo } from "../arrival-areas";

// ---------------------------------------------------------------------------
// Arrival areas adapter against REAL Postgres (arrival-areas spec, 2026-10-16).
//
// The full migration set is applied to a throwaway database, so the
// parent-xor CHECK, the hide unique key and every CASCADE / SET NULL foreign
// key are the real ones. Nothing here disables triggers: the CASCADE cases
// are the point.
// ---------------------------------------------------------------------------

const LOT: ArrivalAreaGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-86.7412, 36.1775],
      [-86.7402, 36.1775],
      [-86.7402, 36.1785],
      [-86.7412, 36.1775],
    ],
  ],
};
const STREET: ArrivalAreaGeometry = {
  type: "LineString",
  coordinates: [
    [-86.742, 36.177],
    [-86.741, 36.177],
  ],
};

describe("arrival areas adapter (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  const repo = () => makeArrivalAreasRepo(prisma!);

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE "EventArrivalAreaHide", "ArrivalArea", "Event", "Place", "Human" CASCADE`,
    );
  });

  async function makePlace(name = "The Basement East") {
    const place = await prisma!.place.create({
      data: { name, address: "917 Woodland St, Nashville, TN" },
    });
    return place.id;
  }

  async function makeEvent(placeId: string | null = null) {
    const event = await prisma!.event.create({
      data: {
        title: "Open mic",
        startsAt: new Date("2026-11-01T01:00:00.000Z"),
        endsAt: new Date("2026-11-01T04:00:00.000Z"),
        ...(placeId ? { placeId } : {}),
      },
    });
    return event.id;
  }

  function area(
    parent: { placeId: string } | { eventId: string },
    extra: Partial<Omit<CreateArrivalAreaInput, "placeId" | "eventId">> = {},
  ): CreateArrivalAreaInput {
    return {
      ...parent,
      kind: "PARKING",
      geometry: LOT,
      label: "Back lot",
      ...extra,
    } as CreateArrivalAreaInput;
  }

  test("creates a place area and an event area with defaults and the geometry intact", async () => {
    const placeId = await makePlace();
    const eventId = await makeEvent();

    const placeArea = await repo().create(area({ placeId }));
    const eventArea = await repo().create(
      area(
        { eventId },
        {
          kind: "LOAD_IN",
          geometry: STREET,
          label: "Alley",
          cost: "PAID",
          priceText: "$5",
          note: "Ring the bell",
          accessibleSpots: true,
          sortOrder: 3,
        },
      ),
    );

    expect(placeArea).toMatchObject({
      placeId,
      eventId: null,
      kind: "PARKING",
      geometry: LOT,
      cost: "UNKNOWN",
      priceText: null,
      note: null,
      accessibleSpots: false,
      sortOrder: 0,
      disabledAt: null,
      createdByHumanId: null,
    });
    expect(eventArea).toMatchObject({
      placeId: null,
      eventId,
      kind: "LOAD_IN",
      geometry: STREET,
      cost: "PAID",
      priceText: "$5",
      note: "Ring the bell",
      accessibleSpots: true,
      sortOrder: 3,
    });
    expect(await repo().getById(placeArea.id)).toEqual(placeArea);
    expect(await repo().getById("00000000-0000-4000-8000-000000000000")).toBe(
      null,
    );
  });

  test("the DB CHECK refuses an area with both parents or neither", async () => {
    const placeId = await makePlace();
    const eventId = await makeEvent();

    await expect(
      repo().create({ ...area({ placeId }), eventId } as never),
    ).rejects.toThrow(/ArrivalArea_parent_xor/);
    await expect(
      repo().create({
        kind: "PARKING",
        geometry: LOT,
        label: "Orphan",
      } as never),
    ).rejects.toThrow(/ArrivalArea_parent_xor/);
    expect(await prisma!.arrivalArea.count()).toBe(0);
  });

  test("lists by parent in sortOrder then createdAt, and counts", async () => {
    const placeId = await makePlace();
    const otherPlaceId = await makePlace("Other");
    const eventId = await makeEvent(placeId);

    const b = await repo().create(area({ placeId }, { label: "B", sortOrder: 1 }));
    const a1 = await repo().create(area({ placeId }, { label: "A1", sortOrder: 0 }));
    const a2 = await repo().create(area({ placeId }, { label: "A2", sortOrder: 0 }));
    const other = await repo().create(area({ placeId: otherPlaceId }));
    const ev = await repo().create(area({ eventId }));

    expect((await repo().listForPlace(placeId)).map((r) => r.id)).toEqual([
      a1.id,
      a2.id,
      b.id,
    ]);
    expect((await repo().listForEvent(eventId)).map((r) => r.id)).toEqual([
      ev.id,
    ]);
    expect(
      (await repo().listForPlaces([placeId, otherPlaceId])).map((r) => r.id),
    ).toHaveLength(4);
    expect(
      (await repo().listForPlaces([otherPlaceId])).map((r) => r.id),
    ).toEqual([other.id]);
    expect(await repo().listForPlaces([])).toEqual([]);
    expect(await repo().countForPlace(placeId)).toBe(3);
    expect(await repo().countForEvent(eventId)).toBe(1);
  });

  test("update lands on a matching updatedAt and moves it", async () => {
    const placeId = await makePlace();
    const created = await repo().create(area({ placeId }));

    const result = await repo().update(
      created.id,
      { label: "Front lot", cost: "FREE", note: null, geometry: STREET },
      { expectedUpdatedAt: created.updatedAt },
    );

    expect(result.status).toBe("updated");
    if (result.status !== "updated") return;
    expect(result.row).toMatchObject({
      label: "Front lot",
      cost: "FREE",
      geometry: STREET,
      kind: "PARKING",
    });
    expect(result.row.updatedAt.getTime()).toBeGreaterThan(
      created.updatedAt.getTime(),
    );
  });

  test("update moves the token strictly forward even when the stored one is ahead of this clock", async () => {
    // A lagging instance clock, or a second write in the same millisecond:
    // `now` is not past the stored token, so plain @updatedAt would leave it
    // where it is and the save it replaced would still match.
    const placeId = await makePlace();
    const created = await repo().create(area({ placeId }));
    const ahead = new Date(Date.now() + 60_000);
    await pool!.query(`UPDATE "ArrivalArea" SET "updatedAt" = $1 WHERE id = $2`, [
      ahead.toISOString(),
      created.id,
    ]);

    const result = await repo().update(
      created.id,
      { label: "Saved" },
      { expectedUpdatedAt: ahead },
    );

    expect(result.status).toBe("updated");
    if (result.status !== "updated") return;
    expect(result.row.updatedAt.getTime()).toBe(ahead.getTime() + 1);
    const replay = await repo().update(
      created.id,
      { label: "Replayed" },
      { expectedUpdatedAt: ahead },
    );
    expect(replay.status).toBe("conflict");
    expect((await repo().getById(created.id))?.label).toBe("Saved");
  });

  test("update with a stale updatedAt writes nothing and returns the current row", async () => {
    const placeId = await makePlace();
    const created = await repo().create(area({ placeId }));
    const first = await repo().update(
      created.id,
      { label: "First save" },
      { expectedUpdatedAt: created.updatedAt },
    );
    expect(first.status).toBe("updated");

    const stale = await repo().update(
      created.id,
      { label: "Second save" },
      // The token the second editor opened the form with.
      { expectedUpdatedAt: created.updatedAt },
    );

    expect(stale.status).toBe("conflict");
    if (stale.status !== "conflict") return;
    expect(stale.current.label).toBe("First save");
    if (first.status !== "updated") return;
    expect(stale.current.updatedAt).toEqual(first.row.updatedAt);
    expect((await repo().getById(created.id))?.label).toBe("First save");
  });

  test("update of a missing id is not_found", async () => {
    expect(
      await repo().update(
        "00000000-0000-4000-8000-000000000000",
        { label: "x" },
        { expectedUpdatedAt: new Date() },
      ),
    ).toEqual({ status: "not_found" });
  });

  test("delete with a stale updatedAt keeps the row; a matching one returns it", async () => {
    const placeId = await makePlace();
    const created = await repo().create(area({ placeId }));

    const edited = await repo().update(
      created.id,
      { label: "Edited elsewhere" },
      { expectedUpdatedAt: created.updatedAt },
    );
    expect(edited.status).toBe("updated");
    if (edited.status !== "updated") return;

    // Removing from a form opened before the edit.
    const stale = await repo().delete(created.id, {
      expectedUpdatedAt: created.updatedAt,
    });
    expect(stale).toEqual({ status: "conflict", current: edited.row });
    expect(await repo().getById(created.id)).toEqual(edited.row);

    const ok = await repo().delete(created.id, {
      expectedUpdatedAt: edited.row.updatedAt,
    });
    expect(ok).toEqual({ status: "deleted", row: edited.row });
    expect(await repo().getById(created.id)).toBe(null);
    expect(
      await repo().delete(created.id, {
        expectedUpdatedAt: edited.row.updatedAt,
      }),
    ).toEqual({ status: "not_found" });
  });

  test("reorder sets 0..n-1, leaves updatedAt and other parents alone, refuses a mismatched set", async () => {
    const placeId = await makePlace();
    const otherPlaceId = await makePlace("Other");
    const a = await repo().create(area({ placeId }, { label: "A", sortOrder: 0 }));
    const b = await repo().create(area({ placeId }, { label: "B", sortOrder: 1 }));
    const c = await repo().create(area({ placeId }, { label: "C", sortOrder: 2 }));
    const foreign = await repo().create(
      area({ placeId: otherPlaceId }, { sortOrder: 7 }),
    );

    const done = await repo().reorder({ placeId }, [c.id, a.id, b.id]);
    expect(done.status).toBe("reordered");
    if (done.status !== "reordered") return;
    expect(done.rows.map((r) => [r.id, r.sortOrder])).toEqual([
      [c.id, 0],
      [a.id, 1],
      [b.id, 2],
    ]);
    // The order is not what an edit form saves: its token must not move.
    expect(done.rows.find((r) => r.id === a.id)?.updatedAt).toEqual(a.updatedAt);

    // A foreign id, a missing id, or a duplicate: nothing written.
    for (const ids of [
      [c.id, a.id, foreign.id],
      [c.id, a.id],
      [c.id, a.id, b.id, b.id],
    ]) {
      const refused = await repo().reorder({ placeId }, ids);
      expect(refused).toEqual({
        status: "mismatch",
        currentIds: [c.id, a.id, b.id],
      });
    }
    expect((await repo().getById(foreign.id))?.sortOrder).toBe(7);
    expect((await repo().getById(foreign.id))?.placeId).toBe(otherPlaceId);
  });

  test("reorder of event areas is scoped to the event", async () => {
    const eventId = await makeEvent();
    const x = await repo().create(area({ eventId }, { sortOrder: 0 }));
    const y = await repo().create(area({ eventId }, { sortOrder: 1 }));

    const done = await repo().reorder({ eventId }, [y.id, x.id]);
    expect(done.status).toBe("reordered");
    expect((await repo().listForEvent(eventId)).map((r) => r.id)).toEqual([
      y.id,
      x.id,
    ]);
  });

  test("hide and unhide are idempotent, and a pair is stored once", async () => {
    const placeId = await makePlace();
    const eventId = await makeEvent(placeId);
    const a = await repo().create(area({ placeId }));
    const b = await repo().create(area({ placeId }, { label: "B" }));

    expect(await repo().hide(eventId, a.id)).toBe(true);
    expect(await repo().hide(eventId, a.id)).toBe(false);
    expect(await repo().hide(eventId, b.id)).toBe(true);
    expect(await prisma!.eventArrivalAreaHide.count()).toBe(2);
    expect(await repo().listHidesForEvent(eventId)).toEqual([a.id, b.id]);

    expect(await repo().unhide(eventId, a.id)).toBe(true);
    expect(await repo().unhide(eventId, a.id)).toBe(false);
    expect(await repo().listHidesForEvent(eventId)).toEqual([b.id]);
  });

  test("deleting a place removes its areas and the hides pointing at them", async () => {
    const placeId = await makePlace();
    const eventId = await makeEvent();
    const a = await repo().create(area({ placeId }));
    await repo().hide(eventId, a.id);

    await prisma!.place.delete({ where: { id: placeId } });

    expect(await prisma!.arrivalArea.count()).toBe(0);
    expect(await prisma!.eventArrivalAreaHide.count()).toBe(0);
  });

  test("deleting an event removes its areas and its hides, not the place's areas", async () => {
    const placeId = await makePlace();
    const eventId = await makeEvent(placeId);
    const placeArea = await repo().create(area({ placeId }));
    await repo().create(area({ eventId }));
    await repo().hide(eventId, placeArea.id);

    await prisma!.event.delete({ where: { id: eventId } });

    expect(await repo().listForEvent(eventId)).toEqual([]);
    expect(await prisma!.eventArrivalAreaHide.count()).toBe(0);
    expect(await repo().getById(placeArea.id)).not.toBe(null);
  });

  test("deleting the creator keeps the area and clears createdByHumanId", async () => {
    const placeId = await makePlace();
    const human = await prisma!.human.create({ data: {} });
    const a = await repo().create(
      area({ placeId }, { createdByHumanId: human.id }),
    );
    expect(a.createdByHumanId).toBe(human.id);

    await prisma!.human.delete({ where: { id: human.id } });

    expect((await repo().getById(a.id))?.createdByHumanId).toBe(null);
  });

  test("movePlaceAreas keeps ids, appends after the target's areas, and hides follow", async () => {
    const fromId = await makePlace("Duplicate");
    const toId = await makePlace("Survivor");
    const eventId = await makeEvent(fromId);
    const kept = await repo().create(area({ placeId: toId }, { sortOrder: 4 }));
    const m1 = await repo().create(area({ placeId: fromId }, { sortOrder: 0 }));
    const m2 = await repo().create(area({ placeId: fromId }, { sortOrder: 1 }));
    await repo().hide(eventId, m2.id);

    const moved = await repo().movePlaceAreas(fromId, toId);

    expect(moved).toEqual([m1.id, m2.id]);
    expect(
      (await repo().listForPlace(toId)).map((r) => [r.id, r.sortOrder]),
    ).toEqual([
      [kept.id, 4],
      [m1.id, 5],
      [m2.id, 6],
    ]);
    expect(await repo().listForPlace(fromId)).toEqual([]);
    expect(await repo().listHidesForEvent(eventId)).toEqual([m2.id]);
    expect(await repo().movePlaceAreas(fromId, toId)).toEqual([]);
  });

  test("place merge order (FR-012): moved areas and their hides survive the merged place's delete", async () => {
    const fromId = await makePlace("Duplicate");
    const toId = await makePlace("Survivor");
    const eventId = await makeEvent(fromId);
    const m = await repo().create(area({ placeId: fromId }));
    const left = await makePlace("Not merged");
    const gone = await repo().create(area({ placeId: left }));
    await repo().hide(eventId, m.id);

    // What mergePlaces does: repoint the event, move the areas, delete.
    await prisma!.event.update({ where: { id: eventId }, data: { placeId: toId } });
    await repo().movePlaceAreas(fromId, toId);
    await prisma!.place.delete({ where: { id: fromId } });

    expect((await repo().getById(m.id))?.placeId).toBe(toId);
    expect(await repo().listHidesForEvent(eventId)).toEqual([m.id]);
    // The control: a place deleted WITHOUT the move takes its areas with it.
    await prisma!.place.delete({ where: { id: left } });
    expect(await repo().getById(gone.id)).toBeNull();
  });

  test("listEventAreasAtPlace: the event-only areas of the place's events, by event then order", async () => {
    const placeId = await makePlace("Duplicate");
    const elsewhere = await makePlace("Elsewhere");
    const e1 = await makeEvent(placeId);
    const e2 = await makeEvent(placeId);
    const away = await makeEvent(elsewhere);
    const a1 = await repo().create(area({ eventId: e1 }));
    const a2 = await repo().create(area({ eventId: e1 }, { label: "Two" }));
    const b1 = await repo().create(area({ eventId: e2 }));
    await repo().create(area({ eventId: away }));
    await repo().create(area({ placeId })); // a place area: not an event's

    const rows = await repo().listEventAreasAtPlace(placeId);
    const [first, second] = [e1, e2].sort();
    const expected = [
      ...(first === e1 ? [a1.id, a2.id] : [b1.id]),
      ...(second === e1 ? [a1.id, a2.id] : [b1.id]),
    ];
    expect(rows.map((r) => r.id)).toEqual(expected);
    expect(await repo().listEventAreasAtPlace(elsewhere)).toHaveLength(1);
  });

  test("movePlaceAreas onto a place with no areas starts at 0", async () => {
    const fromId = await makePlace("Duplicate");
    const toId = await makePlace("Survivor");
    const m = await repo().create(area({ placeId: fromId }, { sortOrder: 3 }));

    expect(await repo().movePlaceAreas(fromId, toId)).toEqual([m.id]);
    expect((await repo().getById(m.id))?.sortOrder).toBe(0);
  });

  test("deleteHidesForEventNotInPlace drops only hides of other places' areas", async () => {
    const oldPlace = await makePlace("Old");
    const newPlace = await makePlace("New");
    const eventId = await makeEvent(newPlace);
    const otherEventId = await makeEvent(oldPlace);
    const oldArea = await repo().create(area({ placeId: oldPlace }));
    const newArea = await repo().create(area({ placeId: newPlace }));
    await repo().hide(eventId, oldArea.id);
    await repo().hide(eventId, newArea.id);
    await repo().hide(otherEventId, oldArea.id);

    const dropped = await repo().deleteHidesForEventNotInPlace(
      eventId,
      newPlace,
    );

    expect(dropped).toEqual([{ eventId, arrivalAreaId: oldArea.id }]);
    expect(await repo().listHidesForEvent(eventId)).toEqual([newArea.id]);
    expect(await repo().listHidesForEvent(otherEventId)).toEqual([oldArea.id]);

    // No place any more: every hide of the event goes.
    expect(await repo().deleteHidesForEventNotInPlace(eventId, null)).toEqual([
      { eventId, arrivalAreaId: newArea.id },
    ]);
    expect(await repo().listHidesForEvent(otherEventId)).toEqual([oldArea.id]);
  });

  test("deleteHidesForEventsNotInPlace: one batch for many events, scoped to them, other places' areas only", async () => {
    const survivor = await makePlace("Survivor");
    const other = await makePlace("Other");
    const kept = await repo().create(area({ placeId: survivor }));
    const stale = await repo().create(area({ placeId: other }));
    const moved = [await makeEvent(survivor), await makeEvent(survivor)];
    const notMoved = await makeEvent(survivor);
    for (const eventId of moved) {
      await repo().hide(eventId, kept.id);
      await repo().hide(eventId, stale.id);
    }
    await repo().hide(notMoved, stale.id);

    const dropped = await repo().deleteHidesForEventsNotInPlace(moved, survivor);

    expect(
      dropped.map((d) => [d.eventId, d.arrivalAreaId]).sort(),
    ).toEqual(moved.map((id) => [id, stale.id]).sort());
    for (const eventId of moved) {
      expect(await repo().listHidesForEvent(eventId)).toEqual([kept.id]);
    }
    // Not one of the given events: untouched even though its hide is stale.
    expect(await repo().listHidesForEvent(notMoved)).toEqual([stale.id]);
    expect(await repo().deleteHidesForEventsNotInPlace([], survivor)).toEqual([]);
  });

  test("deleteHidesForEventsNotInPlace walks every chunk, in event order, skipping chunks with no stale hide", async () => {
    const survivor = await makePlace("Survivor");
    const other = await makePlace("Other");
    const kept = await repo().create(area({ placeId: survivor }));
    const stale = await repo().create(area({ placeId: other }));
    const events: string[] = [];
    for (let i = 0; i < 7; i += 1) events.push(await makeEvent(survivor));
    const sorted = [...events].sort();
    // Stale hides on the 1st, 4th, 5th and 7th event in id order; with a
    // chunk of 2 that is chunks 1, 2, 3 and 4, and chunk 2 also holds an
    // event with only a kept hide.
    const withStale = [sorted[0]!, sorted[3]!, sorted[4]!, sorted[6]!];
    for (const eventId of withStale) await repo().hide(eventId, stale.id);
    await repo().hide(sorted[2]!, kept.id);

    const chunked = makeArrivalAreasRepo(prisma!, { eventIdBatchChunk: 2 });
    const dropped = await chunked.deleteHidesForEventsNotInPlace(
      [...events, events[0]!], // a duplicate id is read once
      survivor,
    );

    expect(dropped).toEqual(
      withStale.map((eventId) => ({ eventId, arrivalAreaId: stale.id })),
    );
    for (const eventId of sorted) {
      expect(await repo().listHidesForEvent(eventId)).toEqual(
        eventId === sorted[2] ? [kept.id] : [],
      );
    }
  });

  test("a hide of an EVENT-ONLY area (placeId null) is dropped by both hide cleanups alike", async () => {
    const survivor = await makePlace("Survivor");
    const kept = await repo().create(area({ placeId: survivor }));

    // Per-event cleanup.
    const single = await makeEvent(survivor);
    const singleOwn = await repo().create(area({ eventId: single }));
    await repo().hide(single, singleOwn.id); // the DB allows it; core never writes it
    await repo().hide(single, kept.id);
    expect(
      await repo().deleteHidesForEventNotInPlace(single, survivor),
    ).toEqual([{ eventId: single, arrivalAreaId: singleOwn.id }]);
    expect(await repo().listHidesForEvent(single)).toEqual([kept.id]);

    // Batch cleanup: the same answer for the same rows.
    const batch = await makeEvent(survivor);
    const batchOwn = await repo().create(area({ eventId: batch }));
    await repo().hide(batch, batchOwn.id);
    await repo().hide(batch, kept.id);
    expect(
      await repo().deleteHidesForEventsNotInPlace([batch], survivor),
    ).toEqual([{ eventId: batch, arrivalAreaId: batchOwn.id }]);
    expect(await repo().listHidesForEvent(batch)).toEqual([kept.id]);

    // The areas themselves stay.
    expect(await repo().getById(singleOwn.id)).not.toBeNull();
    expect(await repo().getById(batchOwn.id)).not.toBeNull();
  });

  test("getByIds: one read, missing ids omitted, duplicates once, empty input no read", async () => {
    const placeId = await makePlace();
    const eventId = await makeEvent();
    const a = await repo().create(area({ placeId }));
    const b = await repo().create(area({ eventId }, { label: "Curb" }));
    const missing = "00000000-0000-4000-8000-000000000000";

    const rows = await repo().getByIds([b.id, missing, a.id, b.id]);

    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)).toEqual(await repo().getById(a.id));
    expect(byId.get(b.id)).toEqual(await repo().getById(b.id));
    expect(await repo().getByIds([])).toEqual([]);
  });

  test("listForEvents: only the given events' areas, by event then sortOrder, across chunks", async () => {
    const placeId = await makePlace("Survivor");
    const e1 = await makeEvent(placeId);
    const e2 = await makeEvent(placeId);
    const e3 = await makeEvent(placeId);
    const notAsked = await makeEvent(placeId);
    const e1Late = await repo().create(area({ eventId: e1 }, { sortOrder: 2 }));
    const e1Early = await repo().create(area({ eventId: e1 }, { sortOrder: 0 }));
    const e2Only = await repo().create(area({ eventId: e2 }));
    await repo().create(area({ eventId: notAsked }));
    await repo().create(area({ placeId })); // a place area: never in the list
    // e3 has no areas.

    const byEvent = new Map<string, string[]>([
      [e1, [e1Early.id, e1Late.id]],
      [e2, [e2Only.id]],
      [e3, []],
    ]);
    const expected = [e1, e2, e3].sort().flatMap((id) => byEvent.get(id)!);

    const whole = await repo().listForEvents([e3, e1, e2, e1]);
    expect(whole.map((r) => r.id)).toEqual(expected);

    const chunked = makeArrivalAreasRepo(prisma!, { eventIdBatchChunk: 1 });
    expect((await chunked.listForEvents([e3, e1, e2])).map((r) => r.id)).toEqual(
      expected,
    );
    expect(await repo().listForEvents([])).toEqual([]);
  });

  test("setDisabledForEvent switches the event's areas off and on, keeping the first time", async () => {
    const placeId = await makePlace();
    const eventId = await makeEvent(placeId);
    const placeArea = await repo().create(area({ placeId }));
    const e1 = await repo().create(area({ eventId }));
    const e2 = await repo().create(area({ eventId }, { label: "Two" }));
    const first = new Date("2026-10-16T10:00:00.000Z");
    const later = new Date("2026-10-16T11:00:00.000Z");

    expect(await repo().setDisabledForEvent(eventId, first)).toBe(2);
    const off = await repo().getById(e1.id);
    expect(off!.updatedAt.getTime()).toBeGreaterThan(e1.updatedAt.getTime());
    expect(await repo().setDisabledForEvent(eventId, later)).toBe(0);
    expect((await repo().getById(e1.id))?.updatedAt).toEqual(off!.updatedAt);
    for (const id of [e1.id, e2.id]) {
      expect((await repo().getById(id))?.disabledAt).toEqual(first);
    }
    expect((await repo().getById(placeArea.id))?.disabledAt).toBe(null);

    expect(await repo().setDisabledForEvent(eventId, null)).toBe(2);
    const on = await repo().getById(e1.id);
    expect(on?.disabledAt).toBe(null);
    expect(on!.updatedAt.getTime()).toBeGreaterThan(off!.updatedAt.getTime());
  });

  test("lockParent locks an existing place or event inside a transaction, then count-then-insert", async () => {
    const placeId = await makePlace();
    const eventId = await makeEvent();

    const result = await prisma!.$transaction(async (tx) => {
      const r = makeArrivalAreasRepo(tx);
      const place = await r.lockParent({ placeId });
      const event = await r.lockParent({ eventId });
      const missing = await r.lockParent({
        placeId: "00000000-0000-4000-8000-000000000000",
      });
      await r.create(area({ placeId }));
      return { place, event, missing, count: await r.countForPlace(placeId) };
    });

    expect(result).toMatchObject({
      place: true,
      event: true,
      missing: false,
      count: 1,
    });
  });

  test("lockParent holds a second transaction's lock until the first commits", async () => {
    const placeId = await makePlace();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((r) => (releaseFirst = r));
    let firstLocked!: () => void;
    const locked = new Promise<void>((r) => (firstLocked = r));

    const first = prisma!.$transaction(
      async (tx) => {
        await makeArrivalAreasRepo(tx).lockParent({ placeId });
        order.push("first locked");
        firstLocked();
        await firstHolds;
        order.push("first done");
      },
      { timeout: 20_000 },
    );
    await locked;
    const second = prisma!.$transaction(
      async (tx) => {
        await makeArrivalAreasRepo(tx).lockParent({ placeId });
        order.push("second locked");
      },
      { timeout: 20_000 },
    );
    await new Promise((r) => setTimeout(r, 300));
    order.push("released");
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "first locked",
      "released",
      "first done",
      "second locked",
    ]);
  });

  test("a held lockParent does not block FK child inserts on the parent", async () => {
    // FOR NO KEY UPDATE, not FOR UPDATE: an event created at the place, or a
    // hide on the event, takes FOR KEY SHARE on the parent and must not wait
    // for an open area save (checkout inserts ride the same lock).
    const placeId = await makePlace();
    const eventId = await makeEvent(placeId);
    const placeArea = await repo().create(area({ placeId }));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));

    const holder = prisma!.$transaction(
      async (tx) => {
        const r = makeArrivalAreasRepo(tx);
        await r.lockParent({ placeId });
        await r.lockParent({ eventId });
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;

    const client = await pool!.connect();
    try {
      await client.query(`SET lock_timeout = '2s'`);
      await client.query(
        `INSERT INTO "Event" (id, title, "startsAt", "endsAt", "placeId", "updatedAt")
         VALUES (gen_random_uuid()::text, 'Second night', '2026-11-02T01:00:00.000Z',
                 '2026-11-02T04:00:00.000Z', $1, now())`,
        [placeId],
      );
      await client.query(
        `INSERT INTO "EventArrivalAreaHide" (id, "eventId", "arrivalAreaId")
         VALUES (gen_random_uuid()::text, $1, $2)`,
        [eventId, placeArea.id],
      );
    } finally {
      client.release();
      release();
      await holder;
    }

    expect(await prisma!.event.count({ where: { placeId } })).toBe(2);
    expect(await repo().listHidesForEvent(eventId)).toEqual([placeArea.id]);
  });
});
