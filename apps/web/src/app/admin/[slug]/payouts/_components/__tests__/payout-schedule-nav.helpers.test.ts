import { describe, expect, it } from "vitest";

import type { PayoutSchedule } from "@th/types";
import {
  isSelectionKey,
  nextScheduleForKey,
  scheduleOptionDomId,
} from "../payout-schedule-nav.helpers";

const ORDER: readonly PayoutSchedule[] = [
  "ASAP",
  "WEEK_OF_EVENT",
  "ONE_WEEK_AFTER",
  "TWO_WEEKS_AFTER",
  "FOUR_WEEKS_AFTER",
];

describe("nextScheduleForKey", () => {
  it("moves forward on ArrowDown and ArrowRight", () => {
    expect(nextScheduleForKey("ASAP", "ArrowDown", ORDER)).toBe(
      "WEEK_OF_EVENT",
    );
    expect(nextScheduleForKey("ASAP", "ArrowRight", ORDER)).toBe(
      "WEEK_OF_EVENT",
    );
  });

  it("moves backward on ArrowUp and ArrowLeft", () => {
    expect(nextScheduleForKey("WEEK_OF_EVENT", "ArrowUp", ORDER)).toBe("ASAP");
    expect(nextScheduleForKey("WEEK_OF_EVENT", "ArrowLeft", ORDER)).toBe(
      "ASAP",
    );
  });

  it("wraps in both directions (radio groups are circular)", () => {
    expect(nextScheduleForKey("FOUR_WEEKS_AFTER", "ArrowDown", ORDER)).toBe(
      "ASAP",
    );
    expect(nextScheduleForKey("ASAP", "ArrowUp", ORDER)).toBe(
      "FOUR_WEEKS_AFTER",
    );
  });

  it("jumps to the ends on Home and End", () => {
    expect(nextScheduleForKey("ONE_WEEK_AFTER", "Home", ORDER)).toBe("ASAP");
    expect(nextScheduleForKey("ONE_WEEK_AFTER", "End", ORDER)).toBe(
      "FOUR_WEEKS_AFTER",
    );
  });

  it("returns null for keys it does not handle, so callers never swallow them", () => {
    for (const key of ["Tab", "Enter", "a", "Escape", "PageDown"]) {
      expect(nextScheduleForKey("ASAP", key, ORDER)).toBeNull();
    }
  });

  it("treats 'nothing selected yet' as before the first option", () => {
    // Pre-first-save there is no current schedule; the first arrow press must
    // still land somewhere predictable rather than doing nothing.
    expect(nextScheduleForKey(undefined, "ArrowDown", ORDER)).toBe("ASAP");
    expect(nextScheduleForKey(undefined, "ArrowUp", ORDER)).toBe(
      "FOUR_WEEKS_AFTER",
    );
  });

  it("returns null for an unknown current value or an empty order", () => {
    expect(
      nextScheduleForKey("NOT_A_SCHEDULE" as PayoutSchedule, "ArrowDown", ORDER),
    ).toBeNull();
    expect(nextScheduleForKey("ASAP", "ArrowDown", [])).toBeNull();
  });
});

describe("isSelectionKey", () => {
  it("accepts Space (both spellings) and nothing else", () => {
    expect(isSelectionKey(" ")).toBe(true);
    expect(isSelectionKey("Spacebar")).toBe(true);
    expect(isSelectionKey("Enter")).toBe(false);
    expect(isSelectionKey("ArrowDown")).toBe(false);
  });
});

describe("scheduleOptionDomId", () => {
  it("is stable and unique per option", () => {
    expect(scheduleOptionDomId("ASAP")).toBe("payout-schedule-option-ASAP");
    const ids = new Set(ORDER.map(scheduleOptionDomId));
    expect(ids.size).toBe(ORDER.length);
  });
});
