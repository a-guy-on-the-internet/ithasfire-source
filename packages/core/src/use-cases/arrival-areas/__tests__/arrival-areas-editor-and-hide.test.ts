import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../../../lib/location/obfuscation-key";
import { resolveEventAreaAccess } from "../_shared/event-area-access";
import { listArrivalAreasForEditor } from "../list-arrival-areas-for-editor";
import {
  eventLocationChanged,
  onEventLocationChanged,
} from "../on-event-location-changed";
import { setEventArrivalAreaHidden } from "../set-event-arrival-area-hidden";
import {
  BOTH,
  EVENT_EDITOR,
  EVENT_ID,
  MODERATOR,
  NOW,
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
  squareAt,
} from "./arrival-area-world";

/**
 * arrival-areas step 4: the editor read (FR-002..FR-004, FR-014), hiding a
 * place area per event (FR-004, FR-013), and the event-location-change hook
 * (FR-014).
 */

beforeAll(() => {
  configureLocationObfuscation({ secret: "arrival-areas-editor-test" });
});
afterAll(() => {
  resetLocationObfuscationForTests();
});

const P_PARK = "a1a1a1a1-a1a1-4a1a-8a1a-000000000001";
const P_DROP = "a1a1a1a1-a1a1-4a1a-8a1a-000000000002";
const P_LOAD = "a1a1a1a1-a1a1-4a1a-8a1a-000000000003";
const E_PARK = "a1a1a1a1-a1a1-4a1a-8a1a-000000000004";
const FOREIGN = "a1a1a1a1-a1a1-4a1a-8a1a-000000000005";

const placeAreas = () => [
  areaRow({ id: P_PARK, kind: "PARKING", sortOrder: 0 }),
  areaRow({ id: P_DROP, kind: "ACCESSIBLE_DROP_OFF", sortOrder: 1 }),
  areaRow({ id: P_LOAD, kind: "LOAD_IN", sortOrder: 2 }),
];
const eventArea = (overrides = {}) =>
  areaRow({ id: E_PARK, placeId: null, eventId: EVENT_ID, ...overrides });
const foreignArea = () => areaRow({ id: FOREIGN, placeId: OTHER_PLACE_ID });

const EXACT_PLACE = () => makePlace({ locationMode: "EXACT", locationRadiusMeters: null });
const EXACT_EVENT = () => makeEvent({ locationMode: "EXACT" });

// ── Editor read: place ──────────────────────────────────────────────────────

describe("listArrivalAreasForEditor — place", () => {
  it("lists every area, disabled included, for the manager", async () => {
    const world = makeWorld({ areas: placeAreas() });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
    });
    expect(out.parent).toBe("place");
    expect(out.areas.map((a) => a.id)).toEqual([P_PARK, P_DROP, P_LOAD]);
    expect(out.areas.every((a) => a.outsideEnvelope === false)).toBe(true);
  });

  it("flags areas beyond 3 km once the place's pin has moved", async () => {
    const world = makeWorld({
      place: makePlace({ lat: TRUE_LAT + 0.05 }), // ~5.5 km north
      areas: placeAreas(),
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
    });
    expect(out.areas.every((a) => a.outsideEnvelope === true)).toBe(true);
  });

  it("a moderator reads an unowned place's areas; a stranger and an event editor cannot", async () => {
    const mod = makeWorld({ unowned: true, areas: placeAreas() });
    await expect(
      listArrivalAreasForEditor(mod.deps, { actorHumanId: MODERATOR, placeId: PLACE_ID }),
    ).resolves.toMatchObject({ editorKind: "community_moderator" });

    for (const actor of [STRANGER, EVENT_EDITOR]) {
      const world = makeWorld({ areas: placeAreas() });
      const err = await errorOf(
        listArrivalAreasForEditor(world.deps, { actorHumanId: actor, placeId: PLACE_ID }),
      );
      expect(err.code).toBe("NOT_RESOURCE_OWNER");
    }
  });
});

// ── Editor read: event ──────────────────────────────────────────────────────

describe("listArrivalAreasForEditor — event", () => {
  it("an editor at a WITHHELD place they do not manage sees none of the place's shapes", async () => {
    const world = makeWorld({ areas: [...placeAreas(), eventArea()] });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.placeAreas).toEqual([]);
    expect(out.areas.map((a) => a.id)).toEqual([E_PARK]);
    expect(JSON.stringify(out)).not.toContain(P_PARK);
    expect(world.repos.arrivalAreas.listForPlace).not.toHaveBeenCalled();
  });

  it("at a public place: the place's public areas with hiddenForEvent, never its LOAD_IN", async () => {
    const world = makeWorld({
      place: EXACT_PLACE(),
      event: EXACT_EVENT(),
      areas: [...placeAreas(), eventArea()],
      hides: [{ eventId: EVENT_ID, arrivalAreaId: P_DROP }],
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.placeAreas.map((a) => [a.id, a.hiddenForEvent])).toEqual([
      [P_PARK, false],
      [P_DROP, true],
    ]);
    expect(out.areas[0]?.hiddenForEvent).toBeNull();
  });

  it("Q3: at a show the place vouched for (stamp), the editor sees the place's LOAD_IN", async () => {
    const world = makeWorld({
      place: EXACT_PLACE(),
      event: makeEvent({
        locationMode: "EXACT",
        venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
      }),
      areas: placeAreas(),
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.placeAreas.map((a) => a.id)).toEqual([P_PARK, P_DROP, P_LOAD]);
  });

  it("Q3: a vouched show at a WITHHELD place still shows an editor who cannot see the address nothing (option A)", async () => {
    const world = makeWorld({
      event: makeEvent({
        venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
      }),
      areas: [...placeAreas(), eventArea()],
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.placeAreas).toEqual([]);
    expect(out.areas[0]).toMatchObject({ geometry: null, geometryWithheld: true });
    expect(JSON.stringify(out)).not.toContain(P_LOAD);
    expect(world.repos.arrivalAreas.listForPlace).not.toHaveBeenCalled();
  });

  it("Q3: once the vouched show has ended, the editor no longer sees the place's LOAD_IN", async () => {
    const world = makeWorld({
      place: EXACT_PLACE(),
      event: makeEvent({
        locationMode: "EXACT",
        startsAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
        endsAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
        venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
      }),
      areas: placeAreas(),
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.placeAreas.map((a) => a.id)).toEqual([P_PARK, P_DROP]);
  });

  it("the place's manager editing the event sees its LOAD_IN too", async () => {
    const world = makeWorld({ areas: placeAreas() });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: BOTH,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.placeAreas.map((a) => a.id)).toEqual([P_PARK, P_DROP, P_LOAD]);
  });

  it("the place's manager keeps its LOAD_IN after the show ends (the end only limits acts and editors)", async () => {
    const world = makeWorld({
      event: makeEvent({
        startsAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
        endsAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      }),
      areas: placeAreas(),
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: BOTH,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.placeAreas.map((a) => a.id)).toEqual([P_PARK, P_DROP, P_LOAD]);
  });

  it("allPublicHidden: every public place area hidden and no own public area on", async () => {
    const hides = [
      { eventId: EVENT_ID, arrivalAreaId: P_PARK },
      { eventId: EVENT_ID, arrivalAreaId: P_DROP },
    ];
    const all = makeWorld({ place: EXACT_PLACE(), event: EXACT_EVENT(), areas: placeAreas(), hides });
    const a = await listArrivalAreasForEditor(all.deps, { actorHumanId: EVENT_EDITOR, eventId: EVENT_ID });
    expect(a).toMatchObject({ allPublicHidden: true });

    const one = makeWorld({
      place: EXACT_PLACE(),
      event: EXACT_EVENT(),
      areas: placeAreas(),
      hides: hides.slice(0, 1),
    });
    const b = await listArrivalAreasForEditor(one.deps, { actorHumanId: EVENT_EDITOR, eventId: EVENT_ID });
    expect(b).toMatchObject({ allPublicHidden: false });

    const own = makeWorld({
      place: EXACT_PLACE(),
      event: EXACT_EVENT(),
      areas: [...placeAreas(), eventArea()],
      hides,
    });
    const c = await listArrivalAreasForEditor(own.deps, { actorHumanId: EVENT_EDITOR, eventId: EVENT_ID });
    expect(c).toMatchObject({ allPublicHidden: false });
  });

  it("switched-off event areas are listed, flagged against the editor's pin", async () => {
    const world = makeWorld({
      place: EXACT_PLACE(),
      event: EXACT_EVENT(),
      areas: [
        eventArea({
          disabledAt: new Date("2026-10-10T00:00:00.000Z"),
          geometry: squareAt(TRUE_LAT + 0.05, TRUE_LNG),
        }),
      ],
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    expect(out.areas[0]).toMatchObject({
      id: E_PARK,
      disabledAt: new Date("2026-10-10T00:00:00.000Z"),
      outsideEnvelope: true,
    });
  });

  it("a non-editor cannot read the event's editor list", async () => {
    const world = makeWorld();
    const err = await errorOf(
      listArrivalAreasForEditor(world.deps, { actorHumanId: STRANGER, eventId: EVENT_ID }),
    );
    expect(err.code).toBe("INSUFFICIENT_ROLE");
  });
});

// ── Hide / show ─────────────────────────────────────────────────────────────

describe("setEventArrivalAreaHidden", () => {
  const exactWorld = (extra: Parameters<typeof makeWorld>[0] = {}) =>
    makeWorld({
      place: EXACT_PLACE(),
      event: EXACT_EVENT(),
      areas: [...placeAreas(), eventArea(), foreignArea()],
      ...extra,
    });
  const hide = (areaId: string, hidden = true, actorHumanId = EVENT_EDITOR) => ({
    actorHumanId,
    eventId: EVENT_ID,
    arrivalAreaId: areaId,
    hidden,
  });

  it("hides a place area, audits it, and answers with the editor list", async () => {
    const world = exactWorld();
    const out = await setEventArrivalAreaHidden(world.deps, hide(P_PARK));
    expect(out.placeAreas.find((a) => a.id === P_PARK)?.hiddenForEvent).toBe(true);
    expect(world.calls.indexOf("lockParent:event")).toBeLessThan(world.calls.indexOf("hide"));
    expect(world.audit).toEqual([
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "arrival_area.hidden",
        data: expect.objectContaining({
          actorHumanId: EVENT_EDITOR,
          arrivalAreaId: P_PARK,
          before: { hidden: false },
          after: { hidden: true },
        }),
      }),
    ]);
  });

  it("is idempotent and audits only real changes", async () => {
    const world = exactWorld();
    await setEventArrivalAreaHidden(world.deps, hide(P_PARK));
    await setEventArrivalAreaHidden(world.deps, hide(P_PARK));
    expect(world.audit).toHaveLength(1);
    await setEventArrivalAreaHidden(world.deps, hide(P_PARK, false));
    await setEventArrivalAreaHidden(world.deps, hide(P_PARK, false));
    expect(world.audit.map((a) => a.action)).toEqual([
      "arrival_area.hidden",
      "arrival_area.unhidden",
    ]);
  });

  it("another place's area reads as not found", async () => {
    const world = exactWorld();
    const err = await errorOf(setEventArrivalAreaHidden(world.deps, hide(FOREIGN)));
    expect(err.code).toBe("ARRIVAL_AREA_NOT_FOUND");
    expect(world.repos.arrivalAreas.hide).not.toHaveBeenCalled();
  });

  it("an event-only area reads as not found", async () => {
    const world = exactWorld();
    const err = await errorOf(setEventArrivalAreaHidden(world.deps, hide(E_PARK)));
    expect(err.code).toBe("ARRIVAL_AREA_NOT_FOUND");
  });

  it("an area this editor cannot see reads as not found (withheld place; the place's LOAD_IN)", async () => {
    const withheld = makeWorld({ areas: placeAreas() });
    const a = await errorOf(setEventArrivalAreaHidden(withheld.deps, hide(P_PARK)));
    expect(a.code).toBe("ARRIVAL_AREA_NOT_FOUND");

    const loadIn = exactWorld();
    const b = await errorOf(setEventArrivalAreaHidden(loadIn.deps, hide(P_LOAD)));
    expect(b.code).toBe("ARRIVAL_AREA_NOT_FOUND");
  });

  it("Q3: at a show the place stamped, the editor CAN hide the place's LOAD_IN", async () => {
    const world = exactWorld({
      event: makeEvent({
        locationMode: "EXACT",
        venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
      }),
    });
    const out = await setEventArrivalAreaHidden(world.deps, hide(P_LOAD));
    expect(out.placeAreas.find((a) => a.id === P_LOAD)?.hiddenForEvent).toBe(true);
    expect(world.repos.arrivalAreas.hide).toHaveBeenCalledTimes(1);
  });

  it("someone who cannot edit the event is refused", async () => {
    const world = exactWorld();
    const err = await errorOf(
      setEventArrivalAreaHidden(world.deps, hide(P_PARK, true, PLACE_MANAGER)),
    );
    expect(err.code).toBe("INSUFFICIENT_ROLE");
  });
});

// ── FR-014: the event changed place or address ──────────────────────────────

describe("onEventLocationChanged", () => {
  const before = { id: EVENT_ID, placeId: PLACE_ID, addressText: "East Nashville", lat: 36.18, lng: -86.75 };

  it("a change of place switches event areas off and deletes stale hides, with audit rows", async () => {
    const world = makeWorld({
      areas: [
        ...placeAreas(),
        eventArea(),
        areaRow({ id: FOREIGN, placeId: OTHER_PLACE_ID }),
      ],
      hides: [
        { eventId: EVENT_ID, arrivalAreaId: P_PARK },
        { eventId: EVENT_ID, arrivalAreaId: FOREIGN },
      ],
    });
    const result = await onEventLocationChanged(world.repos as never, {
      before,
      after: { ...before, placeId: OTHER_PLACE_ID },
      actorHumanId: EVENT_EDITOR,
      now: NOW,
    });
    expect(result).toEqual({ disabledIds: [E_PARK], removedHideIds: [P_PARK] });
    expect(world.store.get(E_PARK)?.disabledAt).toEqual(NOW);
    // The hide of an area of the NEW place stays.
    expect(world.hides).toEqual([{ eventId: EVENT_ID, arrivalAreaId: FOREIGN }]);
    expect(world.audit.map((a) => [a.entity, a.entityId, a.action])).toEqual([
      ["event", EVENT_ID, "arrival_areas.disabled_for_location_change"],
      ["event", EVENT_ID, "arrival_area_hides.removed_for_location_change"],
    ]);
    expect(world.audit[0]?.data).toMatchObject({
      actorHumanId: EVENT_EDITOR,
      arrivalAreaIds: [E_PARK],
      from: { placeId: PLACE_ID },
      to: { placeId: OTHER_PLACE_ID },
    });
  });

  it("a freeform address change switches event areas off (no hides to touch)", async () => {
    const free = { id: EVENT_ID, placeId: null, addressText: "1 Main St", lat: 36.1, lng: -86.7 };
    const world = makeWorld({ place: null, areas: [eventArea()] });
    const result = await onEventLocationChanged(world.repos as never, {
      before: free,
      after: { ...free, addressText: "9 Elm St", lat: 36.2 },
      actorHumanId: EVENT_EDITOR,
      now: NOW,
    });
    expect(result.disabledIds).toEqual([E_PARK]);
    expect(world.repos.arrivalAreas.deleteHidesForEventNotInPlace).not.toHaveBeenCalled();
  });

  it("an unrelated save changes nothing and writes no audit row", async () => {
    const world = makeWorld({
      areas: [eventArea()],
      hides: [{ eventId: EVENT_ID, arrivalAreaId: P_PARK }],
    });
    // Same place; the stored circle centre re-projected (a moved place pin
    // is the place editor's flag, not the event moving).
    const result = await onEventLocationChanged(world.repos as never, {
      before,
      after: { ...before, lat: 36.19, lng: -86.74 },
      actorHumanId: EVENT_EDITOR,
      now: NOW,
    });
    expect(result).toEqual({ disabledIds: [], removedHideIds: [] });
    expect(world.repos.arrivalAreas.setDisabledForEvent).not.toHaveBeenCalled();
    expect(world.audit).toEqual([]);
  });

  it("a change of place with nothing to switch off writes no audit row", async () => {
    const world = makeWorld({ areas: [eventArea({ disabledAt: new Date("2026-10-01") })] });
    await onEventLocationChanged(world.repos as never, {
      before,
      after: { ...before, placeId: null },
      actorHumanId: EVENT_EDITOR,
      now: NOW,
    });
    expect(world.repos.arrivalAreas.setDisabledForEvent).not.toHaveBeenCalled();
    expect(world.audit).toEqual([]);
  });

  it("eventLocationChanged: the rule", () => {
    expect(eventLocationChanged(before, { ...before })).toBe(false);
    expect(eventLocationChanged(before, { ...before, placeId: null })).toBe(true);
    expect(eventLocationChanged({ ...before, placeId: null }, { ...before, placeId: null, addressText: "x" })).toBe(true);
    expect(eventLocationChanged({ ...before, placeId: undefined }, { ...before, placeId: null })).toBe(false);
    expect(eventLocationChanged({ ...before, placeId: null }, { ...before, placeId: undefined })).toBe(false);
  });
});


// ── Review round 1 ──────────────────────────────────────────────────────────

describe("editor read: review round 1", () => {
  it("place switched to withheld after an event area was drawn: listed, geometry withheld, not measured", async () => {
    const world = makeWorld({
      areas: [
        ...placeAreas(),
        eventArea({
          geometry: squareAt(TRUE_LAT + 0.05, TRUE_LNG),
          note: "Behind the blue house",
          priceText: "$5",
        }),
      ],
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    expect(out.areas).toEqual([
      expect.objectContaining({
        id: E_PARK,
        geometry: null,
        note: null,
        priceText: null,
        geometryWithheld: true,
        outsideEnvelope: false,
      }),
    ]);
    expect(JSON.stringify(out)).not.toMatch(/36\.2|86\.72/);
  });

  it("an editor of an OBSCURED event at a place that PUBLISHES its address sees its public areas, not its LOAD_IN", async () => {
    const world = makeWorld({
      place: EXACT_PLACE(),
      event: makeEvent({ locationMode: "OBSCURED" }),
      areas: [...placeAreas(), eventArea()],
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.placeAreas.map((a) => a.id)).toEqual([P_PARK, P_DROP]);
    expect(out.areas[0]).toMatchObject({ geometryWithheld: false });
  });
});

describe("resolveEventAreaAccess with precomputed staff", () => {
  it("drops placeStaff probed for another place (fail closed)", async () => {
    const event = makeEvent();
    const place = makePlace();
    const deps = {
      repos: {
        eventHumans: { listByEvent: async () => [] },
        tickets: { viewerHoldsActiveTicketForEvent: async () => false },
        eventRsvps: { existsForUser: async () => false },
        eventDateRsvps: { existsForUserOnEvent: async () => false },
      },
    } as never;
    const base = { event, place, viewerHumanId: BOTH, gateAccessGranted: true, now: NOW };
    const same = await resolveEventAreaAccess(deps, {
      ...base,
      precomputedStaff: { placeId: PLACE_ID, placeStaff: true, eventStaff: true },
    });
    expect(same).toMatchObject({ placeStaff: true, addressVisible: true });
    const other = await resolveEventAreaAccess(deps, {
      ...base,
      precomputedStaff: { placeId: OTHER_PLACE_ID, placeStaff: true, eventStaff: true },
    });
    expect(other).toMatchObject({ placeStaff: false, addressVisible: false });
  });
});

// ── FR-008: the editor's pin, and a moderator at a withheld place ──────────

describe("editor read: the measuring pin, and a moderator at a WITHHELD place (option A)", () => {
  const TRUE_PIN = { lat: TRUE_LAT, lng: TRUE_LNG };
  const withNotes = () =>
    placeAreas().map((row) => ({ ...row, note: "Behind the blue house", priceText: "$5" }));

  it("a moderator at a WITHHELD unowned place: every row listed, geometry / note / price withheld, not measured, no pin", async () => {
    const world = makeWorld({ unowned: true, areas: withNotes() });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: MODERATOR,
      placeId: PLACE_ID,
    });
    if (out.parent !== "place") throw new Error("expected a place list");
    expect(out.editorKind).toBe("community_moderator");
    expect(out.pin).toBeNull();
    expect(out.addressWithheld).toBe(true);
    expect(out.areas.map((a) => a.id)).toEqual([P_PARK, P_DROP, P_LOAD]);
    for (const area of out.areas) {
      expect(area).toMatchObject({
        geometry: null,
        geometryWithheld: true,
        note: null,
        priceText: null,
        outsideEnvelope: false,
      });
    }
    expect(JSON.stringify(out)).not.toContain("blue house");
    expect(JSON.stringify(out)).not.toMatch(/36\.18|86\.72/);
  });

  it("the place's owner at the same OBSCURED place: the true pin and full rows", async () => {
    const world = makeWorld({ areas: withNotes() });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
    });
    if (out.parent !== "place") throw new Error("expected a place list");
    expect(out.editorKind).toBe("owner");
    expect(out.pin).toEqual(TRUE_PIN);
    expect(out.addressWithheld).toBe(false);
    expect(out.areas.every((a) => a.geometryWithheld === false && a.geometry !== null)).toBe(true);
    expect(out.areas[0]?.note).toBe("Behind the blue house");
  });

  it("a moderator at a place that PUBLISHES its address is unchanged: the true pin and full rows", async () => {
    const world = makeWorld({
      unowned: true,
      place: makePlace({ orgIdsWithAccess: [], locationMode: "EXACT", locationRadiusMeters: null }),
      areas: withNotes(),
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: MODERATOR,
      placeId: PLACE_ID,
    });
    if (out.parent !== "place") throw new Error("expected a place list");
    expect(out.pin).toEqual(TRUE_PIN);
    expect(out.addressWithheld).toBe(false);
    expect(out.areas.every((a) => a.geometryWithheld === false && a.geometry !== null)).toBe(true);
    expect(out.areas[0]?.note).toBe("Behind the blue house");
  });

  it("a place with no coordinates answers pin null for its owner, NOT addressWithheld (set the address first)", async () => {
    const world = makeWorld({ place: makePlace({ lat: null, lng: null } as never), areas: placeAreas() });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: PLACE_MANAGER,
      placeId: PLACE_ID,
    });
    if (out.parent !== "place") throw new Error("expected a place list");
    expect(out.pin).toBeNull();
    expect(out.addressWithheld).toBe(false);
  });

  it("event: an editor who cannot see a withheld place's address gets no pin (NO_PIN)", async () => {
    const world = makeWorld({ areas: [eventArea()] });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.pin).toBeNull();
    expect(out.addressWithheld).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/36\.18|86\.72/);
  });

  it("event: the place's manager editing it gets the true pin", async () => {
    const world = makeWorld({ areas: [eventArea()] });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: BOTH,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.pin).toEqual(TRUE_PIN);
    expect(out.addressWithheld).toBe(false);
  });

  it("event: an editor of an OBSCURED event at a place that PUBLISHES its address gets the true pin", async () => {
    const world = makeWorld({
      place: EXACT_PLACE(),
      event: makeEvent({ locationMode: "OBSCURED" }),
      areas: [eventArea()],
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.pin).toEqual(TRUE_PIN);
  });

  it("event at a freeform address: its editor's own pin", async () => {
    const own = { lat: TRUE_LAT + 0.01, lng: TRUE_LNG + 0.01 };
    const world = makeWorld({
      place: null,
      event: makeEvent({ placeId: null, ...own }),
      areas: [eventArea()],
    });
    const out = await listArrivalAreasForEditor(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
    });
    if (out.parent !== "event") throw new Error("expected an event list");
    expect(out.pin).toEqual(own);
    expect(out.addressWithheld).toBe(false);
  });

  it("setEventArrivalAreaHidden answers with the same pin", async () => {
    const world = makeWorld({
      place: EXACT_PLACE(),
      event: EXACT_EVENT(),
      areas: [...placeAreas(), eventArea()],
    });
    const out = await setEventArrivalAreaHidden(world.deps, {
      actorHumanId: EVENT_EDITOR,
      eventId: EVENT_ID,
      arrivalAreaId: P_PARK,
      hidden: true,
    });
    expect(out.pin).toEqual(TRUE_PIN);
    expect(out.addressWithheld).toBe(false);
  });
});
