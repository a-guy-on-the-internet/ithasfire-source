import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { normalizeThreadSide } from "../../lib/legacy-place-values";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
// ── P3b (asks) ──
import {
  isBookingAttachmentImage,
  refundBookingAttachmentQuota,
  verifyBookingAttachmentObject,
} from "./_shared/attachment-files";
import {
  ensureBookingThreadParticipant,
  ensureBookingThreadReader,
  requireBookingRequest,
} from "./messages/_shared/thread-access";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-request attachments (venue-hierarchy FR-008): riders, stage plots,
// tech specs — the working documents a booking conversation trades.
//
// Both thread sides (venue AND performer) may attach; the participant authz
// is exactly the thread's (`ensureBookingThreadParticipant`); listing runs
// the membership-any READ gate (`ensureBookingThreadReader`). DELETE is
// uploader-or-venue (see `deleteBookingRequestAttachment`).
//
// Rows reference the stored object by `storageKey`; on soft-delete the
// object bytes are GC'd via the PendingObjectDeletion outbox, enqueued IN
// THE SAME TRANSACTION and ONLY when `didStamp` is true (the port's
// double-enqueue protection — a repeat delete must not GC twice).
//
// Cross-request isolation: `softDeleteAttachment` scopes its WHERE by BOTH
// (id, bookingRequestId) — a forged attachment id from another request
// matches zero rows and no-ops (pinned by test). Deletes are idempotent.
// ─────────────────────────────────────────────────────────────────────────────

const FILE_NAME_MAX = 200;
const CONTENT_TYPE_MAX = 100;
const STORAGE_KEY_MAX = 512;
/** 50 MB — matches the upload infra's document ceiling; belt-and-braces here. */
const SIZE_BYTES_MAX = 50 * 1024 * 1024;

const threadSideSchema = z.enum(["VENUE", "PERFORMER"]);

export const bookingRequestAttachmentOutputSchema = z
  .object({
    id: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    storageKey: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    // ── P3b (asks) ── the ask this file answers, or null (FR-009a).
    askId: z.string().uuid().nullable(),
    createdAt: z.date(),
  })
  .strict();

export type BookingRequestAttachmentOutput = z.infer<
  typeof bookingRequestAttachmentOutputSchema
>;

export type BookingRequestAttachmentsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── P3b (asks) ──
/**
 * `add` HEADs the stored object (venue-booking-standards v1.1 FR-009a): the
 * row records the size and type the STORE reports. `reportError` covers the
 * shared size verifier's swallowed delete of an oversize object.
 */
export type AddBookingRequestAttachmentDeps = BookingRequestAttachmentsDeps & {
  storage: Pick<FileStoragePort, "headObject" | "deleteObject">;
  reportError?: ReporterPort;
};

// ── Add ─────────────────────────────────────────────────────────────────────

export const addBookingRequestAttachmentInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    side: threadSideSchema,
    /**
     * Object key minted by the upload infra. MUST live under this request's
     * own namespace — `booking-requests/{bookingRequestId}/…` (cross-field
     * superRefine below). Without the prefix check, a participant could
     * register a FOREIGN object key on their own request and have the
     * soft-delete GC destroy someone else's stored bytes.
     *
     * NOTE(step 6): the transport's upload-session mint must scope keys to
     * (actor, bookingRequestId) server-side; this prefix check is the interim
     * guard until then.
     *
     * CLAIM-ONCE (Step-6 review, also interim until the Step-8 mint): both
     * participants share the request's namespace, so the prefix check alone
     * still lets one side re-register a key the OTHER side uploaded and later
     * GC bytes they never put there. The adapter enforces first-writer-wins
     * inside the insert's transaction — a key already carried by ANY
     * attachment row (live or soft-deleted, on ANY request) rejects with
     * `{ code: "conflict", message: "attachment_key_taken" }`, which this use
     * case surfaces untouched (transport maps `conflict` → 409 CONFLICT).
     */
    storageKey: z.string().min(1).max(STORAGE_KEY_MAX),
    /** Display name — sanitized BEFORE the length cap (house helper). */
    fileName: plainTextRequired(FILE_NAME_MAX),
    contentType: z
      .string()
      .trim()
      .min(1)
      .max(CONTENT_TYPE_MAX)
      .regex(/^[\w.+-]+\/[\w.+-]+$/, "Must be a media type"),
    sizeBytes: z.number().int().positive().max(SIZE_BYTES_MAX),
    // ── P3b (asks) ── the ask this file answers (IMAGE / FILE kinds only;
    // PERFORMER side only — see the use case). Omit for "Attach a file".
    askId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const prefix = `booking-requests/${value.bookingRequestId}/`;
    if (
      !value.storageKey.startsWith(prefix) ||
      value.storageKey.length <= prefix.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["storageKey"],
        message: "storage_key_outside_request_namespace",
      });
    }
  });

export type AddBookingRequestAttachmentUseCaseInput = z.infer<
  typeof addBookingRequestAttachmentInputSchema
>;

/**
 * Attach a stored object to the request. Participant authz is the only gate —
 * a request's status never closes its thread (thread-access module header), so
 * the rider for a booking that already happened can still be filed against it.
 */
export async function addBookingRequestAttachment(
  deps: AddBookingRequestAttachmentDeps,
  rawInput: unknown,
): Promise<BookingRequestAttachmentOutput> {
  const input = parseInput(addBookingRequestAttachmentInputSchema, rawInput);

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

  // ── P3b (asks) ── an upload FOR an ask: only the side that answers asks
  // (the sender), only for an ask that takes a file, never a withdrawn one.
  const ask = input.askId
    ? await requireAttachableAsk(deps, {
        bookingRequestId: request.id,
        askId: input.askId,
        side: input.side,
      })
    : null;

  // ── P3b (asks) ── trust the STORE, not the client: the object must exist,
  // be an allowed type within 25 MB, and carry this request's / this actor's
  // presign stamp when the store kept it. The row records the HEAD's values.
  const stored = await verifyBookingAttachmentObject(
    { storage: deps.storage, logger: deps.logger, reportError: deps.reportError },
    {
      key: input.storageKey,
      bookingRequestId: request.id,
      actorHumanId: input.actorHumanId,
      context: "addBookingRequestAttachment",
    },
  );
  if (stored.contentType !== input.contentType.toLowerCase()) {
    throw fail("INVALID_INPUT", {
      message: "content_type_mismatch",
      meta: { reason: "content_type_mismatch" },
    });
  }
  if (ask?.kind === "IMAGE" && !isBookingAttachmentImage(stored.contentType)) {
    throw fail("INVALID_INPUT", {
      message: "ask_needs_an_image",
      meta: { reason: "ask_needs_an_image" },
    });
  }

  const now = deps.clock.now();

  const record = await deps.repos.tx(async (tx) => {
    const created = await tx.bookingRequests.addAttachment({
      bookingRequestId: request.id,
      storageKey: input.storageKey,
      fileName: input.fileName,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      // Uploader provenance (uploader-or-venue delete posture): the actor's
      // VERIFIED side (`ensureBookingThreadParticipant` above) + their id —
      // never client-supplied beyond the side claim that authz just checked.
      uploadedBySide: input.side,
      uploadedByHumanId: input.actorHumanId,
      ...(ask ? { askId: ask.id } : {}),
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: request.id,
      action: "booking_request.attachment_added",
      data: {
        attachmentId: created.id,
        actorHumanId: input.actorHumanId,
        // AuditLog.data spells the place side the new way (legacy-place-values).
        side: normalizeThreadSide(input.side),
        fileName: created.fileName,
        contentType: created.contentType,
        sizeBytes: created.sizeBytes,
        askId: created.askId,
      },
      at: now,
    });

    return created;
  });

  deps.logger?.info("booking_requests.attachment_added", {
    bookingRequestId: request.id,
    attachmentId: record.id,
    actorHumanId: input.actorHumanId,
  });

  return bookingRequestAttachmentOutputSchema.parse({
    id: record.id,
    bookingRequestId: record.bookingRequestId,
    storageKey: record.storageKey,
    fileName: record.fileName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    askId: record.askId,
    createdAt: record.createdAt,
  });
}

// ── P3b (asks) ──
/**
 * The ask an upload names must be on THIS request (scoped read), take a file
 * (IMAGE / FILE), and still be answerable (not WITHDRAWN); and the uploader
 * must be on the PERFORMER side — the venue asks, the sender answers (V11).
 */
async function requireAttachableAsk(
  deps: Pick<BookingRequestAttachmentsDeps, "repos">,
  args: { bookingRequestId: string; askId: string; side: "VENUE" | "PERFORMER" },
) {
  const ask = await deps.repos.bookingRequests.getAsk({
    id: args.askId,
    bookingRequestId: args.bookingRequestId,
  });
  if (!ask) {
    throw fail("BOOKING_ASK_NOT_FOUND");
  }
  if (args.side !== "PERFORMER") {
    throw fail("NOT_RESOURCE_OWNER", {
      meta: { entity: "booking_request_ask", reason: "sender_answers_asks" },
    });
  }
  if (ask.kind !== "IMAGE" && ask.kind !== "FILE") {
    throw fail("INVALID_INPUT", {
      message: "ask_takes_no_file",
      meta: { reason: "ask_takes_no_file", kind: ask.kind },
    });
  }
  if (ask.status === "WITHDRAWN") {
    throw fail("INVALID_STATUS", {
      message: "booking_ask_withdrawn",
      meta: { askId: ask.id, status: ask.status },
    });
  }
  return ask;
}

// ── List ────────────────────────────────────────────────────────────────────

export const listBookingRequestAttachmentsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    side: threadSideSchema,
  })
  .strict();

export type ListBookingRequestAttachmentsUseCaseInput = z.infer<
  typeof listBookingRequestAttachmentsInputSchema
>;

/** Live attachments, oldest first. Works on closed threads (read-only state). */
export async function listBookingRequestAttachments(
  deps: BookingRequestAttachmentsDeps,
  rawInput: unknown,
): Promise<BookingRequestAttachmentOutput[]> {
  const input = parseInput(listBookingRequestAttachmentsInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  // READ gate: membership-any, same bar as listing the request itself.
  await ensureBookingThreadReader(
    deps.repos,
    request,
    input.actorHumanId,
    input.side,
  );

  const records = await deps.repos.bookingRequests.listAttachments(request.id);
  return records.map((record) =>
    bookingRequestAttachmentOutputSchema.parse({
      id: record.id,
      bookingRequestId: record.bookingRequestId,
      storageKey: record.storageKey,
      fileName: record.fileName,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      askId: record.askId,
      createdAt: record.createdAt,
    }),
  );
}

// ── Delete ──────────────────────────────────────────────────────────────────

export const deleteBookingRequestAttachmentInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    side: threadSideSchema,
    attachmentId: z.string().uuid(),
  })
  .strict();

export type DeleteBookingRequestAttachmentUseCaseInput = z.infer<
  typeof deleteBookingRequestAttachmentInputSchema
>;

/**
 * Idempotent soft-delete. Allowed on closed threads too (removing a stale
 * document is cleanup, not conversation). The storage-GC enqueue rides the
 * SAME transaction and fires ONLY on `didStamp` (see the module header); a
 * forged/foreign attachment id matches zero rows and silently no-ops.
 *
 * UPLOADER-OR-VENUE posture (venue-hierarchy Step 5): the VENUE moderates
 * its own inbox and may delete ANY attachment; the PERFORMER may delete
 * ONLY performer-side uploads (`uploadedBySide === "PERFORMER"`). Legacy
 * rows whose uploader columns predate the
 * booking_request_attachment_uploader migration read as `null` and are
 * treated as venue-managed — the performer cannot delete them. A blocked
 * performer delete gets INSUFFICIENT_ROLE (the
 * participant-but-under-privileged code, matching requirePlaceOwnership's
 * posture) with `reason: "not_uploader"`.
 *
 * READ-then-CHECK-then-MUTATE (Step-5 review): inside the transaction the
 * target row is resolved from the request's LIVE attachments and the
 * uploader check runs BEFORE `softDeleteAttachment` — a blocked performer
 * never mutates anything, and a row that is absent from the live list
 * (foreign id, unknown id, OR already soft-deleted) is the same idempotent
 * `{ deleted: false }` no-op, so a performer probing an already-deleted
 * venue attachment learns nothing a missing id wouldn't tell them.
 */
export async function deleteBookingRequestAttachment(
  deps: BookingRequestAttachmentsDeps,
  rawInput: unknown,
): Promise<{ deleted: boolean }> {
  const input = parseInput(deleteBookingRequestAttachmentInputSchema, rawInput);

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

  const now = deps.clock.now();

  const deleted = await deps.repos.tx(async (tx) => {
    // READ: resolve the target from the request's LIVE attachments (soft-
    // deleted rows are already filtered out by the port contract).
    const live = await tx.bookingRequests.listAttachments(request.id);
    const target = live.find((record) => record.id === input.attachmentId);
    if (!target) {
      // No live row for (id, bookingRequestId) — foreign id, unknown id, or
      // already soft-deleted. One idempotent no-op for all three (IDOR
      // posture): a performer probing an already-deleted venue attachment
      // gets the same answer as any missing id — no existence leak.
      return false;
    }
    // CHECK — BEFORE any mutation. Uploader-or-venue: the performer may only
    // delete their own side's uploads (null uploader = legacy venue-managed
    // row). Both invariants pinned here: the GC enqueue stays AFTER this
    // check, and a throw rolls the whole transaction back, so nothing a
    // blocked delete touched can ever commit.
    if (input.side === "PERFORMER" && target.uploadedBySide !== "PERFORMER") {
      throw fail("INSUFFICIENT_ROLE", {
        meta: {
          entity: "booking_request_attachment",
          reason: "not_uploader",
        },
      });
    }
    // MUTATE.
    const result = await tx.bookingRequests.softDeleteAttachment({
      id: input.attachmentId,
      bookingRequestId: request.id,
    });
    if (!result || !result.didStamp) {
      // Raced: the row vanished or was already stamped between the read
      // above and this write, and that earlier delete's enqueue committed
      // with it — enqueueing again would double-GC (port contract).
      return false;
    }

    // ── P3b (asks) ── the UPLOADER gets back the quota the presign charged
    // (review W2) — not the deleter; same stamp guard as the GC enqueue.
    await refundBookingAttachmentQuota(tx, result.record);

    await tx.pendingObjectDeletions.enqueueMany([
      {
        targetKey: result.record.storageKey,
        targetKind: "KEY",
        source: "booking_request_attachment",
        sourceId: result.record.id,
      },
    ]);

    await tx.audit.log({
      entity: "booking_request",
      entityId: request.id,
      action: "booking_request.attachment_deleted",
      data: {
        attachmentId: result.record.id,
        actorHumanId: input.actorHumanId,
        // AuditLog.data spells the place side the new way (legacy-place-values).
        side: normalizeThreadSide(input.side),
        fileName: result.record.fileName,
      },
      at: now,
    });

    return true;
  });

  deps.logger?.info("booking_requests.attachment_deleted", {
    bookingRequestId: request.id,
    attachmentId: input.attachmentId,
    actorHumanId: input.actorHumanId,
    deleted,
  });

  return { deleted };
}
