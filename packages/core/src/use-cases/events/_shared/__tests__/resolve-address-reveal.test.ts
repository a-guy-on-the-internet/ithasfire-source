import { describe, expect, it } from "vitest";

import type { EventRecord } from "@th/types";

import { resolveAddressReveal } from "../save-event-shared";

const BASE_EVENT: EventRecord = {
  id: "e0000000-0000-4000-8000-000000000000",
  orgId: null,
  humanId: "h0000000-0000-4000-8000-000000000000",
  title: "Test",
  status: "DRAFT",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "OBSCURED",
  locationRadiusMeters: 500,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2026-06-01T18:00:00.000Z"),
  endsAt: null,
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: null,
  shortId: null,
  regionCode: null,
  publishedAt: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  agreementPrimaryId: null,
  agreementResaleId: null,
  placeLayoutId: null,
  waitlistStatus: "DISABLED",
  currency: null,
};

describe("resolveAddressReveal", () => {
  const startsAt = new Date("2026-06-01T18:00:00.000Z");
  const now = new Date("2026-05-01T09:00:00.000Z");

  it("EXACT mode → silently nulls both fields regardless of input", () => {
    const out = resolveAddressReveal({
      locationMode: "EXACT",
      startsAt,
      preset: "DAY_BEFORE",
      addressRevealAt: new Date("2026-05-20T00:00:00.000Z"),
      existingEvent: null,
      now,
    });
    expect(out).toEqual({ preset: null, at: null });
  });

  it("OBSCURED + new event + no preset → defaults to DAY_BEFORE (mandatory date)", () => {
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: undefined,
      addressRevealAt: undefined,
      existingEvent: null,
      now,
    });
    expect(out.preset).toBe("DAY_BEFORE");
    expect(out.at?.toISOString()).toBe("2026-05-31T18:00:00.000Z");
  });

  it("OBSCURED + IMMEDIATELY → resolves to the save time (never null)", () => {
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: "IMMEDIATELY",
      addressRevealAt: undefined,
      existingEvent: null,
      now,
    });
    // FR-005: no 'never/immediate-null' sentinel — IMMEDIATELY anchors to now.
    expect(out.preset).toBe("IMMEDIATELY");
    expect(out.at?.toISOString()).toBe(now.toISOString());
  });

  it("OBSCURED + ONE_HOUR_BEFORE → startsAt - 1h", () => {
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: "ONE_HOUR_BEFORE",
      addressRevealAt: undefined,
      existingEvent: null,
      now,
    });
    expect(out.preset).toBe("ONE_HOUR_BEFORE");
    expect(out.at?.toISOString()).toBe("2026-06-01T17:00:00.000Z");
  });

  it("OBSCURED + WEEK_BEFORE → startsAt - 7d", () => {
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: "WEEK_BEFORE",
      addressRevealAt: undefined,
      existingEvent: null,
      now,
    });
    expect(out.preset).toBe("WEEK_BEFORE");
    expect(out.at?.toISOString()).toBe("2026-05-25T18:00:00.000Z");
  });

  it("OBSCURED + CUSTOM → uses caller-provided addressRevealAt", () => {
    const custom = new Date("2026-05-30T12:00:00.000Z");
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: "CUSTOM",
      addressRevealAt: custom,
      existingEvent: null,
      now,
    });
    expect(out).toEqual({ preset: "CUSTOM", at: custom });
  });

  it("OBSCURED + CUSTOM with no resolvable addressRevealAt → rejects (invalid_input)", () => {
    // A reveal date is mandatory for OBSCURED — CUSTOM without a date is
    // malformed input, never a silent null.
    expect(() =>
      resolveAddressReveal({
        locationMode: "OBSCURED",
        startsAt,
        preset: "CUSTOM",
        addressRevealAt: null,
        existingEvent: null,
        now,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_input" }) as Error,
    );
  });

  it("update: existing OBSCURED event with preset DAY_BEFORE + new startsAt → recomputes", () => {
    const newStart = new Date("2026-07-15T20:00:00.000Z");
    const existing: EventRecord = {
      ...BASE_EVENT,
      startsAt: new Date("2026-06-01T18:00:00.000Z"),
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date("2026-05-31T18:00:00.000Z"),
    };
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt: newStart,
      preset: undefined, // caller didn't re-send preset
      addressRevealAt: undefined,
      existingEvent: existing,
      now,
    });
    expect(out.preset).toBe("DAY_BEFORE");
    expect(out.at?.toISOString()).toBe("2026-07-14T20:00:00.000Z");
  });

  it("update: existing OBSCURED event with CUSTOM preset + no new addressRevealAt → preserves stored CUSTOM timestamp", () => {
    const storedAt = new Date("2026-05-20T00:00:00.000Z");
    const existing: EventRecord = {
      ...BASE_EVENT,
      addressRevealPreset: "CUSTOM",
      addressRevealAt: storedAt,
    };
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: undefined,
      addressRevealAt: undefined,
      existingEvent: existing,
      now,
    });
    // Reschedule without re-sending addressRevealAt → preserves the stored value.
    expect(out.preset).toBe("CUSTOM");
    expect(out.at?.toISOString()).toBe(storedAt.toISOString());
  });

  it("update: existing OBSCURED event with CUSTOM preset + explicit new addressRevealAt → overrides stored value", () => {
    const storedAt = new Date("2026-05-20T00:00:00.000Z");
    const newAt = new Date("2026-06-10T12:00:00.000Z");
    const existing: EventRecord = {
      ...BASE_EVENT,
      addressRevealPreset: "CUSTOM",
      addressRevealAt: storedAt,
    };
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: "CUSTOM",
      addressRevealAt: newAt,
      existingEvent: existing,
      now,
    });
    expect(out.preset).toBe("CUSTOM");
    expect(out.at?.toISOString()).toBe(newAt.toISOString());
  });

  it("update: legacy row with a stored reveal date but no preset → preserves the date as CUSTOM", () => {
    const storedAt = new Date("2026-05-15T00:00:00.000Z");
    const existing: EventRecord = {
      ...BASE_EVENT,
      addressRevealPreset: null,
      addressRevealAt: storedAt,
    };
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: undefined,
      addressRevealAt: undefined,
      existingEvent: existing,
      now,
    });
    expect(out.preset).toBe("CUSTOM");
    expect(out.at?.toISOString()).toBe(storedAt.toISOString());
  });

  it("update: legacy row with neither preset nor date → falls back to DAY_BEFORE (no null escape hatch)", () => {
    const existing: EventRecord = {
      ...BASE_EVENT,
      addressRevealPreset: null,
      addressRevealAt: null,
    };
    const out = resolveAddressReveal({
      locationMode: "OBSCURED",
      startsAt,
      preset: undefined,
      addressRevealAt: undefined,
      existingEvent: existing,
      now,
    });
    expect(out.preset).toBe("DAY_BEFORE");
    expect(out.at?.toISOString()).toBe("2026-05-31T18:00:00.000Z");
  });
});
