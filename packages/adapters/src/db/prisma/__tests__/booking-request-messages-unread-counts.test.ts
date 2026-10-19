import { describe, expect, it, vi } from "vitest";

import { makeBookingRequestMessagesRepo } from "../booking-request-messages";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape coverage for `countUnreadByRequest`, the grouped counting twin
 * of `markRead` (booking-conversation FR-001). Sibling of
 * `booking-requests-open-counts.test.ts`, and for the same reason: the
 * contract is not just "returns numbers".
 *
 *   - the WHERE must be the EXACT complement of what `markRead` stamps
 *     (`authorSide: { notIn: [side, "SYSTEM"] }` + `readAt: null`), or a list
 *     badge and the thread it opens will disagree;
 *   - SYSTEM must be excluded from BOTH. That is an INVERSION of the original
 *     `not: side` rule, made when the thread became the booking's ledger:
 *     unread means "a human is waiting on you", and counting entries would
 *     badge an inbox for the viewer's own lifecycle actions;
 *   - it must be ONE grouped count for the whole page — a findMany-and-map
 *     would drag every message body over the wire to produce a badge number,
 *     and a per-row count would be an N+1.
 *
 * All of it lives in the query Prisma is asked to run, so that is what is
 * asserted. Real-Postgres semantics (SYSTEM rows, mixed read state) are
 * covered in `booking-request-messages-unread-counts.integration.test.ts`.
 */

const REQUEST_A = "44444444-4444-4444-8444-444444444444";
const REQUEST_B = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";

function messagesPrisma(
  groups: unknown[] = [],
  options: { first?: unknown } = {},
) {
  const groupBy = vi.fn(async () => groups);
  const findMany = vi.fn(async () => []);
  const findFirst = vi.fn(async () => options.first ?? null);
  const count = vi.fn(async () => 0);
  const updateMany = vi.fn(async () => ({ count: 0 }));
  const prisma = {
    bookingRequestMessage: {
      groupBy,
      findMany,
      findFirst,
      count,
      updateMany,
    },
  } as unknown as PrismaClientOrTx;
  return { prisma, groupBy, findMany, findFirst, count, updateMany };
}

describe("bookingRequestMessages.countUnreadByRequest", () => {
  it("groups by bookingRequestId with the not-my-side + unread scope (never a list map)", async () => {
    const { prisma, groupBy, findMany } = messagesPrisma([
      { bookingRequestId: REQUEST_A, _count: { _all: 3 } },
    ]);

    const result = await makeBookingRequestMessagesRepo(
      prisma,
    ).countUnreadByRequest({
      bookingRequestIds: [REQUEST_A, REQUEST_B],
      side: "VENUE",
    });

    expect(result).toEqual(new Map([[REQUEST_A, 3]]));
    expect(groupBy).toHaveBeenCalledWith({
      by: ["bookingRequestId"],
      where: {
        bookingRequestId: { in: [REQUEST_A, REQUEST_B] },
        // Load-bearing: the exact complement of markRead's WHERE, and the
        // INVERSION of the old `not: side` rule — SYSTEM sits in the `notIn`
        // so ledger entries never badge an inbox.
        authorSide: { notIn: ["VENUE", "SYSTEM"] },
        readAt: null,
      },
      _count: { _all: true },
    });
    // The counts must never be derived from full message rows.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("uses the viewer's own side for the PERFORMER surface", async () => {
    const { prisma, groupBy } = messagesPrisma();

    await makeBookingRequestMessagesRepo(prisma).countUnreadByRequest({
      bookingRequestIds: [REQUEST_A],
      side: "PERFORMER",
    });

    const args = groupBy.mock.calls[0]![0] as {
      where: { authorSide: { notIn: string[] } };
    };
    expect(args.where.authorSide).toEqual({ notIn: ["PERFORMER", "SYSTEM"] });
  });

  it("markRead excludes SYSTEM with the SAME predicate the count uses", async () => {
    // The two WHEREs must stay exact complements — that is the invariant that
    // stops a list badge and the thread it opens from disagreeing. Asserted
    // side by side so a change to one without the other fails here.
    const { prisma, groupBy, updateMany } = messagesPrisma();
    const repo = makeBookingRequestMessagesRepo(prisma);
    const cutoff = new Date("2026-06-05T00:00:00.000Z");

    await repo.markRead({
      bookingRequestId: REQUEST_A,
      side: "VENUE",
      upToCreatedAt: cutoff,
    });
    await repo.countUnreadByRequest({
      bookingRequestIds: [REQUEST_A],
      side: "VENUE",
    });

    const stampWhere = (
      updateMany.mock.calls[0]![0] as unknown as {
        where: Record<string, unknown>;
      }
    ).where;
    const countWhere = (
      groupBy.mock.calls[0]![0] as unknown as {
        where: Record<string, unknown>;
      }
    ).where;

    expect(stampWhere).toEqual({
      bookingRequestId: REQUEST_A,
      authorSide: { notIn: ["VENUE", "SYSTEM"] },
      readAt: null,
      createdAt: { lte: cutoff },
    });
    // Identical apart from the cutoff and the id-vs-IN scoping.
    expect(countWhere.authorSide).toEqual(stampWhere.authorSide);
    expect(countWhere.readAt).toEqual(stampWhere.readAt);
  });

  it("omits requests with no unread rows (callers zero-fill)", async () => {
    const { prisma } = messagesPrisma([
      { bookingRequestId: REQUEST_B, _count: { _all: 1 } },
    ]);

    const result = await makeBookingRequestMessagesRepo(
      prisma,
    ).countUnreadByRequest({
      bookingRequestIds: [REQUEST_A, REQUEST_B],
      side: "VENUE",
    });

    expect(result.get(REQUEST_A)).toBeUndefined();
    expect(result.get(REQUEST_B)).toBe(1);
  });

  it("short-circuits an empty id set without querying", async () => {
    const { prisma, groupBy } = messagesPrisma();

    await expect(
      makeBookingRequestMessagesRepo(prisma).countUnreadByRequest({
        bookingRequestIds: [],
        side: "VENUE",
      }),
    ).resolves.toEqual(new Map());
    expect(groupBy).not.toHaveBeenCalled();
  });
});

/**
 * The at-most-once guard the expiry sweep uses. Its whole job is to answer
 * EXISTENCE cheaply and scoped to ONE request, so that is the query shape
 * asserted: no `systemData` selected (the column is a Json blob), and the
 * WHERE carries the `bookingRequestId` that makes the existing
 * `[bookingRequestId, createdAt]` index cover it.
 */
describe("bookingRequestMessages.hasSystemEntry", () => {
  it("probes ONE request for ONE kind, selecting only the id", async () => {
    const { prisma, findFirst } = messagesPrisma([], {
      first: { id: "msg-1" },
    });

    await expect(
      makeBookingRequestMessagesRepo(prisma).hasSystemEntry({
        bookingRequestId: REQUEST_A,
        kind: "booking_request.expired",
      }),
    ).resolves.toBe(true);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        bookingRequestId: REQUEST_A,
        systemKind: "booking_request.expired",
      },
      select: { id: true },
    });
  });

  it("is false when the thread has no entry of that kind", async () => {
    const { prisma } = messagesPrisma();

    await expect(
      makeBookingRequestMessagesRepo(prisma).hasSystemEntry({
        bookingRequestId: REQUEST_A,
        kind: "booking_request.expired",
      }),
    ).resolves.toBe(false);
  });
});
