import { describe, expect, it } from "vitest";

import { isProvenEventFirstRow } from "../request-origin";

/** FR-011: the thread's venue confirmation is for event-first requests only. */
describe("isProvenEventFirstRow", () => {
  it("is true when the summary says the request was built from an event", () => {
    expect(isProvenEventFirstRow({ builtFromEvent: true })).toBe(true);
  });

  it("is false for a request that was not built from an event", () => {
    expect(isProvenEventFirstRow({ builtFromEvent: false })).toBe(false);
  });
});
