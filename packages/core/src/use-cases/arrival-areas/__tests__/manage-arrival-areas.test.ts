import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { haversineDistance } from "../../../lib/geo/haversine";
import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../../../lib/location/obfuscation-key";
import { projectPublicEventLocation } from "../../../lib/location/project-public-event-location";
import {
  createArrivalArea,
  removeArrivalArea,
  reorderArrivalAreas,
  updateArrivalArea,
} from "../manage-arrival-areas";
import {
  BOTH,
  EVENT_EDITOR,
  EVENT_ID,
  MODERATOR,
  OTHER_PLACE_ID,
  PLACE_ID,
  PLACE_MANAGER,
  STRANGER,
  TRUE_LAT,
  TRUE_LNG,
  areaRow,
  errorOf,
  makeEvent,
  makePlace,
  makeWorld,
  offset,
  squareAt,
} from "./arrival-area-world";

/**
 * arrival-areas step 4: create / update / reorder / remove. Authorization
 * (FR-002, FR-003), the pin an event-only area is measured from (FR-005 and
 * the security finding: never a "within 3 km of the withheld house" oracle),
 * the limits under the parent lock, NFR-004 conflicts, FR-014 re-enable, and
 * the FR-013 audit rows.
 */

beforeAll(() => {
  configureLocationObfuscation({ secret: "arrival-areas-manage-test" });
});
afterAll(() => {
  resetLocationObfuscationForTests();
});

const NEAR_TRUTH = squareAt(TRUE_LAT + 0.002, TRUE_LNG);

const createInput = (overrides: Record<string, unknown> = {}) => ({
  actorHumanId: PLACE_MANAGER,
  placeId: PLACE_ID,
  kind: "PARKING",
  label: "Back lot",
  geometry: NEAR_TRUTH,
  ...overrides,
});

const eventInput = (overrides: Record<string, unknown> = {}) => {
  const { placeId: _drop, ...rest } = createInput({
    actorHumanId: EVENT_EDITOR,
    ...overrides,
  });
  return { ...rest, eventId: EVENT_ID };
};

// ── Authorization matrix ────────────────────────────────────────────────────

describe("authorization", () => {
  it("the place's manager creates a place area", async () => {
    const world = makeWorld();
    const row = await createArrivalArea(world.deps, createInput());
    expect(row.placeId).toBe(PLACE_ID);
    expect(row.eventId).toBeNull();
    expect(row.createdByHumanId).toBe(PLACE_MANAGER);
  });

  it("a moderator creates on an UNOWNED place, claim lock taken before the parent lock", async () => {
    // A place that publishes its address: at a withheld one a moderator
    // draws nothing (see "a moderator at a WITHHELD unowned place").
    const world = makeWorld({
      unowned: true,
      place: makePlace({
        orgIdsWithAccess: [],
        locationMode: "EXACT",
        locationRadiusMeters: null,
      }),
    });
    const row = await createArrivalArea(
      world.deps,
      createInput({ actorHumanId: MODERATOR }),
    );
    expect(row.placeId).toBe(PLACE_ID);
    expect(world.calls.indexOf("lockPlaceForClaim")).toBeGreaterThanOrEqual(0);
    expect(world.calls.indexOf("lockPlaceForClaim")).toBeLessThan(
      world.calls.indexOf("lockParent:place"),
    );
    expect(world.audit[0]?.data).toMatchObject({ editorKind: "community_moderator" });
  });

  it("a moderator is refused on an OWNED place", async () => {
    const world = makeWorld();
    const err = await errorOf(
      createArrivalArea(world.deps, createInput({ actorHumanId: MODERATOR })),
    );
    expect(err.code).toBe("PLACE_HAS_OWNER");
    expect(world.repos.arrivalAreas.create).not.toHaveBeenCalled();
  });

  it("a stranger is refused on a place", async () => {
    const world = makeWorld();
    const err = await errorOf(
      createArrivalArea(world.deps, createInput({ actorHumanId: STRANGER })),
    );
    expect(err.code).toBe("NOT_RESOURCE_OWNER");
    expect(world.repos.arrivalAreas.lockParent).not.toHaveBeenCalled();
  });

  it("an event editor creates an event-only area", async () => {
    // An EXACT place: the address is public, so the editor's pin is the truth.
    const world = makeWorld({
      place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
      event: makeEvent({ locationMode: "EXACT" }),
    });
    const row = await createArrivalArea(world.deps, eventInput());
    expect(row.eventId).toBe(EVENT_ID);
    expect(row.placeId).toBeNull();
    expect(world.audit[0]?.data).toMatchObject({ editorKind: "event_editor" });
  });

  it("an event editor is refused on the event's PLACE areas", async () => {
    const world = makeWorld();
    const err = await errorOf(
      createArrivalArea(world.deps, createInput({ actorHumanId: EVENT_EDITOR })),
    );
    expect(err.code).toBe("NOT_RESOURCE_OWNER");
  });

  it("someone who cannot edit the event is refused on its areas", async () => {
    for (const actor of [STRANGER, PLACE_MANAGER, MODERATOR]) {
      const world = makeWorld();
      const err = await errorOf(
        createArrivalArea(world.deps, eventInput({ actorHumanId: actor })),
      );
      expect(err.code).toBe("INSUFFICIENT_ROLE");
      expect(world.repos.arrivalAreas.create).not.toHaveBeenCalled();
    }
  });

  it("an event at a freeform address: its editor draws around the event's own pin", async () => {
    const world = makeWorld({
      place: null,
      event: makeEvent({ placeId: null, locationMode: "OBSCURED" }),
    });
    const row = await createArrivalArea(world.deps, eventInput());
    expect(row.eventId).toBe(EVENT_ID);
  });

  it("refuses a missing parent / a client-supplied both parents", async () => {
    const world = makeWorld();
    await expect(
      createArrivalArea(world.deps, { ...createInput(), eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createArrivalArea(world.deps, { ...createInput(), placeId: undefined }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ── The pin choice (security finding) ───────────────────────────────────────

describe("the pin an event-only area is measured from", () => {
  /** The withheld place's PUBLIC circle centre, as the projection draws it. */
  function publicCentre() {
    const projected = projectPublicEventLocation(makeEvent(), {
      place: makePlace(),
      gateAccessGranted: true,
    });
    expect(projected.hidden).toBe(false);
    return { lat: projected.lat as number, lng: projected.lng as number };
  }

  /** A point `metres` from `from`, continuing away from `away`. */
  function beyond(
    from: { lat: number; lng: number },
    away: { lat: number; lng: number },
    metres: number,
  ) {
    const k = Math.cos((from.lat * Math.PI) / 180);
    const dx = (from.lng - away.lng) * k;
    const dy = from.lat - away.lat;
    const len = Math.hypot(dx, dy);
    return offset(from.lat, from.lng, (dx / len) * metres, (dy / len) * metres);
  }

  it("precondition: the public centre is a real distance from the house", () => {
    const c = publicCentre();
    expect(haversineDistance(c.lat, c.lng, TRUE_LAT, TRUE_LNG)).toBeGreaterThan(150);
  });

  it("an editor who cannot see a withheld place's address draws NOTHING there (NO_PIN), near the house or near the public centre", async () => {
    const c = publicCentre();
    const nearHouse = beyond({ lat: TRUE_LAT, lng: TRUE_LNG }, c, 2_900);
    const nearCentre = beyond(c, { lat: TRUE_LAT, lng: TRUE_LNG }, 2_900);
    for (const p of [{ lat: TRUE_LAT, lng: TRUE_LNG }, nearHouse, nearCentre, c]) {
      const world = makeWorld();
      const err = await errorOf(
        createArrivalArea(world.deps, eventInput({ geometry: squareAt(p.lat, p.lng) })),
      );
      expect(err.code).toBe("ARRIVAL_AREA_INVALID_GEOMETRY");
      // The same answer wherever the shape is: no distance oracle at all.
      expect(err.meta).toEqual({ reason: "NO_PIN" });
      expect(world.repos.arrivalAreas.create).not.toHaveBeenCalled();
    }
  });

  it("an editor of an OBSCURED event at a place that PUBLISHES its address is measured from the true pin", async () => {
    const world = makeWorld({
      place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
      event: makeEvent({ locationMode: "OBSCURED" }),
    });
    await expect(createArrivalArea(world.deps, eventInput())).resolves.toMatchObject({
      eventId: EVENT_ID,
      geometryWithheld: false,
    });
    const far = offset(TRUE_LAT, TRUE_LNG, 0, 3_500);
    const refused = makeWorld({
      place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
      event: makeEvent({ locationMode: "OBSCURED" }),
    });
    const err = await errorOf(
      createArrivalArea(refused.deps, eventInput({ geometry: squareAt(far.lat, far.lng) })),
    );
    expect(err.meta).toEqual({ reason: "OUTSIDE_ENVELOPE", limitMeters: 3_000 });
  });

  it("an editor who also manages the place is measured from the TRUE pin", async () => {
    const c = publicCentre();
    const nearHouse = beyond({ lat: TRUE_LAT, lng: TRUE_LNG }, c, 2_900);
    const nearCentre = beyond(c, { lat: TRUE_LAT, lng: TRUE_LNG }, 2_900);

    const ok = makeWorld();
    await expect(
      createArrivalArea(
        ok.deps,
        eventInput({ actorHumanId: BOTH, geometry: squareAt(nearHouse.lat, nearHouse.lng) }),
      ),
    ).resolves.toMatchObject({ eventId: EVENT_ID });

    const refused = makeWorld();
    const err = await errorOf(
      createArrivalArea(
        refused.deps,
        eventInput({ actorHumanId: BOTH, geometry: squareAt(nearCentre.lat, nearCentre.lng) }),
      ),
    );
    expect(err.meta).toMatchObject({ reason: "OUTSIDE_ENVELOPE" });
  });

  it("a fully hidden place (no public pin) refuses with NO_PIN, even beside the house", async () => {
    const world = makeWorld({ place: makePlace({ locationRadiusMeters: null }) });
    const err = await errorOf(createArrivalArea(world.deps, eventInput()));
    expect(err.code).toBe("ARRIVAL_AREA_INVALID_GEOMETRY");
    expect(err.meta).toEqual({ reason: "NO_PIN" });
  });

  it("each refusal's meta is exactly the rule and its limit fields, never a coordinate", async () => {
    const at = (geometry: unknown, world = makeWorld()) =>
      errorOf(createArrivalArea(world.deps, createInput({ geometry })));
    const far = offset(TRUE_LAT, TRUE_LNG, 0, 9_000);
    const cases: Array<[unknown, string[]]> = [
      [squareAt(far.lat, far.lng), ["limitMeters", "reason"]],
      [{ type: "Point", coordinates: [TRUE_LNG, TRUE_LAT] }, ["reason"]],
      [{ type: "LineString", coordinates: [[TRUE_LNG, TRUE_LAT]] }, ["count", "minimum", "reason"]],
      [
        { type: "LineString", coordinates: [[TRUE_LNG, TRUE_LAT], [TRUE_LNG, TRUE_LAT]] },
        ["reason"],
      ],
      [
        {
          type: "Polygon",
          coordinates: [[[TRUE_LNG, TRUE_LAT], [TRUE_LNG + 0.001, TRUE_LAT], [TRUE_LNG + 0.001, TRUE_LAT + 0.001]]],
        },
        ["reason"],
      ],
    ];
    for (const [geometry, keys] of cases) {
      const err = await at(geometry);
      expect(err.code).toBe("ARRIVAL_AREA_INVALID_GEOMETRY");
      expect(Object.keys(err.meta ?? {}).sort()).toEqual(keys);
    }
    const noPin = await at(NEAR_TRUTH, makeWorld({ place: makePlace({ lat: null, lng: null } as never) }));
    expect(noPin.meta).toEqual({ reason: "NO_PIN" });
  });
});

// ── Limits (FR-005) ─────────────────────────────────────────────────────────

describe("limits", () => {
  const ten = (parent: { placeId?: string; eventId?: string }) =>
    Array.from({ length: 10 }, (_, i) =>
      areaRow({
        id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, "0")}`,
        placeId: parent.placeId ?? null,
        eventId: parent.eventId ?? null,
        sortOrder: i,
      }),
    );

  it("the 11th place area is refused naming the limit; lock before count", async () => {
    const world = makeWorld({ areas: ten({ placeId: PLACE_ID }) });
    const err = await errorOf(createArrivalArea(world.deps, createInput()));
    expect(err.code).toBe("ARRIVAL_AREA_LIMIT_REACHED");
    expect(err.meta).toEqual({ limit: 10, parent: "place" });
    expect(world.calls.indexOf("lockParent:place")).toBeLessThan(
      world.calls.indexOf("countForPlace"),
    );
    expect(world.repos.arrivalAreas.create).not.toHaveBeenCalled();
  });

  it("the 11th event-only area is refused naming the limit; lock before count", async () => {
    const world = makeWorld({
      place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
      event: makeEvent({ locationMode: "EXACT" }),
      areas: ten({ eventId: EVENT_ID }),
    });
    const err = await errorOf(createArrivalArea(world.deps, eventInput()));
    expect(err.code).toBe("ARRIVAL_AREA_LIMIT_REACHED");
    expect(err.meta).toEqual({ limit: 10, parent: "event" });
    expect(world.calls.indexOf("lockParent:event")).toBeLessThan(
      world.calls.indexOf("countForEvent"),
    );
  });

  it("the 10th is accepted and appended at the end", async () => {
    const nine = ten({ placeId: PLACE_ID }).slice(0, 9);
    const world = makeWorld({ areas: nine });
    const row = await createArrivalArea(world.deps, createInput());
    expect(row.sortOrder).toBe(9);
  });

  it("place areas do not count toward the event's limit", async () => {
    const world = makeWorld({
      place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
      event: makeEvent({ locationMode: "EXACT" }),
      areas: ten({ placeId: PLACE_ID }),
    });
    await expect(createArrivalArea(world.deps, eventInput())).resolves.toMatchObject({
      eventId: EVENT_ID,
    });
  });

  it("geometry rules name their limit (too many points)", async () => {
    const world = makeWorld();
    const ring = Array.from({ length: 201 }, (_, i) => [TRUE_LNG + i * 1e-5, TRUE_LAT]);
    const err = await errorOf(
      createArrivalArea(world.deps, createInput({ geometry: { type: "LineString", coordinates: ring } })),
    );
    expect(err.meta).toEqual({ reason: "TOO_MANY_POINTS", limit: 200, count: 201 });
  });

  it("free text is sanitized before its length check", async () => {
    const world = makeWorld();
    const row = await createArrivalArea(
      world.deps,
      createInput({ label: "  <b>Back</b> lot  ", note: "", priceText: "" }),
    );
    expect(row.label).not.toContain("<b>");
    expect(row.note).toBeNull();
    expect(row.priceText).toBeNull();
  });
});

// ── Update / remove / reorder ───────────────────────────────────────────────

describe("update", () => {
  const AREA = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
  const T0 = new Date("2026-10-01T00:00:00.000Z");

  it("edits fields, keeps omitted ones, and audits before/after", async () => {
    const world = makeWorld({
      areas: [areaRow({ id: AREA, priceText: "$5", note: "Gate code at the door" })],
    });
    const row = await updateArrivalArea(world.deps, {
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
      arrivalAreaId: AREA,
      expectedUpdatedAt: T0.toISOString(),
      patch: { label: "Front lot" },
    });
    expect(row.label).toBe("Front lot");
    expect(row.priceText).toBe("$5");
    expect(row.note).toBe("Gate code at the door");
    expect(row.cost).toBe("FREE");
    const entry = world.audit.find((a) => a.action === "arrival_area.updated");
    expect(entry?.entityId).toBe(AREA);
    expect(entry?.data).toMatchObject({
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
      before: { label: `Area ${AREA}`, geometry: expect.any(Object) },
      after: { label: "Front lot", geometry: expect.any(Object) },
    });
  });

  it("a stale token is a conflict carrying the current row; nothing written", async () => {
    const current = areaRow({ id: AREA, updatedAt: new Date("2026-10-02T00:00:00.000Z") });
    const world = makeWorld({ areas: [current] });
    const err = await errorOf(
      updateArrivalArea(world.deps, {
        actorHumanId: PLACE_MANAGER,
        placeId: PLACE_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
        patch: { label: "Front lot" },
      }),
    );
    expect(err.code).toBe("ARRIVAL_AREA_CONFLICT");
    expect(err.meta?.current).toEqual({ ...current, geometryWithheld: false });
    expect(world.store.get(AREA)?.label).toBe(current.label);
    expect(world.audit).toEqual([]);
  });

  it("an id of another place's area reads as not found", async () => {
    const world = makeWorld({ areas: [areaRow({ id: AREA, placeId: OTHER_PLACE_ID })] });
    const err = await errorOf(
      updateArrivalArea(world.deps, {
        actorHumanId: PLACE_MANAGER,
        placeId: PLACE_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
        patch: { label: "Mine now" },
      }),
    );
    expect(err.code).toBe("ARRIVAL_AREA_NOT_FOUND");
    expect(world.repos.arrivalAreas.update).not.toHaveBeenCalled();
  });

  it("an event-only area addressed through its place reads as not found", async () => {
    const world = makeWorld({ areas: [areaRow({ id: AREA, placeId: null, eventId: EVENT_ID })] });
    const err = await errorOf(
      updateArrivalArea(world.deps, {
        actorHumanId: PLACE_MANAGER,
        placeId: PLACE_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
        patch: { label: "x" },
      }),
    );
    expect(err.code).toBe("ARRIVAL_AREA_NOT_FOUND");
  });

  describe("a switched-off event area (FR-014)", () => {
    const exactWorld = () =>
      makeWorld({
        place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
        event: makeEvent({ locationMode: "EXACT" }),
        areas: [
          areaRow({
            id: AREA,
            placeId: null,
            eventId: EVENT_ID,
            disabledAt: new Date("2026-10-10T00:00:00.000Z"),
          }),
        ],
      });

    it("a NEW shape switches it back on", async () => {
      const world = exactWorld();
      const row = await updateArrivalArea(world.deps, {
        actorHumanId: EVENT_EDITOR,
        eventId: EVENT_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
        patch: { geometry: squareAt(TRUE_LAT - 0.001, TRUE_LNG) },
      });
      expect(row.disabledAt).toBeNull();
      expect(world.repos.arrivalAreas.update.mock.calls[0]?.[1]).toMatchObject({
        disabledAt: null,
      });
    });

    it("the same shape re-sent, or a label edit, leaves it off", async () => {
      const world = exactWorld();
      const same = world.store.get(AREA)!.geometry;
      const row = await updateArrivalArea(world.deps, {
        actorHumanId: EVENT_EDITOR,
        eventId: EVENT_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
        patch: { geometry: same, label: "Renamed" },
      });
      expect(row.disabledAt).not.toBeNull();
    });

    it("a new shape is still measured against the pin", async () => {
      const world = exactWorld();
      const far = offset(TRUE_LAT, TRUE_LNG, 0, 5_000);
      const err = await errorOf(
        updateArrivalArea(world.deps, {
          actorHumanId: EVENT_EDITOR,
          eventId: EVENT_ID,
          arrivalAreaId: AREA,
          expectedUpdatedAt: T0,
          patch: { geometry: squareAt(far.lat, far.lng) },
        }),
      );
      expect(err.meta).toMatchObject({ reason: "OUTSIDE_ENVELOPE" });
    });
  });
});

describe("remove", () => {
  const AREA = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
  const T0 = new Date("2026-10-01T00:00:00.000Z");

  it("hard-deletes after the parent lock and keeps the audit row with the before payload", async () => {
    const world = makeWorld({ areas: [areaRow({ id: AREA })] });
    const out = await removeArrivalArea(world.deps, {
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
      arrivalAreaId: AREA,
      expectedUpdatedAt: T0,
    });
    expect(out).toEqual({ id: AREA, removed: true });
    expect(world.store.has(AREA)).toBe(false);
    expect(world.calls.indexOf("lockParent:place")).toBeLessThan(world.calls.indexOf("delete"));
    const entry = world.audit.find((a) => a.action === "arrival_area.removed");
    expect(entry).toMatchObject({
      entity: "arrival_area",
      entityId: AREA,
      data: { before: { id: AREA, geometry: expect.any(Object) }, after: null },
    });
  });

  it("a stale token is a conflict carrying the current row; the row stays", async () => {
    const current = areaRow({ id: AREA, updatedAt: new Date("2026-10-03T00:00:00.000Z") });
    const world = makeWorld({ areas: [current] });
    const err = await errorOf(
      removeArrivalArea(world.deps, {
        actorHumanId: PLACE_MANAGER,
        placeId: PLACE_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
      }),
    );
    expect(err.code).toBe("ARRIVAL_AREA_CONFLICT");
    expect(err.meta?.current).toEqual({ ...current, geometryWithheld: false });
    expect(world.store.has(AREA)).toBe(true);
  });

  it("a foreign id reads as not found and deletes nothing", async () => {
    const world = makeWorld({ areas: [areaRow({ id: AREA, placeId: OTHER_PLACE_ID })] });
    const err = await errorOf(
      removeArrivalArea(world.deps, {
        actorHumanId: PLACE_MANAGER,
        placeId: PLACE_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
      }),
    );
    expect(err.code).toBe("ARRIVAL_AREA_NOT_FOUND");
    expect(world.repos.arrivalAreas.delete).not.toHaveBeenCalled();
  });
});

describe("reorder", () => {
  const A = "f3f3f3f3-f3f3-4f3f-8f3f-000000000001";
  const B = "f3f3f3f3-f3f3-4f3f-8f3f-000000000002";

  it("reorders after the parent lock and audits the order before/after", async () => {
    const world = makeWorld({
      areas: [areaRow({ id: A, sortOrder: 0 }), areaRow({ id: B, sortOrder: 1 })],
    });
    const rows = await reorderArrivalAreas(world.deps, {
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
      orderedIds: [B, A],
    });
    expect(rows.map((r) => r.id)).toEqual([B, A]);
    expect(world.calls.indexOf("lockParent:place")).toBeLessThan(world.calls.indexOf("reorder"));
    expect(world.audit).toEqual([
      expect.objectContaining({
        entity: "place",
        entityId: PLACE_ID,
        action: "arrival_areas.reordered",
        data: expect.objectContaining({ before: [A, B], after: [B, A] }),
      }),
    ]);
  });

  it("a set that does not match is a conflict with the current ids", async () => {
    const world = makeWorld({ areas: [areaRow({ id: A }), areaRow({ id: B, sortOrder: 1 })] });
    const err = await errorOf(
      reorderArrivalAreas(world.deps, {
        actorHumanId: PLACE_MANAGER,
        placeId: PLACE_ID,
        orderedIds: [A],
      }),
    );
    expect(err.code).toBe("ARRIVAL_AREA_CONFLICT");
    expect(err.meta).toEqual({ currentIds: [A, B] });
    expect(world.audit).toEqual([]);
  });

  it("a stranger cannot reorder", async () => {
    const world = makeWorld({ areas: [areaRow({ id: A })] });
    const err = await errorOf(
      reorderArrivalAreas(world.deps, {
        actorHumanId: STRANGER,
        placeId: PLACE_ID,
        orderedIds: [A],
      }),
    );
    expect(err.code).toBe("NOT_RESOURCE_OWNER");
  });
});

// ── Audit (FR-013) ──────────────────────────────────────────────────────────

describe("audit", () => {
  it("create writes ONE row in the transaction with the full after payload", async () => {
    const world = makeWorld();
    const row = await createArrivalArea(world.deps, createInput());
    expect(world.audit).toHaveLength(1);
    expect(world.audit[0]).toMatchObject({
      entity: "arrival_area",
      entityId: row.id,
      action: "arrival_area.created",
      data: {
        actorHumanId: PLACE_MANAGER,
        editorKind: "owner",
        placeId: PLACE_ID,
        eventId: null,
        before: null,
        after: { id: row.id, kind: "PARKING", label: "Back lot", geometry: NEAR_TRUTH },
      },
    });
    expect(world.calls.indexOf("create")).toBeLessThan(
      world.calls.indexOf("audit:arrival_area.created"),
    );
  });

  it("no logger line carries a geometry", async () => {
    const world = makeWorld();
    await createArrivalArea(world.deps, createInput());
    const logged = JSON.stringify(world.logger.info.mock.calls);
    expect(logged).not.toContain("coordinates");
    expect(logged).not.toMatch(/36\.18|86\.72/);
  });
});

// ── Review round 1: no root-pool authz under the lock; withheld shapes ─────

describe("authz probes run before the transaction (no pool starvation)", () => {
  it("event-area mutations probe canManagePlace / canEditEvent before lockParent, never inside the tx", async () => {
    const world = makeWorld({
      place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
      event: makeEvent({ locationMode: "EXACT" }),
    });
    // The fake's authz THROWS if called inside `repos.tx`; succeeding at all
    // proves no probe ran under the lock.
    await createArrivalArea(world.deps, eventInput({ actorHumanId: BOTH }));
    const lock = world.calls.indexOf("lockParent:event");
    const probes = world.calls
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.startsWith("authz:"));
    expect(probes.map(([c]) => c)).toEqual(
      expect.arrayContaining(["authz:canManagePlace", "authz:canEditEvent"]),
    );
    expect(probes.every(([, i]) => i < lock)).toBe(true);
  });
});

describe("an editor who cannot see the event's address never receives a shape (F1)", () => {
  const AREA = "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4";
  const T0 = new Date("2026-10-01T00:00:00.000Z");
  /** The place switched to withheld AFTER this event area was drawn. */
  const withheldAfterDrawing = () =>
    makeWorld({
      areas: [
        areaRow({
          id: AREA,
          placeId: null,
          eventId: EVENT_ID,
          note: "Behind the blue house",
          priceText: "$5",
        }),
      ],
    });

  it("update returns the row with geometry withheld", async () => {
    const world = withheldAfterDrawing();
    const row = await updateArrivalArea(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
      arrivalAreaId: AREA,
      expectedUpdatedAt: T0,
      patch: { label: "Renamed" },
    });
    expect(row).toMatchObject({
      id: AREA,
      label: "Renamed",
      kind: "PARKING",
      cost: "FREE",
      geometry: null,
      note: null,
      priceText: null,
      geometryWithheld: true,
    });
    expect(JSON.stringify(row)).not.toContain("blue house");
    expect(JSON.stringify(row)).not.toMatch(/36\.18|86\.72/);
  });

  it("a moved shape cannot be saved there (NO_PIN)", async () => {
    const world = withheldAfterDrawing();
    const err = await errorOf(
      updateArrivalArea(world.deps, {
        actorHumanId: EVENT_EDITOR,
        eventId: EVENT_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
        patch: { geometry: squareAt(TRUE_LAT, TRUE_LNG) },
      }),
    );
    expect(err.meta).toEqual({ reason: "NO_PIN" });
  });

  it("a conflict's current row is withheld too", async () => {
    const world = makeWorld({
      areas: [
        areaRow({ id: AREA, placeId: null, eventId: EVENT_ID, updatedAt: new Date("2026-10-05") }),
      ],
    });
    const err = await errorOf(
      updateArrivalArea(world.deps, {
        actorHumanId: EVENT_EDITOR,
        eventId: EVENT_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
        patch: { label: "x" },
      }),
    );
    expect(err.code).toBe("ARRIVAL_AREA_CONFLICT");
    expect(err.meta?.current).toMatchObject({ id: AREA, geometry: null, geometryWithheld: true });
    expect(JSON.stringify(err.meta)).not.toMatch(/36\.18|86\.72/);
  });

  it("reorder returns withheld rows; remove still works", async () => {
    const world = withheldAfterDrawing();
    const rows = await reorderArrivalAreas(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
      orderedIds: [AREA],
    });
    expect(rows[0]).toMatchObject({ geometry: null, note: null, priceText: null, geometryWithheld: true });
    await expect(
      removeArrivalArea(world.deps, {
        actorHumanId: EVENT_EDITOR,
        eventId: EVENT_ID,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
      }),
    ).resolves.toEqual({ id: AREA, removed: true });
  });

  it("the place's manager editing the same event gets the shape", async () => {
    const world = withheldAfterDrawing();
    const row = await updateArrivalArea(world.deps, {
      actorHumanId: BOTH,
      eventId: EVENT_ID,
      arrivalAreaId: AREA,
      expectedUpdatedAt: T0,
      patch: { label: "Renamed" },
    });
    expect(row.geometryWithheld).toBe(false);
    expect(row.geometry).not.toBeNull();
    expect(row.note).toBe("Behind the blue house");
  });
});

describe("a moderator at a WITHHELD unowned place never receives the place's pin or shapes (FR-008, option A)", () => {
  const AREA = "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5";
  const T0 = new Date("2026-10-01T00:00:00.000Z");
  const withheldUnowned = () =>
    makeWorld({
      unowned: true,
      areas: [
        areaRow({ id: AREA, note: "Behind the blue house", priceText: "$5" }),
      ],
    });
  const exactUnowned = () =>
    makeWorld({
      unowned: true,
      place: makePlace({
        orgIdsWithAccess: [],
        locationMode: "EXACT",
        locationRadiusMeters: null,
      }),
      areas: [areaRow({ id: AREA, note: "Behind the blue house" })],
    });
  const asModerator = { actorHumanId: MODERATOR, placeId: PLACE_ID };
  const FAR = squareAt(TRUE_LAT + 0.05, TRUE_LNG); // ~5.5 km north

  it("create answers NO_PIN, near the house or far from it: no distance oracle", async () => {
    for (const geometry of [NEAR_TRUTH, FAR]) {
      const world = withheldUnowned();
      const err = await errorOf(
        createArrivalArea(world.deps, createInput({ ...asModerator, geometry })),
      );
      expect(err.code).toBe("ARRIVAL_AREA_INVALID_GEOMETRY");
      expect(err.meta).toEqual({ reason: "NO_PIN" });
      expect(world.repos.arrivalAreas.create).not.toHaveBeenCalled();
    }
  });

  it("update of fields returns the row withheld; a new shape answers NO_PIN", async () => {
    const world = withheldUnowned();
    const row = await updateArrivalArea(world.deps, {
      ...asModerator,
      arrivalAreaId: AREA,
      expectedUpdatedAt: T0,
      patch: { label: "Renamed" },
    });
    expect(row).toMatchObject({
      id: AREA,
      label: "Renamed",
      geometry: null,
      note: null,
      priceText: null,
      geometryWithheld: true,
    });
    expect(JSON.stringify(row)).not.toContain("blue house");
    expect(JSON.stringify(row)).not.toMatch(/36\.18|86\.72/);

    const err = await errorOf(
      updateArrivalArea(world.deps, {
        ...asModerator,
        arrivalAreaId: AREA,
        expectedUpdatedAt: row.updatedAt,
        patch: { geometry: NEAR_TRUTH },
      }),
    );
    expect(err.meta).toEqual({ reason: "NO_PIN" });
  });

  it("a conflict's current row is withheld too", async () => {
    const world = makeWorld({
      unowned: true,
      areas: [areaRow({ id: AREA, updatedAt: new Date("2026-10-05") })],
    });
    const err = await errorOf(
      updateArrivalArea(world.deps, {
        ...asModerator,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
        patch: { label: "x" },
      }),
    );
    expect(err.code).toBe("ARRIVAL_AREA_CONFLICT");
    expect(err.meta?.current).toMatchObject({ id: AREA, geometry: null, geometryWithheld: true });
    expect(JSON.stringify(err.meta)).not.toMatch(/36\.18|86\.72/);
  });

  it("reorder returns withheld rows; remove still works", async () => {
    const world = withheldUnowned();
    const rows = await reorderArrivalAreas(world.deps, {
      ...asModerator,
      orderedIds: [AREA],
    });
    expect(rows[0]).toMatchObject({ geometry: null, note: null, priceText: null, geometryWithheld: true });
    await expect(
      removeArrivalArea(world.deps, {
        ...asModerator,
        arrivalAreaId: AREA,
        expectedUpdatedAt: T0,
      }),
    ).resolves.toEqual({ id: AREA, removed: true });
    expect(world.audit.at(-1)).toMatchObject({
      action: "arrival_area.removed",
      data: expect.objectContaining({ editorKind: "community_moderator" }),
    });
  });

  it("the place's owner at the same OBSCURED place is measured from the true pin and gets the shape", async () => {
    // makePlace() is OBSCURED by default; this world's place is owned.
    const world = makeWorld({
      areas: [areaRow({ id: AREA, note: "Behind the blue house" })],
    });
    const created = await createArrivalArea(world.deps, createInput());
    expect(created).toMatchObject({ geometryWithheld: false, geometry: NEAR_TRUTH });
    const far = await errorOf(
      createArrivalArea(world.deps, createInput({ geometry: FAR })),
    );
    expect(far.meta).toMatchObject({ reason: "OUTSIDE_ENVELOPE" });
    const row = await updateArrivalArea(world.deps, {
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
      arrivalAreaId: AREA,
      expectedUpdatedAt: T0,
      patch: { label: "Renamed" },
    });
    expect(row.geometryWithheld).toBe(false);
    expect(row.note).toBe("Behind the blue house");
  });

  it("decides on the LOCKED row: EXACT before the transaction, OBSCURED under the lock, is withheld", async () => {
    const world = withheldUnowned();
    const exact = makePlace({
      orgIdsWithAccess: [],
      locationMode: "EXACT",
      locationRadiusMeters: null,
    });
    const obscured = makePlace({ orgIdsWithAccess: [] });
    let inside = false;
    const realTx = world.repos.tx.getMockImplementation();
    if (!realTx) throw new Error("expected the fake tx");
    world.repos.tx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      inside = true;
      try {
        return await realTx(fn);
      } finally {
        inside = false;
      }
    });
    const reads: boolean[] = [];
    world.repos.places.getById.mockImplementation(async (id: string) => {
      if (id !== PLACE_ID) return null;
      reads.push(inside);
      return inside ? obscured : exact;
    });

    const err = await errorOf(
      createArrivalArea(world.deps, createInput({ ...asModerator, geometry: NEAR_TRUTH })),
    );
    expect(err.meta).toEqual({ reason: "NO_PIN" });
    expect(world.repos.arrivalAreas.create).not.toHaveBeenCalled();

    const row = await updateArrivalArea(world.deps, {
      ...asModerator,
      arrivalAreaId: AREA,
      expectedUpdatedAt: T0,
      patch: { label: "Renamed" },
    });
    expect(row).toMatchObject({ label: "Renamed", geometry: null, geometryWithheld: true });
    // Precondition: the advisory check saw the EXACT row, the decision the
    // locked one.
    expect(reads).toContain(false);
    expect(reads).toContain(true);
  });

  it("a moderator at a place that PUBLISHES its address is unchanged: true pin, full rows", async () => {
    const world = exactUnowned();
    const created = await createArrivalArea(world.deps, createInput(asModerator));
    expect(created).toMatchObject({ geometryWithheld: false, geometry: NEAR_TRUTH });
    const far = await errorOf(
      createArrivalArea(world.deps, createInput({ ...asModerator, geometry: FAR })),
    );
    expect(far.meta).toMatchObject({ reason: "OUTSIDE_ENVELOPE" });
    const row = await updateArrivalArea(world.deps, {
      ...asModerator,
      arrivalAreaId: AREA,
      expectedUpdatedAt: T0,
      patch: { label: "Renamed" },
    });
    expect(row).toMatchObject({ geometryWithheld: false, note: "Behind the blue house" });
  });
});
