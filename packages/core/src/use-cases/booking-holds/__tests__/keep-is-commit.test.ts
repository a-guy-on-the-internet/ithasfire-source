import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";

import { respondToBookingAgreement } from "../../booking-agreements/respond-to-booking-agreement";
import {
  A_TERMS,
  EVENT_ID,
  buildNightHarness,
  type NightHarness,
} from "../../booking-agreements/__tests__/night-harness";
import { answerBookingHoldChallenge, type AnswerBookingHoldChallengeDeps } from "../answer-booking-hold-challenge";
import { challengeBookingHold } from "../challenge-booking-hold";
import { listBookingHoldsForRequest } from "../list-booking-holds-for-request";
import { settleBookingHolds } from "../settle-booking-holds";
import {
  ACT_A_ID,
  DATE,
  NOW,
  REQUEST_A,
  REQUEST_B,
  REQUEST_C,
  STAFF_ID,
} from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// Keep = commit (booking-the-night N19 / FR-014). On a challenged hold:
//   - terms for that night already with the act (PROPOSED) → Keep IS "Agree
//     & book" (FR-001, the respond path) and books the night in the same call;
//   - otherwise Keep is recorded, the venue is asked for terms, and the act
//     has 48h to agree them before the hold lapses (the existing lapse).
// Built on the night harness: request A ACCEPTED with PROPOSED terms
// (A_TERMS) for the night of DATE. The post-commit mint is a boundary.
// ─────────────────────────────────────────────────────────────────────────────

const agreeMint = vi.fn();
vi.mock("../../booking-agreements/create-event-from-agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../booking-agreements/create-event-from-agreement")>()),
  createEventFromAgreementOnNight: (...args: unknown[]) => agreeMint(...args),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  agreeMint.mockReset();
  agreeMint.mockResolvedValue({ eventId: EVENT_ID, alreadyLinked: false, finalized: false });
});

function answerDeps(ctx: NightHarness, clock = ctx.deps.clock): AnswerBookingHoldChallengeDeps {
  return {
    repos: ctx.repos,
    clock,
    logger: ctx.deps.logger,
    reportError: ctx.deps.reportError,
    agree: {
      idempotency: ctx.deps.idempotency,
      authz: ctx.deps.authz,
      notify: ctx.deps.notify,
    },
  };
}

/** A at 1st hold, CHALLENGED; B behind with draft terms for the night (ready). */
function challengedNight(ctx: NightHarness) {
  const a = ctx.seedHold(REQUEST_A, {
    status: "CHALLENGED",
    challengedAt: new Date(NOW.getTime() - HOUR_MS),
    respondBy: new Date(NOW.getTime() + DAY_MS),
  });
  const b = ctx.seedHold(REQUEST_B);
  ctx.seedTerms(REQUEST_B);
  return { a, b };
}

const keep = (ctx: NightHarness, holdId: string, extra: Record<string, unknown> = {}) =>
  answerBookingHoldChallenge(answerDeps(ctx), { actorHumanId: ACT_A_ID, holdId, answer: "keep", ...extra });

const actView = async (ctx: NightHarness) => {
  const read = await listBookingHoldsForRequest(ctx.deps, { actorHumanId: ACT_A_ID, bookingRequestId: REQUEST_A, viewer: "act" });
  if (read.viewer !== "act") throw new Error("unreachable");
  return read.holds;
};

const setTerms = (ctx: NightHarness, over: Partial<AgreementRecord>) =>
  ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, ...over });

describe("Keep with terms already sent = Agree & book (FR-014 → FR-001)", () => {
  it("the act's panel says Keep will book BEFORE the tap", async () => {
    const ctx = buildNightHarness();
    challengedNight(ctx);
    expect(await actView(ctx)).toEqual([expect.objectContaining({ status: "CHALLENGED", keepWill: "book_now", kept: false })]);
    // Pulled back to draft: Keep would ask for terms instead.
    setTerms(ctx, { status: "DRAFT" });
    expect(await actView(ctx)).toEqual([expect.objectContaining({ keepWill: "ask_for_terms" })]);
  });

  it("books the night in the same call: terms ACCEPTED, this hold CONFIRMED, the ready act loses the date, the draft event is minted", async () => {
    const ctx = buildNightHarness();
    const { a, b } = challengedNight(ctx);

    const result = await keep(ctx, a.id, { expectedKeepWill: "book_now" });

    expect(result).toMatchObject({ keepOutcome: "booked", eventId: EVENT_ID, hold: { id: a.id, status: "CONFIRMED" } });
    expect(result.actHold).toMatchObject({ status: "CONFIRMED", keepWill: null, kept: false });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(ctx.bookingHolds.rows.get(a.id)).toMatchObject({ status: "CONFIRMED", respondBy: null });
    expect(ctx.bookingHolds.rows.get(b.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    expect(agreeMint).toHaveBeenCalledTimes(1);
    // The agree's own ledger — never a bare "kept" for a keep that booked.
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_agreement.accepted", "booking_hold.confirmed"]);
    // The act behind is told it lost the date.
    expect(result.notificationIntents).toContainEqual(
      expect.objectContaining({ kind: "hold.lost_date", bookingRequestId: REQUEST_B, holdId: b.id }),
    );
  });

  it("a refused agree is a refused keep: night gone → NIGHT_NO_LONGER_AVAILABLE, the hold stays CHALLENGED on its clock, nothing recorded as kept", async () => {
    const ctx = buildNightHarness();
    const { a } = challengedNight(ctx);
    // Another request already booked the night on this line (a CONFIRMED row).
    ctx.seedHold(REQUEST_C, { status: "CONFIRMED", confirmedAt: NOW, position: 9 });
    const before = ctx.bookingHolds.rows.get(a.id)!;

    // The sender's refusal carries nothing (FR-013) — asserted on the
    // rejection itself, so this cannot pass vacuously.
    await expect(keep(ctx, a.id, { expectedKeepWill: "book_now" })).rejects.toSatisfy(
      (error: unknown) =>
        (error as { code?: string }).code === "NIGHT_NO_LONGER_AVAILABLE" &&
        (error as { meta?: unknown }).meta === undefined,
    );

    expect(ctx.bookingHolds.rows.get(a.id)).toMatchObject({ status: "CHALLENGED", respondBy: before.respondBy });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).not.toContain("booking_hold.kept");
  });

  it("a refused agree: this request already booked another night → BOOKING_ALREADY_HAS_NIGHT, nothing kept", async () => {
    const ctx = buildNightHarness();
    const { a } = challengedNight(ctx);
    ctx.seedHold(REQUEST_A, { date: "2026-06-27", status: "CONFIRMED", confirmedAt: NOW });

    await expect(keep(ctx, a.id, { expectedKeepWill: "book_now" })).rejects.toMatchObject({ code: "BOOKING_ALREADY_HAS_NIGHT" });
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("CHALLENGED");
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
  });

  it("a concurrent agree of the same terms (the card's Agree & book) wins first → Keep's goal is met: booked once, no error", async () => {
    const ctx = buildNightHarness();
    const { a } = challengedNight(ctx);
    // Stage the race at the keep's CAS: the act's card agree runs to
    // completion first, then the keep's own PROPOSED → ACCEPTED loses.
    const realUpdate = ctx.repos.agreements.updateStatus;
    let raced = false;
    ctx.repos.agreements.updateStatus = vi.fn(async (input) => {
      if (!raced && input.status === "ACCEPTED") {
        raced = true;
        await respondToBookingAgreement(ctx.deps, { actorHumanId: ACT_A_ID, agreementId: A_TERMS, action: "accept" });
      }
      return realUpdate(input);
    }) as typeof realUpdate;

    const result = await keep(ctx, a.id, { expectedKeepWill: "book_now" });

    expect(result).toMatchObject({ keepOutcome: "booked", hold: { id: a.id, status: "CONFIRMED" } });
    expect(ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_agreement.accepted")).toHaveLength(1);
    // The swallowed refusal is reported (ReporterPort convention).
    expect(ctx.deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AGREEMENT_NOT_PROPOSED" }),
      expect.objectContaining({ tags: { useCase: "answerBookingHoldChallenge", step: "keep_agree_raced_booked" } }),
    );
    expect([...ctx.bookingHolds.rows.values()].filter((h) => h.status === "CONFIRMED")).toHaveLength(1);
  });
});

describe("Keep's raced-agree report never changes the outcome", () => {
  it("a throwing reporter: the keep still succeeds as booked", async () => {
    const ctx = buildNightHarness();
    const { a } = challengedNight(ctx);
    vi.mocked(ctx.deps.reportError).mockImplementation(() => {
      throw new Error("sentry down");
    });
    const realUpdate = ctx.repos.agreements.updateStatus;
    let raced = false;
    ctx.repos.agreements.updateStatus = vi.fn(async (input) => {
      if (!raced && input.status === "ACCEPTED") {
        raced = true;
        await respondToBookingAgreement({ ...ctx.deps, reportError: undefined }, { actorHumanId: ACT_A_ID, agreementId: A_TERMS, action: "accept" });
      }
      return realUpdate(input);
    }) as typeof realUpdate;

    await expect(keep(ctx, a.id, { expectedKeepWill: "book_now" })).resolves.toMatchObject({ keepOutcome: "booked" });
  });
});

describe("Keep with no terms sent = a commitment to agree them (FR-014)", () => {
  it("consent guard: a tap meant as 'ask for terms' never books — terms that arrived since → TERMS_CHANGED_SINCE_VIEWED, nothing written", async () => {
    const ctx = buildNightHarness();
    const { a } = challengedNight(ctx);

    await expect(keep(ctx, a.id, { expectedKeepWill: "ask_for_terms" })).rejects.toMatchObject({ code: "TERMS_CHANGED_SINCE_VIEWED" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("CHALLENGED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);

    // …and the other way round: terms pulled back since the panel said "book".
    setTerms(ctx, { status: "DRAFT" });
    await expect(keep(ctx, a.id, { expectedKeepWill: "book_now" })).rejects.toMatchObject({ code: "TERMS_CHANGED_SINCE_VIEWED" });
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("never shortens a deadline the venue gave: respondBy = max(current, now + 48h)", async () => {
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "DRAFT" });
    const far = new Date(NOW.getTime() + 3 * DAY_MS);
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", challengedAt: NOW, respondBy: far });

    const result = await keep(ctx, a.id);
    expect(result).toMatchObject({ keepOutcome: "awaiting_terms", hold: { status: "CHALLENGED", respondBy: far } });
    expect(ctx.entries(REQUEST_A)).toEqual([
      expect.objectContaining({ kind: "booking_hold.kept", data: expect.objectContaining({ respondBy: far.toISOString() }) }),
    ]);
  });

  it("then the terms arrive: the panel says Keep will book; Keep (or the card) books the CHALLENGED hold", async () => {
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "DRAFT" });
    const { a } = challengedNight(ctx);

    await keep(ctx, a.id);
    expect(await actView(ctx)).toEqual([expect.objectContaining({ keepWill: "ask_for_terms", kept: true })]);

    setTerms(ctx, { status: "PROPOSED" }); // the venue sends them
    expect(await actView(ctx)).toEqual([expect.objectContaining({ keepWill: "book_now", kept: true })]);
    const booked = await keep(ctx, a.id, { expectedKeepWill: "book_now" });
    expect(booked).toMatchObject({ keepOutcome: "booked", hold: { status: "CONFIRMED" } });
  });

  it("missing the new deadline lapses the hold through the existing path, and the ready act behind moves up with a venue-only 'Send terms' cue", async () => {
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "DRAFT" });
    const { a, b } = challengedNight(ctx);
    const kept = await keep(ctx, a.id);

    // 48h and a minute later, any touch of the line settles it.
    const later = { now: () => new Date(kept.hold.respondBy!.getTime() + 60_000) };
    await settleBookingHolds({ ...ctx.deps, clock: later }, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A });

    expect(ctx.bookingHolds.rows.get(a.id)).toMatchObject({ status: "RELEASED", releasedReason: "EXPIRED" });
    expect(ctx.bookingHolds.rows.get(b.id)?.position).toBe(1);
    const bEntries = ctx.entries(REQUEST_B);
    expect(bEntries).toContainEqual({
      kind: "booking_hold.first_ready",
      data: { holdId: b.id, date: DATE, agreementId: expect.any(String) },
      actor: null,
    });
  });

  it("a keep in a LATER challenge of the same hold is its own keep (the 'already kept' match is per challenge)", async () => {
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "DRAFT" });
    const { a } = challengedNight(ctx);
    await keep(ctx, a.id);
    // A new challenge round: a fresh challengedAt.
    const row = ctx.bookingHolds.rows.get(a.id)!;
    ctx.bookingHolds.rows.set(a.id, { ...row, challengedAt: new Date(NOW.getTime() + HOUR_MS) });

    const again = await keep(ctx, a.id);
    expect(again.keepOutcome).toBe("awaiting_terms");
    expect(ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_hold.kept")).toHaveLength(2);
  });
});

describe("the ready act moves up (N20: 'You're 1st hold — Send terms')", () => {
  it("the 1st-hold act releases: the ready act reaching 1st gets the venue-only cue; a not-ready mover does not", async () => {
    const ctx = buildNightHarness();
    const { a, b } = challengedNight(ctx);
    const c = ctx.seedHold(REQUEST_C); // no terms

    await answerBookingHoldChallenge(answerDeps(ctx), { actorHumanId: ACT_A_ID, holdId: a.id, answer: "release" });

    expect(ctx.entries(REQUEST_B).map((e) => e.kind)).toEqual(["booking_hold.reordered", "booking_hold.first_ready"]);
    expect(ctx.entries(REQUEST_C).map((e) => e.kind)).toEqual(["booking_hold.reordered"]);
    expect(ctx.bookingHolds.rows.get(b.id)?.position).toBe(1);
    expect(ctx.bookingHolds.rows.get(c.id)?.position).toBe(2);
  });

  it("the cue is VENUE-INTERNAL: the act's side of the thread never lists it", async () => {
    const { isVenueInternalSystemEntry } = await import("../../booking-requests/messages/_shared/system-entries");
    expect(isVenueInternalSystemEntry("booking_hold.first_ready")).toBe(true);
  });
});

describe("the challenge notice says what Keep will do", () => {
  it("terms already sent → book_now; none → ask_for_terms", async () => {
    const ctx = buildNightHarness();
    const a = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);

    const sent = await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });
    expect(sent.notificationIntents[0]).toMatchObject({ audience: "act", holdId: a.id, keepWill: "book_now" });
    // Only the challenged act's notice carries it.
    expect(sent.notificationIntents.filter((i) => i.keepWill !== undefined)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2d-2 review round
// ─────────────────────────────────────────────────────────────────────────────

describe("W1 — the consent guard is REQUIRED on a keep that books (fail closed)", () => {
  it("book_now with no expectedKeepWill → TERMS_CHANGED_SINCE_VIEWED, no meta, nothing recorded or booked", async () => {
    const ctx = buildNightHarness();
    const { a, b } = challengedNight(ctx);
    const before = ctx.bookingHolds.rows.get(a.id)!;

    await expect(keep(ctx, a.id)).rejects.toSatisfy(
      (error: unknown) =>
        (error as { code?: string }).code === "TERMS_CHANGED_SINCE_VIEWED" &&
        (error as { meta?: unknown }).meta === undefined,
    );

    expect(ctx.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(ctx.bookingHolds.rows.get(a.id)).toMatchObject({ status: "CHALLENGED", respondBy: before.respondBy });
    expect(ctx.bookingHolds.rows.get(b.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
    expect(agreeMint).not.toHaveBeenCalled();
  });

  it("book_now WITH expectedKeepWill: book_now → books", async () => {
    const ctx = buildNightHarness();
    const { a } = challengedNight(ctx);
    await expect(keep(ctx, a.id, { expectedKeepWill: "book_now" })).resolves.toMatchObject({
      keepOutcome: "booked",
      hold: { status: "CONFIRMED" },
    });
  });

  it("ask_for_terms with no expectedKeepWill → proceeds (records the keep)", async () => {
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "DRAFT" });
    const { a } = challengedNight(ctx);
    await expect(keep(ctx, a.id)).resolves.toMatchObject({ keepOutcome: "awaiting_terms" });
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_hold.kept"]);
  });
});

describe("W3 — terms already AGREED for the night: nothing to keep (fail closed)", () => {
  it("an older challenge on a hold whose terms are ACCEPTED for the night: keep refuses TERMS_AGREED_FOR_THIS_NIGHT (no meta) instead of asking for terms; nothing written", async () => {
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "ACCEPTED" });
    const { a } = challengedNight(ctx);

    expect(await actView(ctx)).toEqual([expect.objectContaining({ status: "CHALLENGED", keepWill: null, kept: false })]);
    await expect(keep(ctx, a.id)).rejects.toSatisfy(
      (error: unknown) =>
        (error as { code?: string }).code === "TERMS_AGREED_FOR_THIS_NIGHT" &&
        (error as { meta?: unknown }).meta === undefined,
    );
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("CHALLENGED");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("the challenge itself refuses on such a hold, with the hold for the venue", async () => {
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "ACCEPTED" });
    const a = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);

    await expect(challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id })).rejects.toMatchObject({
      code: "TERMS_AGREED_FOR_THIS_NIGHT",
      meta: { holdId: a.id, agreementId: A_TERMS, date: DATE },
    });
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    const staff = await listBookingHoldsForRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_B, viewer: "staff" });
    if (staff.viewer !== "staff") throw new Error("unreachable");
    expect(staff.lineHeads).toEqual([
      expect.objectContaining({ holdId: a.id, challengeable: false, challengeBlocker: "terms_agreed" }),
    ]);
  });
});

describe("a refused keep still owes the notices its committed settlement wrote", () => {
  it("the decide tx released a closed request's hold and moved the act behind up; the agree is then refused → the error carries those notices", async () => {
    const { committedHoldIntentsOf } = await import("../_shared/booking-hold-intents");
    const ctx = buildNightHarness();
    const a = ctx.seedHold(REQUEST_A, {
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY_MS),
    });
    // C's request is already WITHDRAWN: the settle releases C (REQUEST_CLOSED) and B moves up.
    const c = ctx.seedHold(REQUEST_C);
    ctx.requests.set(REQUEST_C, { ...ctx.requests.get(REQUEST_C)!, status: "WITHDRAWN" });
    const b = ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);
    // The night is gone (another request's CONFIRMED row): the agree will be refused.
    ctx.seedHold("47474747-4747-4747-8747-474747474747", { status: "CONFIRMED", confirmedAt: NOW, position: 9 });

    const error = await keep(ctx, a.id, { expectedKeepWill: "book_now" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "NIGHT_NO_LONGER_AVAILABLE" });
    expect(ctx.bookingHolds.rows.get(c.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
    const committed = committedHoldIntentsOf(error);
    expect(committed?.bookingRequestId).toBe(REQUEST_A);
    expect(committed?.notificationIntents).toContainEqual(
      expect.objectContaining({ kind: "hold.position_changed", bookingRequestId: REQUEST_B, holdId: b.id, position: 2 }),
    );
  });
});

describe("the keeper is told the ABSOLUTE deadline the keep set (W2)", () => {
  it("the keeper's own notice carries respondBy = max(current, keep + 48h)", async () => {
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "DRAFT" });
    const far = new Date(NOW.getTime() + 3 * DAY_MS);
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", challengedAt: NOW, respondBy: far });

    const result = await keep(ctx, a.id);
    expect(result.notificationIntents).toContainEqual({
      kind: "hold.kept",
      bookingRequestId: REQUEST_A,
      holdId: a.id,
      audience: "act",
      date: DATE,
      position: 1,
      respondBy: far,
      awaitingTerms: true,
    });
  });

  it("a challenged hold with no challengedAt is never 'kept' (fail closed)", async () => {
    const { isKeptAwaitingTerms } = await import("../_shared/keep-will");
    const ctx = buildNightHarness();
    setTerms(ctx, { status: "DRAFT" });
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", challengedAt: null, respondBy: new Date(NOW.getTime() + DAY_MS) });
    await keep(ctx, a.id);
    const row = ctx.bookingHolds.rows.get(a.id)!;
    expect(await isKeptAwaitingTerms(ctx.repos as never, row)).toBe(false);
  });
});
