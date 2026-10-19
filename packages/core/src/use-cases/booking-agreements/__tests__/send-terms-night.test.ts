import { describe, expect, it, vi } from "vitest";

import {
  ACT_A_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  OTHER_CALENDAR_ID,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
} from "../../booking-holds/__tests__/hold-test-context";
import { sendBookingAgreementForReview } from "../send-booking-agreement-for-review";
import { sendBookingTerms } from "../send-booking-terms";
import { A_TERMS, NIGHT_AT, buildNightHarness, terms } from "./night-harness";

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night FR-002 (the send records its actor and refuses a night
// another hold is ahead on — N6) and FR-003 (the one "Send terms" call).
// ─────────────────────────────────────────────────────────────────────────────

function draftHarness(over: Parameters<typeof terms>[2] = {}) {
  const ctx = buildNightHarness();
  ctx.agreements.set(
    A_TERMS,
    terms(A_TERMS, ACT_A_ID, {
      status: "DRAFT",
      proposedAt: null,
      sentForReviewByHumanId: null,
      ...over,
    }),
  );
  return ctx;
}

const send = (ctx: ReturnType<typeof draftHarness>, actorHumanId = STAFF_ID) =>
  sendBookingAgreementForReview(ctx.deps, { actorHumanId, agreementId: A_TERMS });

describe("sendBookingAgreementForReview — the actor stamp (FR-002)", () => {
  it("records who sent the terms in the same guarded write as DRAFT → PROPOSED", async () => {
    const ctx = draftHarness();
    ctx.seedHold(REQUEST_A);

    await send(ctx);

    expect(ctx.agreements.get(A_TERMS)).toMatchObject({
      status: "PROPOSED",
      proposedAt: NOW,
      sentForReviewByHumanId: STAFF_ID,
    });
    expect(ctx.repos.agreements.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "PROPOSED",
        expectedFrom: ["DRAFT"],
        sentForReviewByHumanId: STAFF_ID,
      }),
    );
  });
});

describe("sendBookingAgreementForReview — N6: the night must be free for this request", () => {
  it("another act's hold AHEAD of this request's → NIGHT_TAKEN with the date, the position and the hold to challenge; nothing sent", async () => {
    const ctx = draftHarness();
    const ahead = ctx.seedHold(REQUEST_B);
    ctx.seedHold(REQUEST_A);

    await expect(send(ctx)).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: DATE, position: 1, aheadHoldId: ahead.id, booked: false, challengeable: true },
    });
    expect(ctx.agreements.get(A_TERMS)).toMatchObject({ status: "DRAFT", sentForReviewByHumanId: null });
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("this request holds nothing on the night but another act does → NIGHT_TAKEN", async () => {
    const ctx = draftHarness();
    const ahead = ctx.seedHold(REQUEST_B);

    await expect(send(ctx)).rejects.toMatchObject({ code: "NIGHT_TAKEN", meta: { aheadHoldId: ahead.id } });
  });

  it("another request has BOOKED the night → NIGHT_TAKEN, booked, nothing to challenge", async () => {
    const ctx = draftHarness();
    ctx.seedHold(REQUEST_B, { status: "CONFIRMED", confirmedAt: NOW });

    await expect(send(ctx)).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: DATE, aheadHoldId: null, booked: true, challengeable: false },
    });
  });

  it("an open challenge on the hold ahead is reported as not challengeable again", async () => {
    const ctx = draftHarness();
    ctx.seedHold(REQUEST_B, { status: "CHALLENGED", challengedAt: NOW, respondBy: new Date(NOW.getTime() + 3600_000) });
    ctx.seedHold(REQUEST_A);

    await expect(send(ctx)).rejects.toMatchObject({ code: "NIGHT_TAKEN", meta: { challengeable: false } });
  });

  it("this request first in line, or nobody on the night → the terms go out", async () => {
    const first = draftHarness();
    first.seedHold(REQUEST_A);
    first.seedHold(REQUEST_B);
    await expect(send(first)).resolves.toMatchObject({ status: "PROPOSED" });

    const empty = draftHarness();
    await expect(send(empty)).resolves.toMatchObject({ status: "PROPOSED" });
  });

  it("acceptance: refused while another act holds position 1; after that act releases, the send works", async () => {
    const ctx = draftHarness();
    const ahead = ctx.seedHold(REQUEST_B);
    const mine = ctx.seedHold(REQUEST_A);
    await expect(send(ctx)).rejects.toMatchObject({ code: "NIGHT_TAKEN" });

    ctx.bookingHolds.rows.set(ahead.id, { ...ahead, status: "RELEASED", releasedReason: "MANUAL", releasedAt: NOW });
    ctx.bookingHolds.rows.set(mine.id, { ...mine, position: 1 });
    await expect(send(ctx)).resolves.toMatchObject({ status: "PROPOSED" });
  });

  it("a LAPSED hold ahead does not block, and the send writes nothing to the line (lapses are projected, not settled)", async () => {
    const ctx = draftHarness();
    const lapsed = ctx.seedHold(REQUEST_B, {
      status: "CHALLENGED",
      challengedAt: new Date(NOW.getTime() - 86_400_000),
      respondBy: new Date(NOW.getTime() - 60_000),
    });
    ctx.seedHold(REQUEST_A);

    await expect(send(ctx)).resolves.toMatchObject({ status: "PROPOSED" });
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(lapsed.id)?.status).toBe("CHALLENGED");
  });

  it("the check runs under the night's line lock, taken before the line is read", async () => {
    const ctx = draftHarness();
    ctx.seedHold(REQUEST_A);

    await send(ctx);

    expect(ctx.bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, date: DATE });
    const lockAt = vi.mocked(ctx.bookingHolds.lockLine).mock.invocationCallOrder[0]!;
    for (const at of vi.mocked(ctx.bookingHolds.listLine).mock.invocationCallOrder) {
      expect(lockAt).toBeLessThan(at);
    }
  });

  it("the night's line is this request's hold's calendar, not just the routed one", async () => {
    const ctx = draftHarness();
    ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID });
    // Another act ahead on the ROUTED calendar does not matter: the terms
    // book the line this request holds.
    ctx.seedHold(REQUEST_B);

    await expect(send(ctx)).resolves.toMatchObject({ status: "PROPOSED" });
    expect(ctx.bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: OTHER_CALENDAR_ID, date: DATE });
  });

  it("terms with no date are not checked (no night to hold)", async () => {
    const ctx = draftHarness({ proposedDate: null });
    ctx.seedHold(REQUEST_B);

    await expect(send(ctx)).resolves.toMatchObject({ status: "PROPOSED" });
    expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
  });

  it("the act cannot send (TERMS_EDITOR_ONLY) and no hold is read for them", async () => {
    const ctx = draftHarness();
    ctx.seedHold(REQUEST_B);

    await expect(send(ctx, ACT_A_ID)).rejects.toMatchObject({ code: "TERMS_EDITOR_ONLY" });
    expect(ctx.bookingHolds.listForRequest).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.listLine).not.toHaveBeenCalled();
  });
});

describe("sendBookingAgreementForReview — one booked night per request (review B1)", () => {
  it("terms for a night OTHER than the one this request booked → BOOKING_ALREADY_HAS_NIGHT, nothing sent", async () => {
    const ctx = draftHarness(); // terms for DATE
    ctx.seedHold(REQUEST_A, { date: "2026-06-27", status: "CONFIRMED", confirmedAt: NOW });

    const error = await send(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "BOOKING_ALREADY_HAS_NIGHT" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("DRAFT");
  });

  it("terms for the night this request booked go out (new money terms on a booked night)", async () => {
    const ctx = draftHarness();
    ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW });

    await expect(send(ctx)).resolves.toMatchObject({ status: "PROPOSED" });
  });

  it("\"Send terms\" with no night defaults to the BOOKED night, not a released one (Scenario A)", async () => {
    const ctx = draftHarness({ proposedDate: null });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: ["2026-06-13", "2026-06-27"] });
    ctx.seedHold(REQUEST_A, { date: "2026-06-13", status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });
    ctx.seedHold(REQUEST_A, { date: "2026-06-27", status: "CONFIRMED", confirmedAt: NOW });

    const result = await sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS });
    expect(result).toMatchObject({ status: "PROPOSED", night: "2026-06-27" });
  });
});

describe("review round 2 — W2 / W3 on the send side", () => {
  it("W2: sendBookingTerms for another night than the booked one is refused BEFORE the header write — the draft is unchanged", async () => {
    const ctx = draftHarness();
    const before = ctx.agreements.get(A_TERMS)!;
    ctx.seedHold(REQUEST_A, { date: "2026-06-27", status: "CONFIRMED", confirmedAt: NOW });

    await expect(
      sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS, night: DATE, startTime: "21:00" }),
    ).rejects.toMatchObject({ code: "BOOKING_ALREADY_HAS_NIGHT" });
    expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
    expect(ctx.agreements.get(A_TERMS)).toEqual(before);
  });

  it("W3: a book-without-terms moves the DRAFT header to its night while the send waits for the line lock → the send's re-read refuses (agreement_status_changed); nothing sent", async () => {
    const ctx = draftHarness(); // terms for DATE
    ctx.seedHold(REQUEST_A);
    const moved = new Date("2026-06-28T01:00:00.000Z");
    const lockLine = vi.mocked(ctx.bookingHolds.lockLine);
    const real = lockLine.getMockImplementation()!;
    let fired = false;
    lockLine.mockImplementation(async (key) => {
      if (!fired) {
        fired = true;
        // The concurrent booking committed its header alignment.
        ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, proposedDate: moved });
      }
      return real(key);
    });

    await expect(send(ctx)).rejects.toMatchObject({ code: "conflict", message: "agreement_status_changed" });
    expect(ctx.agreements.get(A_TERMS)).toMatchObject({ status: "DRAFT", proposedDate: moved, sentForReviewByHumanId: null });
    expect(ctx.repos.agreements.updateStatus).not.toHaveBeenCalled();
  });
});

describe("sendBookingTerms — one call (FR-003)", () => {
  it("defaults the night to this request's position-1 hold, the time to the calendar's default, then sends", async () => {
    const ctx = draftHarness({ proposedDate: null });
    ctx.seedHold(REQUEST_A, { date: "2026-06-27" });

    const result = await sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS });

    // 2026-06-27 20:00 CDT.
    const expected = new Date("2026-06-28T01:00:00.000Z");
    expect(result).toMatchObject({ status: "PROPOSED", night: "2026-06-27", proposedDate: expected });
    expect(ctx.agreements.get(A_TERMS)).toMatchObject({
      status: "PROPOSED",
      proposedDate: expected,
      sentForReviewByHumanId: STAFF_ID,
    });
  });

  it("no position-1 hold → the first night the pitch asked for", async () => {
    const ctx = draftHarness({ proposedDate: null });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: ["2026-07-04T21:30", DATE] });

    const result = await sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS });

    // The act named 21:30 on that night: 2026-07-04 21:30 CDT.
    expect(result).toMatchObject({ night: "2026-07-04", proposedDate: new Date("2026-07-05T02:30:00.000Z") });
  });

  it("an explicit night and a 00:30 time land ON that calendar day (the day publish settling uses) — and N6 checks that day's line", async () => {
    const ctx = draftHarness();
    const mine = ctx.seedHold(REQUEST_A);

    const result = await sendBookingTerms(ctx.deps, {
      actorHumanId: STAFF_ID,
      agreementId: A_TERMS,
      night: DATE,
      startTime: "00:30",
    });

    // 00:30 CDT on Sat 20 June — not the early hours of the 21st.
    expect(result.proposedDate).toEqual(new Date("2026-06-20T05:30:00.000Z"));
    expect(result.night).toBe(DATE);
    expect(ctx.bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: mine.calendarId, date: DATE });
  });

  // ── P3b (asks) ── review W3: a SET_LENGTH answered while the draft named
  // no date is not lost — the night set here still gets start + minutes.
  it("no negotiated length and no pitch set length → the ANSWERED set-length ask sets the end", async () => {
    const ctx = draftHarness({ proposedDate: null, proposedEndDate: null });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, setLengthMinutes: null });
    ctx.bookingRequests.listAsks.mockResolvedValue([
      {
        id: "a5a5a5a5-0000-4000-8000-000000000001",
        bookingRequestId: REQUEST_A,
        kind: "SET_LENGTH",
        status: "ANSWERED",
        answerMinutes: 50,
        answeredAt: NOW,
      },
    ] as never);

    const result = await sendBookingTerms(ctx.deps, {
      actorHumanId: STAFF_ID,
      agreementId: A_TERMS,
      night: "2026-06-27",
      startTime: "21:00",
    });

    expect(ctx.agreements.get(A_TERMS)?.proposedEndDate).toEqual(
      new Date(result.proposedDate.getTime() + 50 * 60_000),
    );
  });

  it("the pitch's own set length still wins over an answered ask", async () => {
    const ctx = draftHarness({ proposedDate: null, proposedEndDate: null });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, setLengthMinutes: 30 });
    ctx.bookingRequests.listAsks.mockResolvedValue([
      { kind: "SET_LENGTH", status: "ANSWERED", answerMinutes: 90, answeredAt: NOW },
    ] as never);
    const result = await sendBookingTerms(ctx.deps, {
      actorHumanId: STAFF_ID,
      agreementId: A_TERMS,
      night: "2026-06-27",
      startTime: "21:00",
    });
    expect(ctx.agreements.get(A_TERMS)?.proposedEndDate).toEqual(
      new Date(result.proposedDate.getTime() + 30 * 60_000),
    );
  });

  it("keeps the negotiated length on the new start", async () => {
    const ctx = draftHarness({ proposedEndDate: new Date(NIGHT_AT.getTime() + 2 * 3600_000) });

    const result = await sendBookingTerms(ctx.deps, {
      actorHumanId: STAFF_ID,
      agreementId: A_TERMS,
      night: "2026-06-27",
      startTime: "21:00",
    });

    expect(ctx.agreements.get(A_TERMS)).toMatchObject({
      proposedDate: result.proposedDate,
      proposedEndDate: new Date(result.proposedDate.getTime() + 2 * 3600_000),
    });
  });

  it("a header already on that instant is not rewritten", async () => {
    const ctx = draftHarness();

    await sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS, night: DATE, startTime: "20:00" });

    expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
  });

  // Review round 3 nit: the output reports what was SENT — the stored
  // instant re-read after the send, and the night derived from it — never
  // the value this call computed.
  it("returns the STORED proposedDate and its night, even when the header write left a different instant in place", async () => {
    const ctx = draftHarness(); // stored: 20:00 on DATE (NIGHT_AT)
    const updateHeader = vi.mocked(ctx.repos.agreements.updateHeader);
    updateHeader.mockImplementation(async (input: { id: string }) => ctx.agreements.get(input.id)! as never);

    const result = await sendBookingTerms(ctx.deps, {
      actorHumanId: STAFF_ID,
      agreementId: A_TERMS,
      night: DATE,
      startTime: "22:00",
    });

    expect(updateHeader).toHaveBeenCalled();
    expect(result.proposedDate).toEqual(NIGHT_AT);
    expect(result.proposedDate).toEqual(ctx.agreements.get(A_TERMS)?.proposedDate);
    expect(result.night).toBe(DATE);
  });

  it("NIGHT_TAKEN on the chosen night: the draft keeps the night the venue picked, nothing is sent", async () => {
    const ctx = draftHarness({ proposedDate: null });
    const ahead = ctx.seedHold(REQUEST_B);

    await expect(
      sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS, night: DATE }),
    ).rejects.toMatchObject({ code: "NIGHT_TAKEN", meta: { aheadHoldId: ahead.id } });
    expect(ctx.agreements.get(A_TERMS)).toMatchObject({ status: "DRAFT", proposedDate: NIGHT_AT });
  });

  it("the act is refused before anything about the request is read", async () => {
    const ctx = draftHarness();

    await expect(
      sendBookingTerms(ctx.deps, { actorHumanId: ACT_A_ID, agreementId: A_TERMS }),
    ).rejects.toMatchObject({ code: "TERMS_EDITOR_ONLY" });
    expect(ctx.bookingHolds.listForRequest).not.toHaveBeenCalled();
    expect(ctx.repos.places.getById).not.toHaveBeenCalled();
  });

  it("a request that names no night and holds none → invalid_input night_required", async () => {
    const ctx = draftHarness({ proposedDate: null });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: [] });

    await expect(
      sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS }),
    ).rejects.toMatchObject({ code: "invalid_input", issues: [{ message: "night_required" }] });
  });

  it("rejects a malformed time at the boundary", async () => {
    const ctx = draftHarness();
    await expect(
      sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS, startTime: "25:00" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
