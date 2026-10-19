import { describe, expect, it } from "vitest";
import { isEventNotFoundAnswer } from "../event-not-found-answer";

describe("isEventNotFoundAnswer", () => {
  it("is true for NOT_FOUND + EVENT_NOT_FOUND (data and shape.data)", () => {
    const data = { code: "NOT_FOUND", appCode: "EVENT_NOT_FOUND" };
    expect(isEventNotFoundAnswer({ data })).toBe(true);
    expect(isEventNotFoundAnswer({ shape: { data } })).toBe(true);
  });
  it("is false for everything else", () => {
    expect(isEventNotFoundAnswer({ data: { code: "NOT_FOUND" } })).toBe(false);
    expect(
      isEventNotFoundAnswer({
        data: { code: "TOO_MANY_REQUESTS", appCode: "EVENT_NOT_FOUND" },
      }),
    ).toBe(false);
    expect(
      isEventNotFoundAnswer({
        data: { code: "NOT_FOUND", appCode: "OTHER" },
      }),
    ).toBe(false);
    expect(isEventNotFoundAnswer(new TypeError("Failed to fetch"))).toBe(false);
    expect(isEventNotFoundAnswer({})).toBe(false);
    expect(isEventNotFoundAnswer(null)).toBe(false);
  });
});
