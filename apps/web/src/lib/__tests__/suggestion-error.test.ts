import { describe, expect, it } from "vitest";

import { SUGGESTION_REJECTION_REASONS } from "@th/core/use-cases/community/_shared/suggestion-rejection";

import {
  SUGGESTION_REASON_MESSAGE_KEYS,
  getInvalidFieldsMeta,
  suggestionReasonMessageKey,
} from "../suggestion-error";

describe("SUGGESTION_REASON_MESSAGE_KEYS", () => {
  it("has a message key for EVERY core rejection reason (exhaustive)", () => {
    // The map is typed `Record<SuggestionRejectionReason, string>`, so a missing
    // reason is a COMPILE error. This runtime check is a belt-and-braces guard
    // that the tuple and the map stay in lockstep.
    for (const reason of SUGGESTION_REJECTION_REASONS) {
      expect(SUGGESTION_REASON_MESSAGE_KEYS[reason]).toBeTruthy();
    }
    expect(Object.keys(SUGGESTION_REASON_MESSAGE_KEYS).sort()).toEqual(
      [...SUGGESTION_REJECTION_REASONS].sort(),
    );
  });
});

describe("suggestionReasonMessageKey", () => {
  it("maps a known reason to its specific key", () => {
    expect(suggestionReasonMessageKey("blocked_content")).toBe(
      "suggestEdit.errBlockedContent",
    );
    expect(suggestionReasonMessageKey("empty_diff")).toBe(
      "suggestEdit.errEmptyDiff",
    );
  });

  it("falls back to the neutral message for an unknown / missing reason", () => {
    expect(suggestionReasonMessageKey("totally_new_wire_reason")).toBe(
      "errors.editSuggestionInvalidFields",
    );
    expect(suggestionReasonMessageKey(undefined)).toBe(
      "errors.editSuggestionInvalidFields",
    );
    expect(suggestionReasonMessageKey(null)).toBe(
      "errors.editSuggestionInvalidFields",
    );
  });
});

describe("getInvalidFieldsMeta", () => {
  it("reads reason + fields + term off a tRPC-shaped error", () => {
    const error = {
      data: {
        meta: {
          reason: "blocked_content",
          fields: ["title", "content"],
          term: "slurword",
        },
      },
    };
    expect(getInvalidFieldsMeta(error)).toEqual({
      reason: "blocked_content",
      fields: ["title", "content"],
      term: "slurword",
    });
  });

  it("filters non-string field entries and drops an empty fields array", () => {
    const error = {
      data: { meta: { reason: "empty_diff", fields: [1, "content", null] } },
    };
    expect(getInvalidFieldsMeta(error)).toEqual({
      reason: "empty_diff",
      fields: ["content"],
    });

    const emptyFields = { data: { meta: { reason: "empty_diff", fields: [] } } };
    expect(getInvalidFieldsMeta(emptyFields)).toEqual({ reason: "empty_diff" });
  });

  it("returns null when there is no usable meta", () => {
    expect(getInvalidFieldsMeta(null)).toBeNull();
    expect(getInvalidFieldsMeta({})).toBeNull();
    expect(getInvalidFieldsMeta({ data: {} })).toBeNull();
    expect(getInvalidFieldsMeta({ data: { meta: {} } })).toBeNull();
    expect(getInvalidFieldsMeta({ data: { meta: "nope" } })).toBeNull();
  });
});
