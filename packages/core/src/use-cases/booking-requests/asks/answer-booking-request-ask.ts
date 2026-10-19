import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  AnswerBookingRequestAskInput,
  BookingRequestAskRecord,
  BookingRequestAttachmentRecord,
} from "@th/ports/repos/booking-requests";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import { plainTextMultilineRequired } from "../../../lib/sanitize-plain-text";
import {
  isBookingAttachmentImage,
  refundBookingAttachmentQuota,
  verifyBookingAttachmentObject,
} from "../_shared/attachment-files";
import { appendBookingSystemEntry } from "../messages/_shared/system-entries";
import {
  ensureBookingThreadParticipant,
  requireBookingRequest,
} from "../messages/_shared/thread-access";
import {
  BOOKING_ASK_ANSWER_TEXT_MAX,
  BOOKING_ASK_ANSWER_URL_MAX,
  BOOKING_ASK_SET_LENGTH_MAX,
  BOOKING_ASK_SET_LENGTH_MIN,
  answerMatchesKind,
  bookingRequestAskOutputSchema,
  requireAsk,
  requireToVenueForAsks,
  toAskOutput,
  type BookingRequestAskOutput,
} from "./_shared/ask-schemas";
import {
  applySetLengthToDraftTerms,
  bookedEventIdForRequest,
  mapAskImageToEvent,
} from "./map-ask-answers";
import {
  fireAskNotice,
  type NotifyBookingRequestAskFn,
} from "./notify-booking-request-ask";

// ─────────────────────────────────────────────────────────────────────────────
// answerBookingRequestAsk (venue-booking-standards v1.1 V9, V10, FR-009b):
// the SENDER side saves an answer — or replaces it while the ask is ANSWERED
// (a wrong file, a typo); a WITHDRAWN ask refuses.
//
// The answer's shape must match the kind (`ANSWER_TYPE_FOR_KIND`): an
// attachment for IMAGE / FILE (IMAGE: an image type), a URL for LINK, text
// for TEXT, minutes (5–600) for SET_LENGTH. An attachment must be a LIVE file
// on this request, uploaded FOR this ask by the sender side, and still in
// storage with the type its row records (HEAD — never trusted from the row
// alone).
//
// One transaction: the answer CAS (status OPEN | ANSWERED and the answer
// revision read before — so a concurrent answer, or an answer racing a
// withdraw, has one winner), the superseded answer file soft-deleted with its
// storage GC enqueued (a replaced answer never leaves a file nobody points
// at), SET_LENGTH applied to the DRAFT terms, `booking_request.ask_answered`,
// audit. After commit: an IMAGE marked "use as the event image" is copied
// into the booking's event if it already exists (best-effort), and the venue
// side hears `booking.ask-answered`.
// ─────────────────────────────────────────────────────────────────────────────

const httpUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(BOOKING_ASK_ANSWER_URL_MAX);

export const bookingAskAnswerInputSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("attachment"), attachmentId: z.string().uuid() })
    .strict(),
  z.object({ type: z.literal("url"), url: httpUrlSchema }).strict(),
  z
    .object({
      type: z.literal("text"),
      text: plainTextMultilineRequired(BOOKING_ASK_ANSWER_TEXT_MAX),
    })
    .strict(),
  z
    .object({
      type: z.literal("minutes"),
      minutes: z
        .number()
        .int()
        .min(BOOKING_ASK_SET_LENGTH_MIN)
        .max(BOOKING_ASK_SET_LENGTH_MAX),
    })
    .strict(),
]);

export const answerBookingRequestAskInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    askId: z.string().uuid(),
    answer: bookingAskAnswerInputSchema,
  })
  .strict();

export type AnswerBookingRequestAskUseCaseInput = z.input<
  typeof answerBookingRequestAskInputSchema
>;

export type AnswerBookingRequestAskDeps = {
  repos: Repos;
  clock: ClockPort;
  /**
   * HEAD for an attachment answer (required); get / put / url for the
   * after-mint image copy (optional there — absent skips the copy).
   */
  storage: Pick<FileStoragePort, "headObject" | "deleteObject"> &
    Partial<Pick<FileStoragePort, "getObject" | "putObject" | "getObjectUrl">>;
  logger?: LoggerPort;
  /** Post-commit `booking.ask-answered` to the venue side. */
  notifyBookingRequestAsk?: NotifyBookingRequestAskFn;
  /** Reports the swallowed notifier / image-copy / oversize-delete failures. */
  reportError?: ReporterPort;
};

export async function answerBookingRequestAsk(
  deps: AnswerBookingRequestAskDeps,
  rawInput: unknown,
): Promise<BookingRequestAskOutput> {
  const input = parseInput(answerBookingRequestAskInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  await ensureBookingThreadParticipant(
    deps.repos,
    request,
    input.actorHumanId,
    "PERFORMER",
  );
  requireToVenueForAsks(request);

  const ask = await requireAsk(deps.repos, {
    askId: input.askId,
    bookingRequestId: request.id,
  });
  assertAnswerable(ask);
  if (!answerMatchesKind(ask.kind, input.answer.type)) {
    throw fail("INVALID_INPUT", {
      message: "answer_does_not_match_ask",
      meta: {
        reason: "answer_does_not_match_ask",
        kind: ask.kind,
        answerType: input.answer.type,
      },
    });
  }

  let attachment: BookingRequestAttachmentRecord | null = null;
  if (input.answer.type === "attachment") {
    attachment = await requireAnswerAttachment(deps, {
      ask,
      attachmentId: input.answer.attachmentId,
      actorHumanId: input.actorHumanId,
    });
  }

  const answer: AnswerBookingRequestAskInput["answer"] =
    input.answer.type === "attachment"
      ? { kind: "attachment", attachmentId: input.answer.attachmentId }
      : input.answer.type === "url"
        ? { kind: "url", url: input.answer.url }
        : input.answer.type === "text"
          ? { kind: "text", text: input.answer.text }
          : { kind: "minutes", minutes: input.answer.minutes };

  const now = deps.clock.now();
  const replaced = ask.status === "ANSWERED";

  const answered = await deps.repos.tx(async (tx) => {
    const updated = await tx.bookingRequests.answerAsk({
      id: ask.id,
      bookingRequestId: request.id,
      expectedRevision: ask.answerRevision,
      answer,
      answeredByHumanId: input.actorHumanId,
      answeredAt: now,
    });
    if (!updated) {
      // Lost the CAS: re-read to say why.
      const current = await tx.bookingRequests.getAsk({
        id: ask.id,
        bookingRequestId: request.id,
      });
      if (!current) throw fail("BOOKING_ASK_NOT_FOUND");
      assertAnswerable(current);
      throw fail("INVALID_STATUS", {
        message: "booking_ask_changed",
        meta: { askId: ask.id, status: current.status },
      });
    }

    // A replaced FILE answer: the old file was uploaded for THIS ask and is
    // no longer its answer — soft-delete it, refund its uploader's quota and
    // enqueue its bytes on the deletion outbox, in this transaction (only
    // when this call stamped it).
    const superseded = ask.answerAttachmentId;
    if (superseded !== null && superseded !== updated.answerAttachmentId) {
      const removed = await tx.bookingRequests.softDeleteAttachment({
        id: superseded,
        bookingRequestId: request.id,
      });
      if (removed?.didStamp) {
        await refundBookingAttachmentQuota(tx, removed.record);
        await tx.pendingObjectDeletions.enqueueMany([
          {
            targetKey: removed.record.storageKey,
            targetKind: "KEY",
            source: "booking_request_attachment",
            sourceId: removed.record.id,
          },
        ]);
      }
    }

    // SET_LENGTH → the DRAFT terms' end (V10). No terms yet → seeded at
    // accept from this answer (accept-in-tx).
    const proposedEndDate =
      answer.kind === "minutes"
        ? await applySetLengthToDraftTerms(tx, {
            request,
            askId: ask.id,
            minutes: answer.minutes,
            actorHumanId: input.actorHumanId,
            now,
          })
        : null;

    await appendBookingSystemEntry(tx, {
      bookingRequestId: request.id,
      kind: "booking_request.ask_answered",
      data: { askId: ask.id, kind: ask.kind, label: ask.label, replaced },
      actorHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: request.id,
      action: "booking_request.ask_answered",
      data: {
        askId: ask.id,
        kind: ask.kind,
        answerType: answer.kind,
        replaced,
        supersededAttachmentId:
          superseded !== null && superseded !== updated.answerAttachmentId
            ? superseded
            : null,
        proposedEndDate: proposedEndDate?.toISOString() ?? null,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });

    return updated;
  });

  // After the mint, an image answer goes onto the event at once (V10).
  if (answered.kind === "IMAGE" && answered.useAsEventImage) {
    const eventId = await bookedEventIdForRequest(deps.repos, request);
    if (eventId) {
      await mapAskImageToEvent(
        {
          repos: deps.repos,
          storage:
            deps.storage.getObject && deps.storage.putObject && deps.storage.getObjectUrl
              ? {
                  getObject: deps.storage.getObject.bind(deps.storage),
                  putObject: deps.storage.putObject.bind(deps.storage),
                  getObjectUrl: deps.storage.getObjectUrl.bind(deps.storage),
                }
              : undefined,
          clock: deps.clock,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        {
          bookingRequestId: request.id,
          eventId,
          askId: answered.id,
          context: "answerBookingRequestAsk",
        },
      );
    }
  }

  await fireAskNotice(
    deps,
    {
      event: "answered",
      bookingRequest: request,
      ask: answered,
      actorHumanId: input.actorHumanId,
    },
    "answerBookingRequestAsk",
  );

  deps.logger?.info("booking_requests.ask_answered", {
    bookingRequestId: request.id,
    askId: answered.id,
    kind: answered.kind,
    replaced,
    actorHumanId: input.actorHumanId,
  });

  return bookingRequestAskOutputSchema.parse(toAskOutput(answered, attachment));
}

/** WITHDRAWN is final: the venue took the ask back. */
function assertAnswerable(ask: BookingRequestAskRecord): void {
  if (ask.status === "WITHDRAWN") {
    throw fail("INVALID_STATUS", {
      message: "booking_ask_withdrawn",
      meta: { askId: ask.id, status: ask.status },
    });
  }
}

/**
 * The file an IMAGE / FILE answer points at: live, on this request, uploaded
 * for THIS ask by the sender side, an image for an IMAGE ask, and still in
 * storage as recorded (HEAD).
 */
async function requireAnswerAttachment(
  deps: Pick<AnswerBookingRequestAskDeps, "repos" | "storage" | "logger" | "reportError">,
  args: {
    ask: BookingRequestAskRecord;
    attachmentId: string;
    actorHumanId: string;
  },
): Promise<BookingRequestAttachmentRecord> {
  const attachment = await deps.repos.bookingRequests.getAttachment({
    id: args.attachmentId,
    bookingRequestId: args.ask.bookingRequestId,
  });
  if (!attachment || attachment.deletedAt !== null) {
    throw fail("DOCUMENT_NOT_FOUND", {
      meta: { entity: "booking_request_attachment" },
    });
  }
  if (
    attachment.askId !== args.ask.id ||
    attachment.uploadedBySide !== "PERFORMER"
  ) {
    throw fail("INVALID_INPUT", {
      message: "attachment_not_for_this_ask",
      meta: { reason: "attachment_not_for_this_ask" },
    });
  }
  if (args.ask.kind === "IMAGE" && !isBookingAttachmentImage(attachment.contentType)) {
    throw fail("INVALID_INPUT", {
      message: "ask_needs_an_image",
      meta: { reason: "ask_needs_an_image" },
    });
  }
  // The row was checked at `add`; the store is checked again here, against
  // the row: the object is still there, and still what the row says.
  const stored = await verifyBookingAttachmentObject(
    { storage: deps.storage, logger: deps.logger, reportError: deps.reportError },
    {
      key: attachment.storageKey,
      bookingRequestId: args.ask.bookingRequestId,
      actorHumanId: attachment.uploadedByHumanId ?? args.actorHumanId,
      context: "answerBookingRequestAsk",
    },
  );
  if (stored.contentType !== attachment.contentType.toLowerCase()) {
    throw fail("INVALID_INPUT", {
      message: "content_type_mismatch",
      meta: { reason: "content_type_mismatch" },
    });
  }
  return attachment;
}
