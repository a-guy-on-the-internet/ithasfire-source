import { z } from "zod";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookingRequestAskKind,
  BookingRequestAskRecord,
  BookingRequestAttachmentRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import { OPEN_BOOKING_REQUEST_STATUSES } from "@th/ports/repos/booking-requests";
import { fail } from "@th/errors";


// ─────────────────────────────────────────────────────────────────────────────
// ASKS — shared vocabulary (venue-booking-standards v1.1, V9–V11, FR-009b).
//
// An ask is a venue's typed request on a booking thread for one thing the
// night needs, with the sender's saved answer:
//
//   kind        answer                     bounds
//   IMAGE       an image attachment        jpeg / png / webp, ≤ 25 MB
//   FILE        an attachment              pdf / jpeg / png / webp, ≤ 25 MB
//   LINK        an http(s) URL             ≤ 2048
//   TEXT        plain text                 1–2000 (sanitized first)
//   SET_LENGTH  minutes                    5–600
//
// STATE MACHINE
//   OPEN ──answer──▶ ANSWERED ──answer (replace)──▶ ANSWERED
//     │
//     └──withdraw──▶ WITHDRAWN (final)
//   ANSWERED cannot be withdrawn (its answer may already be the event's
//   image or the terms' end time); WITHDRAWN cannot be answered.
//
// WHO
//   ask      — the VENUE side (thread WRITE gate), TO_VENUE requests only;
//   answer   — the PERFORMER side (thread WRITE gate: the sender, or an org
//              sender's edit-role members);
//   withdraw — any VENUE-side participant (the venue as a side, not only the
//              person who asked: venue staff hand threads to each other);
//   read     — the thread READ gate on VENUE | PERFORMER (a VIEWER sees an
//              answer file's name; opening it takes the PARTICIPANT gate,
//              `getBookingAttachmentUrl`). A read-only ACT reads no asks (and
//              the ledger hides ask entries from it).
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_ASK_LABEL_MAX = 80;
export const BOOKING_ASK_NOTE_MAX = 240;
export const BOOKING_ASK_ANSWER_TEXT_MAX = 2000;
export const BOOKING_ASK_ANSWER_URL_MAX = 2048;
export const BOOKING_ASK_SET_LENGTH_MIN = 5;
export const BOOKING_ASK_SET_LENGTH_MAX = 600;

export const bookingRequestAskKindSchema = z.enum([
  "IMAGE",
  "FILE",
  "LINK",
  "TEXT",
  "SET_LENGTH",
]);

export const bookingRequestAskStatusSchema = z.enum([
  "OPEN",
  "ANSWERED",
  "WITHDRAWN",
]);

/** What each answer shape is called on the wire (`answer.type`). */
export type BookingAskAnswerType = "attachment" | "url" | "text" | "minutes";

/**
 * THE kind → answer-shape table. An answer whose `type` is not the one its
 * ask's kind takes is refused (INVALID_INPUT `answer_does_not_match_ask`).
 */
export const ANSWER_TYPE_FOR_KIND: Record<
  BookingRequestAskKind,
  BookingAskAnswerType
> = {
  IMAGE: "attachment",
  FILE: "attachment",
  LINK: "url",
  TEXT: "text",
  SET_LENGTH: "minutes",
};

export function answerMatchesKind(
  kind: BookingRequestAskKind,
  answerType: BookingAskAnswerType,
): boolean {
  return ANSWER_TYPE_FOR_KIND[kind] === answerType;
}

/** One ask on the wire, with its answer and (for a file) the file's facts. */
export const bookingRequestAskOutputSchema = z
  .object({
    id: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    kind: bookingRequestAskKindSchema,
    label: z.string(),
    note: z.string().nullable(),
    standardField: z.string().nullable(),
    useAsEventImage: z.boolean(),
    status: bookingRequestAskStatusSchema,
    askedByHumanId: z.string().uuid(),
    askedAt: z.date(),
    answer: z
      .discriminatedUnion("type", [
        z
          .object({
            type: z.literal("attachment"),
            attachmentId: z.string().uuid(),
            /** Null when the file was deleted since. */
            fileName: z.string().nullable(),
            contentType: z.string().nullable(),
            sizeBytes: z.number().int().nonnegative().nullable(),
          })
          .strict(),
        z.object({ type: z.literal("url"), url: z.string() }).strict(),
        z.object({ type: z.literal("text"), text: z.string() }).strict(),
        z.object({ type: z.literal("minutes"), minutes: z.number().int() }).strict(),
      ])
      .nullable(),
    answeredByHumanId: z.string().uuid().nullable(),
    answeredAt: z.date().nullable(),
    withdrawnAt: z.date().nullable(),
    /** The event this IMAGE answer was copied into as its image (V10). */
    eventImageEventId: z.string().uuid().nullable(),
  })
  .strict();

export type BookingRequestAskOutput = z.infer<
  typeof bookingRequestAskOutputSchema
>;

export function toAskOutput(
  ask: BookingRequestAskRecord,
  attachment: BookingRequestAttachmentRecord | null,
): BookingRequestAskOutput {
  let answer: BookingRequestAskOutput["answer"] = null;
  if (ask.status === "ANSWERED") {
    if (ask.answerAttachmentId !== null) {
      const live =
        attachment && attachment.deletedAt === null ? attachment : null;
      answer = {
        type: "attachment",
        attachmentId: ask.answerAttachmentId,
        fileName: live?.fileName ?? null,
        contentType: live?.contentType ?? null,
        sizeBytes: live?.sizeBytes ?? null,
      };
    } else if (ask.answerUrl !== null) {
      answer = { type: "url", url: ask.answerUrl };
    } else if (ask.answerText !== null) {
      answer = { type: "text", text: ask.answerText };
    } else if (ask.answerMinutes !== null) {
      answer = { type: "minutes", minutes: ask.answerMinutes };
    }
  }
  return bookingRequestAskOutputSchema.parse({
    id: ask.id,
    bookingRequestId: ask.bookingRequestId,
    kind: ask.kind,
    label: ask.label,
    note: ask.note,
    standardField: ask.standardField,
    useAsEventImage: ask.useAsEventImage,
    status: ask.status,
    askedByHumanId: ask.askedByHumanId,
    askedAt: ask.askedAt,
    answer,
    answeredByHumanId: ask.answeredByHumanId,
    answeredAt: ask.answeredAt,
    withdrawnAt: ask.withdrawnAt,
    eventImageEventId: ask.eventImageEventId,
  });
}

/** Asks live on venue-bound requests only (V11: only the venue asks). */
export function requireToVenueForAsks(request: BookingRequestRecord): void {
  if (request.direction !== "TO_VENUE") {
    throw fail("INVALID_INPUT", {
      message: "booking_asks_venue_only",
      meta: { reason: "booking_asks_venue_only" },
    });
  }
}

/**
 * A request takes new asks while it is LIVE: open (PENDING / VIEWED, not past
 * its expiry) or ACCEPTED. DECLINED / WITHDRAWN / EXPIRED refuse with the
 * house's INVALID_STATUS `booking_request_closed` (as hold placement does).
 * The other half — a cancelled booking refuses with BOOKING_CANCELLED — is
 * `lockRequestBookingAndAssertNotCancelled` (booking-holds), which the ask
 * runs first under the request's booking lock; read `request` after it.
 */
export function assertRequestTakesAsks(
  request: BookingRequestRecord,
  now: Date,
): void {
  const open = (OPEN_BOOKING_REQUEST_STATUSES as readonly string[]).includes(
    request.status,
  );
  const live =
    (open && (request.expiresAt === null || request.expiresAt > now)) ||
    request.status === "ACCEPTED";
  if (!live) {
    throw fail("INVALID_STATUS", {
      message: "booking_request_closed",
      meta: { bookingRequestId: request.id, status: request.status },
    });
  }
}

/** Load one ask scoped to its request; BOOKING_ASK_NOT_FOUND otherwise. */
export async function requireAsk(
  repos: Pick<Repos, "bookingRequests"> | Pick<TxRepos, "bookingRequests">,
  args: { askId: string; bookingRequestId: string },
): Promise<BookingRequestAskRecord> {
  const ask = await repos.bookingRequests.getAsk({
    id: args.askId,
    bookingRequestId: args.bookingRequestId,
  });
  if (!ask) {
    throw fail("BOOKING_ASK_NOT_FOUND");
  }
  return ask;
}
