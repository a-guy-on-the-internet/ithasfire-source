import { fail } from "@th/errors";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

import { verifyUploadedObjectSize } from "../../storage/verify-uploaded-object-size";

/**
 * Cap shared by `requestVerificationDocUpload` / `requestClaimDocUpload` and
 * the three submit paths (verification, claim, dispute).
 */
export const MAX_PLACE_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Key prefix both doc presigns mint (`place-verification/<placeId>/<uuid>.<ext>`). */
export const placeDocumentKeyPrefix = (placeId: string) =>
  `place-verification/${placeId}/`;

export type VerifyPlaceDocumentUploadsDeps = {
  storage: Pick<FileStoragePort, "headObject" | "deleteObject">;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * Checks each NEWLY submitted document before it is recorded:
 *
 * 1. The key must sit under this place's doc prefix. The submit inputs took
 *    any `storageKey`, so a claim could attach an arbitrary bucket object
 *    (another upload kind, another place's file) and have staff mint a
 *    signed URL for it during review.
 * 2. The object must exist (`UPLOAD_NOT_COMPLETE` otherwise).
 * 3. It must be no bigger than the doc cap or the presign declaration
 *    (F11: the quota was charged from that) — such an object is deleted and
 *    refused — nor than the size re-stated at submit, which is refused
 *    WITHOUT deleting (a client-chosen number never destroys an object).
 *
 * Reused documents (verification resubmits) were checked when first
 * submitted and are not passed here.
 */
export async function verifyPlaceDocumentUploads(
  deps: VerifyPlaceDocumentUploadsDeps,
  args: {
    placeId: string;
    documents: ReadonlyArray<{ storageKey: string; sizeBytes: number }>;
    context: string;
  },
): Promise<void> {
  const prefix = placeDocumentKeyPrefix(args.placeId);
  for (const doc of args.documents) {
    if (!doc.storageKey.startsWith(prefix) || doc.storageKey.includes("..")) {
      throw fail("INVALID_INPUT", {
        message: "document_key_not_owned",
        meta: { reason: "document_key_not_owned" },
      });
    }
  }

  for (const doc of args.documents) {
    const head = await verifyUploadedObjectSize(deps, {
      key: doc.storageKey,
      maxBytes: MAX_PLACE_DOCUMENT_BYTES,
      // Client-restated at submit: refuse above it, but only DELETE for the
      // cap or the server-stamped presign declaration.
      untrustedDeclaredBytes: doc.sizeBytes,
      context: args.context,
    });
    if (!head.exists) {
      throw fail("UPLOAD_NOT_COMPLETE");
    }
  }
}
