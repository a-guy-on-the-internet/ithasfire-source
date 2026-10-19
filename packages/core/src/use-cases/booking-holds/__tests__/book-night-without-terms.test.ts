import { beforeEach, describe, expect, it, vi } from "vitest";

import { bookNightWithoutTerms } from "../book-night-without-terms";
import { committedHoldIntentsOf } from "../_shared/booking-hold-intents";
import { HOLD_MINT_AGREEMENT_STATUSES } from "../../booking-agreements/create-event-from-agreement";
import { deriveAgreementPitchProvenance } from "../../booking-agreements/_shared/pitch-seed";
import { makeFakeIdempotency } from "../../booking-requests/__tests__/helpers";
import {
  ACT_A_ID,
  AGREEMENT_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  ORG_ID,
  OTHER_CALENDAR_ID,
  OUTSIDER_ID,
  REQUEST_A,
  REQUEST_B,
  REQUEST_C,
  PLACE_ID,
  SPACE_ID,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "./hold-test-context";
import type { FakeBookingHoldsRepo } from "./fakes";

// ─────────────────────────────────────────────────────────────────────────────
// bookNightWithoutTerms (booking-the-night FR-004, N3) — the former hold
// confirm's body plus three gates: the place's STAFF (never a booking grantee,
// holds-without-a-request FR-002), the hold belongs to the
// request, and its night is one the pitch asked for. N6 now runs inside tx1:
// a hold with another party ahead of it (or a night another party booked) is
// refused NIGHT_TAKEN. Most of this suite pins the inherited body (lock order,
// pre-flight, header alignment, the post-commit mint).
// ─────────────────────────────────────────────────────────────────────────────

/** Every night the suite books, after a FIRST preferred date that is none of them. */
const ASKED_FOR = ["2026-07-10", DATE, "2026-06-27", "2026-06-01"];

/** An existing DRAFT agreement whose venue counterparty is the owning org. */
const ORG_AGREEMENT = {
  id: AGREEMENT_ID,
  status: "DRAFT",
  eventId: null,
  draftEventId: null,
  counterpartyType: "organization",
  counterpartyId: ORG_ID,
};

// The post-commit mint is the EXISTING create-event-from-agreement path
// (hold variant), pinned by its own suite. Here it is a boundary: what
// matters is what confirm hands it, and what confirm does when it throws.
const mintForHold = vi.fn();
vi.mock("../../booking-agreements/create-event-from-agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../booking-agreements/create-event-from-agreement")>()),
  createEventFromAgreementForHold: (...args: unknown[]) => mintForHold(...args),
}));

const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
/** 20:00 America/Chicago (CDT) on DATE — the calendar's defaultStartTime. */
const EXPECTED_STARTS_AT = new Date("2026-06-21T01:00:00.000Z");

function buildDeps() {
  const ctx = buildHoldTestContext();
  for (const [id, row] of ctx.requests) {
    ctx.requests.set(id, { ...row, preferredDates: ASKED_FOR });
  }
  const deps = {
    repos: ctx.repos,
    idempotency: makeFakeIdempotency(),
    clock: ctx.deps.clock,
    reportError: vi.fn(),
    authz: { canManagePlace: vi.fn(async () => ({ allowed: true })) },
  };
  return { ...ctx, deps };
}

type Deps = ReturnType<typeof buildDeps>["deps"];

/** The use case, with the request id read off the hold (the thread it is booked from). */
function book(deps: Deps, input: { actorHumanId: string; holdId: string }) {
  const hold = (deps.repos.bookingHolds as unknown as FakeBookingHoldsRepo).rows.get(input.holdId);
  return bookNightWithoutTerms(deps, {
    ...input,
    bookingRequestId: hold?.bookingRequestId ?? REQUEST_A,
  });
}

beforeEach(() => {
  mintForHold.mockReset();
  mintForHold.mockResolvedValue({ eventId: EVENT_ID, alreadyLinked: false, finalized: false });
});

describe("bookNightWithoutTerms", () => {
  it("accepts the open request, confirms the hold, releases siblings + competitors, renumbers, then mints on the hold's date/calendar/space", async () => {
    const ctx = buildDeps();
    const winner = ctx.seedHold(REQUEST_A, { spaceId: SPACE_ID });
    const competitor = ctx.seedHold(REQUEST_B);
    const sibling = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
    const siblingLineMate = ctx.seedHold(REQUEST_C, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });

    const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

    // tx1 — statuses.
    expect(ctx.bookingHolds.rows.get(winner.id)).toMatchObject({ status: "CONFIRMED", confirmedAt: NOW });
    expect(ctx.bookingHolds.rows.get(competitor.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    expect(ctx.bookingHolds.rows.get(sibling.id)).toMatchObject({ status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });
    expect(ctx.bookingHolds.rows.get(siblingLineMate.id)?.position).toBe(1);
    // tx1 — the request was ACCEPTED via the shared accept body.
    expect(ctx.requests.get(REQUEST_A)).toMatchObject({ status: "ACCEPTED", agreementId: AGREEMENT_ID });
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual([
      "booking_hold.released", // sibling
      "booking_request.accepted",
      "booking_hold.confirmed",
    ]);
    expect(ctx.entries(REQUEST_A).at(-1)).toEqual({
      kind: "booking_hold.confirmed",
      data: { holdId: winner.id, eventId: null, withoutTerms: true },
      actor: STAFF_ID,
    });
    expect(ctx.entries(REQUEST_B)).toEqual([
      { kind: "booking_hold.released", data: { holdId: competitor.id, reason: "CONFIRMED_OTHER" }, actor: STAFF_ID },
    ]);

    // Post-commit mint — hold placement + anchored start.
    expect(mintForHold).toHaveBeenCalledTimes(1);
    expect(mintForHold.mock.calls[0]![1]).toEqual({
      actorHumanId: STAFF_ID,
      agreementId: AGREEMENT_ID,
      hold: { id: winner.id, calendarId: CALENDAR_ID, spaceId: SPACE_ID, date: DATE, startsAt: EXPECTED_STARTS_AT, endsAt: null },
    });

    expect(result).toMatchObject({
      hold: { id: winner.id, status: "CONFIRMED" },
      eventId: EVENT_ID,
      agreementId: AGREEMENT_ID,
    });
    expect(result.releasedHoldIds.sort()).toEqual([sibling.id, competitor.id].sort());
    expect(result.notificationIntents).toEqual([
      { kind: "hold.confirmed", bookingRequestId: REQUEST_A, holdId: winner.id, audience: "act", date: DATE },
      { kind: "hold.released", bookingRequestId: REQUEST_A, holdId: sibling.id, audience: "act", date: "2026-06-27", reason: "SIBLING_CONFIRMED" },
      { kind: "hold.lost_date", bookingRequestId: REQUEST_B, holdId: competitor.id, audience: "act", date: DATE, reason: "CONFIRMED_OTHER" },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_C, holdId: siblingLineMate.id, audience: "act", date: "2026-06-27", position: 1 },
    ]);
  });

  it("locks the hold's line AND every sibling line up front, in sorted order, before any line read", async () => {
    const ctx = buildDeps();
    const winner = ctx.seedHold(REQUEST_A);
    // Siblings seeded OUT of lock order (a later calendar first, then an
    // earlier date on the winner's calendar) to prove the sort: keys order
    // by calendarId ("cccc…" < "cdcd…"), then date.
    ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
    ctx.seedHold(REQUEST_A, { calendarId: CALENDAR_ID, date: "2026-06-01" });

    await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

    const firstThree = vi.mocked(ctx.bookingHolds.lockLine).mock.calls.slice(0, 3).map(([k]) => k);
    expect(firstThree).toEqual([
      { calendarId: CALENDAR_ID, date: "2026-06-01" },
      { calendarId: CALENDAR_ID, date: DATE },
      { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" },
    ]);
    const firstLock = vi.mocked(ctx.bookingHolds.lockLine).mock.invocationCallOrder[0]!;
    for (const order of vi.mocked(ctx.bookingHolds.listLine).mock.invocationCallOrder) expect(firstLock).toBeLessThan(order);
    for (const order of vi.mocked(ctx.bookingHolds.updateStatus).mock.invocationCallOrder) expect(firstLock).toBeLessThan(order);
  });

  it("a sibling hold that lands on a NEW line between the pre-lock read and the locks → HOLD_LINE_CHANGED, nothing written", async () => {
    const ctx = buildDeps();
    const winner = ctx.seedHold(REQUEST_A);
    const competitor = ctx.seedHold(REQUEST_B);
    // First listForRequest (lock set) sees only the winner's line; by the
    // post-lock re-read a sibling exists on another line.
    vi.mocked(ctx.bookingHolds.listForRequest).mockImplementationOnce(async (id: string) => {
      const rows = [...ctx.bookingHolds.rows.values()].filter((h) => h.bookingRequestId === id);
      ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
      return rows;
    });

    await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
      code: "HOLD_LINE_CHANGED",
      meta: { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27", reason: "line_set_grew" },
    });
    expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(mintForHold).not.toHaveBeenCalled();
  });

  it("a sibling whose status changed between the pre-lock read and the locks is CAS'd from its POST-lock status", async () => {
    const ctx = buildDeps();
    const winner = ctx.seedHold(REQUEST_A);
    const sibling = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
    // The lock-set read sees the sibling ACTIVE; by the time the locks are
    // held a concurrent challenge has committed CHALLENGED. Same line set
    // (no new line), so the confirm must proceed — from the fresh row.
    vi.mocked(ctx.bookingHolds.listForRequest).mockImplementationOnce(async (id: string) => {
      const rows = [...ctx.bookingHolds.rows.values()].filter((h) => h.bookingRequestId === id);
      ctx.bookingHolds.rows.set(sibling.id, {
        ...sibling,
        status: "CHALLENGED",
        challengedAt: NOW,
        respondBy: new Date(NOW.getTime() + 3600_000),
      });
      return rows;
    });

    await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

    const siblingCas = vi.mocked(ctx.bookingHolds.updateStatus).mock.calls.find(([input]) => input.id === sibling.id)?.[0];
    expect(siblingCas).toMatchObject({ status: "RELEASED", expectedFrom: ["CHALLENGED"] });
    expect(ctx.bookingHolds.rows.get(sibling.id)).toMatchObject({
      status: "RELEASED",
      releasedReason: "SIBLING_CONFIRMED",
      respondBy: null,
    });
    expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("CONFIRMED");
  });

  it("N6: a hold with another act AHEAD of it → NIGHT_TAKEN naming the position-1 hold; nothing written, nothing minted", async () => {
    const ctx = buildDeps();
    ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT });
    ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
    const first = ctx.seedHold(REQUEST_A);
    const second = ctx.seedHold(REQUEST_B);

    await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: second.id })).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: DATE, position: 1, aheadHoldId: first.id, booked: false, challengeable: true },
    });

    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(first.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(second.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(ctx.entries(REQUEST_B)).toEqual([]);
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(mintForHold).not.toHaveBeenCalled();
  });

  it("an ACCEPTED request whose hold is first in line is not re-accepted", async () => {
    const ctx = buildDeps();
    ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT });
    ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
    const first = ctx.seedHold(REQUEST_B);
    ctx.seedHold(REQUEST_A);

    const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: first.id });

    expect(result.hold.status).toBe("CONFIRMED");
    expect(ctx.bookingRequests.updateStatus).not.toHaveBeenCalled();
    expect(ctx.entries(REQUEST_B).map((e) => e.kind)).toEqual(["booking_hold.confirmed"]);
  });

  it("is idempotent: a second confirm skips tx1 and returns the agreement's existing event without minting", async () => {
    const ctx = buildDeps();
    const winner = ctx.seedHold(REQUEST_A);
    const first = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });
    // The real mint stamps the draft anchor AND the row exists; emulate both
    // on the fakes (an anchor with no row is the deleted-between-reads case,
    // which re-mints by design).
    ctx.agreements.set(AGREEMENT_ID, { ...ctx.agreements.get(AGREEMENT_ID)!, draftEventId: EVENT_ID });
    ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT });
    mintForHold.mockClear();

    const second = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

    expect(second.eventId).toBe(first.eventId);
    expect(second.notificationIntents).toEqual([]);
    expect(second.releasedHoldIds).toEqual([]);
    expect(mintForHold).not.toHaveBeenCalled();
    expect(ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_hold.confirmed")).toHaveLength(1);
  });

  it("mint throws → tx1 stays committed (hold CONFIRMED, request ACCEPTED), error propagates, re-run heals by minting only", async () => {
    const ctx = buildDeps();
    const winner = ctx.seedHold(REQUEST_A);
    const competitor = ctx.seedHold(REQUEST_B);
    mintForHold.mockRejectedValueOnce(new Error("quota_exceeded"));

    await expect(
      book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id }),
    ).rejects.toThrow("quota_exceeded");

    expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("CONFIRMED");
    expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("RELEASED");
    expect(ctx.requests.get(REQUEST_A)?.status).toBe("ACCEPTED");

    const healed = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });
    expect(healed.eventId).toBe(EVENT_ID);
    expect(mintForHold).toHaveBeenCalledTimes(2);
    // No second accept, no second confirm entry.
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_request.accepted", "booking_hold.confirmed"]);
  });

  it("two bookings in one line: the second reads the first's CONFIRMED row under the lock → NIGHT_TAKEN (booked, nothing to challenge)", async () => {
    const ctx = buildDeps();
    const a = ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    // Emulate the race: A won while B's caller still held a live snapshot of B.
    await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });
    ctx.bookingHolds.rows.set(b.id, { ...ctx.bookingHolds.rows.get(b.id)!, status: "ACTIVE", releasedReason: null, releasedAt: null, position: 1 });

    await expect(
      book(ctx.deps, { actorHumanId: STAFF_ID, holdId: b.id }),
    ).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: DATE, aheadHoldId: null, booked: true, challengeable: false },
    });
    expect(ctx.bookingHolds.rows.get(b.id)?.status).toBe("ACTIVE");
  });

  it("the DB's one-CONFIRMED-per-line unique is still the backstop behind the lock → HOLD_LINE_ALREADY_CONFIRMED", async () => {
    const ctx = buildDeps();
    const a = ctx.seedHold(REQUEST_A);
    // A winner the line read misses (a lock the fake cannot enforce) is still
    // caught by the unique index on the CAS.
    const listLine = vi.mocked(ctx.bookingHolds.listLine);
    const realListLine = listLine.getMockImplementation()!;
    listLine.mockImplementation(async (input) => (input.statuses ? [] : realListLine(input)));
    ctx.bookingHolds.seed({ bookingRequestId: REQUEST_B, calendarId: CALENDAR_ID, date: DATE, status: "CONFIRMED", position: 9 });

    await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id })).rejects.toMatchObject({
      code: "HOLD_LINE_ALREADY_CONFIRMED",
    });
  });

  it("refuses a RELEASED hold, an anonymous open request, and a closed request", async () => {
    const ctx = buildDeps();
    const dead = ctx.seedHold(REQUEST_A, { status: "RELEASED", releasedReason: "MANUAL" });
    await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: dead.id })).rejects.toMatchObject({
      code: "BOOKING_HOLD_NOT_LIVE",
    });

    ctx.requests.set(REQUEST_B, {
      ...ctx.requests.get(REQUEST_B)!,
      performerOwnerType: null,
      performerOwnerId: null,
      contactName: "Anon",
      contactEmail: "anon@example.com",
    });
    const anon = ctx.seedHold(REQUEST_B);
    await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: anon.id })).rejects.toMatchObject({
      code: "HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST",
    });

    ctx.requests.set(REQUEST_C, { ...ctx.requests.get(REQUEST_C)!, status: "DECLINED" });
    const closed = ctx.seedHold(REQUEST_C);
    await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: closed.id })).rejects.toMatchObject({
      code: "INVALID_STATUS",
      message: "booking_request_closed",
    });
    expect(mintForHold).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("ACCEPTED-but-unclaimed anonymous request (no agreement): refused BEFORE tx1 — competitors keep their holds, nothing is released", async () => {
    const ctx = buildDeps();
    ctx.requests.set(REQUEST_B, {
      ...ctx.requests.get(REQUEST_B)!,
      status: "ACCEPTED",
      agreementId: null,
      performerOwnerType: null,
      performerOwnerId: null,
      contactName: "Anon",
      contactEmail: "anon@example.com",
    });
    const anon = ctx.seedHold(REQUEST_B);
    const competitor = ctx.seedHold(REQUEST_A);

    await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: anon.id })).rejects.toMatchObject({
      code: "HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST",
      meta: { bookingRequestId: REQUEST_B, status: "ACCEPTED" },
    });

    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(anon.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(mintForHold).not.toHaveBeenCalled();
  });

  describe("pre-flight: deterministic mint failures are refused BEFORE tx1", () => {
    function acceptedWithAgreement(ctx: ReturnType<typeof buildDeps>, agreement: Record<string, unknown>) {
      ctx.agreements.set(AGREEMENT_ID, agreement);
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);
      return { winner, competitor };
    }

    function expectNothingWritten(ctx: ReturnType<typeof buildDeps>, ids: { winner: { id: string }; competitor: { id: string } }) {
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(ids.winner.id)?.status).toBe("ACTIVE");
      expect(ctx.bookingHolds.rows.get(ids.competitor.id)?.status).toBe("ACTIVE");
      expect(ctx.entries(REQUEST_A)).toEqual([]);
      expect(ctx.entries(REQUEST_B)).toEqual([]);
      expect(mintForHold).not.toHaveBeenCalled();
      // Honest even if a write ever moves OUTSIDE the tx.
      expect(ctx.audit.log).not.toHaveBeenCalled();
      expect(ctx.bookingRequests.updateStatus).not.toHaveBeenCalled();
    }

    it("human counterparty ≠ actor → NOT_RESOURCE_OWNER (the mint would refuse to save under another human)", async () => {
      const ctx = buildDeps();
      const ids = acceptedWithAgreement(ctx, { ...ORG_AGREEMENT, counterpartyType: "human", counterpartyId: OUTSIDER_ID });

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: ids.winner.id })).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "agreement_counterparty", counterpartyId: OUTSIDER_ID },
      });
      expectNothingWritten(ctx, ids);
    });

    // Owner by intent (venue-confirmation spec): a RENT / USE mint is
    // REQUESTER-owned, so the venue-counterparty rule does not apply — a
    // second direct owner may confirm it. (Was: a grant holder; a grantee is
    // not staff since holds-without-a-request FR-002, see the suite below.)
    it("a second direct owner confirms a RENT hold whose agreement names ANOTHER human counterparty: no NOT_RESOURCE_OWNER, the mint runs", async () => {
      const ctx = buildDeps();
      const ids = acceptedWithAgreement(ctx, { ...ORG_AGREEMENT, counterpartyType: "human", counterpartyId: OUTSIDER_ID });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, intent: "RENT", spaceId: SPACE_ID });
      const CO_OWNER_ID = "17171717-1717-4171-8171-171717171717";
      ctx.place.humanIdsWithAccess.push(CO_OWNER_ID);

      const result = await book(ctx.deps, { actorHumanId: CO_OWNER_ID, holdId: ids.winner.id });

      expect(result.eventId).toBe(EVENT_ID);
      expect(ctx.bookingHolds.rows.get(ids.winner.id)?.status).toBe("CONFIRMED");
      expect(mintForHold).toHaveBeenCalledTimes(1);
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({ actorHumanId: CO_OWNER_ID, agreementId: AGREEMENT_ID });
      expect(mintForHold.mock.calls[0]![1]).not.toHaveProperty("ownerOverride");
    });

    // holds-without-a-request FR-002: booking an ACT's night is staff-only.
    // Before, a grant passed the gate and the mint's grantee rule (FR-006,
    // revised 2026-09-08) refused only the venue-owned cases
    // (grant_cannot_mint_venue_owned); an OPEN RENT request was booked by the
    // grantee under the owning org, and a replay handed the event back. Every
    // case is now refused at the STAFF gate, before tx1, nothing written.
    describe("booking grantee — refused at the staff gate (FR-002)", () => {
      const GRANTEE_ID = "17171717-1717-4171-8171-171717171717";

      function openWithCompetitor(ctx: ReturnType<typeof buildDeps>) {
        const winner = ctx.seedHold(REQUEST_B);
        const competitor = ctx.seedHold(REQUEST_A);
        return { winner, competitor };
      }

      it("an OPEN PERFORM request → NOT_RESOURCE_OWNER BEFORE tx1, nothing written", async () => {
        const ctx = buildDeps();
        const ids = openWithCompetitor(ctx);
        ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });

        await expect(book(ctx.deps, { actorHumanId: GRANTEE_ID, holdId: ids.winner.id })).rejects.toMatchObject({
          code: "NOT_RESOURCE_OWNER",
          meta: { entity: "place" },
        });
        expectNothingWritten(ctx, ids);
        expect(ctx.requests.get(REQUEST_B)?.status).not.toBe("ACCEPTED");
        expect(ctx.agreements.get(AGREEMENT_ID)).toBeUndefined();
      });

      it("an ACCEPTED PERFORM agreement naming the grantee as counterparty → still refused BEFORE tx1", async () => {
        const ctx = buildDeps();
        const ids = acceptedWithAgreement(ctx, { ...ORG_AGREEMENT, counterpartyType: "human", counterpartyId: GRANTEE_ID });
        ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });

        await expect(book(ctx.deps, { actorHumanId: GRANTEE_ID, holdId: ids.winner.id })).rejects.toMatchObject({
          code: "NOT_RESOURCE_OWNER",
        });
        expectNothingWritten(ctx, ids);
      });

      // Was: a replay handed the event back to the grantee.
      it("a replay of an already-minted hold → refused (was: returned the event), zero writes", async () => {
        const ctx = buildDeps();
        ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT });
        ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "ACCEPTED", eventId: EVENT_ID });
        ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
        const winner = ctx.seedHold(REQUEST_B, { status: "CONFIRMED", confirmedAt: NOW, placedByHumanId: GRANTEE_ID });
        ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });

        await expect(book(ctx.deps, { actorHumanId: GRANTEE_ID, holdId: winner.id })).rejects.toMatchObject({
          code: "NOT_RESOURCE_OWNER",
        });
        expect(ctx.repos.tx).not.toHaveBeenCalled();
        expect(mintForHold).not.toHaveBeenCalled();
        expect(ctx.audit.log).not.toHaveBeenCalled();
      });

      // Was: the grantee booked it, the agreement naming the owning org.
      it("an OPEN RENT request → refused (was: booked under the owning org), nothing written", async () => {
        const ctx = buildDeps();
        ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, intent: "RENT", spaceId: SPACE_ID });
        const ids = openWithCompetitor(ctx);
        ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID, calendarId: CALENDAR_ID });

        await expect(book(ctx.deps, { actorHumanId: GRANTEE_ID, holdId: ids.winner.id })).rejects.toMatchObject({
          code: "NOT_RESOURCE_OWNER",
        });
        expectNothingWritten(ctx, ids);
        expect(ctx.agreements.get(AGREEMENT_ID)).toBeUndefined();
        // The staff gate never reads grants.
        expect(ctx.placeBookingGrants.findActiveForActor).not.toHaveBeenCalled();
      });
    });

    it("org counterparty the actor holds no edit role in → INSUFFICIENT_ROLE", async () => {
      const ctx = buildDeps();
      const ids = acceptedWithAgreement(ctx, { ...ORG_AGREEMENT });
      // VIEWER is a member of ORG_ID, but the org save needs an edit role.
      // (VIEWER cannot pass the place gate either — so seed direct human
      // ownership for the place to isolate the agreement-level check.)
      ctx.place.humanIdsWithAccess.push(VIEWER_ID);

      await expect(book(ctx.deps, { actorHumanId: VIEWER_ID, holdId: ids.winner.id })).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expectNothingWritten(ctx, ids);
    });

    it("terminal agreement → INVALID_STATUS agreement_terminal", async () => {
      const ctx = buildDeps();
      const ids = acceptedWithAgreement(ctx, { ...ORG_AGREEMENT, status: "DECLINED" });

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: ids.winner.id })).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "agreement_terminal",
      });
      expectNothingWritten(ctx, ids);
    });

    it("agreement row missing → AGREEMENT_NOT_FOUND before tx1", async () => {
      const ctx = buildDeps();
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "AGREEMENT_NOT_FOUND",
      });
      expectNothingWritten(ctx, { winner, competitor });
    });

    it("an already-minted agreement whose event IS on the hold's night skips the ownership check and hands back that event", async () => {
      const ctx = buildDeps();
      // 20:00 Chicago on DATE — same place-local day as the hold.
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT });
      const ids = acceptedWithAgreement(ctx, {
        ...ORG_AGREEMENT,
        counterpartyType: "human",
        counterpartyId: OUTSIDER_ID,
        draftEventId: EVENT_ID,
      });

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: ids.winner.id });
      expect(result.eventId).toBe(EVENT_ID);
      expect(mintForHold).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(ids.competitor.id)?.status).toBe("RELEASED");
    });

    it("an already-minted agreement whose event is on ANOTHER night → HOLD_DATE_MISMATCHES_EVENT before tx1 (competitors keep the date)", async () => {
      const ctx = buildDeps();
      // 23:30 Chicago the night BEFORE the hold (= 04:30Z on DATE): a UTC-day
      // comparison would call this a match; the place day says otherwise.
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: new Date("2026-06-20T04:30:00.000Z") });
      const ids = acceptedWithAgreement(ctx, { ...ORG_AGREEMENT, draftEventId: EVENT_ID });

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: ids.winner.id })).rejects.toMatchObject({
        code: "HOLD_DATE_MISMATCHES_EVENT",
        meta: { holdDate: DATE, eventDate: "2026-06-19", eventId: EVENT_ID },
      });
      expectNothingWritten(ctx, ids);
    });

    it("an already-minted agreement whose event row is GONE goes through the mint and returns the FRESH id, never the stale anchor", async () => {
      const ctx = buildDeps();
      const FRESH_EVENT_ID = "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3";
      const ids = acceptedWithAgreement(ctx, { ...ORG_AGREEMENT, draftEventId: EVENT_ID });
      // draftEventId set, no event row (deleted between reads; FK SetNull
      // pending/landed) → the mint mints fresh over the cleared anchor.
      mintForHold.mockResolvedValueOnce({ eventId: FRESH_EVENT_ID, alreadyLinked: false, finalized: false });

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: ids.winner.id });

      expect(result.eventId).toBe(FRESH_EVENT_ID);
      expect(result.eventId).not.toBe(EVENT_ID);
      expect(mintForHold).toHaveBeenCalledTimes(1);
      expect(ctx.bookingHolds.rows.get(ids.winner.id)?.status).toBe("CONFIRMED");
    });
  });

  it("AGREEMENT_NOT_FOUND AFTER tx1 (the accept minted an id the read cannot see): tx1 stays committed, error propagates, replay heals", async () => {
    const ctx = buildDeps();
    const winner = ctx.seedHold(REQUEST_A);
    const competitor = ctx.seedHold(REQUEST_B);
    // The agreement written by the in-tx accept vanishes for ONE read.
    const realGetById = ctx.repos.agreements.getById as ReturnType<typeof vi.fn>;
    realGetById.mockImplementationOnce(async () => null);

    await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
      code: "AGREEMENT_NOT_FOUND",
    });

    expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("CONFIRMED");
    expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("RELEASED");
    expect(ctx.requests.get(REQUEST_A)).toMatchObject({ status: "ACCEPTED", agreementId: AGREEMENT_ID });
    expect(mintForHold).not.toHaveBeenCalled();

    const healed = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });
    expect(healed.eventId).toBe(EVENT_ID);
    expect(mintForHold).toHaveBeenCalledTimes(1);
  });

  describe("open challenge in the line (owner ruling 2026-08-27)", () => {
    const OPEN = { status: "CHALLENGED", challengedAt: NOW, respondBy: new Date(NOW.getTime() + 3600_000) };
    const LAPSED = { status: "CHALLENGED", challengedAt: new Date(NOW.getTime() - 86_400_000), respondBy: new Date(NOW.getTime() - 60_000) };

    it("another hold in the line has an open challenge (only position 1 can be, so it is AHEAD) → NIGHT_TAKEN, not challengeable again; no status writes, no releases, no ledger, no intents", async () => {
      const ctx = buildDeps();
      const challenged = ctx.seedHold(REQUEST_B, OPEN);
      const target = ctx.seedHold(REQUEST_A);
      const competitor = ctx.seedHold(REQUEST_C);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: target.id })).rejects.toMatchObject({
        code: "NIGHT_TAKEN",
        meta: { date: DATE, position: 1, aheadHoldId: challenged.id, booked: false, challengeable: false },
      });

      expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
      expect(ctx.audit.log).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(target.id)?.status).toBe("ACTIVE");
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
      expect(ctx.bookingHolds.rows.get(challenged.id)).toMatchObject({ status: "CHALLENGED", respondBy: OPEN.respondBy });
      expect(ctx.requests.get(REQUEST_A)?.status).not.toBe("ACCEPTED");
      expect(ctx.entries(REQUEST_A)).toEqual([]);
      expect(ctx.entries(REQUEST_B)).toEqual([]);
      expect(ctx.entries(REQUEST_C)).toEqual([]);
      expect(mintForHold).not.toHaveBeenCalled();
    });

    it("confirming the challenged hold ITSELF is allowed (the venue saying yes early)", async () => {
      const ctx = buildDeps();
      const challenged = ctx.seedHold(REQUEST_A, OPEN);
      const competitor = ctx.seedHold(REQUEST_B);

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: challenged.id });

      expect(result.hold.status).toBe("CONFIRMED");
      expect(ctx.bookingHolds.rows.get(challenged.id)).toMatchObject({ status: "CONFIRMED", confirmedAt: NOW, respondBy: null, challengedAt: null });
      expect(ctx.bookingHolds.rows.get(competitor.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
      expect(mintForHold).toHaveBeenCalledTimes(1);
    });

    it("a LAPSED challenge on another hold is settled first (released EXPIRED), then the confirm proceeds", async () => {
      const ctx = buildDeps();
      const lapsed = ctx.seedHold(REQUEST_B, LAPSED);
      const target = ctx.seedHold(REQUEST_A);

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: target.id });

      expect(result.hold.status).toBe("CONFIRMED");
      expect(ctx.bookingHolds.rows.get(lapsed.id)).toMatchObject({ status: "RELEASED", releasedReason: "EXPIRED" });
      expect(ctx.entries(REQUEST_B)).toEqual([
        { kind: "booking_hold.released", data: { holdId: lapsed.id, reason: "EXPIRED" }, actor: null },
      ]);
      // Order: settle's release of the lapsed hold lands BEFORE the winner's CAS.
      const writes = vi.mocked(ctx.bookingHolds.updateStatus).mock.calls.map(([input]) => [input.id, input.status]);
      expect(writes[0]).toEqual([lapsed.id, "RELEASED"]);
      expect(writes).toContainEqual([target.id, "CONFIRMED"]);
      expect(writes.findIndex(([id]) => id === lapsed.id)).toBeLessThan(writes.findIndex(([id, st]) => id === target.id && st === "CONFIRMED"));
      // The lapsed hold expired on its own clock — it is not a CONFIRMED_OTHER loser.
      expect(result.releasedHoldIds).toEqual([]);
      expect(result.notificationIntents.map((i) => i.kind)).toEqual(["hold.expired", "hold.expired", "hold.position_changed", "hold.confirmed"]);
    });

    it("an open challenge on a DIFFERENT date's line does not block", async () => {
      const ctx = buildDeps();
      const elsewhere = ctx.seedHold(REQUEST_B, { ...OPEN, date: "2026-06-27" });
      const target = ctx.seedHold(REQUEST_A);

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: target.id });

      expect(result.hold.status).toBe("CONFIRMED");
      expect(ctx.bookingHolds.rows.get(elsewhere.id)?.status).toBe("CHALLENGED");
    });

    it("an already-CONFIRMED hold re-run (mint retry) returns the same event WITHOUT hitting the guard, even with a later open challenge in the line", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, draftEventId: EVENT_ID });
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT });
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const confirmed = ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW });
      const challenged = ctx.seedHold(REQUEST_B, OPEN);

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: confirmed.id });

      expect(result).toMatchObject({ hold: { id: confirmed.id, status: "CONFIRMED" }, eventId: EVENT_ID, releasedHoldIds: [] });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(challenged.id)?.status).toBe("CHALLENGED");
      expect(mintForHold).not.toHaveBeenCalled();
    });
  });

  it("the act cannot book", async () => {
    const ctx = buildDeps();
    const a = ctx.seedHold(REQUEST_A);
    await expect(book(ctx.deps, { actorHumanId: ACT_A_ID, holdId: a.id })).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  describe("the confirmed hold's night is the agreed date (agreement header alignment)", () => {
    /** What the accept seeds from the harness pitch: 2026-07-10 @ 20:00 Chicago. */
    const PITCH_SEEDED_DATE = new Date("2026-07-11T01:00:00.000Z");
    /** The request's pitch, as the provenance read sees it. */
    const pitchContext = { timezone: "America/Chicago", calendarDefaultStartTime: "20:00", settlementCurrency: "usd" };

    it("hold on a date other than the pitch's first preferred date → proposedDate becomes the hold's anchored instant (the mint's startsAt), the seeded 45-min span rides along, provenance drops", async () => {
      const ctx = buildDeps();
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, setLengthMinutes: 45 });
      const winner = ctx.seedHold(REQUEST_A);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      const agreement = ctx.agreements.get(AGREEMENT_ID)!;
      // The accept seeded start + 45 min on the pitch night; the 45-min span
      // is preserved onto the hold's start (same answer addSetLength gives).
      expect(agreement).toMatchObject({
        proposedDate: EXPECTED_STARTS_AT,
        proposedEndDate: new Date(EXPECTED_STARTS_AT.getTime() + 45 * 60_000),
      });
      // ONE header write, CAS'd on the hold-mintable statuses, inside tx1
      // (before the confirm ledger entry).
      const updateHeader = (ctx.repos.agreements.updateHeader as ReturnType<typeof vi.fn>);
      expect(updateHeader).toHaveBeenCalledTimes(1);
      expect(updateHeader.mock.calls[0]![0]).toEqual({
        id: AGREEMENT_ID,
        // Never PROPOSED or ACCEPTED: terms the sender has seen or agreed are
        // not rewritten (review W3 / W4).
        expectedFrom: HOLD_MINT_AGREEMENT_STATUSES.filter((status) => status !== "PROPOSED" && status !== "ACCEPTED"),
        proposedDate: EXPECTED_STARTS_AT,
        proposedEndDate: new Date(EXPECTED_STARTS_AT.getTime() + 45 * 60_000),
      });
      // The event is minted on the SAME instants the header now carries —
      // the end tx1 wrote rides into the mint, not a +3h default.
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({
        hold: { startsAt: agreement.proposedDate, endsAt: agreement.proposedEndDate },
      });
      // Audit carries the correction; the ledger gets no extra entry (no
      // header-edit kind exists — booking_hold.confirmed records the date).
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking_hold.confirmed",
          data: expect.objectContaining({ agreementDateAligned: { from: PITCH_SEEDED_DATE, to: EXPECTED_STARTS_AT } }),
        }),
      );
      expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_request.accepted", "booking_hold.confirmed"]);
      // Provenance flips by derivation: the stored instant is no longer the pitch's.
      const provenance = deriveAgreementPitchProvenance(agreement as never, ctx.requests.get(REQUEST_A)!, pitchContext);
      expect(provenance.proposedDate).toBe(false);
      expect(provenance.proposedEndDate).toBe(false);
    });

    it("no set length → proposedEndDate null; a hold on a calendar without a default start anchors at 19:00 place time", async () => {
      const ctx = buildDeps();
      const winner = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      // 2026-06-27 19:00 CDT.
      const expected = new Date("2026-06-28T00:00:00.000Z");
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ proposedDate: expected, proposedEndDate: null });
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({ hold: { calendarId: OTHER_CALENDAR_ID, startsAt: expected } });
    });

    // ── P3b (asks) ── review W3: terms that named no date when the sender
    // answered the SET_LENGTH ask get start + minutes once the night is
    // booked here.
    it("dateless DRAFT terms, no pitch set length → the ANSWERED set-length ask sets the booked night's end", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "DRAFT", proposedDate: null, proposedEndDate: null });
      ctx.requests.set(REQUEST_B, {
        ...ctx.requests.get(REQUEST_B)!,
        status: "ACCEPTED",
        agreementId: AGREEMENT_ID,
        setLengthMinutes: null,
      });
      ctx.bookingRequests.listAsks.mockResolvedValue([
        { kind: "SET_LENGTH", status: "ANSWERED", answerMinutes: 50, answeredAt: NOW },
      ] as never);
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      const agreement = ctx.agreements.get(AGREEMENT_ID)!;
      const start = agreement.proposedDate as Date | null;
      expect(start).toBeInstanceOf(Date);
      expect(agreement.proposedEndDate).toEqual(
        new Date(start!.getTime() + 50 * 60_000),
      );
    });

    it("hold on the pitch's first preferred date → no header write; pitch provenance survives", async () => {
      const ctx = buildDeps();
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: [DATE], setLengthMinutes: 45 });
      const winner = ctx.seedHold(REQUEST_A);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
      const agreement = ctx.agreements.get(AGREEMENT_ID)!;
      expect(agreement).toMatchObject({
        proposedDate: EXPECTED_STARTS_AT,
        proposedEndDate: new Date(EXPECTED_STARTS_AT.getTime() + 45 * 60_000),
      });
      expect(deriveAgreementPitchProvenance(agreement as never, ctx.requests.get(REQUEST_A)!, pitchContext).proposedDate).toBe(true);
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking_hold.confirmed", data: expect.objectContaining({ agreementDateAligned: null }) }),
      );
    });

    it("already-ACCEPTED request with DRAFT terms on the wrong night → header aligned in tx1 (no re-accept), negotiated 1h span preserved", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "DRAFT", proposedDate: PITCH_SEEDED_DATE, proposedEndDate: new Date(PITCH_SEEDED_DATE.getTime() + 3600_000) });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.bookingRequests.updateStatus).not.toHaveBeenCalled();
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({
        status: "DRAFT",
        proposedDate: EXPECTED_STARTS_AT,
        proposedEndDate: new Date(EXPECTED_STARTS_AT.getTime() + 3600_000),
      });
    });

    // Review W3: terms out with the sender are never rewritten by a booking.
    it("PROPOSED terms for ANOTHER night → TERMS_SENT_FOR_ANOTHER_NIGHT before any write", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "PROPOSED", proposedDate: PITCH_SEEDED_DATE });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "TERMS_SENT_FOR_ANOTHER_NIGHT",
        meta: { agreementId: AGREEMENT_ID, holdDate: DATE, termsDate: "2026-07-10" },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
      expect(mintForHold).not.toHaveBeenCalled();
    });

    it("terms SENT for another night after pre-flight are caught in tx1 too — no header rewrite, nothing minted", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "DRAFT", proposedDate: PITCH_SEEDED_DATE });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      // The venue's send lands after pre-flight (the 1st read): every read
      // inside tx1 sees PROPOSED terms for another night.
      const getById = vi.mocked(ctx.repos.agreements.getById);
      const real = getById.getMockImplementation()!;
      let reads = 0;
      getById.mockImplementation(async (id: string) => {
        reads += 1;
        const row = await real(id);
        return (reads === 1 || !row ? row : { ...row, status: "PROPOSED" }) as never;
      });

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "TERMS_SENT_FOR_ANOTHER_NIGHT",
      });
      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
      expect(mintForHold).not.toHaveBeenCalled();
    });

    it("W3: terms SENT for another night lose the header CAS race (the write never targets PROPOSED) → TERMS_SENT_FOR_ANOTHER_NIGHT, nothing minted", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "DRAFT", proposedDate: PITCH_SEEDED_DATE });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      // The venue's send commits between tx1's read and its header write.
      const updateHeader = vi.mocked(ctx.repos.agreements.updateHeader);
      updateHeader.mockImplementationOnce(async (input: { expectedFrom: readonly string[] }) => {
        ctx.agreements.set(AGREEMENT_ID, { ...ctx.agreements.get(AGREEMENT_ID)!, status: "PROPOSED" });
        expect(input.expectedFrom).not.toContain("PROPOSED");
        throw { code: "conflict", message: "agreement_status_changed" };
      });

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "TERMS_SENT_FOR_ANOTHER_NIGHT",
        meta: { termsDate: "2026-07-10", holdDate: DATE },
      });
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ status: "PROPOSED", proposedDate: PITCH_SEEDED_DATE });
      expect(mintForHold).not.toHaveBeenCalled();
    });

    it("W3: terms SENT for THIS night lose the header CAS race → the booking proceeds without rewriting them, and the event starts at their instant", async () => {
      const ctx = buildDeps();
      const termsAt = new Date("2026-06-21T02:15:00.000Z"); // 21:15 CDT on DATE
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "DRAFT", proposedDate: PITCH_SEEDED_DATE });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      vi.mocked(ctx.repos.agreements.updateHeader).mockImplementationOnce(async () => {
        ctx.agreements.set(AGREEMENT_ID, { ...ctx.agreements.get(AGREEMENT_ID)!, status: "PROPOSED", proposedDate: termsAt });
        throw { code: "conflict", message: "agreement_status_changed" };
      });

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("CONFIRMED");
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ status: "PROPOSED", proposedDate: termsAt });
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({ hold: { startsAt: termsAt } });
    });

    it("PROPOSED terms for THIS night stand as sent: no header write, and the event starts at the terms' instant", async () => {
      const ctx = buildDeps();
      // 21:15 CDT on DATE — the venue's own time, not the calendar default.
      const termsAt = new Date("2026-06-21T02:15:00.000Z");
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "PROPOSED", proposedDate: termsAt });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ status: "PROPOSED", proposedDate: termsAt });
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({ hold: { startsAt: termsAt } });
    });

    it("a venue-edited 2h span on the wrong night is shifted onto the hold's start (beats the request's set length)", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, proposedDate: PITCH_SEEDED_DATE, proposedEndDate: new Date(PITCH_SEEDED_DATE.getTime() + 2 * 3600_000) });
      // The pitch said 45 minutes; the negotiated two hours wins.
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID, setLengthMinutes: 45 });
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({
        proposedDate: EXPECTED_STARTS_AT,
        proposedEndDate: new Date(EXPECTED_STARTS_AT.getTime() + 2 * 3600_000),
      });
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking_hold.confirmed",
          data: expect.objectContaining({ agreementDateAligned: { from: PITCH_SEEDED_DATE, to: EXPECTED_STARTS_AT } }),
        }),
      );
    });

    it("the act NAMED a time on the hold's date → header AND mint use that slot, not the calendar default", async () => {
      const ctx = buildDeps();
      // First preferred date is another night; the second names 21:30 on DATE.
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: ["2026-07-10", `${DATE}T21:30`] });
      const winner = ctx.seedHold(REQUEST_A);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      // 2026-06-20 21:30 CDT.
      const named = new Date("2026-06-21T02:30:00.000Z");
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ proposedDate: named, proposedEndDate: null });
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({ hold: { startsAt: named } });
    });

    it("a date-only entry on the hold's date names no time → calendar default", async () => {
      const ctx = buildDeps();
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: ["2026-07-10T21:30", DATE] });
      const winner = ctx.seedHold(REQUEST_A);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ proposedDate: EXPECTED_STARTS_AT });
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({ hold: { startsAt: EXPECTED_STARTS_AT } });
    });

    it("an existing draft event on the hold's night at ANOTHER time is the authority: header aligned to the event's own instants, no mint", async () => {
      const ctx = buildDeps();
      // Venue hand-placed the event at 21:30–23:30 CDT on DATE; the calendar default is 20:00.
      const eventStart = new Date("2026-06-21T02:30:00.000Z");
      const eventEnd = new Date("2026-06-21T04:30:00.000Z");
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: eventStart, endsAt: eventEnd } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, draftEventId: EVENT_ID, proposedDate: PITCH_SEEDED_DATE, proposedEndDate: new Date(PITCH_SEEDED_DATE.getTime() + 3600_000) });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID, setLengthMinutes: 45 });
      const winner = ctx.seedHold(REQUEST_B);

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(result.eventId).toBe(EVENT_ID);
      expect(mintForHold).not.toHaveBeenCalled();
      const updateHeader = ctx.repos.agreements.updateHeader as ReturnType<typeof vi.fn>;
      expect(updateHeader).toHaveBeenCalledTimes(1);
      // The EVENT's span (2h) — not the stored 1h, not the pitch's 45 min.
      expect(updateHeader.mock.calls[0]![0]).toMatchObject({ proposedDate: eventStart, proposedEndDate: eventEnd });
      const agreement = ctx.agreements.get(AGREEMENT_ID)!;
      expect(deriveAgreementPitchProvenance(agreement as never, ctx.requests.get(REQUEST_B)!, pitchContext).proposedDate).toBe(false);
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking_hold.confirmed",
          data: expect.objectContaining({ agreementDateAligned: { from: PITCH_SEEDED_DATE, to: eventStart } }),
        }),
      );
    });

    it("an existing event already at the header's instants (start AND end) → no write", async () => {
      const ctx = buildDeps();
      const end = new Date(EXPECTED_STARTS_AT.getTime() + 2 * 3600_000);
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT, endsAt: end } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, draftEventId: EVENT_ID, proposedDate: EXPECTED_STARTS_AT, proposedEndDate: end });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
      expect(mintForHold).not.toHaveBeenCalled();
    });

    it("an existing event at the header's start but with a DIFFERENT end → one write, end aligned to the event", async () => {
      const ctx = buildDeps();
      const eventEnd = new Date(EXPECTED_STARTS_AT.getTime() + 2 * 3600_000);
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT, endsAt: eventEnd } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, draftEventId: EVENT_ID, proposedDate: EXPECTED_STARTS_AT, proposedEndDate: new Date(EXPECTED_STARTS_AT.getTime() + 3600_000) });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      const updateHeader = ctx.repos.agreements.updateHeader as ReturnType<typeof vi.fn>;
      expect(updateHeader).toHaveBeenCalledTimes(1);
      expect(updateHeader.mock.calls[0]![0]).toMatchObject({ proposedDate: EXPECTED_STARTS_AT, proposedEndDate: eventEnd });
      expect(mintForHold).not.toHaveBeenCalled();
    });

    it("a CANCELLED draft anchor on the hold's night is 'no event': header aligned to the HOLD, a FRESH draft is minted, the dead id is never handed back", async () => {
      const ctx = buildDeps();
      const FRESH_EVENT_ID = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
      // Venue cancelled the 21:30 draft; the anchor survives (no SetNull on cancel).
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: new Date("2026-06-21T02:30:00.000Z"), status: "CANCELLED" } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, draftEventId: EVENT_ID, proposedDate: PITCH_SEEDED_DATE });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID, setLengthMinutes: 60 });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);
      mintForHold.mockResolvedValueOnce({ eventId: FRESH_EVENT_ID, alreadyLinked: false, finalized: false });

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(result.eventId).toBe(FRESH_EVENT_ID);
      expect(result.eventId).not.toBe(EVENT_ID);
      // The hold (calendar default 20:00), not the dead event's 21:30, anchors the header.
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({
        proposedDate: EXPECTED_STARTS_AT,
        proposedEndDate: new Date(EXPECTED_STARTS_AT.getTime() + 60 * 60_000),
      });
      expect(mintForHold).toHaveBeenCalledTimes(1);
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({
        agreementId: AGREEMENT_ID,
        hold: { startsAt: EXPECTED_STARTS_AT, endsAt: new Date(EXPECTED_STARTS_AT.getTime() + 60 * 60_000) },
      });
      // tx1 ran (the dead draft is not a "hand back this event" case).
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("RELEASED");
    });

    // Review round 4 W1: a finalized link is the money link — never replaced
    // by a mint — so a finalized link to a DEAD event books no night at all.
    it("a FINALIZED agreement whose event is CANCELLED → refused linked_event_not_live BEFORE tx1: no line change, no mint, header untouched", async () => {
      const ctx = buildDeps();
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT, status: "CANCELLED" } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "ACCEPTED", eventId: EVENT_ID, proposedDate: PITCH_SEEDED_DATE });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "linked_event_not_live",
        meta: { agreementId: AGREEMENT_ID, eventId: EVENT_ID },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
      expect(mintForHold).not.toHaveBeenCalled();
      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
    });

    it("a CANCELLED draft anchor still runs the mint gates in pre-flight (terminal agreement → refused before tx1)", async () => {
      const ctx = buildDeps();
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT, status: "ARCHIVED" } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "DECLINED", draftEventId: EVENT_ID });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "agreement_terminal",
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
    });

    it("a stored end that is NOT after the start (degenerate span) falls back to the set-length rule", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, proposedDate: PITCH_SEEDED_DATE, proposedEndDate: PITCH_SEEDED_DATE });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID, setLengthMinutes: 30 });
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({
        proposedDate: EXPECTED_STARTS_AT,
        proposedEndDate: new Date(EXPECTED_STARTS_AT.getTime() + 30 * 60_000),
      });
    });

    it("finalized agreement (eventId set, event on the hold's night) → header untouched", async () => {
      const ctx = buildDeps();
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT });
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "ACCEPTED", eventId: EVENT_ID, proposedDate: PITCH_SEEDED_DATE });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(result.eventId).toBe(EVENT_ID);
      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ proposedDate: PITCH_SEEDED_DATE });
      expect(mintForHold).not.toHaveBeenCalled();
    });

    it("replay (mint retry and post-mint) never writes the header a second time", async () => {
      const ctx = buildDeps();
      const winner = ctx.seedHold(REQUEST_A);
      mintForHold.mockRejectedValueOnce(new Error("quota_exceeded"));
      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toThrow("quota_exceeded");
      expect(ctx.repos.agreements.updateHeader).toHaveBeenCalledTimes(1);

      // Heal (mint only) …
      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });
      // … then a post-mint replay against the stamped draft anchor.
      ctx.agreements.set(AGREEMENT_ID, { ...ctx.agreements.get(AGREEMENT_ID)!, draftEventId: EVENT_ID });
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: EXPECTED_STARTS_AT });
      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.repos.agreements.updateHeader).toHaveBeenCalledTimes(1);
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ proposedDate: EXPECTED_STARTS_AT });
    });

    it("header CAS lost to a concurrent agreement transition → INVALID_STATUS agreement_status_changed, nothing minted", async () => {
      const ctx = buildDeps();
      const winner = ctx.seedHold(REQUEST_A);
      (ctx.repos.agreements.updateHeader as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        throw { code: "conflict", message: "agreement_status_changed" };
      });

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "agreement_status_changed",
        meta: { holdId: winner.id },
      });
      expect(mintForHold).not.toHaveBeenCalled();
    });
  });
  describe("FR-004 gates — whose hold, which night", () => {
    it("a hold that belongs to ANOTHER request than the one named → BOOKING_HOLD_NOT_FOUND, nothing read past the gate", async () => {
      const ctx = buildDeps();
      const hold = ctx.seedHold(REQUEST_A);

      await expect(
        bookNightWithoutTerms(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_B, holdId: hold.id }),
      ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_FOUND" });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("ACTIVE");
    });

    it("a night the pitch never asked for → DATE_NOT_ASKED_FOR (with the hold and night), before any write", async () => {
      const ctx = buildDeps();
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: ["2026-07-10", "2026-06-27"] });
      const hold = ctx.seedHold(REQUEST_A);
      const competitor = ctx.seedHold(REQUEST_B);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id })).rejects.toMatchObject({
        code: "DATE_NOT_ASKED_FOR",
        meta: { holdId: hold.id, date: DATE },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
      expect(mintForHold).not.toHaveBeenCalled();
    });

    it("a TIMED preferred entry counts for its day", async () => {
      const ctx = buildDeps();
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: [`${DATE}T21:30`] });
      const hold = ctx.seedHold(REQUEST_A);

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id });
      expect(result.hold.status).toBe("CONFIRMED");
    });

    it("RENT / USE: a night inside the requested window is asked for; one outside it is not", async () => {
      const ctx = buildDeps();
      // 18:00–22:00 CDT on DATE; no preferred dates at all.
      ctx.requests.set(REQUEST_A, {
        ...ctx.requests.get(REQUEST_A)!,
        intent: "RENT",
        spaceId: SPACE_ID,
        preferredDates: [],
        requestedStartsAt: new Date("2026-06-20T23:00:00.000Z"),
        requestedEndsAt: new Date("2026-06-21T03:00:00.000Z"),
      });
      const outside = ctx.seedHold(REQUEST_A, { date: "2026-06-27" });
      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: outside.id })).rejects.toMatchObject({
        code: "DATE_NOT_ASKED_FOR",
      });

      const inside = ctx.seedHold(REQUEST_A);
      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: inside.id });
      expect(result.hold).toMatchObject({ id: inside.id, status: "CONFIRMED" });
      // N17: the request's other night goes.
      expect(ctx.bookingHolds.rows.get(outside.id)).toMatchObject({ status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });
    });

    it("the ledger says the night was booked WITHOUT terms, and the drafted agreement stays DRAFT (no second agreement)", async () => {
      const ctx = buildDeps();
      const hold = ctx.seedHold(REQUEST_A);

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id });

      expect(ctx.entries(REQUEST_A).at(-1)).toEqual({
        kind: "booking_hold.confirmed",
        data: { holdId: hold.id, eventId: null, withoutTerms: true },
        actor: STAFF_ID,
      });
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ status: "DRAFT" });
      expect(ctx.repos.agreements.create).toHaveBeenCalledTimes(1);
      // The sender hears through the existing hold-confirmed notice.
      expect(result.notificationIntents).toContainEqual({
        kind: "hold.confirmed",
        bookingRequestId: REQUEST_A,
        holdId: hold.id,
        audience: "act",
        date: DATE,
      });
      // The mint is the hold variant: no finalize, so the event's money goes
      // to its organiser until terms are added.
      expect(mintForHold).toHaveBeenCalledTimes(1);
    });
  });

  describe("event-first requests (N11)", () => {
    const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";

    it("an origin event on the hold's night anchors the header to the EVENT's instants; the post-commit step goes through the shared mint, which links it", async () => {
      const ctx = buildDeps();
      const eventStart = new Date("2026-06-21T02:30:00.000Z"); // 21:30 CDT on DATE
      const eventEnd = new Date("2026-06-21T04:30:00.000Z");
      ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: eventStart, endsAt: eventEnd, status: "DRAFT" } as never);
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
      const hold = ctx.seedHold(REQUEST_A);
      mintForHold.mockResolvedValueOnce({ eventId: ORIGIN_ID, alreadyLinked: true, finalized: false });

      const result = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id });

      expect(result.eventId).toBe(ORIGIN_ID);
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ proposedDate: eventStart, proposedEndDate: eventEnd });
      expect(mintForHold).toHaveBeenCalledTimes(1);
    });

    it("an origin event on ANOTHER night → HOLD_DATE_MISMATCHES_EVENT before tx1", async () => {
      const ctx = buildDeps();
      ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: new Date("2026-06-28T01:00:00.000Z"), status: "DRAFT" } as never);
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
      const hold = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id })).rejects.toMatchObject({
        code: "HOLD_DATE_MISMATCHES_EVENT",
        meta: { holdDate: DATE, eventId: ORIGIN_ID, eventDate: "2026-06-27" },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(mintForHold).not.toHaveBeenCalled();
    });
  });
  describe("one booked night per request (review B1)", () => {
    it("Scenario A (book side): the request booked one night without terms; booking another of its nights is refused BOOKING_ALREADY_HAS_NIGHT", async () => {
      const ctx = buildDeps();
      const first = ctx.seedHold(REQUEST_A);
      const sibling = ctx.seedHold(REQUEST_A, { date: "2026-06-27" });
      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: first.id });
      expect(ctx.bookingHolds.rows.get(sibling.id)?.status).toBe("RELEASED");
      // The venue places a fresh hold on another asked-for night later.
      const later = ctx.seedHold(REQUEST_A, { date: "2026-06-27" });

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: later.id })).rejects.toMatchObject({
        code: "BOOKING_ALREADY_HAS_NIGHT",
      });
      expect(ctx.bookingHolds.rows.get(later.id)?.status).toBe("ACTIVE");
      const confirmed = [...ctx.bookingHolds.rows.values()].filter((h) => h.status === "CONFIRMED");
      expect(confirmed.map((h) => h.id)).toEqual([first.id]);
      expect(mintForHold).toHaveBeenCalledTimes(1);
    });
  });

  describe("the mint fails after tx1 committed (review W6)", () => {
    it("the error carries the committed notices — lost_date for the act behind, hold-confirmed for the sender", async () => {
      const ctx = buildDeps();
      const winner = ctx.seedHold(REQUEST_A);
      const behind = ctx.seedHold(REQUEST_B);
      const boom = new Error("quota_exceeded");
      mintForHold.mockRejectedValueOnce(boom);

      const error = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id }).catch((e: unknown) => e);

      // A FRESH carrier (the thrown object is never mutated), the original
      // as its cause, its message kept.
      expect(error).not.toBe(boom);
      expect((error as Error).cause).toBe(boom);
      expect((error as Error).message).toBe("quota_exceeded");
      expect(committedHoldIntentsOf(boom)).toBeNull();
      const committed = committedHoldIntentsOf(error);
      expect(committed).toMatchObject({ bookingRequestId: REQUEST_A, staffRecipientHint: { placeId: PLACE_ID } });
      expect(committed!.notificationIntents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "hold.confirmed", holdId: winner.id, audience: "act" }),
          expect.objectContaining({ kind: "hold.lost_date", holdId: behind.id, bookingRequestId: REQUEST_B }),
        ]),
      );
      // Not enumerable: it never reaches a log line or the wire.
      expect(Object.keys(error as object)).not.toContain("notificationIntents");

      // The heal (a replay) owes nothing and carries nothing.
      mintForHold.mockRejectedValueOnce(new Error("still down"));
      const again = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id }).catch((e: unknown) => e);
      expect(committedHoldIntentsOf(again)).toBeNull();
    });
  });
  describe("review round 3 — event-first origin gone, agreed terms, post-commit refusal", () => {
    const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";

    it.each([["CANCELLED"], ["ARCHIVED"], [null]])(
      "a gone origin (%s) → refused in pre-flight with the link's own refusal; no transaction, nothing minted (spec N11)",
      async (status) => {
        const ctx = buildDeps();
        ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
        if (status) ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: EXPECTED_STARTS_AT, status } as never);
        const hold = ctx.seedHold(REQUEST_A);
        const behind = ctx.seedHold(REQUEST_B);

        await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id })).rejects.toMatchObject({
          code: "INVALID_STATUS",
          message: "event_first_origin_not_live",
          meta: { eventId: ORIGIN_ID },
        });
        expect(ctx.repos.tx).not.toHaveBeenCalled();
        expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
        expect(mintForHold).not.toHaveBeenCalled();
      },
    );

    it("an origin cancelled AFTER pre-flight is caught in tx1, under the lock, before the line moves", async () => {
      const ctx = buildDeps();
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
      ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: EXPECTED_STARTS_AT, status: "DRAFT" } as never);
      const hold = ctx.seedHold(REQUEST_A);
      const behind = ctx.seedHold(REQUEST_B);
      const lockLine = vi.mocked(ctx.bookingHolds.lockLine);
      const realLock = lockLine.getMockImplementation()!;
      let fired = false;
      lockLine.mockImplementation(async (key) => {
        if (!fired) {
          fired = true;
          ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: EXPECTED_STARTS_AT, status: "CANCELLED" } as never);
        }
        return realLock(key);
      });

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id })).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "event_first_origin_not_live",
      });
      expect(vi.mocked(ctx.bookingHolds.updateStatus)).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
      expect(mintForHold).not.toHaveBeenCalled();
    });

    // W4: agreed terms are never rewritten either.
    it("ACCEPTED terms for ANOTHER night → TERMS_AGREED_FOR_ANOTHER_NIGHT before any write", async () => {
      const ctx = buildDeps();
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "ACCEPTED", proposedDate: new Date("2026-07-11T01:00:00.000Z") });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "TERMS_AGREED_FOR_ANOTHER_NIGHT",
        meta: { agreementId: AGREEMENT_ID, holdDate: DATE, termsDate: "2026-07-10" },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
    });

    it("ACCEPTED terms for THIS night stand: no header write, the event starts at their instant", async () => {
      const ctx = buildDeps();
      const termsAt = new Date("2026-06-21T02:15:00.000Z"); // 21:15 CDT on DATE
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "ACCEPTED", proposedDate: termsAt });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
      expect(ctx.agreements.get(AGREEMENT_ID)).toMatchObject({ status: "ACCEPTED", proposedDate: termsAt });
      expect(mintForHold.mock.calls[0]![1]).toMatchObject({ hold: { startsAt: termsAt, date: DATE } });
      // Review round 4 nit 5: agreed terms for this night → the night was
      // booked WITH terms; the ledger entry carries no `withoutTerms`.
      expect(ctx.entries(REQUEST_B).find((e) => e.kind === "booking_hold.confirmed")).toEqual({
        kind: "booking_hold.confirmed",
        data: { holdId: winner.id, eventId: null },
        actor: STAFF_ID,
      });
    });

    it("PROPOSED (not yet agreed) terms for THIS night → still booked without agreed terms: withoutTerms is written", async () => {
      const ctx = buildDeps();
      const termsAt = new Date("2026-06-21T02:15:00.000Z"); // 21:15 CDT on DATE
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "PROPOSED", proposedDate: termsAt });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);

      await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id });

      expect(ctx.entries(REQUEST_B).find((e) => e.kind === "booking_hold.confirmed")?.data).toEqual({
        holdId: winner.id,
        eventId: null,
        withoutTerms: true,
      });
    });

    // W5: the origin moved between pre-flight and the post-commit link.
    it("the link refuses an origin that moved off the night after tx1 → the night stays booked, the refusal is REPORTED, the notices still ride the error", async () => {
      const ctx = buildDeps();
      const winner = ctx.seedHold(REQUEST_A);
      const behind = ctx.seedHold(REQUEST_B);
      const { AppError } = await import("@th/errors");
      mintForHold.mockRejectedValueOnce(
        new AppError("HOLD_DATE_MISMATCHES_EVENT", { meta: { eventDate: "2026-06-21", holdDate: DATE } }),
      );

      const error = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id }).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "HOLD_DATE_MISMATCHES_EVENT" });
      expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("CONFIRMED");
      expect(ctx.deps.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "HOLD_DATE_MISMATCHES_EVENT" }),
        expect.objectContaining({ tags: { useCase: "bookNightWithoutTerms", step: "post_commit_mint" } }),
      );
      expect(committedHoldIntentsOf(error)?.notificationIntents).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "hold.lost_date", holdId: behind.id })]),
      );
    });

    it("a throwing reporter never changes that outcome", async () => {
      const ctx = buildDeps();
      const winner = ctx.seedHold(REQUEST_A);
      ctx.deps.reportError.mockImplementation(() => {
        throw new Error("sentry down");
      });
      const { AppError } = await import("@th/errors");
      mintForHold.mockRejectedValueOnce(new AppError("HOLD_DATE_MISMATCHES_EVENT"));

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "HOLD_DATE_MISMATCHES_EVENT",
      });
    });
  });

  // ── Review round 4 (round-5 fixes): the shared booking pre-flight ─────────
  describe("review round 4 — the shared booking pre-flight runs before tx1", () => {
    const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
    const DRAFT_ID = "d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7";
    const GRANTEE_ID = "17171717-1717-4171-8171-171717171717";

    // BLOCKING: a suspended place keeps its holds live; booking one of them
    // released the line and then failed the mint on every attempt.
    it.each([["SUSPENDED"], ["RETIRED"]])(
      "the place is %s → PLACE_NOT_ACTIVE BEFORE tx1: repos.tx never runs, the hold behind stays ACTIVE, nothing minted",
      async (status) => {
        const ctx = buildDeps();
        (ctx.place as { status: string }).status = status;
        const hold = ctx.seedHold(REQUEST_A);
        const behind = ctx.seedHold(REQUEST_B);

        await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id })).rejects.toMatchObject({
          code: "PLACE_NOT_ACTIVE",
        });
        expect(ctx.repos.tx).not.toHaveBeenCalled();
        expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("ACTIVE");
        expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
        expect(mintForHold).not.toHaveBeenCalled();
      },
    );

    // Review round 6 BLOCKING: the hold mint refuses terminal terms before it
    // links, so the booking must refuse them before tx1 — one rule, the
    // mint's own plan.
    it.each([["CANCELLED"], ["DECLINED"]])(
      "an event-first request whose terms are %s → INVALID_STATUS agreement_terminal BEFORE tx1: no line change, the hold behind stays ACTIVE",
      async (status) => {
        const ctx = buildDeps();
        ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: EXPECTED_STARTS_AT, status: "DRAFT" } as never);
        ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status, draftEventId: null });
        ctx.requests.set(REQUEST_B, {
          ...ctx.requests.get(REQUEST_B)!,
          status: "ACCEPTED",
          agreementId: AGREEMENT_ID,
          originEventId: ORIGIN_ID,
        });
        const winner = ctx.seedHold(REQUEST_B);
        const behind = ctx.seedHold(REQUEST_A);

        await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
          code: "INVALID_STATUS",
          message: "agreement_terminal",
          meta: { agreementId: AGREEMENT_ID, status },
        });
        expect(ctx.repos.tx).not.toHaveBeenCalled();
        expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("ACTIVE");
        expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
        expect(mintForHold).not.toHaveBeenCalled();
      },
    );

    it("CANCELLED terms with a LIVE draft on the night → refused BEFORE tx1 (the cancel orphaned that draft; it is never handed back)", async () => {
      const ctx = buildDeps();
      ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: EXPECTED_STARTS_AT, status: "DRAFT", orgId: ORG_ID, humanId: null } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "CANCELLED", draftEventId: DRAFT_ID });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      const winner = ctx.seedHold(REQUEST_B);
      const behind = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "agreement_terminal",
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
      expect(mintForHold).not.toHaveBeenCalled();
    });

    // W1: legacy event-first terms FINALIZED against an origin that has since
    // been cancelled — the finalized link no longer skips the liveness rule.
    it("legacy event-first terms finalized against a now-CANCELLED origin → refused BEFORE tx1, no line change", async () => {
      const ctx = buildDeps();
      ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: EXPECTED_STARTS_AT, status: "CANCELLED" } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "ACCEPTED", eventId: ORIGIN_ID });
      ctx.requests.set(REQUEST_B, {
        ...ctx.requests.get(REQUEST_B)!,
        status: "ACCEPTED",
        agreementId: AGREEMENT_ID,
        originEventId: ORIGIN_ID,
      });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "event_first_origin_not_live",
        meta: { agreementId: AGREEMENT_ID, eventId: ORIGIN_ID },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
      expect(mintForHold).not.toHaveBeenCalled();
    });

    // W2 / owner ruling 2026-10-01: no exception for a leftover legacy draft.
    it("a dead origin with a LIVE legacy draft on the night → still refused BEFORE tx1", async () => {
      const ctx = buildDeps();
      ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: EXPECTED_STARTS_AT, status: "ARCHIVED" } as never);
      ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: EXPECTED_STARTS_AT, status: "DRAFT" } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "ACCEPTED", draftEventId: DRAFT_ID });
      ctx.requests.set(REQUEST_B, {
        ...ctx.requests.get(REQUEST_B)!,
        status: "ACCEPTED",
        agreementId: AGREEMENT_ID,
        originEventId: ORIGIN_ID,
      });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "event_first_origin_not_live",
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
    });

    // W4: the owning org's event quota is read before tx1.
    it("the venue org is at its EVENTS_PER_ORG limit → forbidden quota_exceeded BEFORE tx1, nothing written", async () => {
      const ctx = buildDeps();
      ctx.resourceQuotas.getEffectiveQuota.mockResolvedValue({ limitValue: 3n, currentUsage: 3n });
      const hold = ctx.seedHold(REQUEST_A);
      const behind = ctx.seedHold(REQUEST_B);

      await expect(book(ctx.deps, { actorHumanId: STAFF_ID, holdId: hold.id })).rejects.toMatchObject({
        code: "forbidden",
        message: "quota_exceeded",
        meta: { subjectId: ORG_ID, kind: "EVENTS_PER_ORG" },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
      expect(mintForHold).not.toHaveBeenCalled();
    });

    // Review round 6 (orchestrator ruling, fail closed): a grantee never
    // books a night for the venue's own event. Since holds-without-a-request
    // FR-002 the staff gate refuses it first (was: the mint plan's
    // grant_cannot_mint_venue_owned).
    it("a grantee booking a request whose LIVE venue-owned draft is on the night → NOT_RESOURCE_OWNER BEFORE tx1", async () => {
      const ctx = buildDeps();
      ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: EXPECTED_STARTS_AT, status: "DRAFT", orgId: ORG_ID, humanId: null } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "DRAFT", draftEventId: DRAFT_ID });
      ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
      ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });
      const winner = ctx.seedHold(REQUEST_B);
      const behind = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: GRANTEE_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "place" },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("ACTIVE");
      expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
      expect(mintForHold).not.toHaveBeenCalled();
    });

    // A LINK of the venue's own event too: refused at the staff gate (FR-002)
    // before tx1.
    it("a grantee booking an event-first request whose origin is VENUE-owned (the mint would link the venue's own event) → refused BEFORE tx1", async () => {
      const ctx = buildDeps();
      ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: EXPECTED_STARTS_AT, status: "DRAFT", orgId: ORG_ID, humanId: null } as never);
      ctx.agreements.set(AGREEMENT_ID, { ...ORG_AGREEMENT, status: "ACCEPTED" });
      ctx.requests.set(REQUEST_B, {
        ...ctx.requests.get(REQUEST_B)!,
        status: "ACCEPTED",
        agreementId: AGREEMENT_ID,
        originEventId: ORIGIN_ID,
      });
      ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });
      const winner = ctx.seedHold(REQUEST_B);
      const competitor = ctx.seedHold(REQUEST_A);

      await expect(book(ctx.deps, { actorHumanId: GRANTEE_ID, holdId: winner.id })).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "place" },
      });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(competitor.id)?.status).toBe("ACTIVE");
    });

    it("a post-commit refusal that is a plain typed object (the save's quota, used up after pre-flight) is reported too", async () => {
      const ctx = buildDeps();
      const winner = ctx.seedHold(REQUEST_A);
      mintForHold.mockRejectedValueOnce({ code: "forbidden", message: "quota_exceeded", meta: { kind: "EVENTS_PER_ORG" } });

      const error = await book(ctx.deps, { actorHumanId: STAFF_ID, holdId: winner.id }).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "forbidden", message: "quota_exceeded" });
      expect(ctx.bookingHolds.rows.get(winner.id)?.status).toBe("CONFIRMED");
      expect(ctx.deps.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "forbidden" }),
        expect.objectContaining({ tags: { useCase: "bookNightWithoutTerms", step: "post_commit_mint" } }),
      );
    });
  });
});
