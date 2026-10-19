import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { UpdateBookingRequestStatusInput } from "@th/types/repos/booking-requests";

import {
  withdrawBookingRequest,
  withdrawBookingRequestWireOutputSchema,
} from "../withdraw-booking-request";
import type { WithdrawBookingRequestDeps } from "../withdraw-booking-request";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  OTHER_HUMAN_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  withTx,
} from "./helpers";

type BuildDepsOptions = {
  request?: BookingRequestRecord | null;
  membership?: OrgMembership | null;
  /**
   * Simulate the adapter's write-time CAS losing to a concurrent transition
   * invisible to the in-tx re-read (e.g. a just-committed accept).
   */
  updateStatusConflict?: boolean;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const request =
    options.request === undefined
      ? buildBookingRequestRecord()
      : options.request;

  const bookingRequests = {
    getById: vi.fn(async () => request),
    updateStatus: vi.fn(async (input: UpdateBookingRequestStatusInput) => {
      if (
        options.updateStatusConflict ||
        !request ||
        !input.expectedFrom.includes(request.status)
      ) {
        throw {
          code: "conflict",
          message: "booking_request_status_changed",
        } as const;
      }
      return buildBookingRequestRecord({ ...request, status: input.status });
    }),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
  };
  const audit = { log: vi.fn(async () => {}) };

  const mocks = { bookingRequests, authz, audit };

  const deps: WithdrawBookingRequestDeps = {
    repos: withTx(mocks) as unknown as WithdrawBookingRequestDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks };
}

describe("withdrawBookingRequest", () => {
  it("withdraws an open request and audits", async () => {
    const { deps, mocks } = buildDeps();

    const result = await withdrawBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      status: "WITHDRAWN",
      holdNotificationIntents: [],
    });
    expect(mocks.bookingRequests.updateStatus).toHaveBeenCalledWith({
      id: REQUEST_ID,
      status: "WITHDRAWN",
      expectedFrom: ["PENDING", "VIEWED"],
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.withdrawn" }),
    );
  });

  it("is idempotent: withdrawing an already-WITHDRAWN request is a success no-op", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({ status: "WITHDRAWN" }),
    });

    const result = await withdrawBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result.status).toBe("WITHDRAWN");
    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it.each(["DECLINED", "EXPIRED"] as const)(
    "rejects another terminal status (%s) with invalid_status",
    async (status) => {
      const { deps } = buildDeps({
        request: buildBookingRequestRecord({ status }),
      });

      await expect(
        withdrawBookingRequest(deps, {
          actorHumanId: ACTOR_ID,
          bookingRequestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    },
  );

  // booking-the-night N14 / FR-010: an ACCEPTED request to a VENUE has an exit
  // until its night is booked (see withdraw-after-accept.test.ts). An
  // organiser's accepted request to an act keeps none here.
  it("rejects an ACCEPTED organiser request (TO_PERFORMER) with invalid_status", async () => {
    const { deps } = buildDeps({
      request: buildOrganizerBookingRequestRecord({
        status: "ACCEPTED",
        organizerOrgId: ORG_ID,
      }),
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" } as OrgMembership,
    });

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("rejects an actor who is not the human sender", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerId: OTHER_HUMAN_ID,
      }),
    });

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects any actor for an anonymous embed inquiry (no on-platform sender)", async () => {
    // PERMANENT behavior: anonymous inquiries have no on-platform owner, so
    // no signed-in actor can withdraw one (their exit paths are venue
    // decline, expiry, or claim-then-withdraw as the claimed owner).
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "The Basement Tapes",
        contactEmail: "band@example.com",
        source: "EMBED",
      }),
    });

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
  });

  it("rejects the SHADOW owner of an unclaimed inquiry (outreach flip is not consent)", async () => {
    // `notifyBookingInquirer` attaches a shadow performer owner so the venue's
    // reply has somewhere to be mailed. That makes the sender narrowing report
    // `owned`, so without an `isUnclaimedBookingInquiry` guard the gate would
    // collapse to `actorHumanId === shadowHumanId` — and the shadow IS
    // reachable, because signing up with the address upgrades it
    // (apps/api/src/auth/shadow-upgrade.ts) and `requireEmailVerification` is
    // false. Only redeeming the invite-to-claim token proves the mailbox.
    const shadowHumanId = "17171717-1717-4171-8171-171717171717";
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: "human",
        performerOwnerId: shadowHumanId,
        contactName: "The Basement Tapes",
        contactEmail: "band@example.com",
        source: "EMBED",
        claimedAt: null,
      }),
    });

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: shadowHumanId,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
  });

  it("lets the CLAIMED owner withdraw (the token is what opens the gate)", async () => {
    const claimedOwnerId = "17171717-1717-4171-8171-171717171717";
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: "human",
        performerOwnerId: claimedOwnerId,
        contactName: "The Basement Tapes",
        contactEmail: "band@example.com",
        source: "EMBED",
        claimedAt: new Date("2026-06-09T00:00:00.000Z"),
      }),
    });

    const result = await withdrawBookingRequest(deps, {
      actorHumanId: claimedOwnerId,
      bookingRequestId: REQUEST_ID,
    });
    expect(result.status).toBe("WITHDRAWN");
  });

  it("requires an org edit role for an org-sent request", async () => {
    const denied = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" },
    });

    await expect(
      withdrawBookingRequest(denied.deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    const allowed = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" },
    });

    const result = await withdrawBookingRequest(allowed.deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result.status).toBe("WITHDRAWN");
  });

  it("throws not_found for a missing request", async () => {
    const { deps } = buildDeps({ request: null });

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
  });

  it("surfaces a conflict instead of clobbering a concurrently accepted request", async () => {
    // Both reads see PENDING; a concurrent accept commits ACCEPTED (+
    // Agreement) before our guarded write — the CAS must lose loudly rather
    // than overwrite to WITHDRAWN with the agreement still attached.
    const { deps } = buildDeps({ updateStatusConflict: true });

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_status_changed",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking-holds FR-009: a withdrawn request leaves every line it was in.
// ─────────────────────────────────────────────────────────────────────────────

describe("withdrawBookingRequest — releases holds (FR-009)", () => {
  const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const OTHER_REQUEST_ID = "45454545-4545-4545-8545-454545454545";

  it("releases the request's live holds (REQUEST_CLOSED) in the same tx, renumbers, and returns the movers' intents", async () => {
    const { deps } = buildDeps();
    const { holdsOf, systemEntriesFor } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    const theirs = holds.seed({ bookingRequestId: OTHER_REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    const mineChallenged = holds.seed({
      bookingRequestId: REQUEST_ID,
      calendarId: CALENDAR_ID,
      date: "2026-07-11",
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() + 3600_000),
    });

    const result = await withdrawBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID });

    expect(holds.rows.get(mine.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
    expect(holds.rows.get(mineChallenged.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED", respondBy: null });
    expect(holds.rows.get(theirs.id)?.position).toBe(1);
    expect(result.holdNotificationIntents).toEqual([
      { kind: "hold.position_changed", bookingRequestId: OTHER_REQUEST_ID, holdId: theirs.id, audience: "act", date: "2026-07-10", position: 1 },
    ]);
    expect(systemEntriesFor(deps.repos, REQUEST_ID).map((e) => e.systemKind)).toEqual([
      "booking_request.withdrawn",
      "booking_hold.released",
      "booking_hold.released",
    ]);
    expect(systemEntriesFor(deps.repos, OTHER_REQUEST_ID).map((e) => e.systemKind)).toEqual(["booking_hold.reordered"]);
    // The OTHER act's thread never carries the withdrawing act's id (FR-013):
    // the mover's entry is authorless; the withdrawer's own thread keeps it.
    expect(systemEntriesFor(deps.repos, OTHER_REQUEST_ID)[0]!.authorHumanId).toBeNull();
    expect(
      systemEntriesFor(deps.repos, REQUEST_ID).map((e) => e.authorHumanId),
    ).toEqual([ACTOR_ID, ACTOR_ID, ACTOR_ID]);
  });

  it("locks every touched line (sorted) BEFORE reading it — no renumber runs on an unlocked line", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    // Two lines, seeded in REVERSE lock order to prove the sort.
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-11" });
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    holds.seed({ bookingRequestId: OTHER_REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });

    await withdrawBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID });

    const lockCalls = holds.lockLine.mock.calls.map(([k]) => k);
    expect(lockCalls.slice(0, 2)).toEqual([
      { calendarId: CALENDAR_ID, date: "2026-07-10" },
      { calendarId: CALENDAR_ID, date: "2026-07-11" },
    ]);
    // The first lock precedes every line read and every status write.
    const firstLock = holds.lockLine.mock.invocationCallOrder[0]!;
    for (const order of holds.listLine.mock.invocationCallOrder) expect(firstLock).toBeLessThan(order);
    for (const order of holds.updateStatus.mock.invocationCallOrder) expect(firstLock).toBeLessThan(order);
  });

  it("a hold placed on a NEW line between the pre-lock read and the locks → HOLD_LINE_CHANGED, the withdraw rolls back", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    // The competing placement lands as the first LINE lock is being taken:
    // after the release's pre-lock read chose its line set, before the
    // post-lock re-read. (Pinned to the lock, not to "the first
    // listForRequest": the exit reads the request's holds under the booking
    // lock first — booking-the-night W5 — and a hook there would seed the
    // line early enough to be locked normally.)
    vi.mocked(holds.lockLine).mockImplementationOnce(async () => {
      holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-11" });
    });

    await expect(
      withdrawBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "HOLD_LINE_CHANGED", meta: { date: "2026-07-11" } });
    expect(holds.updateStatus).not.toHaveBeenCalled();
    for (const row of holds.rows.values()) expect(row.status).toBe("ACTIVE");
  });

  it("a hold whose status changed between the pre-lock read and the locks is CAS'd from its POST-lock status", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    // Lock-set read sees ACTIVE; a concurrent challenge commits CHALLENGED
    // before the locks are held. Same line, so the release proceeds from
    // the fresh row rather than a CAS on the stale ACTIVE status.
    holds.listForRequest.mockImplementationOnce(async (id: string) => {
      const rows = [...holds.rows.values()].filter((h) => h.bookingRequestId === id);
      holds.rows.set(mine.id, {
        ...mine,
        status: "CHALLENGED",
        challengedAt: NOW,
        respondBy: new Date(NOW.getTime() + 3600_000),
      });
      return rows;
    });

    await withdrawBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID });

    const cas = holds.updateStatus.mock.calls.find(([input]) => input.id === mine.id)?.[0];
    expect(cas).toMatchObject({ status: "RELEASED", expectedFrom: ["CHALLENGED"] });
    expect(holds.rows.get(mine.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED", respondBy: null });
  });

  it("WIRE output (what the sender receives) drops the intents: no other request's id or hold id reaches the act", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    const theirs = holds.seed({ bookingRequestId: OTHER_REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });

    const internal = await withdrawBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID });
    const wire = withdrawBookingRequestWireOutputSchema.parse(internal);

    expect(wire).toEqual({ bookingRequestId: REQUEST_ID, status: "WITHDRAWN" });
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain(OTHER_REQUEST_ID);
    expect(serialized).not.toContain(theirs.id);
    // Sanity: the internal (dispatcher) shape did carry them.
    expect(JSON.stringify(internal)).toContain(OTHER_REQUEST_ID);
  });
});
