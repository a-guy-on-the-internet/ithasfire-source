import type { FileStoragePort } from "@th/ports/file-storage";
import type { TxRepos } from "@th/ports/repos";
import type { BookingRequestAttachmentRecord } from "@th/ports/repos/booking-requests";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import { fail } from "@th/errors";

import { verifyUploadedObjectSize } from "../../storage/verify-uploaded-object-size";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-request FILES (venue-booking-standards v1.1, FR-009a): the one
// place the upload rules live — what may be uploaded, how big, where it is
// stored, and how a stored object is checked before a row may point at it.
//
// Shared by `requestBookingAttachmentUpload` (the presign), the attachment
// `add` (the row), and `answerBookingRequestAsk` (an IMAGE / FILE answer).
// ─────────────────────────────────────────────────────────────────────────────

/** Allowed types → storage-key extension (explicit map, never the subtype). */
export const BOOKING_ATTACHMENT_CONTENT_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export type BookingAttachmentContentType =
  keyof typeof BOOKING_ATTACHMENT_CONTENT_TYPES;

export const BOOKING_ATTACHMENT_CONTENT_TYPE_LIST = Object.keys(
  BOOKING_ATTACHMENT_CONTENT_TYPES,
) as [BookingAttachmentContentType, ...BookingAttachmentContentType[]];

/** The image subset — what an IMAGE ask takes (and what may become a hero). */
export const BOOKING_ATTACHMENT_IMAGE_CONTENT_TYPES: readonly BookingAttachmentContentType[] =
  ["image/jpeg", "image/png", "image/webp"];

/** 25 MB — FR-009a. */
export const BOOKING_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** The presigned PUT lives 15 minutes (FR-009a). */
export const BOOKING_ATTACHMENT_UPLOAD_TTL_SECONDS = 15 * 60;

/**
 * The signed GET lives 5 minutes: long enough to open the file the user just
 * clicked, short enough that a forwarded link dies quickly. A new click mints
 * a new one.
 */
export const BOOKING_ATTACHMENT_URL_TTL_SECONDS = 5 * 60;

/** Object-metadata keys the presign stamps (read back on HEAD as hints). */
export const BOOKING_ATTACHMENT_METADATA = {
  kind: "th-kind",
  bookingRequestId: "th-booking-request-id",
  actorHumanId: "th-actor-human-id",
} as const;

export const BOOKING_ATTACHMENT_METADATA_KIND = "booking-request-attachment";

/** `booking-requests/{requestId}/` — the namespace every key lives under. */
export function bookingAttachmentKeyPrefix(bookingRequestId: string): string {
  return `booking-requests/${bookingRequestId}/`;
}

export function isBookingAttachmentImage(contentType: string): boolean {
  return (BOOKING_ATTACHMENT_IMAGE_CONTENT_TYPES as readonly string[]).includes(
    contentType.toLowerCase(),
  );
}

function normalizeContentType(raw: string | undefined): string | null {
  if (!raw) return null;
  // `image/png; charset=binary` → `image/png`.
  const base = raw.split(";")[0]?.trim().toLowerCase();
  return base && base.length > 0 ? base : null;
}

export type VerifiedBookingAttachmentObject = {
  sizeBytes: number;
  contentType: BookingAttachmentContentType;
};

/**
 * HEAD the stored object and return what the STORE says it is — never what
 * the client declared. Refuses (never trusts the client):
 *   - a missing object → UPLOAD_NOT_COMPLETE;
 *   - an object over 25 MB or over the size signed into its presign →
 *     INVALID_INPUT `upload_size_exceeded` (the shared verifier, which also
 *     deletes it — only a client that bypassed the signed Content-Length can
 *     get there);
 *   - a type outside the allowed list, or none reported (fail closed) →
 *     INVALID_INPUT `unsupported_content_type`;
 *   - an object whose presign stamped ANOTHER request or ANOTHER uploader
 *     (the metadata hint, when the store kept it) → INVALID_INPUT
 *     `attachment_not_uploaded_by_actor`. Both sides share the request's key
 *     namespace, so this keeps one side from registering a file the other
 *     side uploaded but has not attached yet.
 */
export async function verifyBookingAttachmentObject(
  deps: {
    storage: Pick<FileStoragePort, "headObject" | "deleteObject">;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  args: {
    key: string;
    bookingRequestId: string;
    actorHumanId: string;
    context: string;
  },
): Promise<VerifiedBookingAttachmentObject> {
  const head = await deps.storage.headObject({ key: args.key });
  if (!head.exists) {
    throw fail("UPLOAD_NOT_COMPLETE", {
      meta: { entity: "booking_request_attachment" },
    });
  }

  const metadata = head.metadata ?? {};
  const stampedRequest = metadata[BOOKING_ATTACHMENT_METADATA.bookingRequestId];
  const stampedActor = metadata[BOOKING_ATTACHMENT_METADATA.actorHumanId];
  if (
    (stampedRequest !== undefined && stampedRequest !== args.bookingRequestId) ||
    (stampedActor !== undefined && stampedActor !== args.actorHumanId)
  ) {
    throw fail("INVALID_INPUT", {
      message: "attachment_not_uploaded_by_actor",
      meta: { reason: "attachment_not_uploaded_by_actor" },
    });
  }

  const contentType = normalizeContentType(head.contentType);
  if (
    contentType === null ||
    !(contentType in BOOKING_ATTACHMENT_CONTENT_TYPES)
  ) {
    throw fail("INVALID_INPUT", {
      message: "unsupported_content_type",
      meta: { reason: "unsupported_content_type" },
    });
  }

  // Size last: the verifier deletes an oversize object, and nothing above
  // should be able to destroy bytes.
  const sized = await verifyUploadedObjectSize(
    {
      storage: deps.storage,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      key: args.key,
      maxBytes: BOOKING_ATTACHMENT_MAX_BYTES,
      context: args.context,
    },
  );
  if (!sized.exists) {
    throw fail("UPLOAD_NOT_COMPLETE", {
      meta: { entity: "booking_request_attachment" },
    });
  }

  return {
    sizeBytes: sized.size,
    contentType: contentType as BookingAttachmentContentType,
  };
}

/**
 * Give the UPLOADER back the storage their file was charged against
 * (`requestBookingAttachmentUpload` charges STORAGE_BYTES_HUMAN at presign),
 * inside the caller's transaction, right after a soft-delete that STAMPED the
 * row (`didStamp` — a repeat delete must not refund twice). Used by both
 * removal paths: a deleted attachment (either side may delete; the uploader
 * is refunded, never the deleter) and an ask answer replaced by a new file
 * (review W2). Same shape as profiles/cleanup-replaced-image.ts.
 *
 * Rows with no recorded uploader are skipped: nothing can say whose quota
 * they were charged to. The refund is the RECORDED size (the store's HEAD at
 * `add`), which equals the charged, declared size for every honest client —
 * the presign signs it as Content-Length. Usage is floored at zero by the
 * adapter, so a refund can never drive it negative.
 */
export async function refundBookingAttachmentQuota(
  tx: Pick<TxRepos, "resourceQuotas">,
  record: Pick<BookingRequestAttachmentRecord, "uploadedByHumanId" | "sizeBytes">,
): Promise<void> {
  if (!record.uploadedByHumanId || record.sizeBytes <= 0) return;
  await tx.resourceQuotas.incrementUsage({
    subjectType: "HUMAN",
    subjectId: record.uploadedByHumanId,
    kind: "STORAGE_BYTES_HUMAN",
    delta: BigInt(-record.sizeBytes),
  });
}
