import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACT_A_ID,
  DATE,
  NOW,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
} from "@th/core/use-cases/booking-holds/__tests__/hold-test-context";
import {
  A_TERMS,
  EVENT_ID,
  NIGHT_AT,
  buildNightHarness,
  terms,
} from "@th/core/use-cases/booking-agreements/__tests__/night-harness";

import { bookingAgreementsRouter } from "../booking-agreements";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Transport seam for booking-the-night on `bookingAgreements.*`:
//   - respond: an "Agree & book" gets the mint's ports (idempotency, authz,
//     tax lookup, app URL), dispatches the hold notices it owes post-commit,
//     and never puts them on the wire;
//   - respond's refusal NIGHT_NO_LONGER_AVAILABLE reaches the sender with NO
//     meta beyond its code, even if a thrower attached some;
//   - sendTerms: the one "Send terms" call, NIGHT_TAKEN keeps its meta (venue).
// The domain is pinned in core (agree-and-book / send-terms-night suites).
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";

const agreeMint = vi.fn();
const publicMint = vi.fn();
vi.mock(
  "@th/core/use-cases/booking-agreements/create-event-from-agreement",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@th/core/use-cases/booking-agreements/create-event-from-agreement")
    >()),
    createEventFromAgreementOnNight: (...args: unknown[]) => agreeMint(...args),
    createEventFromAgreement: (...args: unknown[]) => publicMint(...args),
  }),
);

const dispatchMock = vi.mocked(dispatchBookingHoldIntents);

function build(actorHumanId: string) {
  const harness = buildNightHarness();
  const reportError = vi.fn();
  const { caller } = createCaller(bookingAgreementsRouter, {
    repos: harness.repos,
    clock: { now: () => NOW },
    idempotency: harness.deps.idempotency,
    actorHumanId,
    reportError,
  });
  return { ...harness, caller, reportError };
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined as never);
  agreeMint.mockReset();
  agreeMint.mockResolvedValue({ eventId: EVENT_ID, alreadyLinked: false, finalized: false });
});

describe("bookingAgreements.respond — Agree & book", () => {
  it("books the night: wire carries the event and no intents; the lost_date notices are dispatched post-commit; the mint gets its ports", async () => {
    const h = build(ACT_A_ID);
    h.seedHold(REQUEST_A);
    const behind = h.seedHold(REQUEST_B);

    const result = await h.caller.respond({ agreementId: A_TERMS, action: "accept" });

    expect(Object.keys(result).sort()).toEqual([
      "acceptedAt",
      "agreementId",
      "declinedAt",
      "eventId",
      "status",
    ]);
    expect(result).toMatchObject({ status: "ACCEPTED", eventId: EVENT_ID });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const args = dispatchMock.mock.calls[0]![1];
    expect(args.intents).toContainEqual(
      expect.objectContaining({ kind: "hold.lost_date", bookingRequestId: REQUEST_B, holdId: behind.id }),
    );

    const mintDeps = agreeMint.mock.calls[0]![0] as Record<string, unknown>;
    for (const port of ["idempotency", "authz", "taxRateLookup", "publicAppUrl", "reportError"]) {
      expect(mintDeps, port).toHaveProperty(port);
    }
    expect(agreeMint.mock.calls[0]![1]).toMatchObject({ actorHumanId: STAFF_ID });
  });

  it("the night went elsewhere → CONFLICT NIGHT_NO_LONGER_AVAILABLE whose meta is the code alone; nothing dispatched", async () => {
    const h = build(ACT_A_ID);
    const ahead = h.seedHold(REQUEST_B);
    h.seedHold(REQUEST_A);

    const error = await h.caller
      .respond({ agreementId: A_TERMS, action: "accept" })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "CONFLICT", message: "NIGHT_NO_LONGER_AVAILABLE" });
    expect((error as { meta?: unknown }).meta).toEqual({ appCode: "NIGHT_NO_LONGER_AVAILABLE" });
    expect(JSON.stringify((error as { meta?: unknown }).meta)).not.toContain(ahead.id);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(agreeMint).not.toHaveBeenCalled();
  });
});

describe("bookingAgreements.sendTerms (FR-003)", () => {
  it("puts the night on the draft and sends it in one call", async () => {
    const h = build(STAFF_ID);
    h.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { status: "DRAFT", proposedAt: null, proposedDate: null, sentForReviewByHumanId: null }));
    h.seedHold(REQUEST_A);

    const result = await h.caller.sendTerms({ agreementId: A_TERMS, startTime: "21:00" });

    expect(result).toMatchObject({ status: "PROPOSED", night: DATE });
    expect(h.agreements.get(A_TERMS)).toMatchObject({ status: "PROPOSED", sentForReviewByHumanId: STAFF_ID });
  });

  it("NIGHT_TAKEN is the venue's refusal and keeps its meta (the hold to challenge)", async () => {
    const h = build(STAFF_ID);
    h.agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID, { status: "DRAFT", proposedAt: null }));
    const ahead = h.seedHold(REQUEST_B);

    const error = await h.caller.sendTerms({ agreementId: A_TERMS }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "CONFLICT", message: "NIGHT_TAKEN" });
    expect((error as { meta?: unknown }).meta).toMatchObject({ appCode: "NIGHT_TAKEN", aheadHoldId: ahead.id, date: DATE });
  });

  it("rejects a client-supplied actorHumanId (.strict omit)", async () => {
    const h = build(STAFF_ID);
    await expect(
      h.caller.sendTerms({ agreementId: A_TERMS, actorHumanId: STAFF_ID } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("bookingAgreements.respond — no sender-side refusal carries meta beyond its code (review W4)", () => {
  async function refusal(promise: Promise<unknown>) {
    const error = await promise.catch((e: unknown) => e);
    return error as { code: string; message: string; meta?: Record<string, unknown> };
  }

  it("night gone, terms moved, terms changed since viewed, a second night, a moved line, a closed request: all { appCode } only", async () => {
    const cases: Array<{ name: string; appCode: string; arrange: (h: ReturnType<typeof build>) => void; input?: Record<string, unknown> }> = [
      { name: "night went elsewhere", appCode: "NIGHT_NO_LONGER_AVAILABLE", arrange: (h) => { h.seedHold(REQUEST_B); h.seedHold(REQUEST_A); } },
      {
        name: "terms changed since viewed",
        appCode: "TERMS_CHANGED_SINCE_VIEWED",
        arrange: (h) => { h.seedHold(REQUEST_A); },
        input: { expectedProposedDate: new Date("2026-06-28T01:00:00.000Z") },
      },
      {
        name: "already booked another night",
        appCode: "BOOKING_ALREADY_HAS_NIGHT",
        arrange: (h) => { h.seedHold(REQUEST_A, { date: "2026-06-27", status: "CONFIRMED", confirmedAt: NOW }); },
      },
      {
        name: "a line appeared under the locks",
        appCode: "HOLD_LINE_CHANGED",
        arrange: (h) => {
          h.seedHold(REQUEST_A);
          const listForRequest = vi.mocked(h.bookingHolds.listForRequest);
          const real = listForRequest.getMockImplementation()!;
          let reads = 0;
          listForRequest.mockImplementation(async (id: string) => {
            const rows = await real(id);
            reads += 1;
            if (reads === 2) h.seedHold(REQUEST_A, { date: "2026-06-27" });
            return rows;
          });
        },
      },
      {
        name: "request closed",
        appCode: "INVALID_STATUS",
        arrange: (h) => { h.requests.set(REQUEST_A, { ...h.requests.get(REQUEST_A)!, status: "WITHDRAWN" }); },
      },
    ];

    for (const c of cases) {
      const h = build(ACT_A_ID);
      c.arrange(h);
      const error = await refusal(h.caller.respond({ agreementId: A_TERMS, action: "accept", ...(c.input ?? {}) }));
      expect(error.meta, c.name).toEqual({ appCode: c.appCode });
    }
  });

  it("expectedProposedDate is accepted on the wire and books when it matches", async () => {
    const h = build(ACT_A_ID);
    const mine = h.seedHold(REQUEST_A);
    const result = await h.caller.respond({
      agreementId: A_TERMS,
      action: "accept",
      expectedProposedDate: NIGHT_AT,
    });
    expect(result.status).toBe("ACCEPTED");
    expect(h.bookingHolds.rows.get(mine.id)?.status).toBe("CONFIRMED");
  });
});

describe("bookingAgreements.createEventFromAgreement — the night it books (booking-the-night NFR-001, review W1)", () => {
  const owed = [
    {
      kind: "hold.lost_date" as const,
      bookingRequestId: REQUEST_B,
      holdId: "00000000-0000-4000-8000-0000000000b2",
      audience: "act" as const,
      date: DATE,
      reason: "CONFIRMED_OTHER" as const,
    },
  ];
  const hint = {
    assigneeHumanId: null,
    placedByHumanId: STAFF_ID,
    orgId: null,
    placeId: "33333333-3333-4333-8333-333333333333",
  };

  it("dispatches the booking's notices post-commit and keeps them off the wire", async () => {
    const h = build(STAFF_ID);
    publicMint.mockResolvedValueOnce({
      eventId: EVENT_ID,
      alreadyLinked: false,
      finalized: false,
      notificationIntents: owed,
      staffRecipientHint: hint,
    });

    const result = await h.caller.createEventFromAgreement({ agreementId: A_TERMS });

    expect(Object.keys(result).sort()).toEqual(["alreadyLinked", "eventId", "finalized"]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1]).toMatchObject({ intents: owed, hint });
  });

  it("the mint fails after the booking committed → the notices still go out, then the error maps", async () => {
    const h = build(STAFF_ID);
    const { withCommittedHoldIntents } = await import(
      "@th/core/use-cases/booking-holds/_shared/booking-hold-intents"
    );
    publicMint.mockRejectedValueOnce(
      withCommittedHoldIntents(new Error("save down"), {
        notificationIntents: owed,
        staffRecipientHint: hint,
        bookingRequestId: REQUEST_A,
      }),
    );

    await expect(h.caller.createEventFromAgreement({ agreementId: A_TERMS })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1]).toMatchObject({ intents: owed });
  });

  it("nothing booked → nothing dispatched", async () => {
    const h = build(STAFF_ID);
    publicMint.mockResolvedValueOnce({ eventId: EVENT_ID, alreadyLinked: true, finalized: true });

    await h.caller.createEventFromAgreement({ agreementId: A_TERMS });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
