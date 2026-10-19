import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import {
  BOOKING_ATTACHMENT_CONTENT_TYPES,
  BOOKING_ATTACHMENT_CONTENT_TYPE_LIST,
  BOOKING_ATTACHMENT_MAX_BYTES,
  BOOKING_ATTACHMENT_METADATA,
  BOOKING_ATTACHMENT_METADATA_KIND,
  BOOKING_ATTACHMENT_UPLOAD_TTL_SECONDS,
  BOOKING_ATTACHMENT_URL_TTL_SECONDS,
  bookingAttachmentKeyPrefix,
} from "./_shared/attachment-files";
import {
  ensureBookingThreadParticipant,
  requireBookingRequest,
} from "./messages/_shared/thread-access";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-request file UPLOAD and OPEN (venue-booking-standards v1.1,
// FR-009a) — the prerequisite the thread's "Attach a file" and IMAGE / FILE
// asks stand on. Modelled on places/request-verification-doc-upload.ts and
// places/get-verification-document-url.ts.
//
//   1. `requestBookingAttachmentUpload` mints the KEY (server-side, under the
//      request's own namespace, a fresh uuid) and a 15-minute presigned PUT
//      into the PRIVATE bucket. The presign stamps the request and the
//      uploader into the object's metadata.
//   2. The client PUTs the bytes, then calls `attachments.add` with the key;
//      `add` HEADs the object and records what the STORE reports (size,
//      type) — never what the client says (see `verifyBookingAttachmentObject`).
//   3. `getBookingAttachmentUrl` signs a 5-minute GET for one live attachment.
//
// AUTHZ
//   - upload: the thread's WRITE gate on the declared side
//     (`ensureBookingThreadParticipant`, VENUE | PERFORMER) — the same people
//     who may attach. A booking-grant holder is not staff and cannot; nor can
//     a read-only ACT.
//   - open: the thread's PARTICIPANT gate on the declared side
//     (`ensureBookingThreadParticipant`, VENUE | PERFORMER — FR-009a
//     "participants only"; orchestrator ruling, review W4): the venue's org
//     edit roles or its verified human owner, the sender or the sending org's
//     edit roles. NOT the read gate, which admits any-role org members.
//     The LISTS stay on the read gate (`attachments.list`, `asks.list`): a
//     VIEWER may see that a file exists, and its name, but not open it. A
//     LINK / TEXT answer is read on the list, like a message in the thread —
//     the same people read the conversation it is part of. An ACT can do
//     none of these (the input schemas refuse the side).
//
// QUOTA: the presign charges the UPLOADER's own storage quota
// (STORAGE_BYTES_HUMAN) by the declared size, like every other presign. The
// declared size is signed as Content-Length, so the charge equals the stored
// size for an honest client.
// ─────────────────────────────────────────────────────────────────────────────

const threadSideSchema = z.enum(["VENUE", "PERFORMER"]);

export const requestBookingAttachmentUploadInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    side: threadSideSchema,
    contentType: z.enum(BOOKING_ATTACHMENT_CONTENT_TYPE_LIST),
    sizeBytes: z.number().int().positive().max(BOOKING_ATTACHMENT_MAX_BYTES),
  })
  .strict();

export const requestBookingAttachmentUploadOutputSchema = z
  .object({
    /** Pass back to `attachments.add` once the PUT succeeded. */
    key: z.string().min(1),
    uploadUrl: z.string().min(1),
    /** Headers the PUT MUST send verbatim (signed into the URL). */
    uploadHeaders: z.record(z.string(), z.string()),
    expiresAt: z.date(),
  })
  .strict();

export type RequestBookingAttachmentUploadInput = z.infer<
  typeof requestBookingAttachmentUploadInputSchema
>;
export type RequestBookingAttachmentUploadOutput = z.infer<
  typeof requestBookingAttachmentUploadOutputSchema
>;

export type RequestBookingAttachmentUploadDeps = {
  repos: Repos;
  storage: Pick<FileStoragePort, "presignPutObject">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function requestBookingAttachmentUpload(
  deps: RequestBookingAttachmentUploadDeps,
  rawInput: unknown,
): Promise<RequestBookingAttachmentUploadOutput> {
  const input = parseInput(requestBookingAttachmentUploadInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  await ensureBookingThreadParticipant(
    deps.repos,
    request,
    input.actorHumanId,
    input.side,
  );

  const quota = {
    subjectType: "HUMAN" as const,
    subjectId: input.actorHumanId,
    kind: "STORAGE_BYTES_HUMAN" as const,
    delta: BigInt(input.sizeBytes),
  };
  await enforceQuota(deps.repos, quota);

  const extension = BOOKING_ATTACHMENT_CONTENT_TYPES[input.contentType];
  const key = `${bookingAttachmentKeyPrefix(request.id)}${randomUUID()}.${extension}`;

  let uploadUrl: string;
  try {
    ({ uploadUrl } = await deps.storage.presignPutObject({
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      public: false,
      metadata: {
        [BOOKING_ATTACHMENT_METADATA.kind]: BOOKING_ATTACHMENT_METADATA_KIND,
        [BOOKING_ATTACHMENT_METADATA.bookingRequestId]: request.id,
        [BOOKING_ATTACHMENT_METADATA.actorHumanId]: input.actorHumanId,
      },
      options: { expiresSec: BOOKING_ATTACHMENT_UPLOAD_TTL_SECONDS },
    }));
  } catch (err) {
    throw fail("STORAGE_ERROR", { cause: err });
  }

  await incrementResourceUsage(deps.repos, quota);

  deps.logger?.info("booking_requests.attachment_upload_requested", {
    bookingRequestId: request.id,
    actorHumanId: input.actorHumanId,
    side: input.side,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  return requestBookingAttachmentUploadOutputSchema.parse({
    key,
    uploadUrl,
    uploadHeaders: { "Content-Type": input.contentType },
    expiresAt: new Date(
      deps.clock.now().getTime() + BOOKING_ATTACHMENT_UPLOAD_TTL_SECONDS * 1000,
    ),
  });
}

// ── Open ────────────────────────────────────────────────────────────────────

export const getBookingAttachmentUrlInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    side: threadSideSchema,
    attachmentId: z.string().uuid(),
  })
  .strict();

export const getBookingAttachmentUrlOutputSchema = z
  .object({
    url: z.string().min(1),
    expiresAt: z.date(),
    fileName: z.string(),
    contentType: z.string(),
  })
  .strict();

export type GetBookingAttachmentUrlInput = z.infer<
  typeof getBookingAttachmentUrlInputSchema
>;
export type GetBookingAttachmentUrlOutput = z.infer<
  typeof getBookingAttachmentUrlOutputSchema
>;

export type GetBookingAttachmentUrlDeps = {
  repos: Repos;
  storage: Pick<FileStoragePort, "getObjectUrl">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * A short-lived signed GET for one LIVE attachment of the request —
 * PARTICIPANTS only (the thread's write gate; see the module header). The
 * attachment is read scoped to `(attachmentId, bookingRequestId)`, AFTER the
 * gate: anyone else is refused before anything about the file is read, and a
 * participant naming another request's attachment id gets
 * DOCUMENT_NOT_FOUND, the same as a missing or deleted one.
 */
export async function getBookingAttachmentUrl(
  deps: GetBookingAttachmentUrlDeps,
  rawInput: unknown,
): Promise<GetBookingAttachmentUrlOutput> {
  const input = parseInput(getBookingAttachmentUrlInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  await ensureBookingThreadParticipant(
    deps.repos,
    request,
    input.actorHumanId,
    input.side,
  );

  const attachment = await deps.repos.bookingRequests.getAttachment({
    id: input.attachmentId,
    bookingRequestId: request.id,
  });
  if (!attachment || attachment.deletedAt !== null) {
    throw fail("DOCUMENT_NOT_FOUND", {
      meta: { entity: "booking_request_attachment" },
    });
  }

  let url: string;
  try {
    ({ url } = await deps.storage.getObjectUrl({
      key: attachment.storageKey,
      options: { expiresSec: BOOKING_ATTACHMENT_URL_TTL_SECONDS },
    }));
  } catch (err) {
    throw fail("STORAGE_ERROR", { cause: err });
  }

  deps.logger?.info("booking_requests.attachment_url_issued", {
    bookingRequestId: request.id,
    attachmentId: attachment.id,
    actorHumanId: input.actorHumanId,
    side: input.side,
  });

  return getBookingAttachmentUrlOutputSchema.parse({
    url,
    expiresAt: new Date(
      deps.clock.now().getTime() + BOOKING_ATTACHMENT_URL_TTL_SECONDS * 1000,
    ),
    fileName: attachment.fileName,
    contentType: attachment.contentType,
  });
}
