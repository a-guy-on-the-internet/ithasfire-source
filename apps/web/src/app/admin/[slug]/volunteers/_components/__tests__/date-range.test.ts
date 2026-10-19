import { describe, expect, it } from "vitest";

import { dateInputToLocalDate, inclusiveEndToExclusive } from "../date-range";

describe("dateInputToLocalDate", () => {
  it("parses YYYY-MM-DD into local midnight", () => {
    const d = dateInputToLocalDate("2026-06-10");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(10);
    expect(d!.getHours()).toBe(0);
    expect(d!.getMinutes()).toBe(0);
  });

  it("returns null for empty input", () => {
    expect(dateInputToLocalDate("")).toBeNull();
  });

  it("returns null for partial/invalid input", () => {
    expect(dateInputToLocalDate("2026-06")).toBeNull();
    expect(dateInputToLocalDate("not-a-date")).toBeNull();
    expect(dateInputToLocalDate("2026-06-10T12:00:00")).toBeNull();
  });
});

describe("inclusiveEndToExclusive", () => {
  it("returns local midnight of the next day so the picked day stays in range", () => {
    const picked = dateInputToLocalDate("2026-06-10")!;
    const exclusive = inclusiveEndToExclusive(picked);
    expect(exclusive.getFullYear()).toBe(2026);
    expect(exclusive.getMonth()).toBe(5);
    expect(exclusive.getDate()).toBe(11);
    expect(exclusive.getHours()).toBe(0);
  });

  it("normalizes month overflow", () => {
    const picked = dateInputToLocalDate("2026-01-31")!;
    const exclusive = inclusiveEndToExclusive(picked);
    expect(exclusive.getMonth()).toBe(1); // February
    expect(exclusive.getDate()).toBe(1);
  });

  it("normalizes year overflow", () => {
    const picked = dateInputToLocalDate("2026-12-31")!;
    const exclusive = inclusiveEndToExclusive(picked);
    expect(exclusive.getFullYear()).toBe(2027);
    expect(exclusive.getMonth()).toBe(0);
    expect(exclusive.getDate()).toBe(1);
  });
});
