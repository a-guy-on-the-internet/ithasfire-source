import { describe, expect, it } from "vitest";

import { createTranslator } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  BATCH_CHUNK_SIZE,
  type BatchReviewResult,
  batchFailureKey,
  chunkIds,
  partitionBatchResults,
} from "../batch-review.helpers";

const makeIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `signup-${i}`);

describe("chunkIds", () => {
  it("returns no chunks for an empty selection", () => {
    expect(chunkIds([])).toEqual([]);
  });

  it("keeps exactly 100 ids in a single chunk", () => {
    const chunks = chunkIds(makeIds(100));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(100);
  });

  it("splits 101 ids into 100 + 1", () => {
    const chunks = chunkIds(makeIds(101));
    expect(chunks.map((c) => c.length)).toEqual([100, 1]);
    expect(chunks[1]![0]).toBe("signup-100");
  });

  it("splits 250 ids into 100 + 100 + 50, preserving order with no loss", () => {
    const ids = makeIds(250);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toEqual(ids);
  });

  it("respects an explicit chunk size", () => {
    expect(chunkIds(makeIds(5), 2).map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it("rejects a non-positive chunk size instead of looping forever", () => {
    expect(() => chunkIds(makeIds(3), 0)).toThrow();
  });

  it("defaults to the mutation's documented 100-id cap", () => {
    expect(BATCH_CHUNK_SIZE).toBe(100);
  });
});

describe("partitionBatchResults", () => {
  const ok = (id: string): BatchReviewResult => ({ id, ok: true });
  const fail = (id: string, code?: string): BatchReviewResult => ({
    id,
    ok: false,
    ...(code !== undefined ? { code } : {}),
  });

  it("treats an all-success batch as zero failures", () => {
    const { failedIds, okCount, failureById } = partitionBatchResults([
      ok("a"),
      ok("b"),
      ok("c"),
    ]);
    expect(failedIds).toEqual([]);
    expect(okCount).toBe(3);
    expect(failureById).toEqual({});
  });

  it("partitions mixed ok/fail: failed ids stay, succeeded drop out", () => {
    const { failedIds, okCount, failureById } = partitionBatchResults([
      ok("a"),
      fail("b", "SHIFT_FULL"),
      ok("c"),
      fail("d", "ROLE_FULL"),
    ]);
    // Set arithmetic the component relies on: the next selection is
    // exactly the failed ids — succeeded ids must not survive.
    expect(new Set(failedIds)).toEqual(new Set(["b", "d"]));
    expect(failedIds).not.toContain("a");
    expect(failedIds).not.toContain("c");
    expect(okCount).toBe(2);
    expect(failureById).toEqual({ b: "SHIFT_FULL", d: "ROLE_FULL" });
  });

  it("merges results across chunks into one settled outcome", () => {
    // Simulate a 250-id run: chunk 1 all ok, chunk 2 mixed, chunk 3 all
    // failed — partition sees the concatenation, exactly as runBatch
    // accumulates it.
    const chunk1 = makeIds(100).map(ok);
    const chunk2 = [
      ...makeIds(99).map((id) => ok(`c2-${id}`)),
      fail("c2-bad", "SIGNUP_NOT_REVIEWABLE"),
    ];
    const chunk3 = [fail("c3-x", "SHIFT_FULL"), fail("c3-y")];
    const { failedIds, okCount, failureById } = partitionBatchResults([
      ...chunk1,
      ...chunk2,
      ...chunk3,
    ]);
    expect(okCount).toBe(199);
    expect(failedIds).toEqual(["c2-bad", "c3-x", "c3-y"]);
    expect(failureById["c2-bad"]).toBe("SIGNUP_NOT_REVIEWABLE");
    expect(failureById["c3-x"]).toBe("SHIFT_FULL");
  });

  it("defaults a missing failure code to internal_error", () => {
    const { failureById } = partitionBatchResults([fail("a")]);
    expect(failureById["a"]).toBe("internal_error");
  });
});

describe("batchFailureKey", () => {
  it("maps canonical capacity codes to the shared single-review body keys", () => {
    expect(batchFailureKey("SHIFT_FULL")).toBe(
      "admin.volunteerSignupsShiftFullBody",
    );
    expect(batchFailureKey("ROLE_FULL")).toBe(
      "admin.volunteerSignupsRoleFullBody",
    );
  });

  it("maps SIGNUP_NOT_REVIEWABLE to the already-reviewed copy", () => {
    expect(batchFailureKey("SIGNUP_NOT_REVIEWABLE")).toBe(
      "admin.volunteerSignupsBatchAlreadyReviewed",
    );
  });

  it("maps VOLUNTEER_APPROVALS_PAUSED to the short paused row copy in both locales", () => {
    expect(batchFailureKey("VOLUNTEER_APPROVALS_PAUSED")).toBe(
      "admin.volunteerSignupsBatchApprovalsPaused",
    );
    const key = batchFailureKey("VOLUNTEER_APPROVALS_PAUSED");
    expect(String(createTranslator("en", enMessages as never).t(key))).toBe(
      "Can't approve right now. You can still reject.",
    );
    expect(String(createTranslator("es", esMessages as never).t(key))).toBe(
      "No se puede aprobar ahora. Todavía puedes rechazar.",
    );
  });

  it("matches case-insensitively so legacy lowercase codes still map", () => {
    expect(batchFailureKey("shift_full")).toBe(
      "admin.volunteerSignupsShiftFullBody",
    );
    expect(batchFailureKey("signup_not_reviewable")).toBe(
      "admin.volunteerSignupsBatchAlreadyReviewed",
    );
  });

  it("falls back to the generic row failure for every other documented code", () => {
    const generic = "admin.volunteerSignupsBatchRowFailed";
    expect(batchFailureKey("SIGNUP_NOT_FOUND")).toBe(generic);
    expect(batchFailureKey("EVENT_NOT_FOUND")).toBe(generic);
    expect(batchFailureKey("INSUFFICIENT_ROLE")).toBe(generic);
    expect(batchFailureKey("internal_error")).toBe(generic);
  });

  it("falls back to the generic row failure for unknown or missing codes", () => {
    const generic = "admin.volunteerSignupsBatchRowFailed";
    expect(batchFailureKey("some_future_code")).toBe(generic);
    expect(batchFailureKey(undefined)).toBe(generic);
    expect(batchFailureKey("")).toBe(generic);
  });
});
