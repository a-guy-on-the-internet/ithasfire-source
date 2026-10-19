import { describe, expect, it, vi } from "vitest";

import type { BookingHoldLineEntry } from "@th/ports/repos/booking-holds";

import { challengeBookingHold } from "../challenge-booking-hold";
import { listBookingHoldsForRequest } from "../list-booking-holds-for-request";
import { releaseBookingHold } from "../release-booking-hold";
import {
  READY_TERMS_STATUSES,
  findReadyBehind,
  holdOwnerKindOf,
  isOwnerReadyToBook,
  isReadyToBookNight,
} from "../_shared/night-readiness";
import {
  CALENDAR_ID,
  DATE,
  NOW,
  REQUEST_A,
  REQUEST_B,
  REQUEST_C,
  STAFF_ID,
  buildHoldTestContext,
} from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night N20 / FR-015 — "someone behind is ready to book this
// night", the ONE rule `challengeBookingHold` enforces and the thread strip's
// `lineHeads` shows (and holds-without-a-request will call).
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Chicago";
/** 20:00 CDT on DATE (2026-06-20). */
const ON_THE_NIGHT = new Date("2026-06-21T01:00:00.000Z");
/** 23:30 CDT on DATE — still DATE as the place reads it (UTC is already the 21st). */
const LATE_ON_THE_NIGHT = new Date("2026-06-21T04:30:00.000Z");
/** 00:30 CDT on the 21st — the NEXT night. */
const AFTER_MIDNIGHT = new Date("2026-06-21T05:30:00.000Z");

function entry(over: Partial<BookingHoldLineEntry> = {}): BookingHoldLineEntry {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    ownerKind: "REQUEST",
    bookingRequestId: REQUEST_B,
    eventId: null,
    note: null,
    noteUpdatedByHumanId: null,
    noteUpdatedAt: null,
    calendarId: CALENDAR_ID,
    spaceId: null,
    date: DATE,
    position: 2,
    status: "ACTIVE",
    placedByHumanId: STAFF_ID,
    challengedAt: null,
    respondBy: null,
    releasedAt: null,
    releasedReason: null,
    confirmedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    terms: { agreementId: "bbbbbbbb-0000-4000-8000-000000000001", status: "DRAFT", proposedDate: ON_THE_NIGHT },
    ...over,
  };
}

describe("the readiness rule (pure)", () => {
  it("(a) a request's hold is ready with DRAFT-or-later terms dated that night — every live status, and no other", () => {
    for (const status of READY_TERMS_STATUSES) {
      expect(isReadyToBookNight(entry({ terms: { agreementId: "x", status, proposedDate: ON_THE_NIGHT } }), TZ), status).toBe(true);
    }
    for (const status of ["DECLINED", "CANCELLED", "EXPIRED", "FULFILLED", "DISPUTED"] as const) {
      expect(isReadyToBookNight(entry({ terms: { agreementId: "x", status, proposedDate: ON_THE_NIGHT } }), TZ), status).toBe(false);
    }
  });

  it("(a) the terms must name the night, as the PLACE reads its calendar", () => {
    expect(isReadyToBookNight(entry({ terms: { agreementId: "x", status: "DRAFT", proposedDate: LATE_ON_THE_NIGHT } }), TZ)).toBe(true);
    expect(isReadyToBookNight(entry({ terms: { agreementId: "x", status: "DRAFT", proposedDate: AFTER_MIDNIGHT } }), TZ)).toBe(false);
    expect(isReadyToBookNight(entry({ terms: { agreementId: "x", status: "DRAFT", proposedDate: null } }), TZ)).toBe(false);
    expect(isReadyToBookNight(entry({ terms: null }), TZ)).toBe(false);
  });

  it("(b) the request-less seam: an outside booker's or the place's own hold is ready by its existence; holdOwnerKindOf reads ownerKind", () => {
    for (const ownerKind of ["booker", "place"] as const) {
      expect(isOwnerReadyToBook({ ownerKind, terms: null, night: DATE, placeTz: TZ })).toBe(true);
    }
    expect(holdOwnerKindOf({ ownerKind: "REQUEST" })).toBe("request");
    expect(holdOwnerKindOf({ ownerKind: "BOOKER" })).toBe("booker");
    expect(holdOwnerKindOf({ ownerKind: "PLACE" })).toBe("place");
  });

  it("(b) a request-less hold BEHIND the head is ready with no terms at all; one AHEAD is not counted", () => {
    const head = entry({ id: "aaaaaaaa-0000-4000-8000-0000000000b1", bookingRequestId: REQUEST_A, position: 1, terms: null });
    const { bookingRequestId: _r, ...base } = entry({ id: "aaaaaaaa-0000-4000-8000-0000000000b2", position: 2, terms: null });
    const placeHold = { ...base, ownerKind: "PLACE", holder: null } as BookingHoldLineEntry;
    const booker = {
      ...base,
      ownerKind: "BOOKER",
      grantId: "cccccccc-0000-4000-8000-000000000001",
      holder: { kind: "person", humanId: STAFF_ID },
    } as BookingHoldLineEntry;
    for (const behind of [placeHold, booker]) {
      expect(isReadyToBookNight(behind, TZ)).toBe(true);
      expect(findReadyBehind({ line: [head, behind], target: head, now: NOW, placeTz: TZ })?.id).toBe(behind.id);
      expect(findReadyBehind({ line: [{ ...behind, position: 1 } as BookingHoldLineEntry, { ...head, position: 2 }], target: { ...head, position: 2 }, now: NOW, placeTz: TZ })).toBeNull();
    }
  });

  it("findReadyBehind: only holds BEHIND the target, unlapsed, first in line order", () => {
    const head = entry({ id: "aaaaaaaa-0000-4000-8000-0000000000a1", bookingRequestId: REQUEST_A, position: 1, terms: null });
    const notReady = entry({ id: "aaaaaaaa-0000-4000-8000-0000000000a2", position: 2, terms: null });
    const ready3 = entry({ id: "aaaaaaaa-0000-4000-8000-0000000000a3", position: 3 });
    const ready4 = entry({ id: "aaaaaaaa-0000-4000-8000-0000000000a4", position: 4 });
    expect(findReadyBehind({ line: [head, notReady, ready3, ready4], target: head, now: NOW, placeTz: TZ })?.id).toBe(ready3.id);
    // A ready hold AHEAD of the target does not count.
    expect(findReadyBehind({ line: [head, notReady, ready3], target: ready3, now: NOW, placeTz: TZ })).toBeNull();
    // The target's own readiness does not count either.
    const readyHead = entry({ ...head, terms: ready3.terms });
    expect(findReadyBehind({ line: [readyHead, notReady], target: readyHead, now: NOW, placeTz: TZ })).toBeNull();
    // A lapsed row (a past night) is projected out, even when its terms match.
    const pastNight = "2026-06-01";
    const pastHead = entry({ ...head, date: pastNight });
    const pastReady = entry({
      ...ready3,
      date: pastNight,
      terms: { agreementId: "x", status: "DRAFT", proposedDate: new Date("2026-06-02T01:00:00.000Z") },
    });
    expect(findReadyBehind({ line: [pastHead, pastReady], target: pastHead, now: NOW, placeTz: TZ })).toBeNull();
  });
});

describe("challengeBookingHold — NO_ACT_READY (N20 / FR-015)", () => {
  it("nobody behind → NO_ACT_READY with the 1st hold and its line, nothing written", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);

    await expect(challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id })).rejects.toMatchObject({
      code: "NO_ACT_READY",
      meta: { holdId: a.id, calendarId: CALENDAR_ID, date: DATE },
    });
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("someone behind but not ready: no terms, closed terms, terms for another night → NO_ACT_READY", async () => {
    for (const setup of [
      (ctx: ReturnType<typeof buildHoldTestContext>) => void ctx,
      (ctx: ReturnType<typeof buildHoldTestContext>) => void ctx.seedTerms(REQUEST_B, { status: "CANCELLED" }),
      (ctx: ReturnType<typeof buildHoldTestContext>) => void ctx.seedTerms(REQUEST_B, { status: "DECLINED" }),
      (ctx: ReturnType<typeof buildHoldTestContext>) => void ctx.seedTerms(REQUEST_B, { night: "2026-06-27" }),
    ]) {
      const ctx = buildHoldTestContext();
      const a = ctx.seedHold(REQUEST_A);
      ctx.seedHold(REQUEST_B);
      setup(ctx);
      await expect(challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id })).rejects.toMatchObject({ code: "NO_ACT_READY" });
      expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    }
  });

  it("a ready act further back (3rd) counts; drafted is enough — the terms need not be sent", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_B); // not ready
    ctx.seedHold(REQUEST_C);
    ctx.seedTerms(REQUEST_C, { status: "DRAFT" });

    const result = await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });
    expect(result.hold.status).toBe("CHALLENGED");
  });

  it("LEAK: the challenged act's notice names nobody — no other request, hold or terms id", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    const bTerms = ctx.seedTerms(REQUEST_B);

    const result = await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id });
    const actNotice = result.notificationIntents.find((i) => i.audience === "act" && i.holdId === a.id)!;
    const serialized = JSON.stringify(actNotice);
    for (const foreign of [REQUEST_B, b.id, bTerms]) expect(serialized).not.toContain(foreign);
    expect(actNotice).toMatchObject({ kind: "hold.challenged", keepWill: "ask_for_terms" });
  });

  it("the ready hold released before the challenge reads the line → NO_ACT_READY (the challenge reads under the line lock)", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);
    // The venue releases the ready act's hold first (its own transaction).
    await releaseBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: b.id });

    await expect(challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: a.id })).rejects.toMatchObject({ code: "NO_ACT_READY" });
    // And the line lock is taken BEFORE the readiness read.
    const lockOrder = vi.mocked(ctx.bookingHolds.lockLine).mock.invocationCallOrder.at(-1)!;
    const readOrder = vi.mocked(ctx.bookingHolds.listLineWithTerms).mock.invocationCallOrder.at(-1)!;
    expect(lockOrder).toBeLessThan(readOrder);
  });
});

describe("lineHeads.challengeable is the SAME rule the challenge enforces", () => {
  // Every fixture pins BOTH what the strip says and what the server does —
  // so a rule broken in the shared function cannot hide behind agreement.
  type Expected = {
    outcome: "challenged" | "NO_ACT_READY" | "TERMS_AGREED_FOR_THIS_NIGHT";
    blocker: "no_act_ready" | "terms_agreed" | null;
  };
  const ready: Expected = { outcome: "challenged", blocker: null };
  const notReady: Expected = { outcome: "NO_ACT_READY", blocker: "no_act_ready" };
  const fixtures: Array<[string, (ctx: ReturnType<typeof buildHoldTestContext>) => void, Expected]> = [
    ["nobody behind", () => {}, notReady],
    ["behind, no terms", (ctx) => void ctx.seedHold(REQUEST_C), notReady],
    ["behind, draft terms for the night", (ctx) => { ctx.seedHold(REQUEST_C); ctx.seedTerms(REQUEST_C); }, ready],
    ["behind, sent terms for the night", (ctx) => { ctx.seedHold(REQUEST_C); ctx.seedTerms(REQUEST_C, { status: "PROPOSED" }); }, ready],
    ["behind, terms for another night", (ctx) => { ctx.seedHold(REQUEST_C); ctx.seedTerms(REQUEST_C, { night: "2026-06-27" }); }, notReady],
    ["behind, cancelled terms", (ctx) => { ctx.seedHold(REQUEST_C); ctx.seedTerms(REQUEST_C, { status: "CANCELLED" }); }, notReady],
    // Review nit: a ready hold whose request is already CLOSED is released by
    // the challenge's settlement — the strip projects it out the same way.
    [
      "behind, draft terms but the request is withdrawn",
      (ctx) => {
        ctx.seedHold(REQUEST_C);
        ctx.seedTerms(REQUEST_C);
        ctx.requests.set(REQUEST_C, { ...ctx.requests.get(REQUEST_C)!, status: "WITHDRAWN" });
      },
      notReady,
    ],
    // Review W3: the 1st hold's own terms for the night are agreed — book it.
    [
      "the 1st hold's own terms are agreed for the night (someone behind is ready)",
      (ctx) => {
        ctx.seedTerms(REQUEST_B, { status: "ACCEPTED" });
        ctx.seedHold(REQUEST_C);
        ctx.seedTerms(REQUEST_C);
      },
      { outcome: "TERMS_AGREED_FOR_THIS_NIGHT", blocker: "terms_agreed" },
    ],
  ];
  for (const [name, setup, expected] of fixtures) {
    it(name, async () => {
      const ctx = buildHoldTestContext();
      const head = ctx.seedHold(REQUEST_B);
      ctx.seedHold(REQUEST_A); // the thread being read
      setup(ctx);

      const staff = await listBookingHoldsForRequest(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, viewer: "staff" });
      if (staff.viewer !== "staff") throw new Error("unreachable");
      const shown = staff.lineHeads.find((h) => h.holdId === head.id)!;
      expect({ challengeable: shown.challengeable, blocker: shown.challengeBlocker }).toEqual({
        challengeable: expected.outcome === "challenged",
        blocker: expected.blocker,
      });

      const outcome = await challengeBookingHold(ctx.deps, { actorHumanId: STAFF_ID, holdId: head.id }).then(
        () => "challenged",
        (error: { code?: string }) => error.code,
      );
      expect(outcome).toBe(expected.outcome);
    });
  }
});
