import { describe, expect, it } from "vitest";

import { isAppError } from "@th/errors";

import {
  SUGGESTION_REJECTION_REASONS,
  suggestionRejection,
  type SuggestionRejectionReason,
} from "../_shared/suggestion-rejection";

/**
 * The reason set is the single source of truth for `EDIT_SUGGESTION_INVALID_FIELDS`
 * discriminators. This spec is a deliberate tripwire: adding or removing a
 * throw-site reason must update BOTH the tuple and this expected list (and, via
 * the exhaustive `Record<SuggestionRejectionReason, string>` client map, the
 * web message table won't compile until it's mapped too).
 */
const EXPECTED_REASONS: SuggestionRejectionReason[] = [
  "not_an_object",
  "unsupported_fields",
  "lat_lng_must_pair",
  "empty_diff",
  "invalid_body",
  "blocked_content",
  "ends_before_starts",
  "not_an_event_image",
  "upload_not_finalized",
  "unattached_not_own_upload",
  "stored_fields_revalidation_failed",
];

describe("suggestion rejection reasons", () => {
  it("covers exactly the canonical reason set with no duplicates", () => {
    expect([...SUGGESTION_REJECTION_REASONS].sort()).toEqual(
      [...EXPECTED_REASONS].sort(),
    );
    expect(new Set(SUGGESTION_REJECTION_REASONS).size).toBe(
      SUGGESTION_REJECTION_REASONS.length,
    );
  });

  it("builds an AppError carrying the code + reason (no fields when omitted)", () => {
    let thrown: unknown;
    try {
      suggestionRejection("empty_diff");
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "empty_diff" },
    });
    // No `fields` key at all when none are provided.
    expect((thrown as { meta: Record<string, unknown> }).meta.fields).toBeUndefined();
  });

  it("includes fields + term + cause when provided", () => {
    const cause = new Error("boom");
    let thrown: unknown;
    try {
      suggestionRejection("blocked_content", ["title", "content"], {
        term: "slurword",
        cause,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "blocked_content", fields: ["title", "content"], term: "slurword" },
    });
    expect((thrown as { cause: unknown }).cause).toBe(cause);
  });

  it("drops an empty fields array (no `fields` key)", () => {
    let thrown: unknown;
    try {
      suggestionRejection("ends_before_starts", []);
    } catch (error) {
      thrown = error;
    }
    expect(
      (thrown as { meta: Record<string, unknown> }).meta.fields,
    ).toBeUndefined();
  });
});
