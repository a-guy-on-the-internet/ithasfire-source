/**
 * The arrival-areas editor's pure decisions (arrival-areas FR-001, FR-014,
 * FR-016, NFR-004): form checks, the create input and update patch, the
 * reorder move, the coverage check, and the copy each server refusal gets.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import type { ArrivalAreaGeometryErrorCode } from "@th/core/lib/arrival-areas/geometry";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  GEOMETRY_REASON_KEY,
  buildCreateInput,
  buildUpdatePatch,
  describeArrivalAreaError,
  draftFromArea,
  editorAreaFromRow,
  emptyFormFields,
  isDraftDirty,
  listedRowSupersedes,
  moveId,
  newDraft,
  pinInBounds,
  removeListedArea,
  reorderListedAreas,
  revalidatePlacePage,
  shapeFromDrawGeometry,
  terraDrawModeFor,
  toDisplayArea,
  upsertListedArea,
  usablePin,
  validateAreaForm,
  type ArrivalAreaMutationRow,
  type EditorArrivalArea,
} from "../arrival-areas-editor.helpers";

const PLACE_ID = "00000000-0000-4000-8000-00000000d033";

const LOT = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-122.25412345678, 37.8738],
      [-122.2538, 37.8738],
      [-122.2538, 37.8741],
      [-122.25412345678, 37.8738],
    ] as [number, number][],
  ],
};

const area = (over: Partial<EditorArrivalArea> = {}): EditorArrivalArea => ({
  id: "a1",
  source: "PLACE",
  kind: "PARKING",
  label: "Lower Hearst lot",
  cost: "PAID",
  priceText: "$10",
  note: null,
  accessibleSpots: false,
  sortOrder: 0,
  geometry: LOT,
  geometryWithheld: false,
  disabledAt: null,
  updatedAt: new Date("2026-10-18T10:00:00Z"),
  outsideEnvelope: false,
  hiddenForEvent: null,
  ...over,
});

const trpcError = (appCode: string, meta?: Record<string, unknown>) =>
  Object.assign(new Error(appCode), { data: { appCode, meta } });

function lookup(messages: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      messages,
    );
}

describe("validateAreaForm", () => {
  it("requires a label and holds the server's limits", () => {
    expect(validateAreaForm({ ...emptyFormFields(), label: "   " })).toEqual({
      label: "required",
    });
    expect(
      validateAreaForm({
        ...emptyFormFields(),
        label: "x".repeat(81),
        cost: "PAID",
        priceText: "x".repeat(41),
        note: "x".repeat(281),
      }),
    ).toEqual({ label: "tooLong", priceText: "tooLong", note: "tooLong" });
    expect(validateAreaForm({ ...emptyFormFields(), label: "x".repeat(80) })).toEqual({});
  });
});

describe("buildCreateInput", () => {
  it("trims, drops price text unless paid, and rounds coordinates to 7 places", () => {
    const input = buildCreateInput(
      { placeId: PLACE_ID },
      {
        ...emptyFormFields(),
        label: "  New lot ",
        cost: "FREE",
        priceText: "$5",
        note: "  ",
      },
      LOT,
    );
    expect(input).toMatchObject({
      placeId: PLACE_ID,
      label: "New lot",
      cost: "FREE",
      priceText: null,
      note: null,
    });
    expect(input.geometry.coordinates[0]?.[0]).toEqual([-122.2541235, 37.8738]);
  });
});

describe("buildUpdatePatch / isDraftDirty", () => {
  it("sends only the changed fields", () => {
    const draft = draftFromArea(area());
    expect(isDraftDirty(draft)).toBe(false);
    expect(buildUpdatePatch(draft)).toEqual({});
    const edited = { ...draft, fields: { ...draft.fields, label: "Upper lot", cost: "FREE" as const } };
    expect(isDraftDirty(edited)).toBe(true);
    // Leaving PAID clears the price text on the server too.
    expect(buildUpdatePatch(edited)).toEqual({
      label: "Upper lot",
      cost: "FREE",
      priceText: null,
    });
  });

  it("sends the shape only when it was redrawn", () => {
    const draft = { ...draftFromArea(area()), geometryDirty: true };
    expect(isDraftDirty(draft)).toBe(true);
    expect(buildUpdatePatch(draft).geometry?.type).toBe("Polygon");
  });

  it("a new draft is always dirty", () => {
    expect(isDraftDirty(newDraft(LOT))).toBe(true);
    expect(isDraftDirty(null)).toBe(false);
  });
});

describe("moveId", () => {
  it("moves one id and refuses a move off either end", () => {
    expect(moveId(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b", "c"], 0, -1)).toBeNull();
    expect(moveId(["a", "b", "c"], 2, 1)).toBeNull();
  });
});

describe("usablePin / pinInBounds", () => {
  it("mirrors core: finite and in range, nothing else", () => {
    expect(usablePin(37.87, -122.25)).toEqual({ lat: 37.87, lng: -122.25 });
    expect(usablePin(null, -122.25)).toBeNull();
    expect(usablePin(Number.NaN, 0)).toBeNull();
    expect(usablePin(91, 0)).toBeNull();
    expect(usablePin(0, 0)).toEqual({ lat: 0, lng: 0 });
  });

  it("checks the basemap's bounds, and assumes coverage without them", () => {
    const usa = [-125, 24, -66, 50];
    expect(pinInBounds({ lat: 37.87, lng: -122.25 }, usa)).toBe(true);
    expect(pinInBounds({ lat: 51.5, lng: -0.12 }, usa)).toBe(false);
    expect(pinInBounds({ lat: 51.5, lng: -0.12 }, undefined)).toBe(true);
  });
});

describe("shapeFromDrawGeometry", () => {
  it("accepts a one-ring polygon and a line, and nothing malformed", () => {
    expect(shapeFromDrawGeometry(LOT)?.type).toBe("Polygon");
    expect(
      shapeFromDrawGeometry({ type: "LineString", coordinates: [[0, 0], [0, 1]] })?.type,
    ).toBe("LineString");
    expect(shapeFromDrawGeometry({ type: "LineString", coordinates: [[0, 0]] })).toBeNull();
    expect(shapeFromDrawGeometry({ type: "Point", coordinates: [0, 0] })).toBeNull();
    expect(
      shapeFromDrawGeometry({ type: "LineString", coordinates: [[0, 0], [Number.NaN, 1]] }),
    ).toBeNull();
  });
});

describe("toDisplayArea", () => {
  it("does not draw a withheld shape", () => {
    expect(toDisplayArea(area({ geometryWithheld: true })).geometry).toBeNull();
    expect(toDisplayArea(area()).geometry).toEqual(LOT);
  });
});

describe("describeArrivalAreaError", () => {
  it("gives every core geometry reason its own copy, in both languages", () => {
    // Type-level: a reason core adds without a key here fails this line.
    const reasons: Record<ArrivalAreaGeometryErrorCode, true> = {
      INVALID_SHAPE: true,
      NON_FINITE: true,
      OUT_OF_RANGE: true,
      TOO_MANY_POINTS: true,
      TOO_FEW_POINTS: true,
      NOT_CLOSED: true,
      SELF_INTERSECTING: true,
      TOO_THIN: true,
      CROSSES_ANTIMERIDIAN: true,
      ZERO_LENGTH: true,
      OUTSIDE_ENVELOPE: true,
      NO_PIN: true,
    };
    for (const reason of Object.keys(reasons)) {
      const described = describeArrivalAreaError(
        trpcError("ARRIVAL_AREA_INVALID_GEOMETRY", { reason }),
      );
      expect(described.kind).toBe("geometry");
      expect(described.key).toBe(GEOMETRY_REASON_KEY[reason]);
      expect(typeof lookup(enMessages, described.key)).toBe("string");
      expect(typeof lookup(esMessages, described.key)).toBe("string");
    }
  });

  it("passes the server's numbers into the copy", () => {
    expect(
      describeArrivalAreaError(
        trpcError("ARRIVAL_AREA_INVALID_GEOMETRY", {
          reason: "TOO_MANY_POINTS",
          count: 240,
          limit: 200,
        }),
      ).values,
    ).toEqual({ count: 240, limit: 200 });
    expect(
      describeArrivalAreaError(
        trpcError("ARRIVAL_AREA_INVALID_GEOMETRY", {
          reason: "OUTSIDE_ENVELOPE",
          limitMeters: 3000,
        }),
      ).values,
    ).toEqual({ km: 3 });
  });

  it("falls back to the generic geometry copy for an unknown reason", () => {
    expect(
      describeArrivalAreaError(
        trpcError("ARRIVAL_AREA_INVALID_GEOMETRY", { reason: "SOMETHING_NEW" }),
      ).key,
    ).toBe("errors.arrivalAreaInvalidGeometry");
    expect(describeArrivalAreaError(trpcError("ARRIVAL_AREA_INVALID_GEOMETRY")).key).toBe(
      "errors.arrivalAreaInvalidGeometry",
    );
  });

  it("reads a conflict's current row, and treats a malformed one as absent", () => {
    const current = { ...area({ label: "Theirs" }), updatedAt: "2026-10-18T11:00:00.000Z" };
    const withRow = describeArrivalAreaError(trpcError("ARRIVAL_AREA_CONFLICT", { current }));
    expect(withRow.kind).toBe("conflict");
    expect(withRow.current?.label).toBe("Theirs");
    expect(withRow.current?.updatedAt).toBeInstanceOf(Date);
    expect(
      describeArrivalAreaError(trpcError("ARRIVAL_AREA_CONFLICT")).current,
    ).toBeNull();
    expect(
      describeArrivalAreaError(
        trpcError("ARRIVAL_AREA_CONFLICT", { current: { id: "a1", label: "x", updatedAt: "nope" } }),
      ).current,
    ).toBeNull();
  });

  it("maps the limit and not-found codes, and leaves the rest to the generic formatter", () => {
    expect(
      describeArrivalAreaError(trpcError("ARRIVAL_AREA_LIMIT_REACHED", { limit: 10 })),
    ).toMatchObject({ kind: "limit", values: { limit: 10 } });
    expect(describeArrivalAreaError(trpcError("ARRIVAL_AREA_NOT_FOUND")).kind).toBe("notFound");
    expect(describeArrivalAreaError(new Error("boom")).kind).toBe("other");
  });
});

describe("revalidatePlacePage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the place purge and never throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(() => revalidatePlacePage(PLACE_ID)).not.toThrow();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/places/${PLACE_ID}/revalidate`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("writing a mutation result into the listed areas", () => {
  const mutated = (over: Partial<ArrivalAreaMutationRow> = {}): ArrivalAreaMutationRow => ({
    id: "a1",
    placeId: PLACE_ID,
    kind: "PARKING",
    label: "Upper Hearst lot",
    cost: "FREE",
    priceText: null,
    note: null,
    accessibleSpots: true,
    sortOrder: 0,
    geometry: LOT,
    geometryWithheld: false,
    disabledAt: null,
    updatedAt: new Date("2026-10-18T12:00:00Z"),
    ...over,
  });

  it("keeps the listed row's editor-only fields and takes the rest from the result", () => {
    const listed = area({ outsideEnvelope: true, source: "PLACE" });
    const next = editorAreaFromRow(mutated(), listed);
    expect(next).toMatchObject({
      label: "Upper Hearst lot",
      accessibleSpots: true,
      updatedAt: new Date("2026-10-18T12:00:00Z"),
      outsideEnvelope: true,
      source: "PLACE",
    });
  });

  it("gives a new row its source from its parent, and no flags yet", () => {
    expect(editorAreaFromRow(mutated({ placeId: null }))).toMatchObject({
      source: "EVENT",
      outsideEnvelope: false,
      hiddenForEvent: null,
    });
  });

  it("appends a created row and replaces an updated one in place", () => {
    const list = [area({ id: "a1" }), area({ id: "a2", label: "Gayley Rd" })];
    expect(upsertListedArea(list, mutated({ id: "new" })).map((a) => a.id)).toEqual([
      "a1",
      "a2",
      "new",
    ]);
    const updated = upsertListedArea(list, mutated({ id: "a2", label: "Gayley east" }));
    expect(updated.map((a) => a.label)).toEqual(["Lower Hearst lot", "Gayley east"]);
    expect(list[1]!.label).toBe("Gayley Rd");
  });

  it("drops a removed row", () => {
    expect(removeListedArea([area({ id: "a1" }), area({ id: "a2" })], "a1").map((a) => a.id)).toEqual(
      ["a2"],
    );
  });

  it("orders by the returned sortOrder, whatever order the rows came in", () => {
    const list = [area({ id: "a1", outsideEnvelope: true }), area({ id: "a2" })];
    const next = reorderListedAreas(list, [
      mutated({ id: "a1", sortOrder: 1 }),
      mutated({ id: "a2", sortOrder: 0 }),
    ]);
    expect(next.map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(next[1]!.outsideEnvelope).toBe(true);
  });
});

describe("listedRowSupersedes", () => {
  const base = area({ updatedAt: new Date("2026-10-18T12:00:00Z") });

  it("replaces with a newer row", () => {
    expect(listedRowSupersedes(area({ updatedAt: new Date("2026-10-18T12:00:01Z") }), base)).toBe(
      "replace",
    );
  });

  it("ignores an older row: the pre-save list still in flight", () => {
    expect(listedRowSupersedes(area({ label: "old" }), base)).toBeNull();
  });

  it("takes only the re-measured envelope flag from a row with the same token", () => {
    expect(
      listedRowSupersedes(
        area({ updatedAt: base.updatedAt, outsideEnvelope: true }),
        base,
      ),
    ).toBe("envelope");
    expect(listedRowSupersedes(area({ updatedAt: base.updatedAt }), base)).toBeNull();
  });
});

describe("buildUpdatePatch on a withheld row", () => {
  it("never sends price text or note, which this editor cannot read", () => {
    const base = area({
      geometry: null,
      geometryWithheld: true,
      priceText: null,
      note: null,
      cost: "FREE",
    });
    const draft = draftFromArea(base);
    const patch = buildUpdatePatch({
      ...draft,
      fields: { ...draft.fields, cost: "PAID", priceText: "$5", note: "typed blind", label: "Lot B" },
    });
    expect(patch).toEqual({ cost: "PAID", label: "Lot B" });
  });
});

describe("terraDrawModeFor", () => {
  it("is render-only while not interactive, so nothing can be dragged mid-save", () => {
    expect(terraDrawModeFor("select", false)).toBe("static");
    expect(terraDrawModeFor("polygon", false)).toBe("static");
    expect(terraDrawModeFor("select", true)).toBe("select");
    expect(terraDrawModeFor("linestring", true)).toBe("linestring");
  });
});

describe("a NO_PIN refusal", () => {
  it("says the place hides its address when the list says so", () => {
    expect(
      describeArrivalAreaError(trpcError("ARRIVAL_AREA_INVALID_GEOMETRY", { reason: "NO_PIN" }), {
        addressWithheld: true,
      }).key,
    ).toBe("arrivalAreasEditor.noPinWithheld");
    expect(
      describeArrivalAreaError(trpcError("ARRIVAL_AREA_INVALID_GEOMETRY", { reason: "NO_PIN" }))
        .key,
    ).toBe("arrivalAreasEditor.noPin");
  });
});
