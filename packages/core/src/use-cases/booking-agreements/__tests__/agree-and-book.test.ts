import { beforeEach, describe, expect, it, vi } from "vitest";

import { isAppError } from "@th/errors";

import { bookNightWithoutTerms } from "../../booking-holds/book-night-without-terms";
import { makeFakeIdempotency } from "../../booking-requests/__tests__/helpers";
import {
  ACT_A_ID,
  ACT_B_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  ORG_ID,
  OTHER_CALENDAR_ID,
  REQUEST_A,
  REQUEST_B,
  REQUEST_C,
  STAFF_ID,
} from "../../booking-holds/__tests__/hold-test-context";
import { pullBackBookingAgreement } from "../pull-back-booking-agreement";
import { respondToBookingAgreement } from "../respond-to-booking-agreement";
import { sendBookingAgreementForReview } from "../send-booking-agreement-for-review";
import { sendBookingTerms } from "../send-booking-terms";
import {
  A_TERMS,
  B_EVENT_ID,
  B_TERMS,
  EVENT_ID,
  NIGHT_AT,
  buildNightHarness,
  terms,
  type NightHarness,
} from "./night-harness";

// ─────────────────────────────────────────────────────────────────────────────
// Agree & book (booking-the-night FR-001; N1, N5, N6, N10, N11, N17, NFR-001).
//
// The sender's accept of request-linked TO_VENUE terms books the night in one
// transaction and mints the draft event after commit, as the venue person
// who sent the terms. Built on the hold harness (an org-owned venue, one
// calendar with a 20:00 default, three acts each with a request); the
// post-commit mints are boundaries here (create-event-from-agreement has its
// own suite).
// ─────────────────────────────────────────────────────────────────────────────

const agreeMint = vi.fn();
const holdMint = vi.fn();
vi.mock("../create-event-from-agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../create-event-from-agreement")>()),
  createEventFromAgreementOnNight: (...args: unknown[]) => agreeMint(...args),
  createEventFromAgreementForHold: (...args: unknown[]) => holdMint(...args),
}));

type Ctx = NightHarness;
const build = buildNightHarness;

const agree = (ctx: Ctx, actorHumanId = ACT_A_ID, agreementId = A_TERMS) =>
  respondToBookingAgreement(ctx.deps, { actorHumanId, agreementId, action: "accept" });

beforeEach(() => {
  agreeMint.mockReset();
  agreeMint.mockResolvedValue({ eventId: EVENT_ID, alreadyLinked: false, finalized: false });
  holdMint.mockReset();
  holdMint.mockResolvedValue({ eventId: B_EVENT_ID, alreadyLinked: false, finalized: false });
});

describe("Agree & book — the night is booked", () => {
  it("confirms this request's hold, others on the night lose it, siblings go; then the event is minted as the terms' sender on the booked night", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    const behind = ctx.seedHold(REQUEST_B);
    const sibling = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });

    const result = await agree(ctx);

    expect(result).toMatchObject({ agreementId: A_TERMS, status: "ACCEPTED", acceptedAt: NOW, eventId: EVENT_ID });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.bookingHolds.rows.get(mine.id)).toMatchObject({ status: "CONFIRMED", confirmedAt: NOW });
    expect(ctx.bookingHolds.rows.get(behind.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    // N17.
    expect(ctx.bookingHolds.rows.get(sibling.id)).toMatchObject({ status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });

    // Ledger on the sender's thread: the accept and the booked night, by the sender.
    const mineEntries = ctx.entries(REQUEST_A);
    expect(mineEntries.slice(-2)).toEqual([
      { kind: "booking_agreement.accepted", data: { agreementId: A_TERMS, actorSide: "PERFORMER" }, actor: ACT_A_ID },
      { kind: "booking_hold.confirmed", data: { holdId: mine.id, eventId: null }, actor: ACT_A_ID },
    ]);
    // The act behind hears it from the VENUE side — never the sender's id
    // on another act's thread (booking-holds FR-013).
    expect(ctx.entries(REQUEST_B)).toEqual([
      { kind: "booking_hold.released", data: { holdId: behind.id, reason: "CONFIRMED_OTHER" }, actor: STAFF_ID },
    ]);

    // N10: the mint runs after commit as the human who sent the terms, placed
    // on the booked night's calendar.
    expect(agreeMint).toHaveBeenCalledTimes(1);
    expect(agreeMint.mock.calls[0]![1]).toEqual({
      actorHumanId: STAFF_ID,
      agreementId: A_TERMS,
      night: { calendarId: CALENDAR_ID, spaceId: null, date: DATE },
    });

    // Notices: lost_date to the act behind; the sender's own "your date is
    // booked" is dropped (they just tapped it).
    expect(result.notificationIntents).toContainEqual({
      kind: "hold.lost_date",
      bookingRequestId: REQUEST_B,
      holdId: behind.id,
      audience: "act",
      date: DATE,
      reason: "CONFIRMED_OTHER",
    });
    expect(result.notificationIntents.some((i) => i.kind === "hold.confirmed")).toBe(false);
    expect(result.staffRecipientHint).toMatchObject({ orgId: ORG_ID });
    // The venue is pinged that the terms were agreed.
    expect(ctx.deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: ASSIGNEE_ID, payload: expect.objectContaining({ title: "Agreement accepted" }) }),
    );
  });

  it("N5: nobody holds the night → a CONFIRMED hold is written for this request (placed by the terms' sender)", async () => {
    const ctx = build();
    const elsewhere = ctx.seedHold(REQUEST_A, { date: "2026-06-27" });

    const result = await agree(ctx);

    const written = [...ctx.bookingHolds.rows.values()].find(
      (h) => h.bookingRequestId === REQUEST_A && h.date === DATE,
    );
    expect(written).toMatchObject({ calendarId: CALENDAR_ID, status: "CONFIRMED", position: 1, placedByHumanId: STAFF_ID });
    expect(ctx.bookingHolds.rows.get(elsewhere.id)).toMatchObject({ status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });
    expect(result.eventId).toBe(EVENT_ID);
  });

  it("a 00:30 start books ITS OWN calendar day's line — the day publish settling will take, never the day before", async () => {
    const ctx = build();
    // 00:30 CDT on Sun 21 June.
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { proposedDate: new Date("2026-06-21T05:30:00.000Z") }));
    const saturday20 = ctx.seedHold(REQUEST_A); // DATE = Sat 20 June
    const sunday21 = ctx.seedHold(REQUEST_A, { date: "2026-06-21" });

    await agree(ctx);

    expect(ctx.bookingHolds.rows.get(sunday21.id)?.status).toBe("CONFIRMED");
    expect(ctx.bookingHolds.rows.get(saturday20.id)).toMatchObject({ status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });
    expect(agreeMint.mock.calls[0]![1]).toMatchObject({ night: { date: "2026-06-21" } });
  });

  it("this request already booked the night (venue booked it without terms first) → terms accepted, no line writes, the mint returns the existing draft", async () => {
    const ctx = build();
    const booked = ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW });
    agreeMint.mockResolvedValueOnce({ eventId: EVENT_ID, alreadyLinked: true, finalized: true });

    const result = await agree(ctx);

    expect(result).toMatchObject({ status: "ACCEPTED", eventId: EVENT_ID });
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.create).not.toHaveBeenCalled();
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_agreement.accepted"]);
    expect(ctx.bookingHolds.rows.get(booked.id)?.status).toBe("CONFIRMED");
  });

  it("the sender's own CHALLENGED hold at position 1 is booked (agreeing is keeping it)", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", challengedAt: NOW, respondBy: new Date(NOW.getTime() + 3600_000) });
    ctx.seedHold(REQUEST_B);

    await agree(ctx);

    expect(ctx.bookingHolds.rows.get(mine.id)).toMatchObject({ status: "CONFIRMED", respondBy: null });
  });
});

describe("Agree & book — the night went elsewhere (N6 re-check)", () => {
  async function expectRefusedWithNoMeta(promise: Promise<unknown>) {
    const error = await promise.then(
      () => {
        throw new Error("expected the agree to be refused");
      },
      (e: unknown) => e,
    );
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({ code: "NIGHT_NO_LONGER_AVAILABLE" });
    // The sender's refusal never names another party's hold.
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect((error as Error).message).toBe("NIGHT_NO_LONGER_AVAILABLE");
  }

  function expectNothingBooked(ctx: Ctx, holdIds: string[]) {
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    for (const id of holdIds) expect(ctx.bookingHolds.rows.get(id)?.status).not.toBe("CONFIRMED");
    expect(ctx.bookingHolds.create).not.toHaveBeenCalled();
    expect(agreeMint).not.toHaveBeenCalled();
  }

  function expectVenueTold(ctx: Ctx) {
    // A VENUE-ONLY ledger entry on the thread …
    const refused = ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_agreement.agree_refused");
    expect(refused).toEqual([
      { kind: "booking_agreement.agree_refused", data: { agreementId: A_TERMS, date: DATE }, actor: ACT_A_ID },
    ]);
    // … and an in-app ping to the venue's admins (not the sender).
    const pinged = (ctx.deps.notify as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([n]) => n);
    expect(pinged.map((n: { humanId: string }) => n.humanId).sort()).toEqual([ASSIGNEE_ID, STAFF_ID].sort());
    expect(pinged[0]).toMatchObject({ payload: { title: "Night no longer available" } });
  }

  it("another act's hold moved AHEAD since the send → refused with no meta, terms stay PROPOSED, the venue is told", async () => {
    const ctx = build();
    const ahead = ctx.seedHold(REQUEST_B);
    const mine = ctx.seedHold(REQUEST_A);

    await expectRefusedWithNoMeta(agree(ctx));

    expectNothingBooked(ctx, [ahead.id, mine.id]);
    expect(ctx.bookingHolds.rows.get(ahead.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expectVenueTold(ctx);
    // Nothing else landed on any thread.
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_agreement.agree_refused"]);
    expect(ctx.entries(REQUEST_B)).toEqual([]);
  });

  it("another request's CONFIRMED hold on the night → refused the same way", async () => {
    const ctx = build();
    const booked = ctx.seedHold(REQUEST_B, { status: "CONFIRMED", confirmedAt: NOW });
    const mine = ctx.seedHold(REQUEST_A);

    await expectRefusedWithNoMeta(agree(ctx));
    expectNothingBooked(ctx, [mine.id]);
    expect(ctx.bookingHolds.rows.get(booked.id)?.status).toBe("CONFIRMED");
    expectVenueTold(ctx);
  });

  it("an open challenge on another act's hold → refused (that hold is position 1, ahead)", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_B, { status: "CHALLENGED", challengedAt: NOW, respondBy: new Date(NOW.getTime() + 3600_000) });
    const mine = ctx.seedHold(REQUEST_A);

    await expectRefusedWithNoMeta(agree(ctx));
    expectNothingBooked(ctx, [mine.id]);
  });

  it("no hold of ours and someone else holds the night → refused (we would be behind them)", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_B);

    await expectRefusedWithNoMeta(agree(ctx));
    expectNothingBooked(ctx, []);
  });

  it("a LAPSED challenge ahead is settled first, and then the night is ours", async () => {
    const ctx = build();
    const lapsed = ctx.seedHold(REQUEST_B, {
      status: "CHALLENGED",
      challengedAt: new Date(NOW.getTime() - 86_400_000),
      respondBy: new Date(NOW.getTime() - 60_000),
    });
    const mine = ctx.seedHold(REQUEST_A);

    const result = await agree(ctx);

    expect(ctx.bookingHolds.rows.get(lapsed.id)).toMatchObject({ status: "RELEASED", releasedReason: "EXPIRED" });
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
    // The lapse's own notices ride out with the booking's.
    expect(result.notificationIntents.map((i) => i.kind)).toContain("hold.expired");
  });

  it("the DB's one-CONFIRMED-per-line unique (behind the lock) is the same refusal", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    // A winner the locked line read missed — only the unique index sees it.
    const listLine = vi.mocked(ctx.bookingHolds.listLine);
    const realListLine = listLine.getMockImplementation()!;
    listLine.mockImplementation(async (input) => (input.statuses ? [] : realListLine(input)));
    ctx.bookingHolds.seed({ bookingRequestId: REQUEST_B, calendarId: CALENDAR_ID, date: DATE, status: "CONFIRMED", position: 9 });

    await expectRefusedWithNoMeta(agree(ctx));
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_A).some((e) => e.kind === "booking_agreement.agree_refused")).toBe(true);
  });

  it("a ledger outage while telling the venue is reported, and the sender still gets the refusal", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_B);
    ctx.seedHold(REQUEST_A);
    const outage = new Error("ledger down");
    let txCalls = 0;
    const realTx = ctx.repos.tx;
    (ctx.repos as { tx: unknown }).tx = vi.fn(async (fn: never) => {
      txCalls += 1;
      if (txCalls === 2) throw outage; // the refusal notice's own tx
      return (realTx as (f: never) => Promise<unknown>)(fn);
    });

    await expectRefusedWithNoMeta(agree(ctx));
    expect(ctx.deps.reportError).toHaveBeenCalledWith(
      outage,
      expect.objectContaining({ tags: expect.objectContaining({ step: "agree_refused_ledger" }) }),
    );
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "booking_agreements.agree_refused_record_failed",
      expect.anything(),
    );
  });
});

describe("Agree & book — the mint degrades, the booking stands (N10)", () => {
  it("terms sent before the sender was recorded → ACCEPTED + night booked, no mint, logged at error AND reported", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { sentForReviewByHumanId: null }));
    const mine = ctx.seedHold(REQUEST_A);

    const result = await agree(ctx);

    expect(result).toMatchObject({ status: "ACCEPTED", eventId: null });
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
    expect(agreeMint).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "booking_agreements.agree_mint_failed",
      expect.objectContaining({ reason: "terms_sent_before_sender_was_recorded" }),
    );
    expect(ctx.deps.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "respondToBookingAgreement", step: "agree_mint" } }),
    );
  });

  it("the mint throws (e.g. the sender lost canCreateEvents) → ACCEPTED + night booked, eventId null, reported; a throwing reporter changes nothing", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    const denied = Object.assign(new Error("NOT_RESOURCE_OWNER"), { code: "NOT_RESOURCE_OWNER" });
    agreeMint.mockRejectedValueOnce(denied);
    ctx.deps.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const result = await agree(ctx);

    expect(result).toMatchObject({ status: "ACCEPTED", eventId: null });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
    expect(ctx.deps.reportError).toHaveBeenCalledWith(denied, expect.anything());
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "booking_agreements.agree_mint_failed",
      expect.objectContaining({ reason: "mint_threw" }),
    );
  });

  // P2b review carry e (P2c): the venue sees on its side of the thread that
  // the event was not created — its cue to use "Create event".
  it("a failed mint leaves a VENUE-INTERNAL `booking_agreement.event_not_created` on the thread (the night, signed by the sender who tapped)", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);
    agreeMint.mockRejectedValueOnce(new Error("quota"));

    await agree(ctx);

    expect(ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_agreement.event_not_created")).toEqual([
      {
        kind: "booking_agreement.event_not_created",
        data: { agreementId: A_TERMS, date: DATE },
        actor: ACT_A_ID,
      },
    ]);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.event_not_created",
        data: expect.objectContaining({ reason: "mint_threw" }),
      }),
    );
  });

  it("no recorded terms sender writes the same entry (that mint never ran)", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { sentForReviewByHumanId: null }));
    ctx.seedHold(REQUEST_A);

    await agree(ctx);

    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toContain("booking_agreement.event_not_created");
  });

  it("a successful mint writes no such entry", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);

    await agree(ctx);

    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).not.toContain("booking_agreement.event_not_created");
  });

  it("the entry's own write failing is swallowed: logged at error AND reported, guarded; the agree still stands", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    agreeMint.mockRejectedValueOnce(new Error("quota"));
    // The booking tx succeeds; the NEXT tx (the entry's own) fails.
    const realTx = vi.mocked(ctx.repos.tx).getMockImplementation()!;
    let txCalls = 0;
    vi.mocked(ctx.repos.tx).mockImplementation(async (fn) => {
      txCalls += 1;
      if (txCalls === 2) throw new Error("db down");
      return realTx(fn);
    });
    ctx.deps.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const result = await agree(ctx);

    expect(result).toMatchObject({ status: "ACCEPTED", eventId: null });
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "booking_agreements.event_not_created_record_failed",
      expect.anything(),
    );
    expect(ctx.deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db down" }),
      expect.objectContaining({
        tags: { useCase: "respondToBookingAgreement", step: "event_not_created_ledger" },
      }),
    );
  });
});

describe("Agree & book — what keeps today's accept", () => {
  it("terms with no date: ACCEPTED, nothing on the line, nothing minted", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { proposedDate: null }));
    const mine = ctx.seedHold(REQUEST_A);

    const result = await agree(ctx);

    expect(result).toMatchObject({ status: "ACCEPTED", eventId: null, notificationIntents: [] });
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(agreeMint).not.toHaveBeenCalled();
  });

  it("a decline never touches the line", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);

    const result = await respondToBookingAgreement(ctx.deps, {
      actorHumanId: ACT_A_ID,
      agreementId: A_TERMS,
      action: "decline",
      declineReason: "That date no longer works.",
    });

    // N16 / FR-012: request-linked terms go back to the venue as a draft.
    expect(result.status).toBe("DRAFT");
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
  });

  it("the venue still cannot self-accept (ACT_RESPONSE_ONLY), and nothing is booked", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);

    await expect(agree(ctx, STAFF_ID)).rejects.toMatchObject({ code: "ACT_RESPONSE_ONLY" });
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
  });

  it("a closed request refuses the booking (INVALID_STATUS) and rolls nothing forward", async () => {
    const ctx = build();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status: "WITHDRAWN" });
    const mine = ctx.seedHold(REQUEST_A, { status: "RELEASED", releasedReason: "REQUEST_CLOSED" });

    await expect(agree(ctx)).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_request_closed" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("RELEASED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency. The fakes have no real lock, so each interleaving is staged at
// the point the real transaction would WAIT: when the agree takes its first
// line lock, the competing action runs to completion first (it held the lock
// and committed), then the agree reads what it left. The adapter integration
// suite (booking-the-night-agree.integration.test.ts) runs the same races
// against Postgres's advisory lock.
// ─────────────────────────────────────────────────────────────────────────────

function onFirstLock(ctx: Ctx, competitor: () => Promise<unknown>) {
  const lockLine = vi.mocked(ctx.bookingHolds.lockLine);
  const real = lockLine.getMockImplementation()!;
  let fired = false;
  lockLine.mockImplementation(async (key) => {
    if (!fired) {
      fired = true;
      await competitor();
    }
    return real(key);
  });
}

function bookDeps(ctx: Ctx) {
  return {
    repos: ctx.repos,
    idempotency: makeFakeIdempotency(),
    clock: ctx.deps.clock,
    authz: { canManagePlace: vi.fn(async () => ({ allowed: true })) },
  };
}

function seedRequestBWithTerms(ctx: Ctx) {
  ctx.agreements.set(B_TERMS, terms(B_TERMS, ACT_B_ID, { status: "DRAFT", proposedAt: null }));
  ctx.requests.set(REQUEST_B, { ...ctx.requests.get(REQUEST_B)!, status: "ACCEPTED", agreementId: B_TERMS, preferredDates: [DATE] });
}

describe("Concurrency (NFR-001: never an event on a night another hold has booked)", () => {
  it("agree vs the venue booking ANOTHER request without terms on the same night: the booking wins the lock, the agree is refused, ONE confirmed hold, ONE event", async () => {
    const ctx = build();
    seedRequestBWithTerms(ctx);
    const theirs = ctx.seedHold(REQUEST_B); // position 1
    const mine = ctx.seedHold(REQUEST_A); // position 2 — the agree's hold
    // (A venue reorder put A first after the send; B's booking gets in first.)
    ctx.bookingHolds.rows.set(mine.id, { ...ctx.bookingHolds.rows.get(mine.id)!, position: 1 });
    ctx.bookingHolds.rows.set(theirs.id, { ...ctx.bookingHolds.rows.get(theirs.id)!, position: 2 });
    // B's booking needs B first — it commits while the agree waits on the lock.
    onFirstLock(ctx, async () => {
      ctx.bookingHolds.rows.set(mine.id, { ...ctx.bookingHolds.rows.get(mine.id)!, position: 2 });
      ctx.bookingHolds.rows.set(theirs.id, { ...ctx.bookingHolds.rows.get(theirs.id)!, position: 1 });
      await bookNightWithoutTerms(bookDeps(ctx), {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_B,
        holdId: theirs.id,
      });
    });

    await expect(agree(ctx)).rejects.toMatchObject({ code: "NIGHT_NO_LONGER_AVAILABLE" });

    const confirmed = [...ctx.bookingHolds.rows.values()].filter((h) => h.date === DATE && h.status === "CONFIRMED");
    expect(confirmed.map((h) => h.id)).toEqual([theirs.id]);
    expect(ctx.bookingHolds.rows.get(mine.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(holdMint).toHaveBeenCalledTimes(1);
    expect(agreeMint).not.toHaveBeenCalled();
  });

  it("the other order: the agree commits first, the venue's booking of another request on that night is refused NIGHT_TAKEN — ONE confirmed hold, ONE event", async () => {
    const ctx = build();
    seedRequestBWithTerms(ctx);
    const mine = ctx.seedHold(REQUEST_A);
    const theirs = ctx.seedHold(REQUEST_B);

    await agree(ctx);
    // B's hold was released CONFIRMED_OTHER by the agree; a stale UI retries it.
    ctx.bookingHolds.rows.set(theirs.id, { ...ctx.bookingHolds.rows.get(theirs.id)!, status: "ACTIVE", releasedReason: null, releasedAt: null, position: 1 });
    await expect(
      bookNightWithoutTerms(bookDeps(ctx), { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_B, holdId: theirs.id }),
    ).rejects.toMatchObject({ code: "NIGHT_TAKEN", meta: { booked: true, aheadHoldId: null } });

    const confirmed = [...ctx.bookingHolds.rows.values()].filter((h) => h.date === DATE && h.status === "CONFIRMED");
    expect(confirmed.map((h) => h.id)).toEqual([mine.id]);
    expect(agreeMint).toHaveBeenCalledTimes(1);
    expect(holdMint).not.toHaveBeenCalled();
  });

  it("two acts agree terms for the SAME night: the first takes it, the second is refused and its venue told", async () => {
    const ctx = build();
    seedRequestBWithTerms(ctx);
    ctx.agreements.set(B_TERMS, terms(B_TERMS, ACT_B_ID));
    // Neither holds the night; both sets of terms name it.
    onFirstLock(ctx, () => respondToBookingAgreement(ctx.deps, { actorHumanId: ACT_B_ID, agreementId: B_TERMS, action: "accept" }));

    await expect(agree(ctx)).rejects.toMatchObject({ code: "NIGHT_NO_LONGER_AVAILABLE" });

    const confirmed = [...ctx.bookingHolds.rows.values()].filter((h) => h.date === DATE && h.status === "CONFIRMED");
    expect(confirmed.map((h) => h.bookingRequestId)).toEqual([REQUEST_B]);
    expect(ctx.agreements.get(B_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(agreeMint).toHaveBeenCalledTimes(1);
    expect(agreeMint.mock.calls[0]![1]).toMatchObject({ agreementId: B_TERMS });
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_agreement.agree_refused"]);
  });

  it("agree twice, concurrently: both pass the pre-check, the second finds the terms ACCEPTED under the lock → AGREEMENT_NOT_PROPOSED; one booking, one ledger pair, one mint", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_C);
    await agree(ctx);
    // The second tap raced the first: its pre-transaction read still saw
    // PROPOSED (staged as a stale read); by the time it holds the lock the
    // first has committed, and the locked re-read says ACCEPTED.
    const getById = ctx.repos.agreements.getById as ReturnType<typeof vi.fn>;
    getById.mockImplementationOnce(async () => terms(A_TERMS, ACT_A_ID));

    await expect(agree(ctx)).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });

    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
    expect(ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_hold.confirmed")).toHaveLength(1);
    expect(ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_agreement.accepted")).toHaveLength(1);
    expect(ctx.entries(REQUEST_A).some((e) => e.kind === "booking_agreement.agree_refused")).toBe(false);
    expect(agreeMint).toHaveBeenCalledTimes(1);
  });

  it("agree twice, sequentially: the second is refused before any transaction", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);
    await agree(ctx);
    const txCalls = (ctx.repos.tx as ReturnType<typeof vi.fn>).mock.calls.length;

    await expect(agree(ctx)).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });
    expect((ctx.repos.tx as ReturnType<typeof vi.fn>).mock.calls.length).toBe(txCalls);
    expect(agreeMint).toHaveBeenCalledTimes(1);
  });

  it("agree racing a pull-back: the pull-back commits while the agree waits → AGREEMENT_NOT_PROPOSED, nothing booked", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    const behind = ctx.seedHold(REQUEST_B);
    onFirstLock(ctx, () => pullBackBookingAgreement(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS }));

    await expect(agree(ctx)).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });

    expect(ctx.agreements.get(A_TERMS)?.status).toBe("DRAFT");
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_agreement.pulled_back"]);
    expect(agreeMint).not.toHaveBeenCalled();
  });

  it("agree racing a pull-back the other way: the agree commits, the pull-back is refused", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);

    await agree(ctx);
    await expect(
      pullBackBookingAgreement(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
  });

  it("the agreement CAS loses at write time (a transition slipped in after the locked read) → AGREEMENT_NOT_PROPOSED before any hold is written", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    const behind = ctx.seedHold(REQUEST_B);
    ctx.casLosses.next = 1;

    await expect(agree(ctx)).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(agreeMint).not.toHaveBeenCalled();
  });

  it("the terms moved to another night between the read and the locks (pull back → edit → resend) → TERMS_CHANGED_SINCE_VIEWED with no meta, nothing booked", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    onFirstLock(ctx, async () => {
      ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { proposedDate: new Date("2026-06-28T01:00:00.000Z") }));
    });

    const error = await agree(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TERMS_CHANGED_SINCE_VIEWED" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
  });
});

describe("the booking's event must sit on the night — checked BEFORE the line moves (review round 2, BLOCKING)", () => {
  const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const DRAFT_ID = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
  /** 20:00 CDT on Sun 21 June — the day after the terms' night (DATE). */
  const NEXT_DAY = new Date("2026-06-22T01:00:00.000Z");

  async function expectEventOnAnotherNight(ctx: Ctx) {
    const error = await agree(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "EVENT_ON_ANOTHER_NIGHT" });
    // Sender side: nothing beyond the code.
    expect((error as { meta?: unknown }).meta).toBeUndefined();
  }

  it("event-first: the act moved its event to the next day after the terms went out → refused with no line change: no lost_date, siblings intact, terms still PROPOSED; the venue is told why", async () => {
    const ctx = build();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: NEXT_DAY, status: "DRAFT" } as never);
    const mine = ctx.seedHold(REQUEST_A);
    const behind = ctx.seedHold(REQUEST_B);
    const sibling = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });

    await expectEventOnAnotherNight(ctx);

    // Nothing on any line moved.
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.create).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(sibling.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_B)).toEqual([]);
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(agreeMint).not.toHaveBeenCalled();
    // The venue is told — venue-only ledger entry with the reason, and a ping.
    expect(ctx.entries(REQUEST_A)).toEqual([
      {
        kind: "booking_agreement.agree_refused",
        data: { agreementId: A_TERMS, date: DATE, reason: "event_on_another_night" },
        actor: ACT_A_ID,
      },
    ]);
    const pinged = vi.mocked(ctx.deps.notify as unknown as (n: { humanId: string; payload: { title: string } }) => Promise<unknown>).mock.calls.map(([n]) => n);
    expect(pinged.map((n) => n.payload.title)).toContain("Event on another day");
    expect(pinged.map((n) => n.humanId)).not.toContain(ACT_A_ID);
  });

  // P2b review carry d (P2c): the event must sit on the night's LINE — the
  // calendar too, not only the day.
  it("carry d: event-first, the origin on the right DAY but ANOTHER calendar → EVENT_ON_ANOTHER_NIGHT (no meta), no line change, the venue told", async () => {
    const ctx = build();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    ctx.events.set(ORIGIN_ID, {
      id: ORIGIN_ID,
      startsAt: NIGHT_AT,
      status: "DRAFT",
      calendarId: OTHER_CALENDAR_ID,
    } as never);
    const mine = ctx.seedHold(REQUEST_A);
    const behind = ctx.seedHold(REQUEST_B);

    await expectEventOnAnotherNight(ctx);

    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(ctx.entries(REQUEST_A)).toEqual([
      {
        kind: "booking_agreement.agree_refused",
        data: { agreementId: A_TERMS, date: DATE, reason: "event_on_another_night" },
        actor: ACT_A_ID,
      },
    ]);
  });

  it("carry d: the origin on the night's OWN calendar books as before", async () => {
    const ctx = build();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    ctx.events.set(ORIGIN_ID, {
      id: ORIGIN_ID,
      startsAt: NIGHT_AT,
      status: "DRAFT",
      calendarId: CALENDAR_ID,
    } as never);
    const mine = ctx.seedHold(REQUEST_A);

    await expect(agree(ctx)).resolves.toMatchObject({ status: "ACCEPTED" });
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
  });

  it("a live DRAFT anchored on another day (minted for an earlier night) → refused the same way, before the line moves", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { draftEventId: DRAFT_ID }));
    ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: NEXT_DAY, status: "DRAFT" } as never);
    const mine = ctx.seedHold(REQUEST_A);

    await expectEventOnAnotherNight(ctx);
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
  });

  it("the check runs under the line lock: an event moved off the night while the agree waited is still caught", async () => {
    const ctx = build();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    // On the night when the agree starts…
    ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: NIGHT_AT, status: "DRAFT" } as never);
    const mine = ctx.seedHold(REQUEST_A);
    // …moved to the next day by the time the agree holds the lock.
    onFirstLock(ctx, async () => {
      ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: NEXT_DAY, status: "DRAFT" } as never);
    });

    await expectEventOnAnotherNight(ctx);
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
  });

  // Owner ruling 2026-10-01 (spec N11): a gone origin means the night is
  // NOT booked — refused before the line moves, the venue is told, and no
  // fresh event is ever minted in its place.
  it.each([
    ["CANCELLED", "CANCELLED"],
    ["ARCHIVED", "ARCHIVED"],
    ["deleted (row gone, stale id)", null],
  ])("a gone origin (%s) → EVENT_FIRST_ORIGIN_GONE with no meta, no line change, the venue told", async (_label, status) => {
    const ctx = build();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    if (status) ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: NIGHT_AT, status } as never);
    const mine = ctx.seedHold(REQUEST_A);
    const behind = ctx.seedHold(REQUEST_B);
    const sibling = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });

    const error = await agree(ctx).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EVENT_FIRST_ORIGIN_GONE" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.create).not.toHaveBeenCalled();
    for (const h of [mine, behind, sibling]) expect(ctx.bookingHolds.rows.get(h.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_B)).toEqual([]);
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(agreeMint).not.toHaveBeenCalled();
    expect(ctx.entries(REQUEST_A)).toEqual([
      {
        kind: "booking_agreement.agree_refused",
        data: { agreementId: A_TERMS, date: DATE, reason: "event_origin_gone" },
        actor: ACT_A_ID,
      },
    ]);
    const pinged = vi.mocked(ctx.deps.notify as unknown as (n: { humanId: string; payload: { title: string } }) => Promise<unknown>).mock.calls.map(([n]) => n);
    expect(pinged.map((n) => n.payload.title)).toContain("Event cancelled or archived");
  });

  // Owner ruling 2026-10-01 (second): NO exception for a leftover legacy
  // draft — a dead origin always refuses, even with a live draft on the night.
  it("a gone origin with a LIVE legacy draft anchored on the night → still EVENT_FIRST_ORIGIN_GONE, no line change, the venue told", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { draftEventId: DRAFT_ID }));
    ctx.events.set(DRAFT_ID, { id: DRAFT_ID, startsAt: NIGHT_AT, status: "DRAFT" } as never);
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: NIGHT_AT, status: "CANCELLED" } as never);
    const mine = ctx.seedHold(REQUEST_A);
    const behind = ctx.seedHold(REQUEST_B);

    const error = await agree(ctx).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EVENT_FIRST_ORIGIN_GONE" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(agreeMint).not.toHaveBeenCalled();
    expect(ctx.entries(REQUEST_A)).toEqual([
      expect.objectContaining({
        kind: "booking_agreement.agree_refused",
        data: { agreementId: A_TERMS, date: DATE, reason: "event_origin_gone" },
      }),
    ]);
  });

  // Review round 4 W1: a finalized link to a dead event is refused too.
  it.each([["CANCELLED"], ["ARCHIVED"]])(
    "terms finalized against an event that is now %s → LINKED_EVENT_NOT_LIVE with no meta, no line change, the venue told",
    async (status) => {
      const ctx = build();
      ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { eventId: EVENT_ID }));
      ctx.events.set(EVENT_ID, { id: EVENT_ID, startsAt: NIGHT_AT, status } as never);
      const mine = ctx.seedHold(REQUEST_A);
      const behind = ctx.seedHold(REQUEST_B);

      const error = await agree(ctx).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "LINKED_EVENT_NOT_LIVE" });
      expect((error as { meta?: unknown }).meta).toBeUndefined();
      expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
      expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
      expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
      expect(ctx.entries(REQUEST_A)).toEqual([
        expect.objectContaining({
          kind: "booking_agreement.agree_refused",
          data: { agreementId: A_TERMS, date: DATE, reason: "linked_event_gone" },
        }),
      ]);
    },
  );

  it("an event ON the night lets the agree through (event-first: the origin is the booking's event)", async () => {
    const ctx = build();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: NIGHT_AT, status: "DRAFT" } as never);
    const mine = ctx.seedHold(REQUEST_A);

    await agree(ctx);
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
  });
});

describe("the send refuses terms for another day than the booking's event (review round 2, B-b)", () => {
  const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";

  // Owner ruling 2026-10-01 (spec N11): a gone origin is refused at the send
  // too — venue side, the link's own refusal, before anything is written.
  it.each([["CANCELLED"], ["ARCHIVED"], [null]])(
    "a gone origin (%s): sendBookingAgreementForReview and sendBookingTerms both refuse event_first_origin_not_live before any write",
    async (status) => {
      const ctx = build();
      const before = terms(A_TERMS, ACT_A_ID, { status: "DRAFT", proposedAt: null, sentForReviewByHumanId: null });
      ctx.agreements.set(A_TERMS, before);
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
      if (status) ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: NIGHT_AT, status } as never);

      for (const attempt of [
        () => sendBookingAgreementForReview(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS }),
        () => sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS, night: DATE, startTime: "21:00" }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          code: "INVALID_STATUS",
          message: "event_first_origin_not_live",
          meta: { agreementId: A_TERMS, eventId: ORIGIN_ID },
        });
      }
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
      expect(ctx.agreements.get(A_TERMS)).toEqual(before);
    },
  );

  it("sendBookingAgreementForReview → HOLD_DATE_MISMATCHES_EVENT (venue side, with the days) before anything is written", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { status: "DRAFT", proposedAt: null, sentForReviewByHumanId: null }));
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: new Date("2026-06-22T01:00:00.000Z"), status: "DRAFT" } as never);

    await expect(
      sendBookingAgreementForReview(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS }),
    ).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { agreementId: A_TERMS, eventId: ORIGIN_ID, eventDate: "2026-06-21", holdDate: DATE },
    });
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("DRAFT");
  });

  it("sendBookingTerms → the same refusal BEFORE the header write (the draft is left exactly as it was)", async () => {
    const ctx = build();
    const before = terms(A_TERMS, ACT_A_ID, { status: "DRAFT", proposedAt: null, sentForReviewByHumanId: null, proposedDate: null });
    ctx.agreements.set(A_TERMS, before);
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, originEventId: ORIGIN_ID });
    ctx.events.set(ORIGIN_ID, { id: ORIGIN_ID, startsAt: new Date("2026-06-22T01:00:00.000Z"), status: "DRAFT" } as never);

    await expect(
      sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS, night: DATE }),
    ).rejects.toMatchObject({ code: "HOLD_DATE_MISMATCHES_EVENT" });
    expect(ctx.repos.agreements.updateHeader).not.toHaveBeenCalled();
    expect(ctx.agreements.get(A_TERMS)).toEqual(before);
  });
});

describe("one booked night per request (review B1)", () => {
  async function expectNoMetaRefusal(promise: Promise<unknown>, code: string) {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toMatchObject({ code });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
  }

  it("Scenario A: the venue booked another night without terms; terms still out for this night → BOOKING_ALREADY_HAS_NIGHT, nothing written", async () => {
    const ctx = build();
    const booked = ctx.seedHold(REQUEST_A, { date: "2026-06-27", status: "CONFIRMED", confirmedAt: NOW });
    const behind = ctx.seedHold(REQUEST_B); // on DATE, the terms' night

    await expectNoMetaRefusal(agree(ctx), "BOOKING_ALREADY_HAS_NIGHT");

    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(ctx.bookingHolds.create).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(ctx.bookingHolds.rows.get(booked.id)?.status).toBe("CONFIRMED");
    expect(agreeMint).not.toHaveBeenCalled();
    // Not a "night went elsewhere": the venue is not told to pick another night.
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("Scenario A, the flow as the UI drives it: \"Send terms\" with no night defaults to the BOOKED night, and the agree then books nothing new", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { status: "DRAFT", proposedAt: null, proposedDate: null, sentForReviewByHumanId: null }));
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, preferredDates: ["2026-06-13", DATE] });
    const booked = ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW }); // DATE
    agreeMint.mockResolvedValueOnce({ eventId: EVENT_ID, alreadyLinked: true, finalized: true });

    const sent = await sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS });
    expect(sent.night).toBe(DATE);
    await agree(ctx);

    const confirmed = [...ctx.bookingHolds.rows.values()].filter((h) => h.status === "CONFIRMED");
    expect(confirmed.map((h) => h.id)).toEqual([booked.id]);
    expect(ctx.bookingHolds.create).not.toHaveBeenCalled();
  });

  it("Scenario B: agreed and booked, terms reopened to DRAFT, \"Send terms\" for another night → BOOKING_ALREADY_HAS_NIGHT (venue side); terms sent behind its back cannot be agreed either", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);
    await agree(ctx);
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
    // Reopen: ACCEPTED → DRAFT (eventId still null), as reopenBookingAgreement does.
    ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, status: "DRAFT", draftEventId: EVENT_ID });

    await expect(
      sendBookingTerms(ctx.deps, { actorHumanId: STAFF_ID, agreementId: A_TERMS, night: "2026-06-27" }),
    ).rejects.toMatchObject({ code: "BOOKING_ALREADY_HAS_NIGHT" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("DRAFT");

    // Even terms PROPOSED for another night by some other route are refused.
    ctx.agreements.set(
      A_TERMS,
      terms(A_TERMS, ACT_A_ID, { proposedDate: new Date("2026-06-28T01:00:00.000Z"), draftEventId: EVENT_ID }),
    );
    agreeMint.mockClear();
    await expectNoMetaRefusal(agree(ctx), "BOOKING_ALREADY_HAS_NIGHT");
    const confirmed = [...ctx.bookingHolds.rows.values()].filter((h) => h.status === "CONFIRMED");
    expect(confirmed.map((h) => h.id)).toEqual([mine.id]);
    expect(agreeMint).not.toHaveBeenCalled();
  });
});

describe("the date the sender saw (review W3)", () => {
  it("expectedProposedDate that no longer matches → TERMS_CHANGED_SINCE_VIEWED with no meta, before any transaction", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);

    const error = await respondToBookingAgreement(ctx.deps, {
      actorHumanId: ACT_A_ID,
      agreementId: A_TERMS,
      action: "accept",
      expectedProposedDate: new Date("2026-06-28T01:00:00.000Z").toISOString(),
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "TERMS_CHANGED_SINCE_VIEWED" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
  });

  it("a matching expectedProposedDate books as usual", async () => {
    const ctx = build();
    const mine = ctx.seedHold(REQUEST_A);

    await respondToBookingAgreement(ctx.deps, {
      actorHumanId: ACT_A_ID,
      agreementId: A_TERMS,
      action: "accept",
      expectedProposedDate: NIGHT_AT.toISOString(),
    });
    expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
  });
});

describe("sender-side refusals never carry meta (review W4)", () => {
  it("an open challenge caught by the line take maps to NIGHT_NO_LONGER_AVAILABLE, and the venue is told", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A); // position 1
    // A challenge row BEHIND us (inconsistent, but it is the takeLine guard
    // this pins): N6 passes, the take refuses HOLD_LINE_HAS_OPEN_CHALLENGE.
    ctx.seedHold(REQUEST_B, { status: "CHALLENGED", challengedAt: NOW, respondBy: new Date(NOW.getTime() + 3600_000) });

    const error = await agree(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "NIGHT_NO_LONGER_AVAILABLE" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toContain("booking_agreement.agree_refused");
  });

  it("HOLD_LINE_CHANGED from the lock helpers reaches the sender without its calendarId", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);
    // A new line appears between the transaction's pre-lock read (the 2nd
    // read; the 1st picks the night's calendar) and the locks.
    const listForRequest = vi.mocked(ctx.bookingHolds.listForRequest);
    const real = listForRequest.getMockImplementation()!;
    let reads = 0;
    listForRequest.mockImplementation(async (id: string) => {
      const rows = await real(id);
      reads += 1;
      if (reads === 2) ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
      return rows;
    });

    const error = await agree(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "HOLD_LINE_CHANGED" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
  });

  it("a closed request is refused with its message and no meta", async () => {
    const ctx = build();
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status: "WITHDRAWN" });

    const error = await agree(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_STATUS", message: "booking_request_closed" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
  });
});

describe("a hold the agree writes is placed by a VENUE human, never the act (review nit)", () => {
  function writtenHold(ctx: Ctx) {
    return [...ctx.bookingHolds.rows.values()].find((h) => h.bookingRequestId === REQUEST_A && h.date === DATE);
  }

  it("legacy terms (no recorded sender) → the request's assignee", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { sentForReviewByHumanId: null }));

    await agree(ctx);
    expect(writtenHold(ctx)?.placedByHumanId).toBe(ASSIGNEE_ID);
  });

  it("no sender and no assignee → the venue org's first owner/admin", async () => {
    const ctx = build();
    ctx.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { sentForReviewByHumanId: null }));
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, assigneeHumanId: null });

    await agree(ctx);
    expect(writtenHold(ctx)?.placedByHumanId).toBe(STAFF_ID);
    expect(writtenHold(ctx)?.placedByHumanId).not.toBe(ACT_A_ID);
  });
});

// Review round 4 BLOCKING / W4: a suspended or retired place books no night —
// the shared booking pre-flight refuses before the line moves.
describe("Agree & book at a place that is not taking bookings (review round 4 W4)", () => {
  it.each([["SUSPENDED"], ["RETIRED"]])(
    "the place is %s → PLACE_NOT_TAKING_BOOKINGS with no meta; nothing on the line moves, the terms stay PROPOSED, the venue is told",
    async (status) => {
      const ctx = build();
      (ctx.place as { status: string }).status = status;
      const mine = ctx.seedHold(REQUEST_A);
      const behind = ctx.seedHold(REQUEST_B);

      const error = await agree(ctx).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "PLACE_NOT_TAKING_BOOKINGS" });
      expect((error as { meta?: unknown }).meta).toBeUndefined();
      expect(ctx.repos.tx).toHaveBeenCalledTimes(1); // the venue's ledger note only
      expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(mine.id)?.status).toBe("ACTIVE");
      expect(ctx.bookingHolds.rows.get(behind.id)?.status).toBe("ACTIVE");
      expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
      expect(agreeMint).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_A)).toEqual([
        {
          kind: "booking_agreement.agree_refused",
          data: { agreementId: A_TERMS, date: DATE, reason: "place_not_taking_bookings" },
          actor: ACT_A_ID,
        },
      ]);
      const pinged = vi.mocked(ctx.deps.notify as unknown as (n: { humanId: string; payload: { title: string } }) => Promise<unknown>).mock.calls.map(([n]) => n);
      expect(pinged.map((n) => n.payload.title)).toContain("Not taking bookings");
      expect(pinged.map((n) => n.humanId)).not.toContain(ACT_A_ID);
    },
  );
});

// Review round 6 nit 2: a plain typed refusal (`{ code, message, meta }` —
// the save's quota refusal names the venue org's numbers) reaches the sender
// as its code and message only.
describe("Agree & book never hands the sender a plain refusal's meta (review round 6)", () => {
  it("a plain { code, message, meta } thrown under the take → the same code and message, no meta", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);
    vi.mocked(ctx.bookingHolds.lockLine).mockImplementationOnce(async () => {
      throw {
        code: "forbidden",
        message: "quota_exceeded",
        meta: { subjectId: "venue-org", limitValue: "5", currentUsage: "5" },
      };
    });

    const error = await agree(ctx).catch((e: unknown) => e);

    expect(error).toEqual({ code: "forbidden", message: "quota_exceeded" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
  });
});
