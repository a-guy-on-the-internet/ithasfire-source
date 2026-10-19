import { Prisma, type BookingRequestMessage } from "@prisma/client";
import type {
  BookingMessageAuthorSide,
  BookingRequestMessagesRepo,
  BookingRequestMessageRow,
} from "@th/ports/repos/booking-request-messages";

import type { PrismaClientOrTx } from "./types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Two-party conversation on a booking request (booking-conversation FR-001 /
 * venue-hierarchy FR-012), and the booking's LEDGER: human messages
 * interleaved with SYSTEM entries for lifecycle transitions.
 *
 * The request IS the thread — no thread row exists; inbox recency lives on
 * the denormalized `BookingRequest.lastMessageAt`, which the USE CASE bumps
 * via `BookingRequestsRepo.touchLastMessageAt` in the same transaction as
 * {@link BookingRequestMessagesRepo.create} (port contract — this repo never
 * reaches across into the request row).
 */
export function makeBookingRequestMessagesRepo(
  p: PrismaClientOrTx,
): BookingRequestMessagesRepo {
  return {
    async create(input) {
      const row = await p.bookingRequestMessage.create({
        data: {
          bookingRequestId: input.bookingRequestId,
          authorSide: input.authorSide,
          authorHumanId: input.authorHumanId ?? null,
          body: input.body,
          // System-entry columns; both stay null for human messages. Params
          // arrive ALREADY zod-validated by `appendBookingSystemEntry` — this
          // repo is a writer, not a validator.
          systemKind: input.systemKind ?? null,
          systemData: toJsonInput(input.systemData ?? null),
        },
      });
      return toMessageRow(row);
    },

    async listForRequest({ bookingRequestId, cursor, limit }) {
      const take = Math.min(
        Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1),
        MAX_LIMIT,
      );

      // Cursor = the LAST row id of the previous page (port contract). Keyset
      // resume needs its (createdAt, id) sort key, so resolve the row —
      // scoped by bookingRequestId, so a foreign/unknown cursor id resolves
      // to nothing and the page restarts from the top instead of leaking
      // another thread's position. Messages are never deleted, so a valid
      // cursor row always still exists.
      const after = cursor
        ? await p.bookingRequestMessage.findFirst({
            where: { id: cursor, bookingRequestId },
            select: { id: true, createdAt: true },
          })
        : null;

      // Chat reading order: createdAt asc, id asc (matches the
      // [bookingRequestId, createdAt] index). take+1 probes for a next page
      // without a second COUNT query.
      const rows = await p.bookingRequestMessage.findMany({
        where: {
          bookingRequestId,
          ...(after
            ? {
                OR: [
                  { createdAt: { gt: after.createdAt } },
                  { createdAt: after.createdAt, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: take + 1,
      });

      const items = rows.slice(0, take).map(toMessageRow);
      const nextCursor =
        rows.length > take ? (items[items.length - 1]?.id ?? null) : null;
      return { items, nextCursor };
    },

    async markRead({ bookingRequestId, side, upToCreatedAt }) {
      // Stamp the COUNTERPARTY's unread messages up to the cutoff.
      // `readAt: null` in the WHERE makes repeats idempotent — already-read
      // rows keep their original stamp.
      //
      // SYSTEM is in the `notIn` alongside the reader's own side: an entry can
      // never be unread (see countUnreadByRequest), so stamping one would be a
      // receipt for a state that does not exist, and it would break the exact
      // complement relationship the two methods are built on. `notIn` rather
      // than an `equals` on the counterparty so that a future fourth HUMAN
      // side would still be swept in by default.
      const result = await p.bookingRequestMessage.updateMany({
        where: {
          bookingRequestId,
          authorSide: { notIn: [side, "SYSTEM"] },
          readAt: null,
          createdAt: { lte: upToCreatedAt },
        },
        data: { readAt: new Date() },
      });
      return result.count;
    },

    async countUnreadByRequest({ bookingRequestIds, side }) {
      // An empty inbox must never issue a query (port contract).
      if (bookingRequestIds.length === 0) return new Map();

      // The exact complement of `markRead`'s WHERE, minus the cutoff: the
      // COUNTERPARTY's rows that are still unstamped. ONE grouped count for the
      // whole page — never findMany-and-map, which would drag every message
      // body over the wire to produce a badge number.
      //
      // SYSTEM IS EXCLUDED — product decision, and the reason this is `notIn`
      // and no longer `not: side`. Unread means "a human is waiting on you".
      // With every lifecycle transition now landing on this thread as an entry,
      // counting them would make the inbox badge fire on your OWN actions:
      // accept your own agreement, and the other side's badge lights up for a
      // message nobody sent.
      const groups = await p.bookingRequestMessage.groupBy({
        by: ["bookingRequestId"],
        where: {
          bookingRequestId: { in: bookingRequestIds },
          authorSide: { notIn: [side, "SYSTEM"] },
          readAt: null,
        },
        _count: { _all: true },
      });

      // Requests with no unread rows are simply absent — callers zero-fill.
      const counts = new Map<string, number>();
      for (const group of groups) {
        counts.set(group.bookingRequestId, group._count._all);
      }
      return counts;
    },

    async hasSystemEntry({ bookingRequestId, kind, dataMatch }) {
      // EXISTENCE only — `select: { id: true }` so this never drags a
      // systemData blob over the wire. Scoped to one request, so the
      // [bookingRequestId, createdAt] index prefix does the work and the
      // deliberate absence of a `systemKind` index costs nothing: a thread is
      // tens of rows, not thousands.
      // `dataMatch` (port doc): every key a top-level JSON path equality on
      // `systemData`, AND-ed. Bound parameters through Prisma's Json filter —
      // never interpolated SQL.
      const row = await p.bookingRequestMessage.findFirst({
        where: {
          bookingRequestId,
          systemKind: kind,
          ...(dataMatch && Object.keys(dataMatch).length > 0
            ? {
                AND: Object.entries(dataMatch).map(([key, value]) => ({
                  systemData: { path: [key], equals: value },
                })),
              }
            : {}),
        },
        select: { id: true },
      });
      return row !== null;
    },
  };
}

/** Prisma row → DTO (adapters never leak Prisma models). */
function toMessageRow(row: BookingRequestMessage): BookingRequestMessageRow {
  return {
    id: row.id,
    bookingRequestId: row.bookingRequestId,
    authorSide: row.authorSide as BookingMessageAuthorSide,
    authorHumanId: row.authorHumanId ?? null,
    body: row.body,
    // Deliberately NOT narrowed to BookingSystemEntryKind: a row written by a
    // newer build can carry a kind this one has never heard of, and a read must
    // never fail on it. Renderers narrow with `isBookingSystemEntryKind` and
    // skip what they do not recognize (port doc: READ POSTURE).
    systemKind: row.systemKind ?? null,
    systemData: toSystemData(row.systemData),
    readAt: row.readAt ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Prisma `Json?` → the DTO's object-or-null. The column also admits arrays and
 * scalars, so non-object JSON is guarded to `null` rather than `as`-cast into
 * a shape it does not have (same discipline as `CalendarRow.eventTemplate`).
 * Params are validated ON WRITE; this is the read-side backstop.
 */
function toSystemData(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** DTO → Prisma Json input (`null` clears via DbNull). */
function toJsonInput(
  value: Record<string, unknown> | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
