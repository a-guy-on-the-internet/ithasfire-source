/**
 * The adapters' guarded-write conflict shape: a legacy `{ code: "conflict" }`
 * use-case error thrown when a compare-and-swap `WHERE … status IN (…)`
 * matched zero rows — i.e. the row's status changed between the caller's
 * read and its write.
 *
 * Callers map it to a domain error (`INVALID_STATUS`) rather than letting it
 * escape; it is deliberately NOT an Error subclass because it mirrors the
 * long-standing `bookingRequests.updateStatus` contract (see the note at the
 * throw site in adapters/db/prisma/event-applications.ts).
 */
export function isStatusConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict"
  );
}

/**
 * The adapters' mapped open-application unique violation
 * (`duplicate_open_application`) — a P2002 from one of the two SQL-only
 * partial unique indexes enforcing "one OPEN application per applicant per
 * event" (migration 20260811140000).
 *
 * Thrown by BOTH `createSubmission` (a second submit) and
 * `updateSubmissionStatus` (a write that moves a row back INTO the open set —
 * approving a stale EXPIRED row, or rescinding a REJECTED one, after the
 * applicant already re-applied). Same bare `{ code, message }` shape as the
 * status conflict above, for the same reason.
 */
export function isDuplicateOpenApplication(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "duplicate_open_application"
  );
}

/**
 * Postgres aborted the transaction to break a lock cycle (40P01 deadlock) or
 * a serialization failure (40001). Prisma surfaces the interactive-tx form
 * as `P2034` and a raw-query form as an unknown request error whose message
 * carries "Code: `40P01`" (the adapter-side twin is
 * `isDeadlockOrSerializationFailure` in adapters/db/prisma/booking-holds.ts).
 * Duck-typed on `code`/`message`, the way core already matches `P2002`, so
 * core needs no Prisma import. The whole transaction rolled back, so the
 * caller may safely run it again.
 */
export function isTransactionDeadlockOrSerialization(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "P2034" || code === "40P01" || code === "40001") return true;
  return typeof message === "string" && /Code: `(40P01|40001)`/.test(message);
}
