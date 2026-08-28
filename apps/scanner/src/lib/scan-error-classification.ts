/**
 * Shared classification of a failed scan-related tRPC call.
 *
 * Extracted from `use-scan-queue.ts` (where it was `classifyScanError`) so the
 * offline-resolve fallback decides "is this a NETWORK failure?" with the exact
 * same rule the queue's flush loop uses. Two classifiers would drift, and the
 * drift would be invisible: the queue would retry a failure the resolver had
 * already treated as fatal, or vice versa.
 *
 * Pure — no expo imports — so it is unit-testable in node.
 */

export type ScanErrorKind = "permanent" | "transient" | "network";

/**
 * Classify a scan-related tRPC rejection.
 *
 *  - "permanent": server actively refused the input (malformed,
 *    unauthorized role, conflict). Retrying never helps, so the queue
 *    drops the row and keeps draining — one bad scan can't stall it.
 *  - "transient": server reachable but errored (5xx, timeout). Bump
 *    attempts + schedule a backoff slot, keep draining the rest.
 *  - "network": couldn't reach the server at all (no tRPC error
 *    envelope). The queue aborts the current flush pass; the resolver
 *    falls back to the local manifest (FR-001).
 *
 * Note: business-rule rejections (REJECTED / REPLAY outcomes) come back
 * as *successful* mutation responses with `outcome: "REJECTED"` etc., so
 * they don't reach this classifier at all.
 */
export function classifyScanError(err: unknown): ScanErrorKind {
  const data = (err as { data?: { code?: string } } | null)?.data;
  if (!data || typeof data.code !== "string") return "network";
  switch (data.code) {
    case "BAD_REQUEST":
    case "NOT_FOUND":
    case "FORBIDDEN":
    case "METHOD_NOT_SUPPORTED":
    case "PRECONDITION_FAILED":
    case "PAYLOAD_TOO_LARGE":
    case "UNSUPPORTED_MEDIA_TYPE":
    case "UNPROCESSABLE_CONTENT":
    case "CONFLICT":
    case "PARSE_ERROR":
      return "permanent";
    default:
      // Includes INTERNAL_SERVER_ERROR, TIMEOUT, UNAUTHORIZED (re-auth
      // may restore us), and any unknown code we should err on retrying.
      return "transient";
  }
}

/** True when the failure means "the server was unreachable". */
export function isNetworkScanError(err: unknown): boolean {
  return classifyScanError(err) === "network";
}
