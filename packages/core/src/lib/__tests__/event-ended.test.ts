import { describe, expect, it } from "vitest";

import { eventEndedAt, isEventPast } from "../event-ended";

const STARTS = new Date("2026-10-01T19:00:00.000Z");
const ENDS = new Date("2026-10-01T23:00:00.000Z");

describe("isEventPast", () => {
  it("is not past before the end, even after the start", () => {
    const event = { startsAt: STARTS, endsAt: ENDS };
    expect(isEventPast(event, new Date("2026-10-01T18:59:59.999Z"))).toBe(false);
    expect(isEventPast(event, new Date("2026-10-01T21:00:00.000Z"))).toBe(false);
    expect(isEventPast(event, new Date(ENDS.getTime() - 1))).toBe(false);
  });

  it("is past at the end instant and after it", () => {
    const event = { startsAt: STARTS, endsAt: ENDS };
    expect(isEventPast(event, ENDS)).toBe(true);
    expect(isEventPast(event, new Date(ENDS.getTime() + 1))).toBe(true);
  });

  it("uses the start when the event has no end", () => {
    const event = { startsAt: STARTS, endsAt: null };
    expect(eventEndedAt(event)).toBe(STARTS);
    expect(isEventPast(event, new Date(STARTS.getTime() - 1))).toBe(false);
    expect(isEventPast(event, STARTS)).toBe(true);
  });
});
