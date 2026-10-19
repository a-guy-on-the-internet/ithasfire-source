import { describe, expect, it } from "vitest";

import {
  DEFAULT_SLOT_RULES,
  crossesMidnight,
  dayStatus,
  freeGaps,
  mergeWindows,
  parseClock,
  slotStarts,
  takenRatio,
  toBusy,
  toWindow,
} from "./availability-intervals";

const W = (open: string, close: string) => toWindow(open, close)!;

describe("parseClock / toWindow", () => {
  it("reads HH:MM and rejects anything else", () => {
    expect(parseClock("18:30")).toBe(18 * 60 + 30);
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("6pm")).toBeNull();
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("18:60")).toBeNull();
  });

  it("treats a close at or before the open as running past midnight", () => {
    expect(W("18:00", "02:00")).toEqual({ start: 1080, end: 1560 });
    // Not an error, and not a zero-length window: 24 hours.
    expect(W("18:00", "18:00")).toEqual({ start: 1080, end: 2520 });
  });
});

describe("mergeWindows", () => {
  it("merges overlapping rows so a seam slot isn't offered twice", () => {
    expect(mergeWindows([W("18:00", "22:00"), W("21:00", "23:00")])).toEqual([
      { start: 1080, end: 1380 },
    ]);
  });

  it("keeps genuinely separate windows apart", () => {
    expect(mergeWindows([W("19:00", "22:00"), W("14:00", "17:00")])).toEqual([
      { start: 840, end: 1020 },
      { start: 1140, end: 1320 },
    ]);
  });
});

describe("toBusy", () => {
  const windows = [W("18:00", "23:00")];

  it("holds a changeover buffer either side of a show", () => {
    const busy = toBusy(
      [{ start: 19 * 60, end: 21 * 60, title: "The Deep Ends" }],
      windows,
    );
    expect(busy[0]).toMatchObject({ start: 18 * 60, end: 22 * 60, assumedEnd: false });
  });

  it("blocks an unknown end time through to closing, and says it assumed", () => {
    const busy = toBusy([{ start: 21 * 60, end: null, title: "Late Show" }], windows);
    expect(busy[0]!.end).toBe(23 * 60); // clipped to close, buffer can't extend past it
    expect(busy[0]!.assumedEnd).toBe(true);
  });

  it("carries a show that ends after midnight into tomorrow", () => {
    const overnight = [W("18:00", "02:00")];
    const busy = toBusy(
      [{ start: 22 * 60, end: 1 * 60, title: "Late set" }],
      overnight,
    );
    expect(busy[0]!.end).toBeGreaterThan(24 * 60);
  });

  it("returns nothing when the room is closed", () => {
    expect(toBusy([{ start: 600, end: 700 }], [])).toEqual([]);
  });
});

describe("freeGaps", () => {
  it("leaves the evening open when only the matinee is booked", () => {
    // The case that makes a day-level "booked" flag wrong.
    const windows = [W("14:00", "17:00"), W("18:00", "02:00")];
    const busy = toBusy([{ start: 14 * 60, end: 16 * 60 + 30 }], windows);
    const gaps = freeGaps(windows, busy);
    expect(gaps).toEqual([{ start: 18 * 60, end: 26 * 60 }]);
  });

  it("finds the gap between two shows when it is long enough", () => {
    const windows = [W("12:00", "23:00")];
    const busy = toBusy(
      [
        { start: 13 * 60, end: 14 * 60 },
        { start: 19 * 60, end: 21 * 60 },
      ],
      windows,
    );
    expect(freeGaps(windows, busy)).toEqual([
      { start: 15 * 60, end: 18 * 60 },
      // The tail is exactly `minSlot` long, so it counts — a gap has to be
      // SHORTER than a set to be dropped, not merely short.
      { start: 22 * 60, end: 23 * 60 },
    ]);
  });

  it("drops a gap too short for a set", () => {
    const windows = [W("18:00", "23:00")];
    const busy = toBusy([{ start: 19 * 60 + 30, end: 22 * 60 }], windows);
    // 18:00–18:30 is only 30 minutes, below the 60-minute floor.
    expect(freeGaps(windows, busy)).toEqual([]);
  });

  it("returns the whole window when nothing is booked", () => {
    const windows = [W("18:00", "23:00")];
    expect(freeGaps(windows, [])).toEqual([{ start: 1080, end: 1380 }]);
  });
});

describe("slotStarts", () => {
  it("steps through a gap and stops a full set before the end", () => {
    const slots = slotStarts([{ start: 18 * 60, end: 21 * 60 }]);
    expect(slots.map((m) => m / 60)).toEqual([18, 18.5, 19, 19.5, 20]);
  });

  it("keeps counting past midnight", () => {
    const slots = slotStarts([{ start: 23 * 60, end: 26 * 60 }]);
    expect(slots[slots.length - 1]).toBe(25 * 60);
  });

  it("offers two runs when the day has two windows", () => {
    const windows = [W("14:00", "17:00"), W("19:00", "22:00")];
    const slots = slotStarts(freeGaps(windows, []));
    expect(slots.map((m) => m / 60)).toEqual([14, 14.5, 15, 15.5, 16, 19, 19.5, 20, 20.5, 21]);
  });

  it("honours a coarser step", () => {
    const slots = slotStarts([{ start: 18 * 60, end: 21 * 60 }], {
      ...DEFAULT_SLOT_RULES,
      step: 60,
    });
    expect(slots.map((m) => m / 60)).toEqual([18, 19, 20]);
  });
});

describe("takenRatio", () => {
  it("is zero when a booking falls outside every open window", () => {
    // A 2pm screening at a room that opens at 6pm costs the evening nothing.
    const windows = [W("18:00", "23:00")];
    const busy = toBusy([{ start: 14 * 60, end: 16 * 60 }], windows);
    expect(takenRatio(windows, freeGaps(windows, busy))).toBe(0);
  });

  it("rises with how much of the night is consumed", () => {
    const windows = [W("18:00", "22:00")];
    const busy = toBusy([{ start: 19 * 60, end: 20 * 60 }], windows);
    // 18:00–21:00 held once buffered, leaving 21:00–22:00 of 4 hours.
    expect(takenRatio(windows, freeGaps(windows, busy))).toBeCloseTo(0.75, 5);
  });

  it("is zero for a closed day rather than dividing by nothing", () => {
    expect(takenRatio([], [])).toBe(0);
  });
});

describe("dayStatus", () => {
  const build = (over: Partial<Parameters<typeof dayStatus>[0]> = {}) => {
    const windows = over.windows ?? [W("18:00", "23:00")];
    const gaps = over.gaps ?? freeGaps(windows, []);
    return dayStatus({
      isPast: false,
      isBlackout: false,
      windows,
      gaps,
      slots: over.slots ?? slotStarts(gaps),
      ...over,
    });
  };

  it("ranks past above every other reason", () => {
    expect(build({ isPast: true, isBlackout: true })).toBe("past");
  });

  it("ranks a blackout above a closed weekday", () => {
    expect(build({ isBlackout: true, windows: [] })).toBe("blackout");
  });

  it("is closed when the weekday has no windows", () => {
    expect(build({ windows: [], gaps: [], slots: [] })).toBe("closed");
  });

  it("is full when nothing is left, partial when something is", () => {
    const windows = [W("18:00", "23:00")];
    const packed = toBusy([{ start: 18 * 60, end: 23 * 60 }], windows);
    const packedGaps = freeGaps(windows, packed);
    expect(
      dayStatus({
        isPast: false,
        isBlackout: false,
        windows,
        gaps: packedGaps,
        slots: slotStarts(packedGaps),
      }),
    ).toBe("full");

    const light = toBusy([{ start: 18 * 60, end: 19 * 60 }], windows);
    const lightGaps = freeGaps(windows, light);
    expect(
      dayStatus({
        isPast: false,
        isBlackout: false,
        windows,
        gaps: lightGaps,
        slots: slotStarts(lightGaps),
      }),
    ).toBe("partial");
  });

  it("is free — not partial — when a booking consumes nothing open", () => {
    const windows = [W("18:00", "23:00")];
    const outside = toBusy([{ start: 9 * 60, end: 10 * 60 }], windows);
    const gaps = freeGaps(windows, outside);
    expect(
      dayStatus({ isPast: false, isBlackout: false, windows, gaps, slots: slotStarts(gaps) }),
    ).toBe("free");
  });
});

describe("crossesMidnight", () => {
  it("flags a span whose end lands on the next date", () => {
    expect(crossesMidnight(W("18:00", "02:00"))).toBe(true);
    expect(crossesMidnight(W("18:00", "23:00"))).toBe(false);
  });
});
