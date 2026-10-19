import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACT_A_ID,
  NOW,
  REQUEST_A,
  REQUEST_B,
  REQUEST_C,
  STAFF_ID,
} from "@th/core/use-cases/booking-holds/__tests__/hold-test-context";
import {
  A_TERMS,
  buildNightHarness,
} from "@th/core/use-cases/booking-agreements/__tests__/night-harness";

import { bookingHoldsRouter } from "../booking-holds";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night P2d-2 — the transport wiring of Keep = commit (N19 /
// FR-014) and the challenge dialog's "also send terms" (N20). The domain is
// pinned in core; HERE: `bookingHolds.answer` passes the agree's ports, so a
// keep on sent terms really books through the respond path, and its wire is
// the act's own projection; `bookingHolds.challenge` passes the send's ports.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";

const agreeMint = vi.fn();
vi.mock(
  "@th/core/use-cases/booking-agreements/create-event-from-agreement",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@th/core/use-cases/booking-agreements/create-event-from-agreement")
    >()),
    createEventFromAgreementOnNight: (...args: unknown[]) => agreeMint(...args),
  }),
);
const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const DAY_MS = 24 * 3600_000;

const dispatchMock = vi.mocked(dispatchBookingHoldIntents);

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined);
  agreeMint.mockReset();
  agreeMint.mockResolvedValue({ eventId: EVENT_ID, alreadyLinked: false, finalized: false });
});

function callers() {
  const night = buildNightHarness();
  const reportError = vi.fn();
  const base = {
    repos: night.repos,
    clock: { now: () => NOW },
    idempotency: night.deps.idempotency,
    reportError,
  };
  return {
    night,
    reportError,
    staff: createCaller(bookingHoldsRouter, { ...base, actorHumanId: STAFF_ID }).caller,
    act: createCaller(bookingHoldsRouter, { ...base, actorHumanId: ACT_A_ID }).caller,
  };
}

describe("bookingHolds.answer — Keep = commit through the transport", () => {
  it("keep on sent terms books the night through the respond path; the wire is the act's own hold, the outcome and its event — nothing else", async () => {
    const { night, act } = callers();
    const a = night.seedHold(REQUEST_A, {
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY_MS),
    });
    const b = night.seedHold(REQUEST_B);
    night.seedTerms(REQUEST_B);

    const kept = await act.answer({ holdId: a.id, answer: "keep", expectedKeepWill: "book_now" });

    expect(kept).toEqual({
      hold: expect.objectContaining({ id: a.id, status: "CONFIRMED", keepWill: null, kept: false }),
      keepOutcome: "booked",
      eventId: EVENT_ID,
    });
    expect(night.agreements.get(A_TERMS)?.status).toBe("ACCEPTED");
    expect(agreeMint).toHaveBeenCalledTimes(1);
    // FR-013: nothing on the act's wire names the act behind or the venue's people.
    const wire = JSON.stringify(kept);
    for (const secret of [REQUEST_B, b.id, STAFF_ID]) expect(wire).not.toContain(secret);
    // The committed notices (B lost the date) are dispatched post-commit.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1].intents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "hold.lost_date", holdId: b.id })]),
    );
  });

  it("a stale panel (terms pulled back since) → CONFLICT TERMS_CHANGED_SINCE_VIEWED with no meta; nothing booked", async () => {
    const { night, act } = callers();
    night.agreements.set(A_TERMS, { ...night.agreements.get(A_TERMS)!, status: "DRAFT" });
    const a = night.seedHold(REQUEST_A, {
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY_MS),
    });

    const error = await act
      .answer({ holdId: a.id, answer: "keep", expectedKeepWill: "book_now" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT", message: "TERMS_CHANGED_SINCE_VIEWED" });
    expect(JSON.stringify((error as { cause?: unknown }).cause ?? {})).not.toContain(REQUEST_A);
    expect(night.bookingHolds.rows.get(a.id)?.status).toBe("CHALLENGED");
  });
});

describe("bookingHolds.challenge — also send terms", () => {
  it("sends the 1st hold's draft terms after the challenge; the venue's wire says so", async () => {
    const { night, staff } = callers();
    night.agreements.set(A_TERMS, {
      ...night.agreements.get(A_TERMS)!,
      status: "DRAFT",
      proposedAt: null,
      sentForReviewByHumanId: null,
    });
    const a = night.seedHold(REQUEST_A);
    night.seedHold(REQUEST_B);
    night.seedTerms(REQUEST_B);

    const result = await staff.challenge({ holdId: a.id, sendTermsToFirstHold: true });

    expect(result).toMatchObject({
      hold: { id: a.id, status: "CHALLENGED" },
      termsToFirstHold: { status: "sent", errorCode: null },
    });
    expect(night.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    // The act's challenge notice says Keep will book.
    expect(dispatchMock.mock.calls[0]![1].intents[0]).toMatchObject({ holdId: a.id, audience: "act", keepWill: "book_now" });
  });

  it("nobody ready behind → CONFLICT NO_ACT_READY", async () => {
    const { night, staff } = callers();
    const a = night.seedHold(REQUEST_A);
    night.seedHold(REQUEST_B); // no terms

    await expect(staff.challenge({ holdId: a.id })).rejects.toMatchObject({ code: "CONFLICT", message: "NO_ACT_READY" });
  });
});

// ── P2d-2 review round ──────────────────────────────────────────────────────
describe("bookingHolds.answer / challenge — review fixes through the transport", () => {
  it("W1: keep on sent terms WITHOUT expectedKeepWill → CONFLICT TERMS_CHANGED_SINCE_VIEWED; nothing booked", async () => {
    const { night, act } = callers();
    const a = night.seedHold(REQUEST_A, {
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY_MS),
    });
    night.seedHold(REQUEST_B);
    night.seedTerms(REQUEST_B);

    await expect(act.answer({ holdId: a.id, answer: "keep" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "TERMS_CHANGED_SINCE_VIEWED",
    });
    expect(night.agreements.get(A_TERMS)?.status).toBe("PROPOSED");
    expect(agreeMint).not.toHaveBeenCalled();
  });

  it("a keep refused by the agree still dispatches the notices its committed settlement owes, then maps the error", async () => {
    const { night, act } = callers();
    const a = night.seedHold(REQUEST_A, {
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY_MS),
    });
    // C's request is withdrawn: the keep's settle releases C and B moves up.
    night.seedHold(REQUEST_C);
    night.requests.set(REQUEST_C, { ...night.requests.get(REQUEST_C)!, status: "WITHDRAWN" });
    const b = night.seedHold(REQUEST_B);
    // The night is gone: the agree is refused.
    night.seedHold("47474747-4747-4747-8747-474747474747", { status: "CONFIRMED", confirmedAt: NOW, position: 9 });

    await expect(act.answer({ holdId: a.id, answer: "keep", expectedKeepWill: "book_now" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "NIGHT_NO_LONGER_AVAILABLE",
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1].intents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "hold.position_changed", holdId: b.id })]),
    );
  });

  it("W3: challenging a 1st hold whose terms are agreed for the night → CONFLICT TERMS_AGREED_FOR_THIS_NIGHT", async () => {
    const { night, staff } = callers();
    night.agreements.set(A_TERMS, { ...night.agreements.get(A_TERMS)!, status: "ACCEPTED" });
    const a = night.seedHold(REQUEST_A);
    night.seedHold(REQUEST_B);
    night.seedTerms(REQUEST_B);

    await expect(staff.challenge({ holdId: a.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "TERMS_AGREED_FOR_THIS_NIGHT",
    });
  });
});
