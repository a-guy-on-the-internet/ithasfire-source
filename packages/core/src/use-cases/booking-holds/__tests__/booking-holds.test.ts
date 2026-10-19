import { describe, expect, it } from "vitest";

import {
  answerBookingHoldChallenge,
  toAnswerBookingHoldChallengeWire,
} from "../answer-booking-hold-challenge";
import { challengeBookingHold } from "../challenge-booking-hold";
import { extendBookingHoldChallenge } from "../extend-booking-hold-challenge";
import { listBookingHoldsForRequest } from "../list-booking-holds-for-request";
import { placeBookingHold } from "../place-booking-hold";
import { releaseBookingHold } from "../release-booking-hold";
import { reorderBookingHold } from "../reorder-booking-hold";
import { settleBookingHolds } from "../settle-booking-holds";
import {
  ACT_A_ID,
  ACT_B_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  DATE,
  FOREIGN_CALENDAR_ID,
  NOW,
  OUTSIDER_ID,
  PLACE_ID,
  REQUEST_A,
  REQUEST_B,
  REQUEST_C,
  SPACE_ID,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "./hold-test-context";
import { buildOrganizerBookingRequestRecord } from "../../booking-requests/__tests__/helpers";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// placeBookingHold (FR-002)
// ─────────────────────────────────────────────────────────────────────────────

describe("placeBookingHold", () => {
  it("three placements on one calendar+date yield positions 1, 2, 3 with a ledger entry and an act intent each", async () => {
    const ctx = buildHoldTestContext();
    const results = [];
    for (const bookingRequestId of [REQUEST_A, REQUEST_B, REQUEST_C]) {
      results.push(
        await placeBookingHold(ctx.deps, {
          actorHumanId: STAFF_ID,
          bookingRequestId,
          calendarId: CALENDAR_ID,
          date: DATE,
        }),
      );
    }

    expect(results.map((r) => r.hold.position)).toEqual([1, 2, 3]);
    expect(results[0]!.hold).toMatchObject({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      // The calendar owns the room: a hold never reserved one, so new rows
      // write null and the space is chosen at confirm, on the draft event.
      spaceId: null,
      date: DATE,
      status: "ACTIVE",
      lapsed: false,
      placedByHumanId: STAFF_ID,
    });
    expect(results[1]!.notificationIntents).toEqual([
      {
        kind: "hold.placed",
        bookingRequestId: REQUEST_B,
        holdId: results[1]!.hold.id,
        audience: "act",
        date: DATE,
        position: 2,
      },
    ]);
    expect(results[1]!.staffRecipientHint).toEqual({
      assigneeHumanId: ASSIGNEE_ID,
      placedByHumanId: STAFF_ID,
      orgId: "22222222-2222-4222-8222-222222222222",
      placeId: PLACE_ID,
    });
    expect(ctx.entries(REQUEST_C)).toEqual([
      {
        kind: "booking_hold.placed",
        data: { holdId: results[2]!.hold.id, date: DATE, position: 3 },
        actor: STAFF_ID,
      },
    ]);
    expect(ctx.audit.log).toHaveBeenCalledTimes(3);
  });

  it("maps the live-unique conflict to HOLD_ALREADY_PLACED", async () => {
    const ctx = buildHoldTestContext();
    const input = { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE };
    await placeBookingHold(ctx.deps, input);

    await expect(placeBookingHold(ctx.deps, input)).rejects.toMatchObject({
      code: "HOLD_ALREADY_PLACED",
    });
  });

  it("lets a RELEASED date be re-held with a fresh row (partial unique on live statuses)", async () => {
    const ctx = buildHoldTestContext();
    ctx.seedHold(REQUEST_A, { status: "RELEASED", releasedReason: "MANUAL", position: 1 });

    const result = await placeBookingHold(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: DATE,
    });

    expect(result.hold.status).toBe("ACTIVE");
    expect(result.hold.position).toBe(1);
  });

  it("settles a lapsed challenge on the line BEFORE counting, so the new hold's position is real", async () => {
    const ctx = buildHoldTestContext();
    ctx.seedHold(REQUEST_A, {
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() - 1000),
    });
    ctx.seedHold(REQUEST_B);

    const result = await placeBookingHold(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_C,
      calendarId: CALENDAR_ID,
      date: DATE,
    });

    // A expired and left; B moved up to 1; C enters at 2, not 3.
    expect(result.hold.position).toBe(2);
    expect(result.notificationIntents.map((i) => [i.kind, i.bookingRequestId, i.audience])).toEqual([
      ["hold.expired", REQUEST_A, "act"],
      ["hold.expired", REQUEST_A, "staff"],
      ["hold.position_changed", REQUEST_B, "act"],
      ["hold.placed", REQUEST_C, "act"],
    ]);
  });

  it("takes the line's advisory lock BEFORE reading the line (the count is made under the lock)", async () => {
    const ctx = buildHoldTestContext();
    await placeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE });

    expect(ctx.bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, date: DATE });
    expect(ctx.bookingHolds.lockLine.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.bookingHolds.listLine.mock.invocationCallOrder[0]!,
    );
    expect(ctx.bookingHolds.lockLine.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.bookingHolds.create.mock.invocationCallOrder[0]!,
    );
  });

  it("refuses a line that already has a CONFIRMED winner (HOLD_LINE_ALREADY_CONFIRMED)", async () => {
    const ctx = buildHoldTestContext();
    ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW });

    await expect(
      placeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_B, calendarId: CALENDAR_ID, date: DATE }),
    ).rejects.toMatchObject({ code: "HOLD_LINE_ALREADY_CONFIRMED" });
    expect(ctx.bookingHolds.create).not.toHaveBeenCalled();
  });

  it("FR-009 backstop: a live hold on an already-EXPIRED request is released (REQUEST_CLOSED) by the next placement on its line", async () => {
    // The expiry sweep's per-request hold release runs in its own small tx
    // and can fail; emulate the gap: request EXPIRED, hold still ACTIVE.
    const ctx = buildHoldTestContext();
    const orphan = ctx.seedHold(REQUEST_A);
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status: "EXPIRED" });
    ctx.seedHold(REQUEST_B);

    const result = await placeBookingHold(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_C,
      calendarId: CALENDAR_ID,
      date: DATE,
    });

    expect(ctx.bookingHolds.rows.get(orphan.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: orphan.id, reason: "REQUEST_CLOSED" }, actor: null },
    ]);
    // B moved up to 1 (notified), C enters at 2; the dead act hears nothing.
    expect(result.hold.position).toBe(2);
    expect(result.notificationIntents.map((i) => [i.kind, i.bookingRequestId])).toEqual([
      ["hold.position_changed", REQUEST_B],
      ["hold.placed", REQUEST_C],
    ]);
  });

  it("rejects a TO_PERFORMER request (holds are venue-only)", async () => {
    const ctx = buildHoldTestContext();
    const organizer = buildOrganizerBookingRequestRecord({ id: "47474747-4747-4747-8747-474747474747" });
    ctx.requests.set(organizer.id, organizer);

    await expect(
      placeBookingHold(ctx.deps, {
        actorHumanId: STAFF_ID,
        bookingRequestId: organizer.id,
        calendarId: CALENDAR_ID,
        date: DATE,
      }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLDS_VENUE_ONLY" });
  });

  it.each([
    ["a VIEWER-role member", VIEWER_ID, "INSUFFICIENT_ROLE"],
    ["an outsider", OUTSIDER_ID, "NOT_RESOURCE_OWNER"],
    ["the act itself", ACT_A_ID, "NOT_RESOURCE_OWNER"],
  ])("refuses %s (%s)", async (_label, actorHumanId, code) => {
    const ctx = buildHoldTestContext();
    await expect(
      placeBookingHold(ctx.deps, { actorHumanId, bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE }),
    ).rejects.toMatchObject({ code });
    expect(ctx.bookingHolds.rows.size).toBe(0);
  });

  it("lets a direct human owner place (no org role needed)", async () => {
    const ctx = buildHoldTestContext({
      place: { orgIdsWithAccess: [], humanIdsWithAccess: [OUTSIDER_ID] },
    });
    const result = await placeBookingHold(ctx.deps, {
      actorHumanId: OUTSIDER_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: DATE,
    });
    expect(result.hold.position).toBe(1);
    // Human-owned venue: no org for staff routing.
    expect(result.staffRecipientHint.orgId).toBeNull();
  });

  // holds-without-a-request FR-002 REVERSES the venue-confirmation spec's
  // "Grant hook" here: placing a hold for an ACT's request is staff-only.
  // Was: a granted stranger placed it. A grantee's own (BOOKER) holds are
  // FR-005's, through their own entry point.
  it("refuses a granted stranger placing a hold for an act's request on a HUMAN-owned venue", async () => {
    const HUMAN_OWNER = "15151515-1515-4151-8151-151515151515";
    const ctx = buildHoldTestContext({
      place: { orgIdsWithAccess: [], humanIdsWithAccess: [HUMAN_OWNER] },
    });
    ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: OUTSIDER_ID,
      calendarId: CALENDAR_ID,
      grantedByHumanId: HUMAN_OWNER,
    });
    await expect(
      placeBookingHold(ctx.deps, { actorHumanId: OUTSIDER_ID, bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.bookingHolds.rows.size).toBe(0);
    // The owner still places it.
    const placed = await placeBookingHold(ctx.deps, {
      actorHumanId: HUMAN_OWNER,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: DATE,
    });
    expect(placed.hold.position).toBe(1);
  });

  it("no longer accepts spaceId at all — the calendar owns the room (.strict())", async () => {
    const ctx = buildHoldTestContext();
    await expect(
      placeBookingHold(ctx.deps, {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        date: DATE,
        spaceId: SPACE_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ctx.bookingHolds.rows.size).toBe(0);
  });

  it("rejects a foreign calendar, a closed request, and a past date", async () => {
    const ctx = buildHoldTestContext();
    const base = { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE };

    await expect(
      placeBookingHold(ctx.deps, { ...base, calendarId: "cfcfcfcf-cfcf-4cfc-8cfc-cfcfcfcfcfcf" }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    // Past date in the place zone (NOW is 2026-06-10 07:00 Chicago).
    await expect(placeBookingHold(ctx.deps, { ...base, date: "2026-06-09" })).rejects.toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ message: "hold_date_in_past" })],
    });
    // Today is fine.
    await expect(placeBookingHold(ctx.deps, { ...base, date: "2026-06-10" })).resolves.toBeDefined();

    ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "DECLINED" });
    await expect(
      placeBookingHold(ctx.deps, { ...base, bookingRequestId: REQUEST_B }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reorderBookingHold (FR-003)
// ─────────────────────────────────────────────────────────────────────────────

describe("reorderBookingHold", () => {
  it("moves a hold within its line, renumbers, records and notifies every mover", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    const c = ctx.seedHold(REQUEST_C);

    const result = await reorderBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: c.id, toPosition: 1 });

    expect(result.line.map((h) => [h.id, h.position])).toEqual([[c.id, 1], [a.id, 2], [b.id, 3]]);
    expect(result.notificationIntents).toEqual([
      { kind: "hold.position_changed", bookingRequestId: REQUEST_C, holdId: c.id, audience: "act", date: DATE, position: 1 },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_A, holdId: a.id, audience: "act", date: DATE, position: 2 },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_B, holdId: b.id, audience: "act", date: DATE, position: 3 },
    ]);
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.reordered", data: { holdId: a.id, from: 1, to: 2 }, actor: STAFF_ID },
    ]);
  });

  it("is idempotent: same position writes nothing; positions past the end clamp", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);

    const same = await reorderBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, toPosition: 1 });
    expect(same.notificationIntents).toEqual([]);
    expect(ctx.bookingHolds.renumberLine).not.toHaveBeenCalled();

    const clamped = await reorderBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, toPosition: 99 });
    expect(clamped.line.map((h) => h.id)).toEqual([b.id, a.id]);
  });

  it("refuses to move a hold that is no longer live", async () => {
    const ctx = buildHoldTestContext();
    const dead = ctx.seedHold(REQUEST_A, { status: "RELEASED", releasedReason: "MANUAL" });
    await expect(
      reorderBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: dead.id, toPosition: 1 }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_LIVE" });
  });

  it("a line that changed under the reorder (adapter line_changed / deadlock) surfaces as typed, retryable HOLD_LINE_CHANGED", async () => {
    const ctx = buildHoldTestContext();
    ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    ctx.bookingHolds.renumberLine.mockRejectedValueOnce({ code: "conflict", message: "booking_hold_line_changed" });

    await expect(
      reorderBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: b.id, toPosition: 1 }),
    ).rejects.toMatchObject({ code: "HOLD_LINE_CHANGED", meta: { calendarId: CALENDAR_ID, date: DATE } });
  });

  it("refuses to reorder a line while a challenge is open (HOLD_LINE_HAS_OPEN_CHALLENGE) — the promised positions must hold until the deadline", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() + DAY_MS) });
    ctx.seedHold(REQUEST_B);
    const c = ctx.seedHold(REQUEST_C);

    await expect(
      reorderBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: c.id, toPosition: 1 }),
    ).rejects.toMatchObject({ code: "HOLD_LINE_HAS_OPEN_CHALLENGE", meta: { challengedHoldId: a.id } });
    expect(ctx.bookingHolds.renumberLine).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(c.id)?.position).toBe(3);
  });

  it("refuses a hold whose calendar belongs to another place (CALENDAR_NOT_FOUND) — staff and act entry points alike", async () => {
    const ctx = buildHoldTestContext();
    const stray = ctx.seedHold(REQUEST_A, {
      calendarId: FOREIGN_CALENDAR_ID,
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() + DAY_MS),
    });

    await expect(
      reorderBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: stray.id, toPosition: 1 }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND", meta: { reason: "hold_calendar_place_mismatch" } });
    await expect(
      answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId: stray.id, answer: "keep" }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND", meta: { reason: "hold_calendar_place_mismatch" } });
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// challengeBookingHold (FR-004)
// ─────────────────────────────────────────────────────────────────────────────

describe("challengeBookingHold", () => {
  it("challenges position 1: respondBy = now + 24h, notifies the challenged act, position 2, and staff", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    // N20: B is ready to book the night (draft terms dated DATE).
    ctx.seedTerms(REQUEST_B);

    const result = await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });

    const respondBy = new Date(NOW.getTime() + DAY_MS);
    expect(result.hold).toMatchObject({ status: "CHALLENGED", respondBy, lapsed: false });
    expect(result.termsToFirstHold).toEqual({ status: "not_requested", errorCode: null });
    expect(result.notificationIntents).toEqual([
      // A has no terms with it: its notice says Keep will ask for them (N19).
      { kind: "hold.challenged", bookingRequestId: REQUEST_A, holdId: a.id, audience: "act", date: DATE, position: 1, respondBy, keepWill: "ask_for_terms" },
      {
        kind: "hold.challenged",
        bookingRequestId: REQUEST_A,
        holdId: a.id,
        audience: "staff",
        date: DATE,
        position: 1,
        respondBy,
        staff: { assigneeHumanId: ASSIGNEE_ID, placedByHumanId: STAFF_ID },
      },
      { kind: "hold.challenged", bookingRequestId: REQUEST_B, holdId: b.id, audience: "act", date: DATE, position: 2, respondBy },
    ]);
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.challenged", data: { holdId: a.id, respondBy: respondBy.toISOString() }, actor: STAFF_ID },
    ]);
  });

  it("accepts a respondBy override ≥ now+1h and rejects one sooner", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);

    await expect(
      challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, respondBy: new Date(NOW.getTime() + 30 * 60 * 1000) }),
    ).rejects.toMatchObject({ code: "invalid_input", issues: [expect.objectContaining({ message: "respond_by_too_soon" })] });

    const later = new Date(NOW.getTime() + 3 * DAY_MS);
    const result = await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, respondBy: later });
    expect(result.hold.respondBy).toEqual(later);
  });

  it("a deadlock the adapter folded into line_changed on the CAS surfaces as typed HOLD_LINE_CHANGED", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);
    ctx.bookingHolds.updateStatus.mockRejectedValueOnce({ code: "conflict", message: "booking_hold_line_changed" });
    await expect(
      challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id }),
    ).rejects.toMatchObject({ code: "HOLD_LINE_CHANGED" });
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
  });

  it("only position 1 can be challenged", async () => {
    const ctx = buildHoldTestContext();
    ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    await expect(
      challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: b.id }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_FIRST" });
  });

  it("one open challenge per line (including re-challenging the same hold)", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);
    await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });
    await expect(
      challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_CHALLENGE_OPEN" });
  });

  it("the act cannot challenge", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    await expect(
      challengeBookingHold(ctx.deps, { actorHumanId: ACT_A_ID, holdId: a.id }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extendBookingHoldChallenge (FR-005)
// ─────────────────────────────────────────────────────────────────────────────

describe("extendBookingHoldChallenge", () => {
  it("pushes the deadline later, records it, notifies the challenged act and position 2", async () => {
    const ctx = buildHoldTestContext();
    const respondBy = new Date(NOW.getTime() + DAY_MS);
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy });
    const b = ctx.seedHold(REQUEST_B);
    const later = new Date(respondBy.getTime() + DAY_MS);

    const result = await extendBookingHoldChallenge(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, respondBy: later });

    expect(result.hold.respondBy).toEqual(later);
    expect(result.notificationIntents).toEqual([
      { kind: "hold.challenge_extended", bookingRequestId: REQUEST_A, holdId: a.id, audience: "act", date: DATE, position: 1, respondBy: later },
      { kind: "hold.challenge_extended", bookingRequestId: REQUEST_B, holdId: b.id, audience: "act", date: DATE, position: 2, respondBy: later },
    ]);
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.extended", data: { holdId: a.id, respondBy: later.toISOString() }, actor: STAFF_ID },
    ]);
  });

  it("is idempotent on the same deadline and refuses an earlier one", async () => {
    const ctx = buildHoldTestContext();
    const respondBy = new Date(NOW.getTime() + DAY_MS);
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy });

    const same = await extendBookingHoldChallenge(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, respondBy });
    expect(same.notificationIntents).toEqual([]);
    expect(ctx.entries(REQUEST_A)).toEqual([]);

    await expect(
      extendBookingHoldChallenge(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, respondBy: new Date(respondBy.getTime() - HOUR_MS) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a lapsed challenge is settled first and reported as LAPSED", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() - 1) });

    await expect(
      extendBookingHoldChallenge(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, respondBy: new Date(NOW.getTime() + DAY_MS) }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_CHALLENGE_LAPSED" });
    expect(ctx.bookingHolds.rows.get(a.id)).toMatchObject({ status: "RELEASED", releasedReason: "EXPIRED" });
  });

  it("refuses to extend an ACTIVE hold", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    await expect(
      extendBookingHoldChallenge(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id, respondBy: new Date(NOW.getTime() + DAY_MS) }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_CHALLENGED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// answerBookingHoldChallenge (FR-006) — ACT side
// ─────────────────────────────────────────────────────────────────────────────

describe("answerBookingHoldChallenge", () => {
  // booking-the-night N19 / FR-014: with no terms with the act, Keep is a
  // commitment to agree the terms the venue sends — the hold STAYS
  // challenged on a new 48h deadline (the existing lapse is the timer).
  it("keep with no terms sent: stays CHALLENGED with a 48h deadline; staff are asked to send terms, position 2 hears the hold stands", async () => {
    const ctx = buildHoldTestContext();
    const challengedAt = new Date(NOW.getTime() - HOUR_MS);
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", challengedAt, respondBy: new Date(NOW.getTime() + DAY_MS) });
    const b = ctx.seedHold(REQUEST_B);

    const result = await answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId: a.id, answer: "keep" });

    const respondBy = new Date(NOW.getTime() + 2 * DAY_MS);
    expect(result.keepOutcome).toBe("awaiting_terms");
    expect(result.hold).toMatchObject({ status: "CHALLENGED", respondBy, position: 1 });
    expect(result.actHold).toMatchObject({ status: "CHALLENGED", respondBy, keepWill: "ask_for_terms", kept: true });
    expect(result.notificationIntents).toEqual([
      // Review W2: the keeper's own notice carries the absolute deadline the keep set.
      { kind: "hold.kept", bookingRequestId: REQUEST_A, holdId: a.id, audience: "act", date: DATE, position: 1, respondBy, awaitingTerms: true },
      { kind: "hold.kept", bookingRequestId: REQUEST_A, holdId: a.id, audience: "staff", date: DATE, position: 1, respondBy, awaitingTerms: true, staff: { assigneeHumanId: ASSIGNEE_ID, placedByHumanId: STAFF_ID } },
      { kind: "hold.kept", bookingRequestId: REQUEST_B, holdId: b.id, audience: "act", date: DATE, position: 2 },
    ]);
    expect(ctx.entries(REQUEST_A)).toEqual([
      {
        kind: "booking_hold.kept",
        data: { holdId: a.id, challengedAt: challengedAt.toISOString(), respondBy: respondBy.toISOString() },
        actor: ACT_A_ID,
      },
    ]);
  });

  it("release: RELEASED (MANUAL), line moves up to 1,2, both remaining acts + staff notified", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() + DAY_MS) });
    const b = ctx.seedHold(REQUEST_B);
    const c = ctx.seedHold(REQUEST_C);

    const result = await answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId: a.id, answer: "release" });

    expect(result.hold).toMatchObject({ status: "RELEASED", releasedReason: "MANUAL" });
    expect(ctx.bookingHolds.rows.get(b.id)?.position).toBe(1);
    expect(ctx.bookingHolds.rows.get(c.id)?.position).toBe(2);
    // INTERNAL output — for the post-commit dispatcher: the movers' intents
    // name B's and C's requests, which is exactly what the dispatcher needs
    // and exactly what the act must never receive (see the wire test below).
    expect(result.notificationIntents).toEqual([
      { kind: "hold.released", bookingRequestId: REQUEST_A, holdId: a.id, audience: "staff", date: DATE, reason: "MANUAL", staff: { assigneeHumanId: ASSIGNEE_ID, placedByHumanId: STAFF_ID } },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_B, holdId: b.id, audience: "act", date: DATE, position: 1 },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_C, holdId: c.id, audience: "act", date: DATE, position: 2 },
    ]);
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: a.id, reason: "MANUAL", by: "act" }, actor: ACT_A_ID },
    ]);
    // The movers' ledger lines on B's and C's threads carry NO author: act A
    // must not appear (by id) on another act's thread.
    expect(ctx.entries(REQUEST_B)).toEqual([
      { kind: "booking_hold.reordered", data: { holdId: b.id, from: 2, to: 1 }, actor: null },
    ]);
    expect(ctx.entries(REQUEST_C)).toEqual([
      { kind: "booking_hold.reordered", data: { holdId: c.id, from: 3, to: 2 }, actor: null },
    ]);
  });

  it("WIRE output (what the act receives) carries only the act's OWN hold — no foreign request or hold id, no staff hint", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() + DAY_MS) });
    const b = ctx.seedHold(REQUEST_B);
    const c = ctx.seedHold(REQUEST_C);

    const internal = await answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId: a.id, answer: "release" });
    const wire = toAnswerBookingHoldChallengeWire(internal);

    // The ACT projection — same shape the sent-request list gives the act.
    expect(wire).toEqual({
      hold: { id: a.id, date: DATE, position: 1, status: "RELEASED", respondBy: null, lapsed: false, keepWill: null, kept: false },
      keepOutcome: null,
      eventId: null,
    });
    expect(wire).not.toHaveProperty("notificationIntents");
    expect(wire).not.toHaveProperty("staffRecipientHint");
    expect(wire.hold).not.toHaveProperty("placedByHumanId");
    const serialized = JSON.stringify(wire);
    for (const foreign of [REQUEST_B, REQUEST_C, b.id, c.id, ASSIGNEE_ID, STAFF_ID]) {
      expect(serialized).not.toContain(foreign);
    }
    expect(serialized).toContain(a.id);
    // Sanity: the internal shape DID carry the foreign ids the wire dropped.
    expect(JSON.stringify(internal)).toContain(REQUEST_B);
  });

  it("is idempotent: a second keep of the same challenge, keep on ACTIVE, and release on RELEASED are no-ops", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", challengedAt: NOW, respondBy: new Date(NOW.getTime() + DAY_MS) });
    const first = await answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId: a.id, answer: "keep" });
    // A second keep never pushes the deadline again (no stalling by keep).
    const again = await answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId: a.id, answer: "keep" });
    expect(again.keepOutcome).toBe("unchanged");
    expect(again.notificationIntents).toEqual([]);
    expect(again.hold.respondBy).toEqual(first.hold.respondBy);
    expect(ctx.entries(REQUEST_A)).toHaveLength(1);
    // Keep on an ACTIVE hold: nothing to do.
    const active = ctx.seedHold(REQUEST_A, { date: "2026-06-27" });
    const onActive = await answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId: active.id, answer: "keep" });
    expect(onActive).toMatchObject({ keepOutcome: "unchanged", hold: { status: "ACTIVE" } });
    expect(ctx.entries(REQUEST_A)).toHaveLength(1);

    const b = ctx.seedHold(REQUEST_B, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() + DAY_MS) });
    await expect(
      // A is ACTIVE at position 1, so B's challenge is at position 2 — the
      // fixture bypasses the position-1 rule; only the answer path matters.
      answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_B_ID, holdId: b.id, answer: "release" }),
    ).resolves.toMatchObject({ hold: { status: "RELEASED" } });
    const replay = await answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_B_ID, holdId: b.id, answer: "release" });
    expect(replay.notificationIntents).toEqual([]);
  });

  it("a deadline that already passed is settled (EXPIRED) and answered with LAPSED", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() - 1) });
    await expect(
      answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId: a.id, answer: "keep" }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_CHALLENGE_LAPSED" });
    expect(ctx.bookingHolds.rows.get(a.id)).toMatchObject({ status: "RELEASED", releasedReason: "EXPIRED" });
  });

  it("only the act may answer — staff and other acts are refused", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() + DAY_MS) });
    for (const actorHumanId of [STAFF_ID, ACT_B_ID]) {
      await expect(
        answerBookingHoldChallenge(ctx.deps, { actorHumanId, holdId: a.id, answer: "keep" }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// releaseBookingHold (staff)
// ─────────────────────────────────────────────────────────────────────────────

describe("releaseBookingHold", () => {
  it("releases (MANUAL), moves the line up, notifies the act and every mover; idempotent on replay", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);

    const result = await releaseBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });

    expect(result.hold).toMatchObject({ status: "RELEASED", releasedReason: "MANUAL" });
    expect(result.line.map((h) => [h.id, h.position])).toEqual([[b.id, 1]]);
    expect(result.notificationIntents).toEqual([
      { kind: "hold.released", bookingRequestId: REQUEST_A, holdId: a.id, audience: "act", date: DATE, reason: "MANUAL" },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_B, holdId: b.id, audience: "act", date: DATE, position: 1 },
    ]);

    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: a.id, reason: "MANUAL", by: "staff" }, actor: STAFF_ID },
    ]);

    const replay = await releaseBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });
    expect(replay.notificationIntents).toEqual([]);
    expect(ctx.entries(REQUEST_A)).toHaveLength(1);
  });

  it("cannot release a CONFIRMED hold", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CONFIRMED" });
    await expect(
      releaseBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_LIVE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listBookingHoldsForRequest (FR-012 / FR-013) + settleBookingHolds (FR-007)
// ─────────────────────────────────────────────────────────────────────────────

describe("listBookingHoldsForRequest", () => {
  it("staff get every column; the act gets date/position/status/respondBy/lapsed only — and never another act's holds", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() - 1) });
    ctx.seedHold(REQUEST_B);

    const staff = await listBookingHoldsForRequest(ctx.deps, { actorHumanId: VIEWER_ID, bookingRequestId: REQUEST_A, viewer: "staff" });
    expect(staff.viewer).toBe("staff");
    expect(staff.holds).toHaveLength(1);
    expect(staff.holds[0]).toMatchObject({ id: a.id, placedByHumanId: STAFF_ID, calendarId: CALENDAR_ID, lapsed: true });

    const act = await listBookingHoldsForRequest(ctx.deps, { actorHumanId: ACT_A_ID, bookingRequestId: REQUEST_A, viewer: "act" });
    expect(act).toEqual({
      viewer: "act",
      // Lapsed: no Keep left to describe.
      holds: [{ id: a.id, date: DATE, position: 1, status: "CHALLENGED", respondBy: a.respondBy, lapsed: true, keepWill: null, kept: false }],
    });
    // Reads never write: still CHALLENGED in the table.
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("CHALLENGED");

    // Act B cannot read A's holds; the act cannot pose as staff.
    await expect(
      listBookingHoldsForRequest(ctx.deps, { actorHumanId: ACT_B_ID, bookingRequestId: REQUEST_A, viewer: "act" }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      listBookingHoldsForRequest(ctx.deps, { actorHumanId: ACT_A_ID, bookingRequestId: REQUEST_A, viewer: "staff" }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  // booking-the-night FR-002: the venue can challenge the hold AHEAD from
  // this thread — so its read names the position-1 hold of every line this
  // request is in. The act's read must never carry it (booking-holds FR-013).
  it("staff get each held line's position-1 hold and whether it is challengeable; the act gets none of it", async () => {
    const ctx = buildHoldTestContext();
    const ahead = ctx.seedHold(REQUEST_B); // position 1 on DATE
    const mine = ctx.seedHold(REQUEST_A); // position 2 on DATE
    const challenged = ctx.seedHold(REQUEST_C, {
      date: "2026-06-27",
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() + HOUR_MS),
    });
    const second = ctx.seedHold(REQUEST_A, { date: "2026-06-27" });
    const first = ctx.seedHold(REQUEST_A, { date: "2026-07-04" }); // we lead this line
    ctx.seedHold(REQUEST_B, { date: "2026-07-04" });
    // N20: A has draft terms for DATE — A is ready behind B there. B has no
    // terms, so nobody is ready behind A on 2026-07-04.
    ctx.seedTerms(REQUEST_A);

    const staff = await listBookingHoldsForRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, viewer: "staff" });
    expect(staff.viewer).toBe("staff");
    if (staff.viewer !== "staff") throw new Error("unreachable");
    expect(staff.holds.map((h) => h.id).sort()).toEqual([mine.id, second.id, first.id].sort());
    expect(staff.lineHeads).toEqual([
      { calendarId: CALENDAR_ID, date: DATE, holdId: ahead.id, isThisRequest: false, challengeable: true, challengeBlocker: null },
      { calendarId: CALENDAR_ID, date: "2026-06-27", holdId: challenged.id, isThisRequest: false, challengeable: false, challengeBlocker: "challenge_open" },
      { calendarId: CALENDAR_ID, date: "2026-07-04", holdId: first.id, isThisRequest: true, challengeable: false, challengeBlocker: "no_act_ready" },
    ]);

    const act = await listBookingHoldsForRequest(ctx.deps, { actorHumanId: ACT_A_ID, bookingRequestId: REQUEST_A, viewer: "act" });
    expect(act).not.toHaveProperty("lineHeads");
    // Nothing on the act's wire names another request's hold.
    const wire = JSON.stringify(act);
    for (const foreign of [ahead.id, challenged.id]) expect(wire).not.toContain(foreign);
    // And the schema itself refuses to carry it on the act variant.
    const { listBookingHoldsForRequestOutputSchema } = await import("../list-booking-holds-for-request");
    expect(
      listBookingHoldsForRequestOutputSchema.safeParse({ ...act, lineHeads: staff.lineHeads }).success,
    ).toBe(false);
  });

  it("a lapsed head is projected out: the next live hold is the head (a read never writes)", async () => {
    const ctx = buildHoldTestContext();
    const lapsed = ctx.seedHold(REQUEST_B, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() - 1) });
    const mine = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_C);
    ctx.seedTerms(REQUEST_C); // C, behind A, is ready

    const staff = await listBookingHoldsForRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, viewer: "staff" });
    if (staff.viewer !== "staff") throw new Error("unreachable");
    expect(staff.lineHeads).toEqual([
      { calendarId: CALENDAR_ID, date: DATE, holdId: mine.id, isThisRequest: true, challengeable: true, challengeBlocker: null },
    ]);
    expect(ctx.bookingHolds.rows.get(lapsed.id)?.status).toBe("CHALLENGED");
  });
});

describe("settleBookingHolds", () => {
  it("persists the lapses a read only projected, across every line the request is in, once", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() - 1) });
    const b = ctx.seedHold(REQUEST_B);
    const aOther = ctx.seedHold(REQUEST_A, { date: "2026-06-05" }); // past date, silent

    const result = await settleBookingHolds(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A });

    expect(result.settledHoldIds.sort()).toEqual([a.id, aOther.id].sort());
    expect(result.notificationIntents.map((i) => [i.kind, i.bookingRequestId])).toEqual([
      ["hold.expired", REQUEST_A],
      ["hold.expired", REQUEST_A],
      ["hold.position_changed", REQUEST_B],
    ]);
    expect(ctx.bookingHolds.rows.get(b.id)?.position).toBe(1);

    const again = await settleBookingHolds(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A });
    expect(again).toEqual({ settledHoldIds: [], notificationIntents: [] });
  });

  it.each([
    ["a VIEWER-role member", VIEWER_ID, "INSUFFICIENT_ROLE"],
    ["an outsider", OUTSIDER_ID, "NOT_RESOURCE_OWNER"],
    ["the act itself", ACT_A_ID, "NOT_RESOURCE_OWNER"],
  ])("refuses %s (%s) and writes nothing — a lapsed hold stays as stored", async (_label, actorHumanId, code) => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() - 1) });

    await expect(
      settleBookingHolds(ctx.deps, { actorHumanId, bookingRequestId: REQUEST_A }),
    ).rejects.toMatchObject({ code });
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("CHALLENGED");
  });
});
