import { describe, expect, it } from "vitest";

import { resolvePresetSchedulePrefill } from "../ticket-type-preset-schedule";
import {
  TICKET_TYPE_PRESETS,
  findTicketTypePreset,
  type TicketTypePreset,
} from "../ticket-type-presets";

/**
 * FR-012 — the preset catalogue's relative sales window, materialized against
 * the event being edited.
 */

const CHICAGO = "America/Chicago";
const NOW = new Date("2026-08-12T15:00:00.000Z");

/** 2026-10-01, 20:00 America/Chicago (CDT, UTC-5). */
const OCTOBER_SHOW = new Date("2026-10-02T01:00:00.000Z");

const advance = findTicketTypePreset("advance");
const door = findTicketTypePreset("door");
const ga = findTicketTypePreset("ga");

const target = {
  eventStartsAt: OCTOBER_SHOW,
  timeZone: CHICAGO,
  now: NOW,
};

describe("preset catalogue relative fields", () => {
  it("gives Advance a close and Door an open at the SAME instant — no gap, no overlap", () => {
    // The half-open boundary (`salesCloseAt` exclusive, `salesOpenAt`
    // inclusive) is what makes this seamless. If these two ever disagree, an
    // organizer picking both presets gets either dead air or two live tiers.
    expect(advance.salesClose).toEqual({
      anchor: "EVENT_START",
      offsetMinutes: -1440,
    });
    expect(door.salesOpen).toEqual({
      anchor: "EVENT_START",
      offsetMinutes: -1440,
    });
    expect(advance.salesClose!.offsetMinutes).toBe(door.salesOpen!.offsetMinutes);
    expect(advance.salesClose!.anchor).toBe(door.salesOpen!.anchor);
  });

  it("leaves Advance without an opening bound and Door without a closing one", () => {
    expect(advance.salesOpen).toBeNull();
    expect(door.salesClose).toBeNull();
  });

  it("NFR-001 — every other preset carries no relative fields at all", () => {
    for (const preset of TICKET_TYPE_PRESETS) {
      if (preset.id === "advance" || preset.id === "door") continue;
      expect(preset.salesOpen).toBeNull();
      expect(preset.salesClose).toBeNull();
      expect(preset.scheduledPriceChange).toBeNull();
    }
  });
});

describe("resolvePresetSchedulePrefill", () => {
  it("seeds Advance with a close on the venue's clock 24h before the show", () => {
    const prefill = resolvePresetSchedulePrefill(advance, target);

    expect(prefill.salesWindow).toEqual({
      enabled: true,
      openLocal: "",
      closeLocal: "2026-09-30T20:00",
    });
    expect(prefill.schedule).toBeNull();
    expect(prefill.drops).toEqual([]);
  });

  it("seeds Door with an open at the same wall clock", () => {
    const prefill = resolvePresetSchedulePrefill(door, target);

    expect(prefill.salesWindow).toEqual({
      enabled: true,
      openLocal: "2026-09-30T20:00",
      closeLocal: "",
    });
  });

  it("resolves against the EVENT's zone, not the browser's", () => {
    const sydney = resolvePresetSchedulePrefill(advance, {
      ...target,
      timeZone: "Australia/Sydney",
    });
    // Same instant, different clock — 2026-10-01 11:00 AEST.
    expect(sydney.salesWindow?.closeLocal).toBe("2026-10-01T11:00");
  });

  it("touches nothing for a preset that carries no relative fields (NFR-001)", () => {
    expect(resolvePresetSchedulePrefill(ga, target)).toEqual({
      schedule: null,
      salesWindow: null,
      drops: [],
    });
  });

  it("REFUSES rather than degrading when the event's zone is unknown", () => {
    // The FR-007 discipline: silently resolving against UTC or the browser
    // would put the day-of cutover hours out with nothing on screen to show.
    expect(
      resolvePresetSchedulePrefill(advance, {
        ...target,
        timeZone: "Mars/Olympus_Mons",
      }),
    ).toEqual({ schedule: null, salesWindow: null, drops: [] });
    expect(
      resolvePresetSchedulePrefill(advance, { ...target, timeZone: null }),
    ).toEqual({ schedule: null, salesWindow: null, drops: [] });
  });

  it("REFUSES when the event has no usable start", () => {
    expect(
      resolvePresetSchedulePrefill(advance, {
        ...target,
        eventStartsAt: null,
      }),
    ).toEqual({ schedule: null, salesWindow: null, drops: [] });
    expect(
      resolvePresetSchedulePrefill(advance, {
        ...target,
        eventStartsAt: new Date("nonsense"),
      }),
    ).toEqual({ schedule: null, salesWindow: null, drops: [] });
  });

  it("leaves the control OFF, with a drop recorded, when the bound has already passed", () => {
    // A show two hours from now: "24 hours before" is yesterday. FR-016 says
    // never a born-unsellable tier; here nothing is written at all, so the
    // control simply doesn't pre-fill.
    const prefill = resolvePresetSchedulePrefill(advance, {
      ...target,
      eventStartsAt: new Date("2026-08-12T17:00:00.000Z"),
    });

    expect(prefill.salesWindow).toEqual({
      enabled: false,
      openLocal: "",
      closeLocal: "",
    });
    expect(prefill.drops).toEqual([
      { field: "salesWindow", reason: "already_elapsed" },
    ]);
  });

  it("DST — a day-of cutover across a fall-back keeps the elapsed-time meaning", () => {
    // 2026-11-01 20:00 America/Chicago (CST, UTC-6), the day the clocks went
    // back. 1440 minutes earlier is 2026-10-31 21:00 CDT: an hour LATER on the
    // wall clock, because those 24 hours contain 25 hours of wall time.
    // Deliberate — the offset is elapsed time, per the core resolver.
    const prefill = resolvePresetSchedulePrefill(advance, {
      ...target,
      eventStartsAt: new Date("2026-11-02T02:00:00.000Z"),
    });

    expect(prefill.salesWindow?.closeLocal).toBe("2026-10-31T21:00");
  });

  it("DST — and across a spring-forward, an hour the other way", () => {
    // 2027-03-14 20:00 America/Chicago (CDT, UTC-5). 1440 minutes earlier is
    // 2027-03-13 19:00 CST — an hour EARLIER on the wall clock.
    const prefill = resolvePresetSchedulePrefill(advance, {
      ...target,
      eventStartsAt: new Date("2027-03-15T01:00:00.000Z"),
    });

    expect(prefill.salesWindow?.closeLocal).toBe("2027-03-13T19:00");
  });

  it("materializes a relative price flip through the same path", () => {
    // No shipped preset carries one (all eight are separate-pool tiers), so
    // this exercises the field on a synthetic preset — the mechanism has to
    // work before a preset can use it.
    const flipping: TicketTypePreset = {
      ...ga,
      scheduledPriceChange: {
        at: { anchor: "EVENT_START", offsetMinutes: -10080 },
        priceDollars: "20.00",
      },
    };

    const prefill = resolvePresetSchedulePrefill(flipping, target);

    expect(prefill.schedule).toEqual({
      enabled: true,
      priceDollars: "20.00",
      // 7 days before 2026-10-01 20:00 CDT.
      atLocal: "2026-09-24T20:00",
    });
    expect(prefill.salesWindow).toBeNull();
  });

  it("drops a price flip whose amount cannot be read, rather than banking $0", () => {
    const broken: TicketTypePreset = {
      ...ga,
      scheduledPriceChange: {
        at: { anchor: "EVENT_START", offsetMinutes: -10080 },
        priceDollars: "twenty dollars",
      },
    };

    const prefill = resolvePresetSchedulePrefill(broken, target);

    expect(prefill.schedule).toEqual({
      enabled: false,
      priceDollars: "",
      atLocal: "",
    });
  });
});
