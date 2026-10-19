import { describe, expect, it } from "vitest";

import { answerBookingHoldChallenge } from "../answer-booking-hold-challenge";
import { challengeBookingHold } from "../challenge-booking-hold";
import { listBookingHoldsForRequest } from "../list-booking-holds-for-request";
import { releaseBookingHold } from "../release-booking-hold";
import { reorderBookingHold } from "../reorder-booking-hold";
import { settleLapsedHolds } from "../_shared/settle-lapsed-holds";
import { takeLine } from "../_shared/take-line";
import {
  ACT_A_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  OUTSIDER_ID,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
  buildHoldTestContext,
} from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// holds-without-a-request, plan step 3: every request-assuming site meets
// BOOKER and PLACE holds. A request-less hold has no thread and no act
// (H20): its history is the audit log, and no request intent names it.
// Request-only staff actions (book without terms; challenge until step 6
// widened it) refuse it with BOOKING_HOLD_NEEDS_REQUEST only AFTER the staff
// gate; the act's answer reads it as BOOKING_HOLD_NOT_FOUND (no existence or
// kind oracle).
// ─────────────────────────────────────────────────────────────────────────────

const ORG_HOLDER = "77777777-7777-4777-8777-777777777777";
const GRANT_ID = "78787878-7878-4787-8787-787878787878";

function seedPlaceHold(
  ctx: ReturnType<typeof buildHoldTestContext>,
  over: Record<string, unknown> = {},
) {
  return ctx.bookingHolds.seed({
    ownerKind: "PLACE",
    holder: null,
    calendarId: CALENDAR_ID,
    date: DATE,
    placedByHumanId: STAFF_ID,
    ...over,
  });
}

function seedBookerHold(ctx: ReturnType<typeof buildHoldTestContext>) {
  return ctx.bookingHolds.seed({
    ownerKind: "BOOKER",
    grantId: GRANT_ID,
    holder: { kind: "org", orgId: ORG_HOLDER },
    calendarId: CALENDAR_ID,
    date: DATE,
    placedByHumanId: STAFF_ID,
  });
}

const auditActions = (ctx: ReturnType<typeof buildHoldTestContext>) =>
  ctx.audit.log.mock.calls.map((call) => {
    const row = (call as unknown as [{ action: string; entityId: string; data: unknown }])[0];
    return { action: row.action, entityId: row.entityId, data: row.data };
  });

describe("releaseBookingHold — request-less holds", () => {
  it("releases a PLACE hold: audit row only, no thread entry, no intent naming it; the request hold behind moves up and is told", async () => {
    const ctx = buildHoldTestContext();
    const own = seedPlaceHold(ctx);
    const behind = ctx.seedHold(REQUEST_A);

    const result = await releaseBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: own.id });

    expect(result.hold).toMatchObject({
      id: own.id,
      ownerKind: "PLACE",
      bookingRequestId: null,
      status: "RELEASED",
      releasedReason: "MANUAL",
    });
    expect(result.notificationIntents).toEqual([
      { kind: "hold.position_changed", bookingRequestId: REQUEST_A, holdId: behind.id, audience: "act", date: DATE, position: 1 },
    ]);
    expect(auditActions(ctx)).toContainEqual({
      action: "booking_hold.released",
      entityId: own.id,
      data: {
        actorHumanId: STAFF_ID,
        ownerKind: "PLACE",
        bookingRequestId: null,
        reason: "MANUAL",
        by: "staff",
      },
    });
    // The only thread entry is the mover's, on the request that moved.
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.reordered", data: { holdId: behind.id, from: 2, to: 1 }, actor: STAFF_ID },
    ]);
  });

  it("a request-less hold that moves up gets an audit row, not a thread entry or an intent", async () => {
    const ctx = buildHoldTestContext();
    const head = ctx.seedHold(REQUEST_A);
    const booker = seedBookerHold(ctx);

    const result = await releaseBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: head.id });

    expect(result.notificationIntents).toEqual([
      { kind: "hold.released", bookingRequestId: REQUEST_A, holdId: head.id, audience: "act", date: DATE, reason: "MANUAL" },
    ]);
    expect(result.line.map((h) => [h.id, h.position])).toEqual([[booker.id, 1]]);
    expect(auditActions(ctx)).toContainEqual({
      action: "booking_hold.reordered",
      entityId: booker.id,
      data: { ownerKind: "BOOKER", from: 2, to: 1, actorHumanId: STAFF_ID, by: "staff" },
    });
    // Stamped with the use case's clock, like every other hold audit row.
    const moverRow = ctx.audit.log.mock.calls
      .map((call) => (call as unknown as [{ action: string; entityId: string; at?: Date }])[0])
      .find((row) => row.action === "booking_hold.reordered" && row.entityId === booker.id);
    expect(moverRow?.at).toEqual(NOW);
  });
});

describe("reorderBookingHold — request-less holds", () => {
  it("moves a PLACE hold to the front; the audit row carries its owner kind and no request", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    const own = seedPlaceHold(ctx);

    const result = await reorderBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: own.id, toPosition: 1 });

    expect(result.line.map((h) => h.id)).toEqual([own.id, a.id]);
    expect(auditActions(ctx)).toContainEqual(
      expect.objectContaining({
        entityId: own.id,
        data: expect.objectContaining({ ownerKind: "PLACE", bookingRequestId: null }),
      }),
    );
    expect(result.notificationIntents).toContainEqual(
      expect.objectContaining({ kind: "hold.position_changed", bookingRequestId: REQUEST_A, position: 2 }),
    );
  });
});

describe("settleLapsedHolds — request-less holds", () => {
  it("a past-date PLACE hold is released PAST_DATE with an audit row; no request read, no thread entry", async () => {
    const ctx = buildHoldTestContext();
    const past = seedPlaceHold(ctx, { date: "2026-06-01" });

    const { settled, intents } = await settleLapsedHolds(ctx.repos as unknown as Parameters<typeof settleLapsedHolds>[0], {
      holds: [past],
      now: NOW,
      placeTz: "America/Chicago",
      actorHumanId: null,
    });

    expect(settled.map((h) => [h.id, h.status, h.releasedReason])).toEqual([[past.id, "RELEASED", "PAST_DATE"]]);
    expect(intents).toEqual([]);
    expect(ctx.bookingRequests.getById).not.toHaveBeenCalled();
    expect(auditActions(ctx)).toContainEqual({
      action: "booking_hold.released",
      entityId: past.id,
      data: { ownerKind: "PLACE", reason: "PAST_DATE", actorHumanId: null },
    });
  });

  it("a live request-less hold is never released REQUEST_CLOSED (it has no request to close)", async () => {
    const ctx = buildHoldTestContext();
    const booker = seedBookerHold(ctx);

    const { settled } = await settleLapsedHolds(ctx.repos as unknown as Parameters<typeof settleLapsedHolds>[0], {
      holds: [booker],
      now: NOW,
      placeTz: "America/Chicago",
      actorHumanId: null,
    });

    expect(settled).toEqual([]);
    expect(ctx.bookingHolds.rows.get(booker.id)?.status).toBe("ACTIVE");
  });
});

describe("takeLine — request-less competitors", () => {
  const tx = (ctx: ReturnType<typeof buildHoldTestContext>) =>
    ctx.repos as unknown as Parameters<typeof takeLine>[0];

  it("a REQUEST winner releases a PLACE competitor CONFIRMED_OTHER with an audit row and no intent for it", async () => {
    const ctx = buildHoldTestContext();
    const winner = ctx.seedHold(REQUEST_A);
    const own = seedPlaceHold(ctx);
    const line = await ctx.bookingHolds.listLine({ calendarId: CALENDAR_ID, date: DATE });

    const result = await takeLine(tx(ctx), {
      key: { calendarId: CALENDAR_ID, date: DATE },
      line,
      now: NOW,
      actorHumanId: STAFF_ID,
      winner: { hold: winner, requestHolds: [] },
    });

    expect(result.confirmed?.id).toBe(winner.id);
    expect(result.released.map((h) => [h.id, h.releasedReason])).toEqual([[own.id, "CONFIRMED_OTHER"]]);
    expect(result.intents.every((i) => i.holdId !== own.id)).toBe(true);
    expect(result.intents).toContainEqual(expect.objectContaining({ kind: "hold.confirmed", bookingRequestId: REQUEST_A }));
    expect(auditActions(ctx)).toContainEqual({
      action: "booking_hold.released",
      entityId: own.id,
      data: { ownerKind: "PLACE", reason: "CONFIRMED_OTHER", actorHumanId: STAFF_ID },
    });
  });

  it("nobody wins (an event took the night): request holds get their intents, the BOOKER hold an audit row", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    const booker = seedBookerHold(ctx);
    const line = await ctx.bookingHolds.listLine({ calendarId: CALENDAR_ID, date: DATE });

    const result = await takeLine(tx(ctx), {
      key: { calendarId: CALENDAR_ID, date: DATE },
      line,
      now: NOW,
      actorHumanId: null,
      winner: null,
      releaseReason: "EVENT_SCHEDULED",
    });

    expect(result.released.map((h) => h.id).sort()).toEqual([a.id, booker.id].sort());
    expect(result.intents.map((i) => [i.kind, i.holdId])).toEqual([
      ["hold.released", a.id],
      ["hold.released", a.id],
    ]);
    expect(auditActions(ctx)).toContainEqual({
      action: "booking_hold.released",
      entityId: booker.id,
      data: { ownerKind: "BOOKER", reason: "EVENT_SCHEDULED", actorHumanId: null },
    });
  });

  it("a request-less winner confirms with no request intent", async () => {
    const ctx = buildHoldTestContext();
    const own = seedPlaceHold(ctx);
    const line = await ctx.bookingHolds.listLine({ calendarId: CALENDAR_ID, date: DATE });

    const result = await takeLine(tx(ctx), {
      key: { calendarId: CALENDAR_ID, date: DATE },
      line,
      now: NOW,
      actorHumanId: STAFF_ID,
      winner: { hold: own, requestHolds: [] },
    });

    expect(result.confirmed).toMatchObject({ id: own.id, status: "CONFIRMED" });
    expect(result.intents).toEqual([]);
  });
});

describe("request-only actions refuse a request-less hold", () => {
  // Step 6 (FR-006) lifted step 3's refusal: a PLACE hold at 1st is
  // challenged like any other (more in requestless-hold-actions.test.ts).
  it("challengeBookingHold on a PLACE hold challenges it: no thread, no request intent, an audit row", async () => {
    const ctx = buildHoldTestContext();
    const own = seedPlaceHold(ctx);
    ctx.seedHold(REQUEST_A);
    ctx.seedTerms(REQUEST_A);

    const out = await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: own.id });

    expect(ctx.bookingHolds.rows.get(own.id)?.status).toBe("CHALLENGED");
    expect(out.notificationIntents.filter((i) => i.holdId === own.id)).toEqual([]);
    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({ kind: "requestless_hold.challenged", audience: "staff", holdId: own.id }),
    ]);
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: own.id, action: "booking_hold.challenged" }),
    );
  });

  it("a stranger challenging a request-less hold gets the staff gate's refusal, not BOOKING_HOLD_NEEDS_REQUEST", async () => {
    const ctx = buildHoldTestContext();
    const own = seedPlaceHold(ctx);
    const booker = seedBookerHold(ctx);

    for (const hold of [own, booker]) {
      const err = await challengeBookingHold(ctx.deps, { actorHumanId: OUTSIDER_ID, holdId: hold.id }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(err).not.toMatchObject({ code: "BOOKING_HOLD_NEEDS_REQUEST" });
      expect(JSON.stringify(err)).not.toContain(hold.ownerKind);
    }
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("answerBookingHoldChallenge on a request-less hold → BOOKING_HOLD_NOT_FOUND, the same answer as a missing id", async () => {
    const ctx = buildHoldTestContext();
    const booker = seedBookerHold(ctx);
    const own = seedPlaceHold(ctx);

    for (const holdId of [booker.id, own.id, "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f"]) {
      const err = await answerBookingHoldChallenge(ctx.deps, { actorHumanId: ACT_A_ID, holdId, answer: "keep" }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "BOOKING_HOLD_NOT_FOUND" });
      expect(err).not.toHaveProperty("meta.ownerKind");
    }
    expect(ctx.bookingRequests.getById).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("a request-less hold BEHIND a request head is a ready one: the head can be challenged", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    seedPlaceHold(ctx);

    const result = await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });

    expect(result.hold).toMatchObject({ id: a.id, status: "CHALLENGED" });
  });
});

describe("listBookingHoldsForRequest — a request-less line head", () => {
  it("names the head with blocker requestless_head and challengeable false; the request's own holds only", async () => {
    const ctx = buildHoldTestContext();
    const own = seedPlaceHold(ctx);
    const mine = ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);

    const result = await listBookingHoldsForRequest(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_B,
      viewer: "staff",
    });
    if (result.viewer !== "staff") throw new Error("expected the staff view");

    expect(result.holds.map((h) => h.id)).toEqual([mine.id]);
    expect(result.holds[0]).toMatchObject({ ownerKind: "REQUEST", bookingRequestId: REQUEST_B });
    expect(result.lineHeads).toEqual([
      {
        calendarId: CALENDAR_ID,
        date: DATE,
        holdId: own.id,
        isThisRequest: false,
        challengeable: false,
        challengeBlocker: "requestless_head",
      },
    ]);
  });
});
