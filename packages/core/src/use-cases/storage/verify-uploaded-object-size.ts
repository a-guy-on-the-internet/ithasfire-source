import { fail } from "@th/errors";
import {
  FILE_STORAGE_DECLARED_BYTES_METADATA_KEY,
  type FileStoragePort,
} from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError } from "../../lib/io";

/**
 * The message (and `meta.reason`) every finalize path throws when the stored
 * object is bigger than it was allowed to be. Rides `INVALID_INPUT` so it
 * needs no new catalog copy: only a client that lied about `sizeBytes` (or
 * bypassed the signed Content-Length) can reach it.
 */
export const UPLOAD_SIZE_EXCEEDED = "upload_size_exceeded";

export type VerifyUploadedObjectSizeDeps = {
  storage: Pick<FileStoragePort, "headObject" | "deleteObject">;
  logger?: LoggerPort;
  /** Reports a failed delete of an oversize object (deliberate swallow). */
  reportError?: ReporterPort;
};

export type VerifyUploadedObjectSizeArgs = {
  key: string;
  /** Hard cap for this upload kind (the request schema's `.max()`). */
  maxBytes: number;
  /**
   * Size the SERVER recorded at presign time (event image/audio rows).
   * Combined with the `th-declared-bytes` metadata the adapters stamp on
   * presigned PUTs — the smaller wins; with neither, only `maxBytes` applies.
   * Exceeding any of these deletes the object.
   */
  declaredBytes?: number | bigint | null;
  /**
   * A size the client RE-STATED later (doc submissions). Exceeding it is
   * refused, but never deletes: the object may not be this caller's to
   * destroy, and a client-chosen number must not decide that.
   */
  untrustedDeclaredBytes?: number | null;
  /** Use-case name for logs/Sentry tags. */
  context: string;
};

export type VerifyUploadedObjectSizeResult =
  | { exists: false }
  | {
      exists: true;
      size: number;
      /**
       * The object's user metadata as the HEAD returned it (keys lower-cased),
       * when the store returns any. Best-effort: absent on stores that drop
       * presign-time metadata.
       */
      metadata?: Record<string, string>;
    };

function positiveSafeInt(value: unknown): number | null {
  const n =
    typeof value === "string"
      ? /^\d+$/.test(value)
        ? Number(value)
        : NaN
      : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The tightest declaration we know of: the caller's recorded size and the
 * presign-time metadata stamp can disagree (a doc submit re-states the size
 * the client presigned with), so take the smaller of the two.
 */
function resolveDeclared(
  explicit: number | bigint | null | undefined,
  metadata: Record<string, string> | undefined,
): number | null {
  const candidates = [
    explicit === null || explicit === undefined
      ? null
      : positiveSafeInt(explicit),
    positiveSafeInt(metadata?.[FILE_STORAGE_DECLARED_BYTES_METADATA_KEY]),
  ].filter((n): n is number => n !== null);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/**
 * HEAD an uploaded object and refuse it if it is larger than declared or
 * larger than the kind allows (F11, 2026-09-29 scanner report).
 *
 * The storage quota is charged from the DECLARED size at presign time, so an
 * object bigger than its declaration is a quota bypass. On an oversize object
 * this deletes it and throws `INVALID_INPUT` / `upload_size_exceeded`.
 *
 * Deliberately NOT done here: crediting the quota back when the object is
 * smaller than declared, or refunding the charge for a rejected object. Most
 * finalize paths can be called repeatedly with the same key (avatar, banner,
 * page image), and concurrent calls would each apply the credit — minting
 * quota. Honest clients declare `file.size` exactly and the adapters sign
 * that as Content-Length, so the charged amount already equals the stored
 * size in every non-hostile case.
 *
 * A store that reports no size fails CLOSED (treated as oversize): every
 * S3-compatible HEAD returns Content-Length, so a missing size is an adapter
 * fault we must not wave through.
 */
export async function verifyUploadedObjectSize(
  deps: VerifyUploadedObjectSizeDeps,
  args: VerifyUploadedObjectSizeArgs,
): Promise<VerifyUploadedObjectSizeResult> {
  const head = await deps.storage.headObject({ key: args.key });
  if (!head.exists) return { exists: false };

  const declared = resolveDeclared(args.declaredBytes, head.metadata);
  const limit =
    declared !== null ? Math.min(declared, args.maxBytes) : args.maxBytes;
  const size = head.size;
  const untrusted =
    args.untrustedDeclaredBytes === null ||
    args.untrustedDeclaredBytes === undefined
      ? null
      : positiveSafeInt(args.untrustedDeclaredBytes);

  if (size !== undefined && size <= limit) {
    if (untrusted !== null && size > untrusted) {
      // Within every server-side bound, over only the client's restatement:
      // refuse, keep the object.
      deps.logger?.warn("upload.size_exceeds_restated", {
        useCase: args.context,
        key: args.key,
        size,
        restated: untrusted,
      });
      throw fail("INVALID_INPUT", {
        message: UPLOAD_SIZE_EXCEEDED,
        meta: { reason: UPLOAD_SIZE_EXCEEDED, maxBytes: untrusted },
      });
    }
    return {
      exists: true,
      size,
      ...(head.metadata ? { metadata: head.metadata } : {}),
    };
  }

  deps.logger?.warn("upload.size_exceeded", {
    useCase: args.context,
    key: args.key,
    size: size ?? null,
    declared,
    maxBytes: args.maxBytes,
  });

  try {
    await deps.storage.deleteObject({ key: args.key });
  } catch (err) {
    // Deliberate swallow: the caller still gets the rejection below, but the
    // oversize object stays in the bucket — log AND report so it is visible.
    deps.logger?.error("upload.size_exceeded_delete_failed", {
      useCase: args.context,
      key: args.key,
      error: describeError(err),
    });
    try {
      deps.reportError?.(err, {
        tags: { area: "upload_size_verification", useCase: args.context },
        extra: { key: args.key, size: size ?? null, declared },
      });
    } catch {
      // Best-effort reporting must never change the outcome.
    }
  }

  throw fail("INVALID_INPUT", {
    message: UPLOAD_SIZE_EXCEEDED,
    meta: {
      reason: UPLOAD_SIZE_EXCEEDED,
      maxBytes: limit,
    },
  });
}
