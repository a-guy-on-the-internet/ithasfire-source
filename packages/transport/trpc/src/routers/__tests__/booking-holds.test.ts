import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACT_A_ID,
  ACT_B_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  ORG_ID,
  PLACE_ID,
  DATE,
  NOW,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "@th/core/use-cases/booking-holds/__tests__/hold-test-context";
import { makeFakeIdempotency } from "@th/core/use-cases/booking-requests/__tests__/helpers";

import { bookingHoldsRouter } from "../booking-holds";
import { createCaller } from "./test-helpers";

// The step-3 dispatcher is the ONE seam the router touches for notifications.
// Mocked at the module boundary so every test can assert "called post-commit
// with the use case's intents" and "a throw is swallowed" without a mailer.
vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";

// The post-commit event mint behind `confirm` is the EXISTING
// create-event-from-agreement path (hold variant), pinned by its own core
// suite; here it is a boundary, exactly as core's confirm test treats it.
const mintForHold = vi.fn();
vi.mock(
  "@th/core/use-cases/booking-agreements/create-event-from-agreement",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@th/core/use-cases/booking-agreements/create-event-from-agreement")
    >()),
    createEventFromAgreementForHold: (...args: unknown[]) => mintForHold(...args),
  }),
);
const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";

/**
 * Transport contract for `bookingHolds.*` (booking-holds spec, step 4).
 *
 * The router is thin, so what is pinned HERE is transport-only:
 *   - every procedure needs an authed actor (UNAUTHORIZED without one);
 *   - `actorHumanId` comes from ctx — a client-supplied one is rejected by
 *     the `.strict()`-derived input (BAD_REQUEST), never honoured;
 *   - typed use-case errors map through `toTrpcError` to the right code;
 *   - `notificationIntents` / `staffRecipientHint` NEVER cross the wire
 *     (FR-013: an act must not learn who else is in a line);
 *   - the intents dispatcher fires AFTER the use case returns, with the
 *     intents the use case computed, and its failure is swallowed + reported
 *     — a notify outage never fails a committed hold transition.
 *
 * The domain itself (line mechanics, lapse, ledger) is covered in core.
 */

const dispatchMock = vi.mocked(dispatchBookingHoldIntents);

function build(actorHumanId: string | null = STAFF_ID) {
  const harness = buildHoldTestContext();
  const reportError = vi.fn();
  const { caller, ctx } = createCaller(bookingHoldsRouter, {
    repos: harness.repos,
    clock: { now: () => NOW },
    idempotency: makeFakeIdempotency(),
    actorHumanId,
    reportError,
  });
  return { ...harness, caller, ctx, reportError };
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(undefined);
  mintForHold.mockReset();
  mintForHold.mockResolvedValue({ eventId: EVENT_ID, alreadyLinked: false, finalized: false });
});

describe("bookingHoldsRouter — auth + actor injection", () => {
  it("rejects an anonymous caller with UNAUTHORIZED on every procedure", async () => {
    const { caller } = build(null);
    const holdId = "00000000-0000-4000-8000-000000000001";
    await expect(
      caller.place({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.placeMany({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, dates: [DATE] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.reorder({ holdId, toPosition: 1 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.challenge({ holdId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.extend({ holdId, respondBy: new Date(NOW.getTime() + 48 * 3600_000) }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.answer({ holdId, answer: "keep" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.release({ holdId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.confirm({ holdId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.bookNightWithoutTerms({ bookingRequestId: REQUEST_A, holdId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.listForRequest({ bookingRequestId: REQUEST_A, viewer: "staff" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.settle({ bookingRequestId: REQUEST_A })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("takes actorHumanId from ctx and rejects a client-supplied one (.strict omit)", async () => {
    const { caller, bookingHolds } = build();
    await expect(
      caller.place({
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        date: DATE,
        actorHumanId: VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { hold } = await caller.place({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: DATE,
    });
    expect(hold.placedByHumanId).toBe(STAFF_ID);
    expect(bookingHolds.rows.get(hold.id)?.placedByHumanId).toBe(STAFF_ID);
  });
});

describe("bookingHoldsRouter — listForRequester (event-calendar-redesign FR-004)", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const { caller } = build(null);
    await expect(
      caller.listForRequester({ ownerType: "HUMAN", ownerId: ACT_A_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("an act sees its OWN requests' holds only, projected without the venue's side of the line", async () => {
    const { caller, seedHold, place } = build(ACT_A_ID);
    const mine = seedHold(REQUEST_A);
    const other = seedHold(REQUEST_B);

    const result = await caller.listForRequester({ ownerType: "HUMAN", ownerId: ACT_A_ID });

    expect(result).toEqual({
      holds: [
        {
          id: mine.id,
          bookingRequestId: REQUEST_A,
          calendarId: CALENDAR_ID,
          spaceId: null,
          placeId: PLACE_ID,
          placeName: place.name,
          date: DATE,
          position: 1,
          status: "ACTIVE",
          respondBy: null,
          requestTitle: "Act A",
        },
      ],
    });
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(other.id);
    expect(wire).not.toContain(STAFF_ID);
  });

  it("a human asking for another human's holds maps to FORBIDDEN (gate lives in core)", async () => {
    const { caller, seedHold } = build(ACT_A_ID);
    seedHold(REQUEST_B);
    await expect(
      caller.listForRequester({ ownerType: "HUMAN", ownerId: ACT_B_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a non-member asking for an org's holds maps to FORBIDDEN", async () => {
    const { caller } = build(ACT_A_ID);
    await expect(
      caller.listForRequester({ ownerType: "ORGANIZATION", ownerId: ORG_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("takes actorHumanId from ctx and rejects a client-supplied one (.strict omit)", async () => {
    const { caller } = build(ACT_A_ID);
    await expect(
      caller.listForRequester({
        ownerType: "HUMAN",
        ownerId: ACT_A_ID,
        actorHumanId: ACT_B_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("bookingHoldsRouter — error mapping", () => {
  it("maps a VIEWER placing a hold to FORBIDDEN (edit-role gate lives in core)", async () => {
    const { caller } = build(VIEWER_ID);
    await expect(
      caller.place({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("maps BOOKING_HOLD_NOT_FIRST (challenging position 2) to PRECONDITION_FAILED", async () => {
    const { caller, seedHold } = build();
    seedHold(REQUEST_A);
    const second = seedHold(REQUEST_B);
    await expect(caller.challenge({ holdId: second.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("maps an unknown hold to NOT_FOUND", async () => {
    const { caller } = build();
    await expect(
      caller.release({ holdId: "00000000-0000-4000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps an act answering someone else's hold to FORBIDDEN", async () => {
    const { caller, seedHold } = build(ACT_B_ID);
    const hold = seedHold(REQUEST_A, { status: "CHALLENGED", respondBy: new Date(NOW.getTime() + 3600_000) });
    await expect(caller.answer({ holdId: hold.id, answer: "keep" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("bookingHoldsRouter — wire output strips intents", () => {
  it("place: returns the hold only; intents + routing hint never cross the wire", async () => {
    const { caller } = build();
    const result = await caller.place({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: DATE,
    });
    expect(Object.keys(result).sort()).toEqual(["hold"]);
    expect(result).not.toHaveProperty("notificationIntents");
    expect(result).not.toHaveProperty("staffRecipientHint");
    expect(result.hold).toMatchObject({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: DATE,
      position: 1,
      status: "ACTIVE",
      lapsed: false,
    });
  });

  it("placeMany: the exact wire contract the admin UI is built against — placed[] + failed[], nothing else", async () => {
    const { caller, seedHold } = build();
    // D2's line already went to another act, so it comes back in `failed`
    // while the other two stand: partial success is the designed outcome.
    const D1 = "2026-06-20";
    const D2 = "2026-06-21";
    const D3 = "2026-06-22";
    seedHold(REQUEST_B, { date: D2, status: "CONFIRMED", confirmedAt: NOW });

    const result = await caller.placeMany({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: [D1, D2, D3],
    });

    expect(Object.keys(result).sort()).toEqual(["failed", "placed"]);
    expect(result).not.toHaveProperty("notificationIntents");
    expect(result).not.toHaveProperty("staffRecipientHint");
    expect(result.failed).toEqual([{ date: D2, code: "HOLD_LINE_ALREADY_CONFIRMED" }]);
    expect(result.placed.map((h) => h.date)).toEqual([D1, D3]);
    // Same hold shape `place` returns.
    expect(result.placed[0]).toMatchObject({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      spaceId: null,
      position: 1,
      status: "ACTIVE",
      lapsed: false,
      placedByHumanId: STAFF_ID,
    });

    // ONE digest dispatched post-commit for the two holds it placed.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [, args] = dispatchMock.mock.calls[0]!;
    expect(args.intents).toEqual([
      expect.objectContaining({
        kind: "hold.placed_batch",
        audience: "act",
        bookingRequestId: REQUEST_A,
        dates: [
          { date: D1, position: 1 },
          { date: D3, position: 1 },
        ],
      }),
    ]);
    expect(args.bookingRequestId).toBe(REQUEST_A);
  });

  it("placeMany: rejects a client-supplied actorHumanId and a spaceId (.strict)", async () => {
    const { caller } = build();
    await expect(
      caller.placeMany({
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        dates: [DATE],
        actorHumanId: VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.placeMany({
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        dates: [DATE],
        spaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("challenge / answer / release / reorder / bookNightWithoutTerms / settle all strip intents", async () => {
    const staff = build();
    // The night must be one the pitch asked for (booking-the-night N3).
    staff.requests.set(REQUEST_A, { ...staff.requests.get(REQUEST_A)!, preferredDates: [DATE] });
    const first = staff.seedHold(REQUEST_A);
    staff.seedHold(REQUEST_B);
    // booking-the-night N20: the act behind has draft terms for the night, so
    // the 1st hold can be challenged.
    staff.seedTerms(REQUEST_B);

    const reordered = await staff.caller.reorder({ holdId: first.id, toPosition: 2 });
    expect(Object.keys(reordered).sort()).toEqual(["line"]);
    const back = await staff.caller.reorder({ holdId: first.id, toPosition: 1 });
    expect(back.line.map((h) => h.bookingRequestId)).toEqual([REQUEST_A, REQUEST_B]);

    const challenged = await staff.caller.challenge({ holdId: first.id });
    // The venue's own "also send terms" outcome rides along (not requested here).
    expect(Object.keys(challenged).sort()).toEqual(["hold", "termsToFirstHold"]);
    expect(challenged.termsToFirstHold).toEqual({ status: "not_requested", errorCode: null });
    expect(challenged.hold.status).toBe("CHALLENGED");
    expect(challenged.hold.respondBy?.getTime()).toBe(NOW.getTime() + 24 * 3600_000);

    const extended = await staff.caller.extend({
      holdId: first.id,
      respondBy: new Date(NOW.getTime() + 48 * 3600_000),
    });
    expect(Object.keys(extended).sort()).toEqual(["hold"]);

    // The act answers on the SAME repos (shared harness state).
    const { caller: actCaller } = createCaller(bookingHoldsRouter, {
      repos: staff.repos,
      clock: { now: () => NOW },
      actorHumanId: ACT_A_ID,
    });
    const kept = await actCaller.answer({ holdId: first.id, answer: "keep" });
    expect(Object.keys(kept).sort()).toEqual(["eventId", "hold", "keepOutcome"]);
    // booking-the-night N19 / FR-014: A has no terms with it — Keep commits
    // to agreeing the terms the venue sends; the hold stays challenged.
    expect(kept).toMatchObject({ keepOutcome: "awaiting_terms", eventId: null });
    expect(kept.hold).toMatchObject({ status: "CHALLENGED", keepWill: "ask_for_terms", kept: true });
    // FR-013: the act gets the ACT projection — never the staff columns, and
    // nothing that names venue-internal humans or the other acts in the line.
    expect(Object.keys(kept.hold).sort()).toEqual([
      "date",
      "id",
      "keepWill",
      "kept",
      "lapsed",
      "position",
      "respondBy",
      "status",
    ]);
    expect(kept.hold).not.toHaveProperty("placedByHumanId");
    const wire = JSON.stringify(kept);
    for (const secret of [STAFF_ID, ASSIGNEE_ID, REQUEST_B, CALENDAR_ID]) {
      expect(wire).not.toContain(secret);
    }

    const settled = await staff.caller.settle({ bookingRequestId: REQUEST_A });
    expect(Object.keys(settled).sort()).toEqual(["settledHoldIds"]);
    expect(settled.settledHoldIds).toEqual([]);

    // The retired confirm books nothing (booking-the-night FR-005).
    await expect(staff.caller.confirm({ holdId: first.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "HOLD_CONFIRM_RETIRED",
    });

    const confirmed = await staff.caller.bookNightWithoutTerms({
      bookingRequestId: REQUEST_A,
      holdId: first.id,
    });
    expect(Object.keys(confirmed).sort()).toEqual([
      "agreementId",
      "eventId",
      "hold",
      "releasedHoldIds",
    ]);
    expect(confirmed.hold.status).toBe("CONFIRMED");
    expect(confirmed.eventId).toBe(EVENT_ID);
    expect(confirmed.releasedHoldIds).toHaveLength(1);
    // Idempotent on the hold id: a replay returns the same event.
    await expect(
      staff.caller.bookNightWithoutTerms({ bookingRequestId: REQUEST_A, holdId: first.id }),
    ).resolves.toMatchObject({ eventId: EVENT_ID });

    const released = await staff.caller.release({ holdId: confirmed.releasedHoldIds[0]! });
    expect(Object.keys(released).sort()).toEqual(["hold", "line"]);
  });

  it("listForRequest: act view is the narrow projection (own date/position only)", async () => {
    const staff = build();
    staff.seedHold(REQUEST_B);
    const mine = staff.seedHold(REQUEST_A);

    const { caller: actCaller } = createCaller(bookingHoldsRouter, {
      repos: staff.repos,
      clock: { now: () => NOW },
      actorHumanId: ACT_A_ID,
    });
    const act = await actCaller.listForRequest({ bookingRequestId: REQUEST_A, viewer: "act" });
    expect(act.viewer).toBe("act");
    expect(act.holds).toEqual([
      { id: mine.id, date: DATE, position: 2, status: "ACTIVE", respondBy: null, lapsed: false, keepWill: null, kept: false },
    ]);
    // The act may not widen itself to the staff projection.
    await expect(
      actCaller.listForRequest({ bookingRequestId: REQUEST_A, viewer: "staff" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const asStaff = await staff.caller.listForRequest({
      bookingRequestId: REQUEST_A,
      viewer: "staff",
    });
    expect(asStaff.viewer).toBe("staff");
    expect(asStaff.holds[0]).toMatchObject({ placedByHumanId: STAFF_ID, calendarId: CALENDAR_ID });
    // Read-only: nothing dispatched for a list.
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("bookingHoldsRouter — post-commit intents dispatch", () => {
  it("fires the dispatcher after the use case with its intents + routing hint", async () => {
    const { caller, ctx } = build();
    await caller.place({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [deps, args] = dispatchMock.mock.calls[0]!;
    expect(deps.repos).toBe(ctx.repos);
    expect(deps.notify).toBe(ctx.notify);
    expect(args.intents).toEqual([
      expect.objectContaining({
        kind: "hold.placed",
        audience: "act",
        bookingRequestId: REQUEST_A,
        date: DATE,
        position: 1,
      }),
    ]);
    expect(args.hint).toMatchObject({ placedByHumanId: STAFF_ID, orgId: ORG_ID, placeId: PLACE_ID });
    expect(args.bookingRequestId).toBe(REQUEST_A);
  });

  it("settle (no hint on its output) resolves the FR-016 hint from the request + place", async () => {
    const { caller, seedHold } = build();
    // A CHALLENGED hold whose deadline is already behind NOW → EXPIRED on settle.
    seedHold(REQUEST_A, {
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() - 60_000),
    });
    seedHold(REQUEST_B);

    const result = await caller.settle({ bookingRequestId: REQUEST_A });
    expect(result.settledHoldIds).toHaveLength(1);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [, args] = dispatchMock.mock.calls[0]!;
    expect(args.hint).toEqual({
      assigneeHumanId: ASSIGNEE_ID,
      placedByHumanId: STAFF_ID,
      orgId: ORG_ID,
      placeId: PLACE_ID,
    });
    expect(args.intents.map((i) => `${i.kind}:${i.audience}`)).toEqual([
      "hold.expired:act",
      "hold.expired:staff",
      "hold.position_changed:act",
    ]);
  });

  it("prefers notifyWithEmail when the composition root bound it", async () => {
    const harness = buildHoldTestContext();
    const notifyWithEmail = vi.fn(async () => ({ ok: true }));
    const { caller } = createCaller(bookingHoldsRouter, {
      repos: harness.repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
      notifyWithEmail: notifyWithEmail as never,
    });
    await caller.place({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE });
    expect(dispatchMock.mock.calls[0]![0].notify).toBe(notifyWithEmail);
  });

  it("swallows + reports a dispatcher failure; the committed mutation still returns", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("mailer down"));
    const { caller, reportError, bookingHolds } = build();

    const result = await caller.place({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: DATE,
    });

    expect(result.hold.status).toBe("ACTIVE");
    expect(bookingHolds.rows.get(result.hold.id)?.status).toBe("ACTIVE");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: "booking_holds", step: "notify_intents" } }),
    );
  });

  it("survives a THROWING reporter on top of a failing dispatcher", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("mailer down"));
    const harness = buildHoldTestContext();
    const { caller } = createCaller(bookingHoldsRouter, {
      repos: harness.repos,
      clock: { now: () => NOW },
      actorHumanId: STAFF_ID,
      reportError: vi.fn(() => {
        throw new Error("sentry down too");
      }),
    });
    await expect(
      caller.place({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE }),
    ).resolves.toMatchObject({ hold: { status: "ACTIVE" } });
  });

  it("does not dispatch when the use case throws (nothing committed)", async () => {
    const { caller } = build(VIEWER_ID);
    await expect(
      caller.place({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: DATE }),
    ).rejects.toBeTruthy();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("skips the dispatcher entirely when a mutation owes no intents", async () => {
    const { caller } = build();
    await caller.settle({ bookingRequestId: REQUEST_A });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("bookingHoldsRouter — booking-the-night (FR-002 / FR-004 / FR-005)", () => {
  it("bookNightWithoutTerms: DATE_NOT_ASKED_FOR maps to BAD_REQUEST and carries the hold + night for the venue's UI", async () => {
    const staff = build();
    const hold = staff.seedHold(REQUEST_A); // DATE is not in the pitch

    const error = await staff.caller
      .bookNightWithoutTerms({ bookingRequestId: REQUEST_A, holdId: hold.id })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "BAD_REQUEST", message: "DATE_NOT_ASKED_FOR" });
    expect((error as { meta?: unknown }).meta).toMatchObject({ appCode: "DATE_NOT_ASKED_FOR", holdId: hold.id, date: DATE });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("bookNightWithoutTerms: NIGHT_TAKEN (venue side) keeps its meta — the hold to challenge", async () => {
    const staff = build();
    staff.requests.set(REQUEST_A, { ...staff.requests.get(REQUEST_A)!, preferredDates: [DATE] });
    const ahead = staff.seedHold(REQUEST_B);
    const mine = staff.seedHold(REQUEST_A);

    const error = await staff.caller
      .bookNightWithoutTerms({ bookingRequestId: REQUEST_A, holdId: mine.id })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFLICT", message: "NIGHT_TAKEN" });
    expect((error as { meta?: unknown }).meta).toMatchObject({
      appCode: "NIGHT_TAKEN",
      date: DATE,
      position: 1,
      aheadHoldId: ahead.id,
    });
  });

  it("bookNightWithoutTerms dispatches the sender's hold-confirmed notice post-commit", async () => {
    const staff = build();
    staff.requests.set(REQUEST_A, { ...staff.requests.get(REQUEST_A)!, preferredDates: [DATE] });
    const hold = staff.seedHold(REQUEST_A);

    await staff.caller.bookNightWithoutTerms({ bookingRequestId: REQUEST_A, holdId: hold.id });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const args = dispatchMock.mock.calls[0]![1];
    expect(args.intents).toContainEqual(
      expect.objectContaining({ kind: "hold.confirmed", bookingRequestId: REQUEST_A, holdId: hold.id, audience: "act" }),
    );
  });

  it("a VIEWER (below edit role) cannot book a night", async () => {
    const viewer = build(VIEWER_ID);
    viewer.requests.set(REQUEST_A, { ...viewer.requests.get(REQUEST_A)!, preferredDates: [DATE] });
    const hold = viewer.seedHold(REQUEST_A);

    await expect(
      viewer.caller.bookNightWithoutTerms({ bookingRequestId: REQUEST_A, holdId: hold.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listForRequest: the venue gets lineHeads; the act's wire never carries another request's hold", async () => {
    const staff = build();
    const ahead = staff.seedHold(REQUEST_B);
    staff.seedHold(REQUEST_A);
    // N20: A (behind) has draft terms for the night — B can be challenged.
    staff.seedTerms(REQUEST_A);

    const asStaff = await staff.caller.listForRequest({ bookingRequestId: REQUEST_A, viewer: "staff" });
    expect(asStaff).toMatchObject({
      viewer: "staff",
      lineHeads: [
        { calendarId: CALENDAR_ID, date: DATE, holdId: ahead.id, isThisRequest: false, challengeable: true, challengeBlocker: null },
      ],
    });

    const { caller: actCaller } = createCaller(bookingHoldsRouter, {
      repos: staff.repos,
      clock: { now: () => NOW },
      actorHumanId: ACT_A_ID,
    });
    const act = await actCaller.listForRequest({ bookingRequestId: REQUEST_A, viewer: "act" });
    expect(act).not.toHaveProperty("lineHeads");
    expect(JSON.stringify(act)).not.toContain(ahead.id);
  });
  it("bookNightWithoutTerms: the mint fails AFTER the night was booked → the committed notices are still dispatched, then the error maps", async () => {
    const staff = build();
    staff.requests.set(REQUEST_A, { ...staff.requests.get(REQUEST_A)!, preferredDates: [DATE] });
    const hold = staff.seedHold(REQUEST_A);
    const behind = staff.seedHold(REQUEST_B);
    mintForHold.mockRejectedValueOnce(new Error("quota_exceeded"));

    await expect(
      staff.caller.bookNightWithoutTerms({ bookingRequestId: REQUEST_A, holdId: hold.id }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const args = dispatchMock.mock.calls[0]![1];
    expect(args.intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "hold.confirmed", holdId: hold.id, bookingRequestId: REQUEST_A }),
        expect.objectContaining({ kind: "hold.lost_date", holdId: behind.id, bookingRequestId: REQUEST_B }),
      ]),
    );
  });
});
