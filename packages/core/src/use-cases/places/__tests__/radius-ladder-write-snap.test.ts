import { describe, expect, it } from "vitest";

import { OBFUSCATION_RADIUS_LADDER_METERS } from "../../../lib/location/obfuscation-radius-ladder";
import { baseSaveEventInputSchema } from "../../events/_shared/save-event-shared";
import { upsertPlaceInputSchema } from "../upsert-place";

/**
 * SNAP ON WRITE (M2): a radius reaches storage only as a ladder rung. Any
 * integer 100..50,000 was reachable through the API, and every distinct
 * radius an owner saved was one more circle — one more sample of the house.
 * The bounds are unchanged; an accepted value is snapped UP (never down).
 */
const fields = [
  ["upsertPlace", upsertPlaceInputSchema.shape.locationRadiusMeters],
  ["event save", baseSaveEventInputSchema.shape.locationRadiusMeters],
] as const;

describe.each(fields)("%s — locationRadiusMeters", (_name, field) => {
  it("snaps an off-ladder radius UP to the next rung", () => {
    expect(field.parse(120)).toBe(250);
    expect(field.parse(501)).toBe(1_000);
    expect(field.parse(1_250)).toBe(2_000);
    expect(field.parse(10_001)).toBe(20_000);
    expect(field.parse(49_999)).toBe(50_000);
  });

  it("leaves every rung as it is", () => {
    for (const rung of OBFUSCATION_RADIUS_LADDER_METERS) {
      expect(field.parse(rung)).toBe(rung);
    }
  });

  it("keeps null (= fully hidden) and still rejects out-of-range values", () => {
    expect(field.parse(null)).toBeNull();
    expect(field.safeParse(99).success).toBe(false);
    expect(field.safeParse(50_001).success).toBe(false);
    expect(field.safeParse(150.5).success).toBe(false);
  });
});

describe("event save specifics", () => {
  const field = baseSaveEventInputSchema.shape.locationRadiusMeters;
  it("keeps its 500 m default (a rung) and coerces numeric strings before snapping", () => {
    expect(field.parse(undefined)).toBe(500);
    expect(field.parse("120")).toBe(250);
  });
});
