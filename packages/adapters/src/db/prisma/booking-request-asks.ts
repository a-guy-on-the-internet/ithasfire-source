import type { BookingRequestAsk } from "@prisma/client";

import type {
  BookingRequestAskRecord,
  BookingRequestsRepo,
} from "@th/ports/repos/booking-requests";
import type { BookingStandardField } from "@th/types/repos/booking-standards";

import type { PrismaClientOrTx } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-request ASKS (venue-booking-standards v1.1, V9–V11, FR-009b) — the
// BookingRequestsRepo methods over `BookingRequestAsk`, kept in their own
// module and spread into `makeBookingRequestsRepo`.
//
// Every state change is a guarded `updateMany` (CAS): the WHERE carries the
// request id (IDOR backstop) and the expected state, so under READ COMMITTED
// two writers on one ask serialise on the row lock and the second re-evaluates
// the WHERE against the committed row — exactly one wins, the other matches
// zero rows and gets `null` / `false`.
// ─────────────────────────────────────────────────────────────────────────────

type AskMethods = Pick<
  BookingRequestsRepo,
  | "createAsk"
  | "getAsk"
  | "listAsks"
  | "answerAsk"
  | "withdrawAsk"
  | "stampAskEventImage"
>;

export function makeBookingRequestAskMethods(p: PrismaClientOrTx): AskMethods {
  return {
    async createAsk(input) {
      const row = await p.bookingRequestAsk.create({
        data: {
          bookingRequestId: input.bookingRequestId,
          kind: input.kind,
          label: input.label,
          note: input.note,
          standardField: input.standardField,
          useAsEventImage: input.useAsEventImage,
          askedByHumanId: input.askedByHumanId,
          askedAt: input.askedAt,
        },
      });
      return toAskRecord(row);
    },

    async getAsk({ id, bookingRequestId }) {
      const row = await p.bookingRequestAsk.findFirst({
        where: { id, bookingRequestId },
      });
      return row ? toAskRecord(row) : null;
    },

    async listAsks(bookingRequestId) {
      const rows = await p.bookingRequestAsk.findMany({
        where: { bookingRequestId },
        orderBy: [{ askedAt: "asc" }, { id: "asc" }],
      });
      return rows.map(toAskRecord);
    },

    async answerAsk(input) {
      const { answer } = input;
      // Every answer column is written: the named one set, the rest cleared,
      // so a replaced answer never leaves a stale column behind (and the
      // per-kind CHECK sees exactly one column).
      const { count } = await p.bookingRequestAsk.updateMany({
        where: {
          id: input.id,
          bookingRequestId: input.bookingRequestId,
          status: { in: ["OPEN", "ANSWERED"] },
          answerRevision: input.expectedRevision,
        },
        data: {
          status: "ANSWERED",
          answerAttachmentId:
            answer.kind === "attachment" ? answer.attachmentId : null,
          answerUrl: answer.kind === "url" ? answer.url : null,
          answerText: answer.kind === "text" ? answer.text : null,
          answerMinutes: answer.kind === "minutes" ? answer.minutes : null,
          answeredByHumanId: input.answeredByHumanId,
          answeredAt: input.answeredAt,
          answerRevision: { increment: 1 },
        },
      });
      if (count === 0) return null;
      const row = await p.bookingRequestAsk.findFirst({
        where: { id: input.id, bookingRequestId: input.bookingRequestId },
      });
      return row ? toAskRecord(row) : null;
    },

    async withdrawAsk(input) {
      const { count } = await p.bookingRequestAsk.updateMany({
        where: {
          id: input.id,
          bookingRequestId: input.bookingRequestId,
          status: "OPEN",
        },
        data: {
          status: "WITHDRAWN",
          withdrawnByHumanId: input.withdrawnByHumanId,
          withdrawnAt: input.withdrawnAt,
        },
      });
      if (count === 0) return null;
      const row = await p.bookingRequestAsk.findFirst({
        where: { id: input.id, bookingRequestId: input.bookingRequestId },
      });
      return row ? toAskRecord(row) : null;
    },

    async stampAskEventImage(input) {
      // `eventImageEventId <> $eventId` alone would skip NULL rows (SQL
      // three-valued logic), hence the explicit OR.
      const { count } = await p.bookingRequestAsk.updateMany({
        where: {
          id: input.id,
          bookingRequestId: input.bookingRequestId,
          status: "ANSWERED",
          answerAttachmentId: input.attachmentId,
          OR: [
            { eventImageEventId: null },
            { eventImageEventId: { not: input.eventId } },
          ],
        },
        data: {
          eventImageEventId: input.eventId,
          eventImageId: input.imageId,
        },
      });
      return count > 0;
    },
  };
}

function toAskRecord(row: BookingRequestAsk): BookingRequestAskRecord {
  return {
    id: row.id,
    bookingRequestId: row.bookingRequestId,
    kind: row.kind,
    label: row.label,
    note: row.note ?? null,
    standardField: (row.standardField as BookingStandardField | null) ?? null,
    useAsEventImage: row.useAsEventImage,
    status: row.status,
    askedByHumanId: row.askedByHumanId,
    askedAt: row.askedAt,
    answerAttachmentId: row.answerAttachmentId ?? null,
    answerUrl: row.answerUrl ?? null,
    answerText: row.answerText ?? null,
    answerMinutes: row.answerMinutes ?? null,
    answeredByHumanId: row.answeredByHumanId ?? null,
    answeredAt: row.answeredAt ?? null,
    answerRevision: row.answerRevision,
    withdrawnByHumanId: row.withdrawnByHumanId ?? null,
    withdrawnAt: row.withdrawnAt ?? null,
    eventImageEventId: row.eventImageEventId ?? null,
    eventImageId: row.eventImageId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
