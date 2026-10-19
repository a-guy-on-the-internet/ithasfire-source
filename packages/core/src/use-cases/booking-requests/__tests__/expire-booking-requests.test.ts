import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import {
  EXPIRY_SWEEP_BATCH_LIMIT,
  expireBookingRequests,
} from "../expire-booking-requests";
import type { ExpireBookingRequestsDeps } from "../expire-booking-requests";
import {
  NOW,
  buildBookingRequestRecord,
  holdsOf,
  systemEntriesFor,
  withTx,
} from "./helpers";

const EXPIRES_AT = new Date("2026-06-09T12:00:00.000Z");

type BuildOptions = {
  /** The request rows; missing candidate ⇒ gone. Default: each candidate PENDING and past its TTL. */
  rows?: Record<string, BookingRequestRecord>;
  /** Ids whose ledger append should blow up. */
  failEntryFor?: string[];
  /** Replay the candidate list unfiltered on every run (an overlapping sweep's stale read). */
  staleCandidates?: boolean;
};

/**
 * booking-the-night P2d-2 (carry a): the sweep reads CANDIDATES, then expires
 * each one in its own transaction under its booking lock through the guarded
 * `expireIfDue` (still open, still due, no CONFIRMED hold). The fake mirrors
 * that guard on its in-memory rows and the hold fake.
 */
function buildDeps(candidates: string[], options: BuildOptions = {}) {
  const rows: Record<string, BookingRequestRecord> =
    options.rows ??
    Object.fromEntries(
      candidates.map((id) => [
        id,
        buildBookingRequestRecord({ id, status: "PENDING", expiresAt: EXPIRES_AT }),
      ]),
    );
  const order: string[] = [];

  const bookingRequests = {
    // The candidate read is a PRE-READ: it can be stale (a request answered
    // since still listed), so it only drops what this fake has already
    // expired — unless `staleCandidates`, which replays the list as-is (an
    // overlapping run). Capped like the adapter.
    listExpiryCandidates: vi.fn(async ({ limit }: { cutoff: Date; limit: number }) =>
      (options.staleCandidates
        ? candidates
        : candidates.filter((id) => rows[id]?.status !== "EXPIRED")
      ).slice(0, limit),
    ),
    expireIfDue: vi.fn(async ({ id, cutoff }: { id: string; cutoff: Date }) => {
      order.push(`expireIfDue:${id}`);
      const row = rows[id];
      const booked = [...holdsOf(repos).rows.values()].some(
        (h) => h.bookingRequestId === id && h.status === "CONFIRMED",
      );
      if (
        !row ||
        !["PENDING", "VIEWED"].includes(row.status) ||
        !row.expiresAt ||
        row.expiresAt.getTime() > cutoff.getTime() ||
        booked
      ) {
        return null;
      }
      rows[id] = { ...row, status: "EXPIRED" } as BookingRequestRecord;
      return rows[id]!;
    }),
    getById: vi.fn(async (id: string) => rows[id] ?? null),
  };
  const audit = { log: vi.fn(async () => {}) };

  const bookingRequestMessages = createFakeBookingRequestMessagesRepo();
  const realCreate = bookingRequestMessages.create;
  const failing = new Set(options.failEntryFor ?? []);
  bookingRequestMessages.create = vi.fn(async (input) => {
    if (failing.has(input.bookingRequestId)) {
      throw new Error(`ledger down for ${input.bookingRequestId}`);
    }
    return realCreate(input);
  });

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  const reportError = vi.fn();

  const mocks = { bookingRequests, audit, bookingRequestMessages };
  const repos = withTx(mocks);
  const holds = holdsOf(repos);
  vi.mocked(holds.lockRequestBooking).mockImplementation(async (id: string) => {
    order.push(`lock:${id}`);
  });

  const deps: ExpireBookingRequestsDeps = {
    repos: repos as unknown as ExpireBookingRequestsDeps["repos"],
    clock: { now: () => NOW },
    logger: logger as unknown as ExpireBookingRequestsDeps["logger"],
    reportError,
  };

  return { deps, mocks, repos, rows, logger, reportError, order };
}

describe("expireBookingRequests", () => {
  it("expires each due candidate in its own tx — the booking lock FIRST, then the guarded flip — and audits each", async () => {
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    const { deps, mocks, order } = buildDeps(ids);

    const result = await expireBookingRequests(deps, {});

    expect(result).toEqual({ expiredCount: 2, holdNotificationIntents: [] });
    expect(mocks.bookingRequests.listExpiryCandidates).toHaveBeenCalledWith({
      cutoff: NOW,
      limit: EXPIRY_SWEEP_BATCH_LIMIT,
    });
    expect(order).toEqual([
      `lock:${ids[0]}`,
      `expireIfDue:${ids[0]}`,
      `lock:${ids[1]}`,
      `expireIfDue:${ids[1]}`,
    ]);
    for (const id of ids) {
      expect(mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "booking_request",
          entityId: id,
          action: "booking_request.expired",
          data: { expiresAt: EXPIRES_AT },
        }),
      );
    }
  });

  // booking-the-night P2d-2 (carry a): a venue confirm that booked the night
  // between the candidate read and this request's turn — the guarded flip,
  // run under the booking lock, sees the CONFIRMED hold and writes nothing.
  it("a candidate whose night was booked after the candidate read is NOT expired, and nothing is logged", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { deps, repos, rows, mocks } = buildDeps([id]);
    holdsOf(repos).seed({ bookingRequestId: id, calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", date: "2026-07-10", status: "CONFIRMED" });

    const result = await expireBookingRequests(deps, {});

    expect(result.expiredCount).toBe(0);
    expect(rows[id]!.status).toBe("PENDING");
    expect(systemEntriesFor(repos, id)).toEqual([]);
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  // P2d-2 review nit: a run is bounded; a backlog drains over runs.
  it(`one run expires at most ${EXPIRY_SWEEP_BATCH_LIMIT}; the backlog drains on the next run`, async () => {
    expect(EXPIRY_SWEEP_BATCH_LIMIT).toBe(500);
    const ids = Array.from({ length: EXPIRY_SWEEP_BATCH_LIMIT + 1 }, (_, i) =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
    );
    const { deps } = buildDeps(ids);

    expect((await expireBookingRequests(deps, {})).expiredCount).toBe(EXPIRY_SWEEP_BATCH_LIMIT);
    expect((await expireBookingRequests(deps, {})).expiredCount).toBe(1);
    expect((await expireBookingRequests(deps, {})).expiredCount).toBe(0);
  });

  it("does not audit when nothing expired", async () => {
    const { deps, mocks } = buildDeps([]);

    const result = await expireBookingRequests(deps, {});

    expect(result).toEqual({ expiredCount: 0, holdNotificationIntents: [] });
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("appends a machine-caused expired entry to each swept request's ledger", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { deps, repos } = buildDeps([id]);

    await expireBookingRequests(deps, {});

    expect(systemEntriesFor(repos, id)).toEqual([
      {
        systemKind: "booking_request.expired",
        // The sweep is machine-caused, so the deadline has to live in the
        // params — and as an ISO STRING, because systemData is a Json column.
        systemData: { expiresAt: EXPIRES_AT.toISOString() },
        authorHumanId: null,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("survives ONE failing request: the rest of the batch still expires, and the failure is reported", async () => {
    const bad = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const good = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { deps, repos, logger, reportError } = buildDeps([bad, good], {
      failEntryFor: [bad],
    });

    // The SWEEP still succeeds — a batch job must not lose a whole run's work
    // to one bad row. The bad request's transaction rolled back (its flip
    // with it, on a real database), so it does not count as expired.
    await expect(expireBookingRequests(deps, {})).resolves.toEqual({ expiredCount: 1, holdNotificationIntents: [] });

    expect(systemEntriesFor(repos, bad)).toEqual([]);
    expect(systemEntriesFor(repos, good)).toHaveLength(1);

    // A swallow WITHOUT a reporter is the invisible-failure bug class the
    // house convention exists to prevent — the log alone is not enough.
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.expired_entry_failed",
      expect.objectContaining({ bookingRequestId: bad }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "expireBookingRequests" },
        extra: { bookingRequestId: bad },
      }),
    );
  });

  it("a throwing reporter cannot abort the sweep", async () => {
    const bad = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const good = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { deps, repos, reportError } = buildDeps([bad, good], {
      failEntryFor: [bad],
    });
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(expireBookingRequests(deps, {})).resolves.toEqual({ expiredCount: 1, holdNotificationIntents: [] });
    expect(systemEntriesFor(repos, good)).toHaveLength(1);
  });

  it("skips a candidate that raced away (answered between the candidate read and its turn)", async () => {
    const swept = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const raced = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { deps, repos } = buildDeps([swept, raced], {
      rows: {
        [swept]: buildBookingRequestRecord({
          id: swept,
          status: "PENDING",
          expiresAt: EXPIRES_AT,
        }),
        // A concurrent accept won — the candidate list is a PRE-READ, so
        // this one is re-checked under its lock and never expires.
        [raced]: buildBookingRequestRecord({
          id: raced,
          status: "ACCEPTED",
          expiresAt: EXPIRES_AT,
        }),
      },
    });

    const result = await expireBookingRequests(deps, {});
    expect(result.expiredCount).toBe(1);

    expect(systemEntriesFor(repos, swept)).toHaveLength(1);
    expect(systemEntriesFor(repos, raced)).toEqual([]);
  });

  // ── Overlapping sweeps ────────────────────────────────────────────────────
  // A and B both pre-read [X]. A expires X under X's booking lock; B, its
  // turn under the same lock, finds X already EXPIRED — the guarded flip
  // matches nothing, so B writes nothing (no second "This request expired").
  it("a second, overlapping sweep does not double-log the same request", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // ONE repos bag shared by both runs — i.e. one database; the candidate
    // list is stale for run B.
    const { deps, repos, mocks } = buildDeps([id], { staleCandidates: true });

    await expireBookingRequests(deps, {});
    const again = await expireBookingRequests(deps, {});
    // Run B really did reach X (stale list) — and the locked re-check refused it.
    expect(mocks.bookingRequests.expireIfDue).toHaveBeenCalledTimes(2);

    expect(again.expiredCount).toBe(0);
    expect(systemEntriesFor(repos, id)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking-holds FR-009: an expired request leaves every line it was in.
// ─────────────────────────────────────────────────────────────────────────────

describe("expireBookingRequests — releases holds (FR-009)", () => {
  const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const EXPIRED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SURVIVOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("releases the swept request's live holds, moves the other act up, returns the intents, and stays idempotent on a re-run", async () => {
    const { deps, repos } = buildDeps([EXPIRED_ID]);
    const holds = holdsOf(repos);
    const dead = holds.seed({ bookingRequestId: EXPIRED_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    const survivor = holds.seed({ bookingRequestId: SURVIVOR_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });

    const result = await expireBookingRequests(deps, {});

    expect(result.expiredCount).toBe(1);
    expect(holds.rows.get(dead.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
    expect(holds.rows.get(survivor.id)?.position).toBe(1);
    expect(result.holdNotificationIntents).toEqual([
      { kind: "hold.position_changed", bookingRequestId: SURVIVOR_ID, holdId: survivor.id, audience: "act", date: "2026-07-10", position: 1 },
    ]);
    expect(systemEntriesFor(repos, EXPIRED_ID).map((e) => e.systemKind)).toEqual([
      "booking_hold.released",
      "booking_request.expired",
    ]);

    const again = await expireBookingRequests(deps, {});
    expect(again.holdNotificationIntents).toEqual([]);
    expect(systemEntriesFor(repos, EXPIRED_ID)).toHaveLength(2);
  });
});
