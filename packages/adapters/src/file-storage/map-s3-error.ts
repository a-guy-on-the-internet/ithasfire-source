import {
  createFileStorageError,
  type FileStorageError,
} from "@th/ports/file-storage";

/**
 * The shape the AWS SDK throws. `name` carries the S3 error code on modern
 * clients; `Code` is the legacy field some responses still populate.
 */
export type S3Error = Error & {
  $metadata?: { httpStatusCode?: number };
  Code?: string;
  name?: string;
};

/**
 * Bucket-scope failures — the BUCKET is wrong or gone, not the object.
 *
 * These MUST be classified before the status check below, because S3 answers
 * `NoSuchBucket` with **404**. Left to the status check they map to
 * `not_found`, which every consumer of this mapper reads as "this one object is
 * absent" and handles by degrading quietly:
 *
 *   - `moderate-image` writes the record terminally to ORPHANED — invisible,
 *     out of the review queue, not requeueable, recoverable only by manual SQL.
 *     A renamed bucket would silently and permanently orphan every row in every
 *     drain pass.
 *   - `deleteObject` returns `{ ok: true }`, reporting a deletion that never
 *     happened;
 *   - `headObjectInternal` returns null, so an upload finalize decides the
 *     object it just wrote is missing;
 *   - `resolve-event-audio` drops the source url for every track;
 *   - `place-layout-blob-storage` reports "no snapshot" for every place.
 *
 * Every one of those is a config incident wearing the costume of a data state.
 * `dependency_failed` is the honest classification: the store is unusable, the
 * request should fail loudly, and retrying is pointless until a human fixes the
 * configuration.
 */
const BUCKET_SCOPE_ERROR_NAMES = new Set([
  "NoSuchBucket",
  "InvalidBucketName",
  // Wrong-region bucket. This one IS a small reclassification, not a no-op:
  // S3/R2 surface the redirect as 301 on some verbs (which already fell through
  // to `dependency_failed`) but as **400 on others**, and a 400 previously hit
  // the `>= 400 && < 500` branch as `invalid_input`. Harmless in practice — no
  // consumer branches on `invalid_input`, they only ever special-case
  // `not_found` — and `dependency_failed` is the honest answer either way: the
  // bucket is unreachable from where we are pointed, which is a configuration
  // fault, not a malformed request.
  "PermanentRedirect",
]);

/**
 * Maps an AWS SDK error onto the {@link FileStorageError} contract.
 *
 * Shared by the R2 and S3 adapters, which held byte-identical private copies
 * until this was extracted — a divergence risk with real teeth, since the
 * `not_found` classification here is what several call sites treat as a
 * terminal, unrecoverable data state.
 *
 * ORDER MATTERS: bucket-scope names are tested BEFORE the HTTP status, because
 * the 404 they share with a missing key means the status check cannot tell them
 * apart. See {@link BUCKET_SCOPE_ERROR_NAMES}.
 */
export const mapS3Error = (error: unknown): FileStorageError => {
  const err = error as S3Error;
  const status = err.$metadata?.httpStatusCode;
  // Kept as-is for the MESSAGE fallback only — `name` is the human-facing label.
  const name = err.name ?? err.Code ?? "unknown";
  const message =
    err instanceof Error &&
    typeof err.message === "string" &&
    err.message.length > 0
      ? err.message
      : name;

  /**
   * CLASSIFY ON BOTH FIELDS.
   *
   * `err.name ?? err.Code` looks like it covers the legacy `Code` field, but
   * `??` only falls through on null/undefined and EVERY `Error` instance has a
   * `name` (defaulting to "Error"). So `Code` was consulted only for a plain
   * object carrying no `name` at all — which is not what the AWS SDK produces.
   * A realistic `{ name: "S3ServiceException", Code: "NoSuchBucket",
   * $metadata: { httpStatusCode: 404 } }` therefore skipped every name check
   * and fell into the 404 branch as `not_found`: the precise misclassification
   * the bucket guard exists to prevent, on the precise shape the `Code`
   * fallback exists to handle.
   */
  const codes = [err.name, err.Code].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  const isCode = (...candidates: string[]): boolean =>
    codes.some((c) => candidates.includes(c));

  if (isCode("ExpiredToken", "SignatureDoesNotMatch")) {
    return createFileStorageError("dependency_failed", message);
  }

  // BEFORE the status check — see the note on BUCKET_SCOPE_ERROR_NAMES.
  if (codes.some((c) => BUCKET_SCOPE_ERROR_NAMES.has(c))) {
    return createFileStorageError("dependency_failed", message);
  }

  // Deliberately still `name`-only, NOT `isCode`. Widening this check would
  // expand what counts as `not_found` — the one direction with teeth, since
  // consumers treat it as a terminal data state. The 404 status already catches
  // every realistic missing-key shape; these two names only add the cases where
  // the status is absent. Narrow stays narrow.
  if (status === 404 || name === "NoSuchKey" || name === "NotFound") {
    return createFileStorageError("not_found", "object_not_found");
  }

  if (status === 409 || name === "Conflict") {
    return createFileStorageError("conflict", message);
  }

  if (status && status >= 500) {
    return createFileStorageError("transient", message);
  }

  if (status && status >= 400 && status < 500) {
    return createFileStorageError("invalid_input", message);
  }

  return createFileStorageError("dependency_failed", message);
};
