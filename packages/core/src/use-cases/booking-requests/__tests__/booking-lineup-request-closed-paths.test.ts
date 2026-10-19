import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { UpdateBookingRequestStatusInput } from "@th/types/repos/booking-requests";

import { expireBookingRequests } from "../expire-booking-requests";
import type { ExpireBookingRequestsDeps } from "../expire-booking-requests";
import { respondToBookingRequest } from "../respond-to-booking-request";
import type { RespondToBookingRequestDeps } from "../respond-to-booking-request";
import { withdrawBookingRequest } from "../withdraw-booking-request";
import type { WithdrawBookingRequestDeps } from "../withdraw-booking-request";
import {
  ACTOR_ID,
  NOW,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  makeFakeIdempotency,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Every way a request closes tells the acts that JOINED its bill (lineup v3,
// L7 / FR-012b): the venue's decline, the sender's withdraw, the expiry
// sweep. Post-commit, once per close, never the reason — and a failing
// notifier is a deliberate swallow (logger.error + guarded reportError).
// The notifier itself (who hears, what it says) has its own suite.
// ─────────────────────────────────────────────────────────────────────────────

function statusRepo(initial: BookingRequestRecord) {
  let current = initial;
  return {
    getById: vi.fn(async (id: string) => (id === current.id ? current : null)),
    updateStatus: vi.fn(async (input: UpdateBookingRequestStatusInput) => {
      if (!input.expectedFrom.includes(current.status)) {
        throw { code: "conflict", message: "booking_request_status_changed" } as const;
      }
      current = {
        ...current,
        status: input.status,
        declineReason: input.declineReason ?? current.declineReason,
      };
      return current;
    }),
  };
}

const logger = () => {
  const l = { child: () => l, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return l;
};

describe("respondToBookingRequest — a TO_VENUE decline", () => {
  function build(options: { notifierFails?: boolean } = {}) {
    const bookingRequests = statusRepo(buildBookingRequestRecord());
    const repos = withTx({
      bookingRequests,
      places: { getById: vi.fn(async () => buildPlaceRecord()) },
      authz: { getOrgMemberships: vi.fn(async () => []) },
      audit: { log: vi.fn(async () => {}) },
    });
    const notifyBookingLineupRequestClosed = vi.fn(async () => {
      if (options.notifierFails) throw new Error("notify down");
    });
    const reportError = vi.fn(() => {
      throw new Error("reporter down too");
    });
    const log = logger();
    const deps = {
      repos: repos as unknown as RespondToBookingRequestDeps["repos"],
      idempotency: makeFakeIdempotency(),
      clock: { now: () => NOW },
      logger: log as unknown as RespondToBookingRequestDeps["logger"],
      notifyBookingLineupRequestClosed,
      reportError,
    } satisfies RespondToBookingRequestDeps;
    return { deps, notifyBookingLineupRequestClosed, reportError, log };
  }

  const decline = {
    actorHumanId: ACTOR_ID,
    bookingRequestId: REQUEST_ID,
    action: "decline",
    declineReason: "We are fully booked that month.",
  };

  it("tells the joined acts once — the hook never carries the reason — and a replay tells nobody again", async () => {
    const { deps, notifyBookingLineupRequestClosed } = build();
    await respondToBookingRequest(deps, decline);
    expect(notifyBookingLineupRequestClosed).toHaveBeenCalledTimes(1);
    expect(notifyBookingLineupRequestClosed).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ id: REQUEST_ID, status: "DECLINED" }),
      closedBy: "declined",
      actorHumanId: ACTOR_ID,
    });
    // The idempotent replay serves the cached response; no second notice.
    await respondToBookingRequest(deps, decline);
    expect(notifyBookingLineupRequestClosed).toHaveBeenCalledTimes(1);
  });

  it("a failing notifier never fails the committed decline; a throwing reporter changes nothing", async () => {
    const { deps, reportError, log } = build({ notifierFails: true });
    await expect(respondToBookingRequest(deps, decline)).resolves.toMatchObject({
      status: "DECLINED",
    });
    expect(log.error).toHaveBeenCalledWith(
      "booking_requests.notify_lineup_request_closed_failed",
      expect.objectContaining({ bookingRequestId: REQUEST_ID, closedBy: "declined" }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "respondToBookingRequest", step: "lineup_request_closed" },
      }),
    );
  });
});

describe("withdrawBookingRequest", () => {
  function build(request: BookingRequestRecord, options: { notifierFails?: boolean } = {}) {
    const repos = withTx({
      bookingRequests: statusRepo(request),
      authz: { getOrgMembership: vi.fn(async () => null) },
      audit: { log: vi.fn(async () => {}) },
    });
    const notifyBookingLineupRequestClosed = vi.fn(async () => {
      if (options.notifierFails) throw new Error("notify down");
    });
    const reportError = vi.fn();
    const log = logger();
    const deps = {
      repos: repos as unknown as WithdrawBookingRequestDeps["repos"],
      clock: { now: () => NOW },
      logger: log as unknown as WithdrawBookingRequestDeps["logger"],
      notifyBookingLineupRequestClosed,
      reportError,
    } satisfies WithdrawBookingRequestDeps;
    return { deps, notifyBookingLineupRequestClosed, reportError, log };
  }

  const withdraw = { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID };

  it("tells the joined acts, naming the withdrawer as the actor (skipped in group fan-outs)", async () => {
    const { deps, notifyBookingLineupRequestClosed } = build(buildBookingRequestRecord());
    await withdrawBookingRequest(deps, withdraw);
    expect(notifyBookingLineupRequestClosed).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ status: "WITHDRAWN" }),
      closedBy: "withdrawn",
      actorHumanId: ACTOR_ID,
    });
  });

  it("an already-WITHDRAWN request (idempotent repeat) tells nobody", async () => {
    const { deps, notifyBookingLineupRequestClosed } = build(
      buildBookingRequestRecord({ status: "WITHDRAWN" }),
    );
    await withdrawBookingRequest(deps, withdraw);
    expect(notifyBookingLineupRequestClosed).not.toHaveBeenCalled();
  });

  it("a failing notifier is logged AND reported; the withdraw stands", async () => {
    const { deps, reportError, log } = build(buildBookingRequestRecord(), { notifierFails: true });
    await expect(withdrawBookingRequest(deps, withdraw)).resolves.toMatchObject({
      status: "WITHDRAWN",
    });
    expect(log.error).toHaveBeenCalledWith(
      "booking_requests.notify_lineup_request_closed_failed",
      expect.any(Object),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "withdrawBookingRequest", step: "lineup_request_closed" },
      }),
    );
  });
});

describe("expireBookingRequests", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const EXPIRES_AT = new Date("2026-06-09T12:00:00.000Z");

  function build(options: { notifierFailsFor?: string } = {}) {
    const rows: Record<string, BookingRequestRecord> = {
      [A]: buildBookingRequestRecord({ id: A, status: "PENDING", expiresAt: EXPIRES_AT }),
      [B]: buildBookingRequestRecord({ id: B, status: "PENDING", expiresAt: EXPIRES_AT }),
    };
    const repos = withTx({
      bookingRequests: {
        // booking-the-night P2d-2 (carry a): candidates, then a guarded
        // per-request flip (open → EXPIRED once; a repeat finds it closed).
        listExpiryCandidates: vi.fn(async () => [A, B]),
        expireIfDue: vi.fn(async ({ id }: { id: string }) => {
          const row = rows[id];
          if (!row || row.status !== "PENDING") return null;
          rows[id] = { ...row, status: "EXPIRED" } as BookingRequestRecord;
          return rows[id]!;
        }),
        getById: vi.fn(async (id: string) => rows[id] ?? null),
      },
      audit: { log: vi.fn(async () => {}) },
    });
    const notifyBookingLineupRequestClosed = vi.fn(
      async (args: { bookingRequest: BookingRequestRecord }) => {
        if (args.bookingRequest.id === options.notifierFailsFor) {
          throw new Error("notify down");
        }
      },
    );
    const reportError = vi.fn();
    const log = logger();
    const deps = {
      repos: repos as unknown as ExpireBookingRequestsDeps["repos"],
      clock: { now: () => NOW },
      logger: log as unknown as ExpireBookingRequestsDeps["logger"],
      reportError,
      notifyBookingLineupRequestClosed,
    } satisfies ExpireBookingRequestsDeps;
    return { deps, notifyBookingLineupRequestClosed, reportError };
  }

  it("tells each newly expired request's joined acts once; a second sweep (entry already there) tells nobody", async () => {
    const { deps, notifyBookingLineupRequestClosed } = build();
    await expireBookingRequests(deps, {});
    expect(notifyBookingLineupRequestClosed.mock.calls.map(([args]) => args)).toEqual([
      { bookingRequest: expect.objectContaining({ id: A }), closedBy: "expired", actorHumanId: null },
      { bookingRequest: expect.objectContaining({ id: B }), closedBy: "expired", actorHumanId: null },
    ]);
    // An overlapping / repeated run finds the requests already expired.
    await expireBookingRequests(deps, {});
    expect(notifyBookingLineupRequestClosed).toHaveBeenCalledTimes(2);
  });

  it("one request's failing notice is reported and the next still goes out", async () => {
    const { deps, notifyBookingLineupRequestClosed, reportError } = build({ notifierFailsFor: A });
    await expect(expireBookingRequests(deps, {})).resolves.toMatchObject({ expiredCount: 2 });
    expect(notifyBookingLineupRequestClosed).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "expireBookingRequests", step: "lineup_request_closed" },
      }),
    );
  });
});
