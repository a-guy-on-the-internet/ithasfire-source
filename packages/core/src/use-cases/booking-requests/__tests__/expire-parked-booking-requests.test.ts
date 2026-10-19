import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import {
  expireParkedBookingRequests,
  type ExpireParkedBookingRequestsDeps,
} from "../expire-parked-booking-requests";
import {
  NOW,
  PLACE_ID,
  buildBookingRequestRecord,
  holdsOf,
  systemEntriesFor,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The 2026-09-25 amendment's cleanup (step 3): every request still PARKED at
// an unclaimed venue is expired through the expiry machinery — booking lock,
// guarded flip that clears the stamp, holds released, ONE note to the sender
// — and a second run finds nothing.
// ─────────────────────────────────────────────────────────────────────────────

const PARKED_AT = new Date("2026-06-01T12:00:00.000Z");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function parked(
  id: string,
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return {
    ...buildBookingRequestRecord({
      id,
      status: "PENDING",
      parkedUnclaimedAt: PARKED_AT,
      // A parked row's deadline may be in the future, or (seeded) absent.
      expiresAt: null,
    }),
    placeName: "The Unclaimed Stage",
    ...overrides,
  } as BookingRequestRecord;
}

function buildDeps(
  initial: BookingRequestRecord[],
  options: { failFor?: string[] } = {},
) {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const order: string[] = [];

  const bookingRequests = {
    // The adapter's filter: TO_VENUE, stamped, OPEN — oldest first, capped.
    listOpenParked: vi.fn(async ({ limit }: { limit: number }) =>
      [...rows.values()]
        .filter(
          (row) =>
            row.parkedUnclaimedAt !== null &&
            ["PENDING", "VIEWED"].includes(row.status),
        )
        .slice(0, limit),
    ),
    // The adapter's guard: still open, still parked, no CONFIRMED hold.
    // Flips to EXPIRED and clears the stamp in one statement.
    expireParked: vi.fn(async ({ id }: { id: string }) => {
      order.push(`expireParked:${id}`);
      if ((options.failFor ?? []).includes(id)) {
        throw new Error(`db down for ${id}`);
      }
      const row = rows.get(id);
      const booked = [...holdsOf(repos).rows.values()].some(
        (h) => h.bookingRequestId === id && h.status === "CONFIRMED",
      );
      if (
        !row ||
        row.parkedUnclaimedAt === null ||
        !["PENDING", "VIEWED"].includes(row.status) ||
        booked
      ) {
        return null;
      }
      const next = {
        ...row,
        status: "EXPIRED",
        parkedUnclaimedAt: null,
      } as BookingRequestRecord;
      rows.set(id, next);
      return next;
    }),
    getById: vi.fn(async (id: string) => rows.get(id) ?? null),
  };
  const audit = { log: vi.fn(async () => {}) };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  const reportError = vi.fn();
  const notifyBookingLineupRequestClosed = vi.fn(async () => {});

  const repos = withTx({ bookingRequests, audit });
  vi.mocked(holdsOf(repos).lockRequestBooking).mockImplementation(
    async (id: string) => {
      order.push(`lock:${id}`);
    },
  );

  const deps: ExpireParkedBookingRequestsDeps = {
    repos: repos as unknown as ExpireParkedBookingRequestsDeps["repos"],
    clock: { now: () => NOW },
    logger: logger as unknown as ExpireParkedBookingRequestsDeps["logger"],
    reportError,
    notifyBookingLineupRequestClosed,
  };
  return {
    deps,
    repos,
    rows,
    order,
    audit,
    logger,
    reportError,
    notifyBookingLineupRequestClosed,
    bookingRequests,
  };
}

describe("expireParkedBookingRequests", () => {
  it("dry run lists every open parked request and writes NOTHING", async () => {
    const { deps, repos, rows, bookingRequests, audit } = buildDeps([
      parked(A),
      parked(B, { status: "VIEWED", source: "EMBED" }),
    ]);

    const result = await expireParkedBookingRequests(deps, { dryRun: true });

    expect(result).toEqual({
      dryRun: true,
      candidates: [
        {
          bookingRequestId: A,
          placeId: PLACE_ID,
          placeName: "The Unclaimed Stage",
          status: "PENDING",
          source: "PLATFORM",
          parkedUnclaimedAt: PARKED_AT.toISOString(),
          outcome: "would_expire",
        },
        expect.objectContaining({
          bookingRequestId: B,
          status: "VIEWED",
          source: "EMBED",
          outcome: "would_expire",
        }),
      ],
      expiredCount: 0,
      holdNotificationIntents: [],
    });
    expect(bookingRequests.expireParked).not.toHaveBeenCalled();
    expect(rows.get(A)!.status).toBe("PENDING");
    expect(systemEntriesFor(repos, A)).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("commit: lock FIRST, then the guarded flip; EXPIRED, stamp cleared, ONE note to the sender, audited", async () => {
    const { deps, repos, rows, order, audit, notifyBookingLineupRequestClosed } =
      buildDeps([parked(A)]);

    const result = await expireParkedBookingRequests(deps, { dryRun: false });

    expect(result.expiredCount).toBe(1);
    expect(result.candidates).toEqual([
      expect.objectContaining({ bookingRequestId: A, outcome: "expired" }),
    ]);
    expect(order).toEqual([`lock:${A}`, `expireParked:${A}`]);
    expect(rows.get(A)).toMatchObject({
      status: "EXPIRED",
      parkedUnclaimedAt: null,
    });
    // ONE note — the amendment's sentence, not a second `expired` entry.
    expect(systemEntriesFor(repos, A)).toEqual([
      {
        systemKind: "booking_request.expired_unclaimed",
        systemData: { placeName: "The Unclaimed Stage" },
        authorHumanId: null,
        authorSide: "SYSTEM",
      },
    ]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_request",
        entityId: A,
        action: "booking_request.expired_unclaimed",
        data: {
          placeId: PLACE_ID,
          parkedUnclaimedAt: PARKED_AT.toISOString(),
          releasedHolds: 0,
        },
        at: NOW,
      }),
    );
    // Joined acts hear it isn't going ahead, as on any expiry.
    expect(notifyBookingLineupRequestClosed).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ id: A, status: "EXPIRED" }),
      closedBy: "expired",
      actorHumanId: null,
    });
  });

  it("is IDEMPOTENT: a second commit finds nothing and writes nothing", async () => {
    const { deps, repos, audit } = buildDeps([parked(A)]);

    await expireParkedBookingRequests(deps, { dryRun: false });
    audit.log.mockClear();
    const again = await expireParkedBookingRequests(deps, { dryRun: false });

    expect(again).toEqual({
      dryRun: false,
      candidates: [],
      expiredCount: 0,
      holdNotificationIntents: [],
    });
    expect(systemEntriesFor(repos, A)).toHaveLength(1);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("releases the request's live holds in the same transaction", async () => {
    const { deps, repos } = buildDeps([parked(A)]);
    holdsOf(repos).seed({
      bookingRequestId: A,
      calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      date: "2026-07-10",
      status: "ACTIVE",
    });

    const result = await expireParkedBookingRequests(deps, { dryRun: false });

    expect(result.expiredCount).toBe(1);
    expect(
      [...holdsOf(repos).rows.values()].filter((h) => h.bookingRequestId === A)
        .map((h) => h.status),
    ).toEqual(["RELEASED"]);
  });

  it("a request whose night is BOOKED is skipped under the lock: not expired, no note", async () => {
    const { deps, repos, rows, audit } = buildDeps([parked(A)]);
    holdsOf(repos).seed({
      bookingRequestId: A,
      calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      date: "2026-07-10",
      status: "CONFIRMED",
    });

    const result = await expireParkedBookingRequests(deps, { dryRun: false });

    expect(result.expiredCount).toBe(0);
    expect(result.candidates).toEqual([
      expect.objectContaining({ bookingRequestId: A, outcome: "skipped" }),
    ]);
    expect(rows.get(A)!.status).toBe("PENDING");
    expect(systemEntriesFor(repos, A)).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("closed requests that still carry the stamp are not touched (only OPEN parked requests are expired)", async () => {
    const { deps, bookingRequests } = buildDeps([
      parked(A, { status: "WITHDRAWN" }),
      parked(B, { status: "EXPIRED" }),
    ]);

    const result = await expireParkedBookingRequests(deps, { dryRun: false });

    expect(result.candidates).toEqual([]);
    expect(bookingRequests.expireParked).not.toHaveBeenCalled();
  });

  it("names 'This place' when the place row is gone: the snapshot is null", async () => {
    const { deps, repos } = buildDeps([parked(A, { placeName: null })]);

    await expireParkedBookingRequests(deps, { dryRun: false });

    expect(systemEntriesFor(repos, A)[0]!.systemData).toEqual({
      placeName: null,
    });
  });

  it("one request's failure is SCOPED: rolled back, logged at error AND reported; the rest still expire", async () => {
    const { deps, rows, logger, reportError } = buildDeps(
      [parked(A), parked(B)],
      { failFor: [A] },
    );

    const result = await expireParkedBookingRequests(deps, { dryRun: false });

    expect(result.candidates.map((c) => [c.bookingRequestId, c.outcome])).toEqual([
      [A, "failed"],
      [B, "expired"],
    ]);
    expect(result.expiredCount).toBe(1);
    expect(rows.get(A)!.status).toBe("PENDING");
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.expire_parked_failed",
      expect.objectContaining({ bookingRequestId: A }),
    );
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "expireParkedBookingRequests" },
      extra: { bookingRequestId: A },
    });
  });

  it("a throwing reporter never aborts the run", async () => {
    const { deps } = buildDeps([parked(A), parked(B)], { failFor: [A] });
    deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    const result = await expireParkedBookingRequests(deps, { dryRun: false });

    expect(result.expiredCount).toBe(1);
  });

  it("rejects input that is not exactly { dryRun }", async () => {
    const { deps } = buildDeps([]);
    await expect(expireParkedBookingRequests(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      expireParkedBookingRequests(deps, { dryRun: false, limit: 5 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
