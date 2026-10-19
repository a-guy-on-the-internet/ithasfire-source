import { describe, expect, it } from "vitest";

import { holdActLabel, indexHoldsByDay, liveCalendarHolds } from "../event-calendar-holds";
import type { CalendarHold } from "../event-calendar-types";

const hold = (over: Partial<CalendarHold> = {}): CalendarHold => ({
  id: "h",
  bookingRequestId: "r",
  calendarId: "c",
  spaceId: null,
  date: "2026-10-13",
  position: 1,
  status: "ACTIVE",
  respondBy: null,
  lapsed: false,
  actName: "The Act",
  performerDisplayName: null,
  ...over,
});

describe("event-calendar-holds", () => {
  it("keeps live holds only, in line order", () => {
    const rows = [
      hold({ id: "b", position: 2 }),
      hold({ id: "gone", status: "RELEASED" }),
      hold({ id: "done", status: "CONFIRMED" }),
      hold({ id: "lapsed", status: "CHALLENGED", lapsed: true }),
      hold({ id: "a", position: 1, status: "CHALLENGED" }),
    ];
    expect(liveCalendarHolds(rows).map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("groups by date and never mixes days", () => {
    const index = indexHoldsByDay([
      hold({ id: "x", date: "2026-10-13", position: 2 }),
      hold({ id: "y", date: "2026-10-14", position: 1 }),
      hold({ id: "z", date: "2026-10-13", position: 1 }),
    ]);
    expect(index.get("2026-10-13")?.map((h) => h.id)).toEqual(["z", "x"]);
    expect(index.get("2026-10-14")?.map((h) => h.id)).toEqual(["y"]);
    expect(index.get("2026-10-15")).toBeUndefined();
  });
});

describe("holdActLabel", () => {
  it("shows a pitched act name, and treats blank as absent", () => {
    expect(holdActLabel(hold({ actName: "The Act" }))).toBe("The Act");
    expect(holdActLabel(hold({ actName: "  The Act " }))).toBe("The Act");
    expect(holdActLabel(hold({ actName: null }))).toBeNull();
    expect(holdActLabel(hold({ actName: "" }))).toBeNull();
    expect(holdActLabel(hold({ actName: "   " }))).toBeNull();
  });

  it("falls back to the resolved performer display name when the act name is blank", () => {
    expect(holdActLabel(hold({ actName: null, performerDisplayName: "Willa" }))).toBe("Willa");
    expect(holdActLabel(hold({ actName: "  ", performerDisplayName: " Willa " }))).toBe("Willa");
    expect(holdActLabel(hold({ actName: "The Act", performerDisplayName: "Willa" }))).toBe("The Act");
    expect(holdActLabel(hold({ actName: null, performerDisplayName: "   " }))).toBeNull();
    expect(holdActLabel(hold({ actName: null, performerDisplayName: null }))).toBeNull();
  });
});
