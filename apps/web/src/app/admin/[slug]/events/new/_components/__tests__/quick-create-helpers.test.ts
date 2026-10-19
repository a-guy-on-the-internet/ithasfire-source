import { describe, expect, it } from "vitest";

import {
  QUICK_CREATE_DEFAULT_DURATION_MS,
  buildQuickCreateLocationPayload,
  buildQuickCreateSaveInput,
  hasQuickCreateVenue,
  resolveQuickCreatePlacement,
  validateQuickCreate,
} from "../quick-create-helpers";

describe("hasQuickCreateVenue", () => {
  it("accepts a linked Place", () => {
    expect(hasQuickCreateVenue({ thPlaceId: "place-1" })).toBe(true);
  });

  it("accepts a fully geocoded freeform address", () => {
    expect(
      hasQuickCreateVenue({
        addressText: "123 Main St",
        lat: 36.16,
        lng: -86.78,
      }),
    ).toBe(true);
  });

  it("rejects an address without coordinates (mirrors what the save persists)", () => {
    expect(hasQuickCreateVenue({ addressText: "123 Main St" })).toBe(false);
    expect(hasQuickCreateVenue({})).toBe(false);
  });
});

describe("validateQuickCreate", () => {
  it("returns no errors when all three fields are present", () => {
    expect(
      validateQuickCreate({
        title: "Warehouse Show",
        startsAt: "2026-08-01T20:00",
        location: { thPlaceId: "place-1" },
      }),
    ).toEqual({});
  });

  it("flags the missing title and start, and NOT the missing venue", () => {
    // Owner ruling 2026-09-08: the venue is optional at quick-create. The
    // picker here only lists owned venues, so a third party names someone
    // else's venue in the full builder.
    expect(
      validateQuickCreate({
        title: "   ",
        startsAt: undefined,
        location: {},
      }),
    ).toEqual({
      title: "required",
      startsAt: "required",
    });
  });

  it("accepts title + start with no venue at all", () => {
    expect(
      validateQuickCreate({
        title: "Warehouse Show",
        startsAt: "2026-08-01T20:00",
        location: {},
        addressSearch: "",
      }),
    ).toEqual({});
  });

  it("flags an address that was typed but never picked from the suggestions", () => {
    // Typed text with no coordinates behind it would be dropped by the save
    // (`{}` goes over the wire) — the one venue state worth stopping on.
    expect(
      validateQuickCreate({
        title: "Warehouse Show",
        startsAt: "2026-08-01T20:00",
        location: {},
        addressSearch: "123 Main St",
      }),
    ).toEqual({ venue: "unresolved" });
    // Whitespace is not a typed address.
    expect(
      validateQuickCreate({
        title: "Warehouse Show",
        startsAt: "2026-08-01T20:00",
        location: {},
        addressSearch: "   ",
      }),
    ).toEqual({});
  });

  it("flags coordinates that never got an address (\"use my location\" mid-flight or geocoder empty)", () => {
    // handleUseMyLocation writes lat/lng first; addressText lands only when
    // the reverse geocode answers. Shipping this as `{}` would drop the
    // coordinates the organiser just asked for.
    expect(
      validateQuickCreate({
        title: "Warehouse Show",
        startsAt: "2026-08-01T20:00",
        location: { lat: 36.16, lng: -86.78 },
        addressSearch: "",
      }),
    ).toEqual({ venue: "unresolved" });
    // Once the address lands it is a whole venue again.
    expect(
      validateQuickCreate({
        title: "Warehouse Show",
        startsAt: "2026-08-01T20:00",
        location: { lat: 36.16, lng: -86.78, addressText: "123 Main St" },
        addressSearch: "123 Main St",
      }),
    ).toEqual({});
  });

  it("does not flag search text once a geocoded address stands behind it", () => {
    expect(
      validateQuickCreate({
        title: "Warehouse Show",
        startsAt: "2026-08-01T20:00",
        location: { addressText: "123 Main St", lat: 36.16, lng: -86.78 },
        addressSearch: "123 Main St",
      }),
    ).toEqual({});
  });
});

describe("buildQuickCreateLocationPayload", () => {
  it("sends only the Place UUID for a linked Place", () => {
    expect(
      buildQuickCreateLocationPayload({
        thPlaceId: "place-1",
        thPlaceName: "The Basement",
        addressText: "1604 8th Ave S",
        lat: 36.13,
        lng: -86.77,
      }),
    ).toEqual({ placeId: "place-1" });
  });

  it("sends `{}` — the wire's \"no location\" — when nothing was chosen", () => {
    expect(buildQuickCreateLocationPayload({})).toEqual({});
    // Typed-but-unpicked text never reaches the payload either (the form
    // stops on it first; this pins that the payload builder does not guess).
    expect(buildQuickCreateLocationPayload({ addressText: "123 Main St" })).toEqual(
      {},
    );
  });

  it("sends the geocoded freeform fields, optional ones only when present", () => {
    expect(
      buildQuickCreateLocationPayload({
        addressText: "123 Main St",
        lat: 36.16,
        lng: -86.78,
        locality: "Nashville",
        region: "TN",
      }),
    ).toEqual({
      addressText: "123 Main St",
      lat: 36.16,
      lng: -86.78,
      locality: "Nashville",
      region: "TN",
    });
  });
});

// The two ids the calendar cell carries (venue-hierarchy FR-011).
const PREFILLED_PLACE = "11111111-1111-4111-8111-111111111111";
const OTHER_PLACE = "22222222-2222-4222-8222-222222222222";
const CELL_CALENDAR = "33333333-3333-4333-8333-333333333333";
const CELL_SPACE = "44444444-4444-4444-8444-444444444444";

const CELL_PREFILL = {
  startsAt: "2026-08-01T20:00",
  placeId: PREFILLED_PLACE,
  calendarId: CELL_CALENDAR,
  spaceId: CELL_SPACE,
};

describe("resolveQuickCreatePlacement", () => {
  it("carries calendarId + spaceId while the venue is still the prefilled place", () => {
    expect(
      resolveQuickCreatePlacement({
        prefill: CELL_PREFILL,
        location: { thPlaceId: PREFILLED_PLACE },
      }),
    ).toEqual({ calendarId: CELL_CALENDAR, spaceId: CELL_SPACE });
  });

  it("DROPS the placement when the organiser picks a different venue", () => {
    // The carried Calendar/Space belong to the OLD venue; sending them would be
    // a guaranteed CALENDAR_NOT_FOUND / SPACE_NOT_FOUND from the save path.
    expect(
      resolveQuickCreatePlacement({
        prefill: CELL_PREFILL,
        location: { thPlaceId: OTHER_PLACE },
      }),
    ).toEqual({});
  });

  it("DROPS the placement when the organiser switches to a freeform address", () => {
    expect(
      resolveQuickCreatePlacement({
        prefill: CELL_PREFILL,
        location: { addressText: "123 Main St", lat: 36.16, lng: -86.78 },
      }),
    ).toEqual({});
  });

  it("DROPS the placement when the venue was cleared entirely", () => {
    expect(
      resolveQuickCreatePlacement({
        prefill: CELL_PREFILL,
        location: {},
      }),
    ).toEqual({});
  });

  it("ignores a hand-edited calendarId that arrives without a placeId", () => {
    expect(
      resolveQuickCreatePlacement({
        prefill: { calendarId: CELL_CALENDAR, spaceId: CELL_SPACE },
        location: { thPlaceId: PREFILLED_PLACE },
      }),
    ).toEqual({});
  });

  it("sends the calendar alone when the cell carried no space", () => {
    expect(
      resolveQuickCreatePlacement({
        prefill: { placeId: PREFILLED_PLACE, calendarId: CELL_CALENDAR },
        location: { thPlaceId: PREFILLED_PLACE },
      }),
    ).toEqual({ calendarId: CELL_CALENDAR });
  });

  it("is empty for a plain visit with no prefill at all", () => {
    expect(
      resolveQuickCreatePlacement({
        prefill: {},
        location: { thPlaceId: PREFILLED_PLACE },
      }),
    ).toEqual({});
  });
});

describe("buildQuickCreateSaveInput", () => {
  it("builds the exact minimal draft payload the builder's create path would save", () => {
    const input = buildQuickCreateSaveInput({
      title: "  Warehouse Show  ",
      // Wall-clock in the event timezone (CDT = UTC-5 on this date).
      startsAtLocal: "2026-08-01T20:00",
      timezone: "America/Chicago",
      location: { thPlaceId: "place-1" },
      clientKey: "client-key-123",
    });

    expect(input).toEqual({
      title: "Warehouse Show",
      startsAt: "2026-08-02T01:00:00.000Z",
      endsAt: "2026-08-02T03:00:00.000Z",
      location: { placeId: "place-1" },
      timezone: "America/Chicago",
      content: { layoutId: "default", blocks: [] },
      clientKey: "client-key-123",
    });
    // No visibility fields: server defaults apply (locationMode EXACT with
    // immediate reveal — FR-103's new-event default).
    expect("locationMode" in input).toBe(false);
    expect("addressRevealAt" in input).toBe(false);
  });

  it("builds a venue-less draft with `location: {}` and no placement keys", () => {
    const input = buildQuickCreateSaveInput({
      title: "Warehouse Show",
      startsAtLocal: "2026-08-01T20:00",
      timezone: "America/Chicago",
      location: {},
      clientKey: "client-key-123",
    });
    expect(input.location).toEqual({});
    expect("calendarId" in input).toBe(false);
    expect("spaceId" in input).toBe(false);
    // The browser zone the form fell back to is what the wall clock is
    // interpreted in — there is no venue to adopt one from.
    expect(input.startsAt).toBe("2026-08-02T01:00:00.000Z");
  });

  it("ends 2 hours after start (the old imperative-draft default)", () => {
    const input = buildQuickCreateSaveInput({
      title: "Show",
      startsAtLocal: "2026-12-01T19:30",
      timezone: "UTC",
      location: { addressText: "A", lat: 1, lng: 2 },
      clientKey: "k".repeat(12),
    });
    expect(
      new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime(),
    ).toBe(QUICK_CREATE_DEFAULT_DURATION_MS);
  });

  it("resolves a wall clock on the far side of a DST transition correctly", () => {
    // Blast-radius pin for the `toIsoInTimeZone` DST fix: quick-create is one
    // of ~8 call sites that turn an organizer's wall clock into the stored
    // instant, and it used to inherit the single-probe error. 03:30 on
    // 2026-11-01 in Chicago is CST (UTC-6) — the clocks went back at 02:00 —
    // so it is 09:30Z, not 08:30Z. See
    // `event-builder-helpers.dst.test.ts` for the full matrix.
    const input = buildQuickCreateSaveInput({
      title: "After-hours",
      startsAtLocal: "2026-11-01T03:30",
      timezone: "America/Chicago",
      location: { thPlaceId: "place-1" },
      clientKey: "client-key-123",
    });
    expect(input.startsAt).toBe("2026-11-01T09:30:00.000Z");
    expect(input.endsAt).toBe("2026-11-01T11:30:00.000Z");
  });

  it("includes the cell's placement when the venue still matches the prefill", () => {
    const input = buildQuickCreateSaveInput({
      title: "Show",
      startsAtLocal: "2026-08-01T20:00",
      timezone: "America/Chicago",
      location: { thPlaceId: PREFILLED_PLACE },
      clientKey: "client-key-123",
      prefill: CELL_PREFILL,
    });
    expect(input).toMatchObject({
      location: { placeId: PREFILLED_PLACE },
      calendarId: CELL_CALENDAR,
      spaceId: CELL_SPACE,
    });
  });

  it("sends NO placement keys once the venue was changed away from the prefill", () => {
    const input = buildQuickCreateSaveInput({
      title: "Show",
      startsAtLocal: "2026-08-01T20:00",
      timezone: "America/Chicago",
      location: { thPlaceId: OTHER_PLACE },
      clientKey: "client-key-123",
      prefill: CELL_PREFILL,
    });
    // Absent, not null: the save path treats null as an explicit clear.
    expect("calendarId" in input).toBe(false);
    expect("spaceId" in input).toBe(false);
    expect(input.location).toEqual({ placeId: OTHER_PLACE });
  });

  it("omits the placement keys entirely when there is no prefill", () => {
    const input = buildQuickCreateSaveInput({
      title: "Show",
      startsAtLocal: "2026-08-01T20:00",
      timezone: "America/Chicago",
      location: { thPlaceId: PREFILLED_PLACE },
      clientKey: "client-key-123",
    });
    expect("calendarId" in input).toBe(false);
    expect("spaceId" in input).toBe(false);
  });
});
