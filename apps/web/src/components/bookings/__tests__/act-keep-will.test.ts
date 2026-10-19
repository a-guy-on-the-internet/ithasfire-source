import { describe, expect, it } from "vitest";

import {
  actKeepView,
  isKeepChangedError,
  keepAnswerInput,
  type ActChallengeFacts,
} from "../act-keep-will";

/** What the act's Keep does, and what it sends back (FR-014, fail closed). */

const facts = (entries: [string, ActChallengeFacts][]) => new Map(entries);

describe("actKeepView", () => {
  it("waits while the read is loading, and when it failed or lacks the hold", () => {
    expect(actKeepView({ holdId: "h1", status: "loading", facts: null })).toEqual({ kind: "loading" });
    expect(actKeepView({ holdId: "h1", status: "error", facts: null })).toEqual({ kind: "unknown" });
    expect(
      actKeepView({ holdId: "h1", status: "success", facts: facts([["h2", { keepWill: "book_now", kept: false }]]) }),
    ).toEqual({ kind: "unknown" });
  });

  it("reads book_now / ask_for_terms / kept / agreed from the server's facts", () => {
    const view = (f: ActChallengeFacts) =>
      actKeepView({ holdId: "h1", status: "success", facts: facts([["h1", f]]) }).kind;
    expect(view({ keepWill: "book_now", kept: false })).toBe("book_now");
    expect(view({ keepWill: "ask_for_terms", kept: false })).toBe("ask_for_terms");
    expect(view({ keepWill: "ask_for_terms", kept: true })).toBe("kept");
    expect(view({ keepWill: null, kept: false })).toBe("agreed");
    // Terms arrived after an ask-for-terms keep: Keep now agrees and books.
    expect(view({ keepWill: "book_now", kept: true })).toBe("book_now");
    // Agreed wins over a stale kept flag.
    expect(view({ keepWill: null, kept: true })).toBe("agreed");
  });
});

describe("keepAnswerInput", () => {
  it("sends back exactly the keepWill on screen", () => {
    expect(keepAnswerInput("h1", { kind: "book_now" })).toEqual({
      holdId: "h1",
      answer: "keep",
      expectedKeepWill: "book_now",
    });
    expect(keepAnswerInput("h1", { kind: "ask_for_terms" })?.expectedKeepWill).toBe("ask_for_terms");
  });

  it("never builds a plain keep the server would refuse", () => {
    for (const kind of ["loading", "unknown", "kept", "agreed"] as const) {
      expect(keepAnswerInput("h1", { kind })).toBeNull();
    }
  });
});

describe("isKeepChangedError", () => {
  it("matches the two 'Keep changed' refusals only", () => {
    expect(isKeepChangedError({ data: { appCode: "TERMS_CHANGED_SINCE_VIEWED" } })).toBe(true);
    expect(isKeepChangedError({ data: { appCode: "TERMS_AGREED_FOR_THIS_NIGHT" } })).toBe(true);
    expect(isKeepChangedError({ data: { appCode: "FORBIDDEN" } })).toBe(false);
    expect(isKeepChangedError(null)).toBe(false);
    expect(isKeepChangedError(new Error("x"))).toBe(false);
  });
});
