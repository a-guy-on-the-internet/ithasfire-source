/**
 * Pure helpers for the bulk volunteer-signup review flow in
 * `SignupsTab`. Extracted so the chunking / result-merging /
 * partitioning logic and the failure-code → i18n mapping are unit
 * testable without rendering the table.
 */

/** `reviewBatch` accepts at most this many signup ids per call. */
export const BATCH_CHUNK_SIZE = 100;

/** Per-id outcome returned by the `reviewBatch` mutation. */
export type BatchReviewResult = {
  id: string;
  ok: boolean;
  code?: string;
};

/** Settled outcome of a whole batch run (possibly several chunks). */
export type BatchPartition = {
  /** Ids that failed — these stay selected so the admin can retry. */
  failedIds: string[];
  /** Ids that succeeded — these are deselected. */
  okCount: number;
  /** signupId → failure code, for the inline per-row markers. */
  failureById: Record<string, string>;
};

/**
 * Split ids into sequential chunks of at most `size`. The mutation
 * caps `signupIds` at 100 per call, so larger selections are submitted
 * as several calls whose results get merged back together.
 */
export function chunkIds(
  ids: readonly string[],
  size: number = BATCH_CHUNK_SIZE,
): string[][] {
  if (size < 1) throw new Error("chunkIds: size must be >= 1");
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Partition merged per-id results into the settled batch outcome.
 * Failed ids keep their failure code (defaulting to `internal_error`
 * when the server omitted one) and stay selected; succeeded ids drop
 * out of the selection.
 */
export function partitionBatchResults(
  results: readonly BatchReviewResult[],
): BatchPartition {
  const failedIds: string[] = [];
  const failureById: Record<string, string> = {};
  for (const r of results) {
    if (r.ok) continue;
    failedIds.push(r.id);
    failureById[r.id] = r.code ?? "internal_error";
  }
  return {
    failedIds,
    okCount: results.length - failedIds.length,
    failureById,
  };
}

/**
 * Per-id failure codes from `reviewBatch` → human copy. Capacity codes
 * reuse the existing single-review body keys so the wording stays
 * identical between the toast (single review) and the inline marker
 * (batch review).
 *
 * The per-id `code` carries the use case's canonical SCREAMING_SNAKE
 * `AppErrorCode` (e.g. `SHIFT_FULL`, `ROLE_FULL`, `SIGNUP_NOT_REVIEWABLE`,
 * `VOLUNTEER_APPROVALS_PAUSED`, `SIGNUP_NOT_FOUND`, `EVENT_NOT_FOUND`), or
 * the synthetic `internal_error`
 * fallback the server sets when it suppresses an internal-tier failure.
 * Lookups are case-insensitive (upper-cased) so a future server build that
 * emits the legacy lowercase form still maps. Anything unmapped (including
 * unknown future codes) falls back to the generic row-failure copy.
 */
const BATCH_FAILURE_KEY: Record<string, string> = {
  SHIFT_FULL: "admin.volunteerSignupsShiftFullBody",
  ROLE_FULL: "admin.volunteerSignupsRoleFullBody",
  SIGNUP_NOT_REVIEWABLE: "admin.volunteerSignupsBatchAlreadyReviewed",
  // Withheld owner (owner ruling 2026-10-08): approving is refused, rejecting
  // still works. Short row copy; the single-review toast has the full sentence.
  VOLUNTEER_APPROVALS_PAUSED: "admin.volunteerSignupsBatchApprovalsPaused",
};

export const batchFailureKey = (code: string | undefined): string =>
  (code && BATCH_FAILURE_KEY[code.toUpperCase()]) ||
  "admin.volunteerSignupsBatchRowFailed";
