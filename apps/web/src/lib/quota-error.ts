/**
 * Helpers for detecting and extracting quota-exceeded metadata from tRPC errors.
 *
 * The API's errorFormatter surfaces `meta` from domain errors onto
 * `error.data.meta`. When the error resolves to the canonical `QUOTA_EXCEEDED`
 * code (carried in `error.data.appCode`, or the legacy `quota_exceeded` message
 * still emitted by the not-yet-migrated `enforceQuota` throw — both normalized
 * by `getAppErrorCode`), meta contains:
 *   - kind: ResourceLimitKind
 *   - subjectType: "HUMAN" | "ORG" | "PLACE"
 *   - subjectId: string
 *   - limitValue: string (bigint serialised)
 *   - currentUsage: string (bigint serialised)
 *   - hasPendingExpansionRequest: boolean
 */

import { getAppErrorCode } from "./app-error";

export interface QuotaExceededMeta {
  kind: string;
  subjectType: "HUMAN" | "ORG" | "PLACE";
  subjectId: string;
  limitValue: string;
  currentUsage: string;
  hasPendingExpansionRequest: boolean;
}

/**
 * Attempt to extract QuotaExceededMeta from a tRPC error.
 * Returns `null` if the error is not a quota_exceeded error.
 */
export function extractQuotaExceededMeta(
  error: unknown,
): QuotaExceededMeta | null {
  if (!error || typeof error !== "object") return null;

  // `getAppErrorCode` resolves both the canonical `QUOTA_EXCEEDED` code and the
  // legacy lowercase `quota_exceeded` message (via `fromLegacyCode`) to the
  // canonical code, so a single check covers the not-yet-migrated throw too.
  if (getAppErrorCode(error) !== "QUOTA_EXCEEDED") return null;

  // tRPC errors surface meta at error.data.meta
  const data =
    "data" in error && typeof (error as any).data === "object"
      ? (error as any).data
      : null;

  const meta = data?.meta;
  if (!meta || typeof meta !== "object") return null;
  if (!("kind" in meta && "subjectType" in meta && "subjectId" in meta))
    return null;

  return meta as QuotaExceededMeta;
}

/**
 * Check whether a tRPC error is a quota_exceeded error.
 */
export function isQuotaExceededError(error: unknown): boolean {
  return extractQuotaExceededMeta(error) !== null;
}
