import { describe, expect, it, vi } from "vitest";

import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";

import {
  ADMIN_MEMBER,
  BANNED_ORG_PAGE,
  BANNED_PAGE,
  BOOKER_EDITOR,
  BOOKER_ORG,
  BOOKER_VIEWER,
  CALENDAR_ID,
  DATE,
  DELEGATE_ID,
  EDITOR_MEMBER,
  NOW,
  OTHER_CALENDAR_ID,
  OTHER_ORG,
  OTHER_ORG_PAGE,
  PERSON_ID,
  PERSON_PAGE,
  PLACE_ID,
  PLACE_PAGE,
  PRIVATE_PAGE,
  REQUEST_A,
  STRANGER_ID,
  UNLISTED_PAGE,
  buildGrantTestContext,
} from "../../place-booking-grants/__tests__/grant-test-context";
import { FOREIGN_CALENDAR_ID } from "./hold-test-context";
import { answerBookingHoldChallenge } from "../answer-booking-hold-challenge";
import {
  challengeBookingHold,
  DEFAULT_CHALLENGE_WINDOW_MS,
  MAX_CHALLENGE_WINDOW_MS,
  toChallengeBookingHoldWire,
} from "../challenge-booking-hold";
import { extendBookingHoldChallenge } from "../extend-booking-hold-challenge";
import { passNamedHold } from "../pass-named-hold";
import {
  NAMED_PARTY_NOTICES_PER_DAY,
  PARTY_NAMED_AUDIT_ACTION,
  placeRequestlessHolds,
} from "../place-requestless-holds";
import { releaseBookingHold, toReleaseBookingHoldWire } from "../release-booking-hold";
import { reorderBookingHold } from "../reorder-booking-hold";

// ─────────────────────────────────────────────────────────────────────────────
// holds-without-a-request, plan step 6 (FR-004 lazy half, FR-005, FR-006,
// FR-007): placing, passing, releasing, reordering, challenging and
// answering request-less holds, on the grant harness (booker org with an
// EDITOR and a VIEWER, a person grantee with an edit-role delegate, public
// pages, an audit fake that reads back, a tx that rolls back on a throw).
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = ReturnType<typeof buildGrantTestContext>;

const DAY = 24 * 60 * 60 * 1000;
const LATER = "2026-06-27";
const PAST = "2026-06-01";
const BOOKER = { kind: "org" as const, orgId: BOOKER_ORG };
const PERSON = { kind: "person" as const, humanId: PERSON_ID };
const GIVER = ADMIN_MEMBER;

const orgGrant = (ctx: Ctx, over: Record<string, unknown> = {}) =>
  ctx.placeBookingGrants.seed({
    placeId: PLACE_ID,
    grantee: BOOKER,
    grantedByHumanId: GIVER,
    ...over,
  });

const bookerHold = (ctx: Ctx, grantId: string, over: Record<string, unknown> = {}) =>
  ctx.bookingHolds.seed({
    ownerKind: "BOOKER",
    grantId,
    holder: BOOKER,
    calendarId: CALENDAR_ID,
    date: DATE,
    placedByHumanId: BOOKER_EDITOR,
    ...over,
  } as never);

const placeHold = (ctx: Ctx, over: Record<string, unknown> = {}) =>
  ctx.bookingHolds.seed({
    ownerKind: "PLACE",
    holder: null,
    calendarId: CALENDAR_ID,
    date: DATE,
    placedByHumanId: EDITOR_MEMBER,
    ...over,
  } as never);

const placeBooker = (ctx: Ctx, over: Record<string, unknown> = {}) =>
  placeRequestlessHolds(ctx.deps, {
    kind: "BOOKER",
    actorHumanId: BOOKER_EDITOR,
    calendarId: CALENDAR_ID,
    dates: [DATE],
    ...over,
  });

const placeOwn = (ctx: Ctx, over: Record<string, unknown> = {}) =>
  placeRequestlessHolds(ctx.deps, {
    kind: "PLACE",
    actorHumanId: EDITOR_MEMBER,
    calendarId: CALENDAR_ID,
    dates: [DATE],
    ...over,
  });

const row = (ctx: Ctx, id: string) => ctx.bookingHolds.rows.get(id) as BookingHoldRecord;
const liveRows = (ctx: Ctx) =>
  [...ctx.bookingHolds.rows.values()].filter((h) => h.status === "ACTIVE" || h.status === "CHALLENGED");

// ─────────────────────────────────────────────────────────────────────────────
// placeRequestlessHolds — BOOKER
// ─────────────────────────────────────────────────────────────────────────────

describe("placeRequestlessHolds — BOOKER", () => {
  it("an org grantee's editor holds an empty line at 1st: BOOKER hold for the org on the grant, audit row, staff told in-app", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);

    const out = await placeBooker(ctx);

    expect(out.failed).toEqual([]);
    expect(out.placed).toHaveLength(1);
    const hold = row(ctx, out.placed[0]!.id);
    expect(hold).toMatchObject({
      ownerKind: "BOOKER",
      grantId: grant.id,
      holder: BOOKER,
      position: 1,
      status: "ACTIVE",
      placedByHumanId: BOOKER_EDITOR,
      note: null,
    });
    expect(ctx.actions("booking_hold.placed")).toEqual([
      expect.objectContaining({
        entityId: hold.id,
        data: expect.objectContaining({ ownerKind: "BOOKER", grantId: grant.id, holder: BOOKER, position: 1 }),
      }),
    ]);
    // FR-013: staff in-app; routed to the grant's giver, never the booker.
    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({
        kind: "requestless_hold.placed",
        audience: "staff",
        holdId: hold.id,
        placeId: PLACE_ID,
        date: DATE,
        position: 1,
        staffHumanId: GIVER,
      }),
    ]);
    expect(out.staffRecipientHint.placedByHumanId).toBe(GIVER);
    // No thread (H20).
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("locks the grant row FOR SHARE before the line lock, in every date's transaction (trap m)", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);

    await placeBooker(ctx, { dates: [DATE, LATER] });

    const shares = vi.mocked(ctx.placeBookingGrants.lockSharedAtPlace).mock.invocationCallOrder;
    const lines = vi.mocked(ctx.bookingHolds.lockLine).mock.invocationCallOrder;
    expect(shares).toHaveLength(2);
    // Per date: the grant row, then that date's line.
    expect(shares[0]!).toBeLessThan(lines[0]!);
    expect(lines[0]!).toBeLessThan(shares[1]!);
    expect(shares[1]!).toBeLessThan(lines[lines.length - 1]!);
  });

  it("a batch: dates deduped and sorted, a past date refused per date, one staff digest for the holds placed", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);

    const out = await placeBooker(ctx, { dates: [LATER, PAST, DATE, LATER] });

    expect(out.placed.map((h) => h.date)).toEqual([DATE, LATER]);
    expect(out.failed).toEqual([{ date: PAST, code: "hold_date_in_past" }]);
    expect(out.requestlessIntents).toHaveLength(1);
    expect(out.requestlessIntents[0]).toMatchObject({
      kind: "requestless_hold.placed",
      dates: [
        { date: DATE, position: 1 },
        { date: LATER, position: 1 },
      ],
      holdIds: out.placed.map((h) => h.id),
    });
  });

  it.each([
    ["no grant at all", () => undefined],
    ["a pending grant", (ctx: Ctx) => orgGrant(ctx, { acceptedAt: null })],
    ["an expired grant", (ctx: Ctx) => orgGrant(ctx, { expiresAt: new Date(NOW.getTime() - 1) })],
    ["a revoked grant", (ctx: Ctx) => orgGrant(ctx, { revokedAt: new Date(NOW.getTime() - DAY) })],
    ["a grant on another calendar", (ctx: Ctx) => orgGrant(ctx, { calendarId: OTHER_CALENDAR_ID })],
  ])("refuses a booker with %s (NOT_RESOURCE_OWNER); nothing written", async (_label, seed) => {
    const ctx = buildGrantTestContext();
    seed(ctx);

    await expect(placeBooker(ctx)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.bookingHolds.rows.size).toBe(0);
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("refuses an org member below edit role, and a stranger", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    for (const actorHumanId of [BOOKER_VIEWER, STRANGER_ID]) {
      await expect(placeBooker(ctx, { actorHumanId })).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
    }
    expect(ctx.bookingHolds.rows.size).toBe(0);
  });

  it("a person grant is used by the person and by their edit-role delegate; the holder is the person", async () => {
    const ctx = buildGrantTestContext();
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, grantee: PERSON });

    const own = await placeBooker(ctx, { actorHumanId: PERSON_ID });
    const delegated = await placeBooker(ctx, { actorHumanId: DELEGATE_ID, dates: [LATER] });

    expect(row(ctx, own.placed[0]!.id)).toMatchObject({ holder: PERSON, placedByHumanId: PERSON_ID });
    expect(row(ctx, delegated.placed[0]!.id)).toMatchObject({ holder: PERSON, placedByHumanId: DELEGATE_ID });
  });

  it("an actor covered for two parties must say which (`as`, item i); with `as` the holder is that party", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, grantee: { kind: "person", humanId: BOOKER_EDITOR } });

    await expect(placeBooker(ctx)).rejects.toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ path: ["as"], message: "booker_party_required" })],
    });
    expect(ctx.bookingHolds.rows.size).toBe(0);

    const out = await placeBooker(ctx, { as: { kind: "person", humanId: BOOKER_EDITOR } });
    expect(row(ctx, out.placed[0]!.id)).toMatchObject({
      holder: { kind: "person", humanId: BOOKER_EDITOR },
    });
    // An `as` the actor cannot act for matches nothing.
    await expect(placeBooker(ctx, { as: { kind: "org", orgId: OTHER_ORG } })).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("the holder already live in the line → BOOKING_HOLD_HOLDER_EXISTS for that date; the other dates stand", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    await placeBooker(ctx);

    const out = await placeBooker(ctx, { dates: [DATE, LATER] });

    expect(out.failed).toEqual([{ date: DATE, code: "BOOKING_HOLD_HOLDER_EXISTS" }]);
    expect(out.placed.map((h) => h.date)).toEqual([LATER]);
  });

  it("joins the back of the line at max + 1, never the count: a gap left by a cascade is not reused (item f)", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    ctx.seedHold(REQUEST_A, { position: 1 });
    placeHold(ctx, { position: 3 });

    const out = await placeBooker(ctx);

    expect(out.placed[0]).toMatchObject({ position: 4 });
    expect(new Set(liveRows(ctx).map((h) => h.position)).size).toBe(3);
  });

  it("a line with a CONFIRMED winner is refused per date", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    ctx.seedHold(REQUEST_A, { status: "CONFIRMED", confirmedAt: NOW });

    const out = await placeBooker(ctx);

    expect(out.placed).toEqual([]);
    expect(out.failed).toEqual([{ date: DATE, code: "HOLD_LINE_ALREADY_CONFIRMED" }]);
  });

  it("the grant revoked between the gate and a date's transaction: that date reads the locked row and gets no hold", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    ctx.commitBeforeNextTx(() => {
      ctx.placeBookingGrants.rows.set(grant.id, { ...grant, revokedAt: NOW });
    });

    const out = await placeBooker(ctx);

    expect(out.placed).toEqual([]);
    expect(out.failed).toEqual([{ date: DATE, code: "PLACE_BOOKING_GRANT_ENDED" }]);
    expect(ctx.bookingHolds.rows.size).toBe(0);
    expect(out.requestlessIntents).toEqual([]);
  });

  it("an unknown failure after a commit is swallowed into unknown_error and reported; a throwing reporter changes nothing", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    const create = ctx.bookingHolds.createRequestless;
    let calls = 0;
    const original = vi.mocked(create).getMockImplementation()!;
    vi.mocked(create).mockImplementation(async (input) => {
      calls += 1;
      if (calls === 2) throw new Error("db fell over");
      return original(input);
    });
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });

    const out = await placeRequestlessHolds(
      { ...ctx.deps, reportError },
      { kind: "BOOKER", actorHumanId: BOOKER_EDITOR, calendarId: CALENDAR_ID, dates: [DATE, LATER] },
    );

    expect(out.placed.map((h) => h.date)).toEqual([DATE]);
    expect(out.failed).toEqual([{ date: LATER, code: "unknown_error" }]);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "placeRequestlessHolds", step: "place_date" } }),
    );
    // The committed hold's notice survives.
    expect(out.requestlessIntents).toHaveLength(1);
  });

  it("an unknown failure with nothing committed throws (the backstops capture it), unreported", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    vi.mocked(ctx.bookingHolds.createRequestless).mockRejectedValueOnce(new Error("db fell over"));
    const reportError = vi.fn();

    await expect(
      placeRequestlessHolds({ ...ctx.deps, reportError }, {
        kind: "BOOKER",
        actorHumanId: BOOKER_EDITOR,
        calendarId: CALENDAR_ID,
        dates: [DATE],
      }),
    ).rejects.toThrow("db fell over");
    expect(reportError).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// placeRequestlessHolds — PLACE
// ─────────────────────────────────────────────────────────────────────────────

describe("placeRequestlessHolds — PLACE", () => {
  it("staff hold for the place, unassigned, with a sanitized note stamped by the placer; nobody is told", async () => {
    const ctx = buildGrantTestContext();

    const out = await placeOwn(ctx, { note: "  Load-in 6pm <b>sharp</b>\u0007 " });

    const hold = row(ctx, out.placed[0]!.id);
    expect(hold).toMatchObject({
      ownerKind: "PLACE",
      holder: null,
      position: 1,
      noteUpdatedByHumanId: EDITOR_MEMBER,
      noteUpdatedAt: NOW,
    });
    expect(hold.note).not.toMatch(/<b>|\u0007/);
    expect(hold.note).toContain("Load-in 6pm");
    expect(out.requestlessIntents).toEqual([]);
    // The audit row says a note exists, never its text (H21).
    const audit = ctx.actions("booking_hold.placed")[0]!;
    expect(audit.data).toMatchObject({ ownerKind: "PLACE", holder: null, hasNote: true });
    expect(JSON.stringify(audit.data)).not.toContain("Load-in");
  });

  it("a note over 2000 characters is refused before anything is written", async () => {
    const ctx = buildGrantTestContext();
    await expect(placeOwn(ctx, { note: "x".repeat(2001) })).rejects.toMatchObject({ code: "invalid_input" });
    expect(ctx.bookingHolds.rows.size).toBe(0);
  });

  it("names a party by public page: the hold names the person, one named_party digest, one cap row for the call", async () => {
    const ctx = buildGrantTestContext();

    const out = await placeOwn(ctx, { namedPartyPageId: PERSON_PAGE, dates: [DATE, LATER] });

    expect(out.placed).toHaveLength(2);
    for (const placed of out.placed) {
      expect(row(ctx, placed.id)).toMatchObject({ ownerKind: "PLACE", holder: PERSON });
    }
    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({
        kind: "requestless_hold.named",
        audience: "named_party",
        party: PERSON,
        holdIds: out.placed.map((h) => h.id),
        staffHumanId: EDITOR_MEMBER,
      }),
    ]);
    expect(ctx.actions(PARTY_NAMED_AUDIT_ACTION)).toEqual([
      expect.objectContaining({ entity: "place", entityId: PLACE_ID }),
    ]);
  });

  it("an org named by its page; a private page and a place's page are refused", async () => {
    const ctx = buildGrantTestContext();

    const org = await placeOwn(ctx, { namedPartyPageId: OTHER_ORG_PAGE });
    expect(row(ctx, org.placed[0]!.id)).toMatchObject({ holder: { kind: "org", orgId: OTHER_ORG } });

    await expect(placeOwn(ctx, { namedPartyPageId: PRIVATE_PAGE, dates: [LATER] })).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
    await expect(placeOwn(ctx, { namedPartyPageId: PLACE_PAGE, dates: [LATER] })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("is staff-only: a booker with an active grant, and a stranger, are refused", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    for (const actorHumanId of [BOOKER_EDITOR, STRANGER_ID]) {
      await expect(placeOwn(ctx, { actorHumanId })).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    }
    expect(ctx.bookingHolds.rows.size).toBe(0);
  });

  it("the named-party notice cap: the 51st naming call in 24h is refused RATE_LIMITED with nothing written; older ones and unnamed holds do not count", async () => {
    const ctx = buildGrantTestContext();
    for (let i = 0; i < NAMED_PARTY_NOTICES_PER_DAY - 1; i += 1) {
      ctx.auditRows.push({
        id: `cap-${i}`,
        entity: "place",
        entityId: PLACE_ID,
        action: PARTY_NAMED_AUDIT_ACTION,
        data: {},
        at: new Date(NOW.getTime() - 60_000),
      });
    }
    ctx.auditRows.push({
      id: "cap-old",
      entity: "place",
      entityId: PLACE_ID,
      action: PARTY_NAMED_AUDIT_ACTION,
      data: {},
      at: new Date(NOW.getTime() - DAY - 1),
    });

    // The 50th fits.
    const fiftieth = await placeOwn(ctx, { namedPartyPageId: PERSON_PAGE });
    expect(fiftieth.placed).toHaveLength(1);
    // An unassigned hold is no notice.
    expect((await placeOwn(ctx, { dates: [LATER] })).placed).toHaveLength(1);

    const before = ctx.bookingHolds.rows.size;
    await expect(placeOwn(ctx, { namedPartyPageId: OTHER_ORG_PAGE, dates: [LATER] })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      meta: { scope: "booking_hold_named_party_notices_daily", limit: NAMED_PARTY_NOTICES_PER_DAY },
    });
    expect(ctx.bookingHolds.rows.size).toBe(before);
    expect(ctx.placeBookingGrants.lockPlace).toHaveBeenCalledWith(PLACE_ID);
  });

  it("a party already holding the line (here as a booker) cannot also be named on it", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    bookerHold(ctx, grant.id);
    ctx.entityPages.getById.mockResolvedValueOnce({
      id: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0",
      ownerType: "ORGANIZATION",
      ownerId: BOOKER_ORG,
      visibility: "PUBLIC",
    } as never);

    const out = await placeOwn(ctx, { namedPartyPageId: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0" });

    expect(out.failed).toEqual([{ date: DATE, code: "BOOKING_HOLD_HOLDER_EXISTS" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// passNamedHold
// ─────────────────────────────────────────────────────────────────────────────

describe("passNamedHold", () => {
  it("the named person passes: name off, same position and status, still the place's; audit row; staff told", async () => {
    const ctx = buildGrantTestContext();
    ctx.seedHold(REQUEST_A, { position: 1 });
    const hold = placeHold(ctx, { holder: PERSON, position: 2 });

    const out = await passNamedHold(ctx.deps, { actorHumanId: PERSON_ID, holdId: hold.id });

    expect(out.alreadyPassed).toBe(false);
    expect(row(ctx, hold.id)).toMatchObject({ ownerKind: "PLACE", holder: null, position: 2, status: "ACTIVE" });
    expect(out.hold).toMatchObject({ id: hold.id, position: 2 });
    expect(ctx.actions("booking_hold.passed")).toEqual([
      expect.objectContaining({ entityId: hold.id, data: expect.objectContaining({ holder: PERSON }) }),
    ]);
    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({
        kind: "requestless_hold.passed",
        audience: "staff",
        holdId: hold.id,
        staffHumanId: EDITOR_MEMBER,
      }),
    ]);
  });

  it("a delegate of the named person, and an edit-role member of a named org, may pass; an org VIEWER may not", async () => {
    const ctx = buildGrantTestContext();
    const forPerson = placeHold(ctx, { holder: PERSON });
    const forOrg = placeHold(ctx, { holder: BOOKER, date: LATER });

    await expect(passNamedHold(ctx.deps, { actorHumanId: BOOKER_VIEWER, holdId: forOrg.id })).rejects.toMatchObject({
      code: "BOOKING_HOLD_NOT_FOUND",
    });
    await passNamedHold(ctx.deps, { actorHumanId: DELEGATE_ID, holdId: forPerson.id });
    await passNamedHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: forOrg.id });

    expect(row(ctx, forPerson.id)).toMatchObject({ holder: null });
    expect(row(ctx, forOrg.id)).toMatchObject({ holder: null });
  });

  it("anyone else, an unassigned hold, a booker hold or a missing id all read BOOKING_HOLD_NOT_FOUND; nothing written", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const named = placeHold(ctx, { holder: PERSON });
    const unassigned = placeHold(ctx, { date: LATER });
    const booker = bookerHold(ctx, grant.id);

    const attempts: Array<[string, string]> = [
      [STRANGER_ID, named.id],
      [EDITOR_MEMBER, named.id],
      [PERSON_ID, unassigned.id],
      [BOOKER_EDITOR, booker.id],
      [PERSON_ID, "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f"],
    ];
    for (const [actorHumanId, holdId] of attempts) {
      await expect(passNamedHold(ctx.deps, { actorHumanId, holdId })).rejects.toMatchObject({
        code: "BOOKING_HOLD_NOT_FOUND",
      });
    }
    expect(row(ctx, named.id)).toMatchObject({ holder: PERSON });
    expect(ctx.actions("booking_hold.passed")).toEqual([]);
  });

  it("losing the CAS to a concurrent pass is idempotent: alreadyPassed, nobody told twice", async () => {
    const ctx = buildGrantTestContext();
    const hold = placeHold(ctx, { holder: PERSON });
    ctx.commitBeforeNextTx(() => {
      ctx.bookingHolds.rows.set(hold.id, { ...row(ctx, hold.id), holder: null } as BookingHoldRecord);
    });

    const out = await passNamedHold(ctx.deps, { actorHumanId: PERSON_ID, holdId: hold.id });

    expect(out.alreadyPassed).toBe(true);
    expect(out.requestlessIntents).toEqual([]);
    expect(ctx.actions("booking_hold.passed")).toEqual([]);
  });

  it("a hold kept on a revoke (placed by the booker) routes the staff notice to the place's members, not the former booker", async () => {
    const ctx = buildGrantTestContext();
    const hold = placeHold(ctx, { holder: BOOKER, placedByHumanId: BOOKER_EDITOR });

    const out = await passNamedHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: hold.id });

    expect(out.requestlessIntents[0]).toMatchObject({ audience: "staff", staffHumanId: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// releaseBookingHold
// ─────────────────────────────────────────────────────────────────────────────

describe("releaseBookingHold — request-less holds", () => {
  it("a booker releases its own hold: the line moves up, the act behind is told, staff are told in-app", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, { position: 1 });
    const act = ctx.seedHold(REQUEST_A, { position: 2 });

    const out = await releaseBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: mine.id });

    expect(row(ctx, mine.id)).toMatchObject({ status: "RELEASED", releasedReason: "MANUAL" });
    expect(row(ctx, act.id)).toMatchObject({ position: 1 });
    expect(out.notificationIntents).toContainEqual(
      expect.objectContaining({ kind: "hold.position_changed", holdId: act.id, position: 1 }),
    );
    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({ kind: "requestless_hold.released", audience: "staff", by: "booker", staffHumanId: GIVER }),
    ]);
    expect(ctx.actions("booking_hold.released")).toContainEqual(
      expect.objectContaining({ entityId: mine.id, data: expect.objectContaining({ by: "booker" }) }),
    );
  });

  it("a booker cannot release another booker's hold (holder identity is 'own')", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    const other = ctx.placeBookingGrants.seed({ placeId: PLACE_ID, grantee: { kind: "org", orgId: OTHER_ORG } });
    const theirs = bookerHold(ctx, other.id, { holder: { kind: "org", orgId: OTHER_ORG } });

    await expect(releaseBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: theirs.id })).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(row(ctx, theirs.id).status).toBe("ACTIVE");
  });

  it("staff release a booker's hold: the booker is told (email + in-app)", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const theirs = bookerHold(ctx, grant.id);

    const out = await releaseBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: theirs.id });

    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({ audience: "booker", party: BOOKER, by: "staff", staffHumanId: null }),
    ]);
  });

  it("staff release a place hold: nobody is told", async () => {
    const ctx = buildGrantTestContext();
    const own = placeHold(ctx, { holder: PERSON });
    const out = await releaseBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: own.id });
    expect(out.requestlessIntents).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reorder + extend stay staff-only and work across the kinds
// ─────────────────────────────────────────────────────────────────────────────

describe("reorder / extend — staff only, every kind", () => {
  it("staff reorder a line of all three kinds; a booker is refused", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    const booker = bookerHold(ctx, grant.id, { position: 2 });
    const own = placeHold(ctx, { position: 3 });

    await expect(
      reorderBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: booker.id, toPosition: 1 }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    await reorderBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: own.id, toPosition: 1 });
    expect([row(ctx, own.id), row(ctx, act.id), row(ctx, booker.id)].map((h) => h.position)).toEqual([1, 2, 3]);
  });

  it("staff extend a challenge on a booker hold; the booker is refused", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const respondBy = new Date(NOW.getTime() + DAY);
    const booker = bookerHold(ctx, grant.id, { status: "CHALLENGED", challengedAt: NOW, respondBy });
    const later = new Date(respondBy.getTime() + DAY);

    await expect(
      extendBookingHoldChallenge(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: booker.id, respondBy: later }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await extendBookingHoldChallenge(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: booker.id, respondBy: later });
    expect(row(ctx, booker.id).respondBy).toEqual(later);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// challengeBookingHold — widened gate, every kind (FR-006)
// ─────────────────────────────────────────────────────────────────────────────

describe("challengeBookingHold — bookers and request-less holds", () => {
  it("a booker challenges an act's hold at 1st with its own hold behind (ready by existing); the act is told as today", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    const out = await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id });

    expect(row(ctx, act.id)).toMatchObject({ status: "CHALLENGED" });
    expect(out.notificationIntents).toContainEqual(
      expect.objectContaining({ kind: "hold.challenged", audience: "act", holdId: act.id }),
    );
    expect(out.requestlessIntents).toEqual([]);
    expect(ctx.actions("booking_hold.challenged")[0]!.data).toMatchObject({
      challenger: { kind: "booker", grantId: grant.id, holder: BOOKER },
    });
  });

  it("staff challenge a booker's hold at 1st with a place hold behind: booker (owner) and staff told", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const booker = bookerHold(ctx, grant.id, { position: 1 });
    placeHold(ctx, { position: 2 });

    const out = await challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: booker.id });

    expect(row(ctx, booker.id)).toMatchObject({ status: "CHALLENGED" });
    expect(out.notificationIntents.filter((i) => i.holdId === booker.id)).toEqual([]);
    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({ kind: "requestless_hold.challenged", audience: "staff", staffHumanId: EDITOR_MEMBER }),
      expect.objectContaining({ kind: "requestless_hold.challenged", audience: "booker", party: BOOKER }),
    ]);
    expect(ctx.actions("booking_hold.challenged")[0]!.data).toMatchObject({
      ownerKind: "BOOKER",
      bookingRequestId: null,
      challenger: { kind: "staff" },
    });
  });

  it("a named place hold challenged by a booker behind it: staff and the named party told", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const own = placeHold(ctx, { holder: PERSON, position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    const out = await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: own.id });

    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({ audience: "staff", staffHumanId: GIVER }),
      expect.objectContaining({ audience: "named_party", party: PERSON }),
    ]);
  });

  it("N20 still gates: nobody ready behind → NO_ACT_READY; the hold is untouched", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const booker = bookerHold(ctx, grant.id, { position: 1 });
    ctx.seedHold(REQUEST_A, { position: 2 }); // no terms: not ready

    await expect(challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: booker.id })).rejects.toMatchObject({
      code: "NO_ACT_READY",
    });
    expect(row(ctx, booker.id).status).toBe("ACTIVE");
  });

  it("one open challenge per line holds for request-less holds too", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const booker = bookerHold(ctx, grant.id, {
      position: 1,
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY),
    });
    placeHold(ctx, { position: 2 });

    await expect(challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: booker.id })).rejects.toMatchObject({
      code: "BOOKING_HOLD_CHALLENGE_OPEN",
    });
  });

  it("refused: a stranger, an org VIEWER, and a booker whose grant is on another calendar (the staff gate's code)", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx, { calendarId: OTHER_CALENDAR_ID });
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    placeHold(ctx, { position: 2 });

    for (const actorHumanId of [STRANGER_ID, BOOKER_VIEWER, BOOKER_EDITOR]) {
      await expect(challengeBookingHold(ctx.deps, { actorHumanId, holdId: act.id })).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
    }
    expect(row(ctx, act.id).status).toBe("ACTIVE");
  });

  it("'also send terms' on a request-less hold → BOOKING_HOLD_NEEDS_REQUEST, nothing written", async () => {
    const ctx = buildGrantTestContext();
    const own = placeHold(ctx, { position: 1 });
    ctx.seedHold(REQUEST_A, { position: 2 });
    ctx.seedTerms(REQUEST_A);

    await expect(
      challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: own.id, sendTermsToFirstHold: true }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_NEEDS_REQUEST" });
    expect(row(ctx, own.id).status).toBe("ACTIVE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// answerBookingHoldChallenge — the owner of a request-less hold
// ─────────────────────────────────────────────────────────────────────────────

describe("answerBookingHoldChallenge — request-less holds", () => {
  const challengedBooker = (ctx: Ctx, grantId: string) =>
    bookerHold(ctx, grantId, {
      position: 1,
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY),
    });

  it("keep is refused CHALLENGE_ANSWER_NEEDS_BOOK_OR_RELEASE (after the owner gate); nothing written", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const hold = challengedBooker(ctx, grant.id);

    await expect(
      answerBookingHoldChallenge(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: hold.id, answer: "keep" }),
    ).rejects.toMatchObject({
      code: "CHALLENGE_ANSWER_NEEDS_BOOK_OR_RELEASE",
      meta: { holdId: hold.id, answers: ["book", "release"] },
    });
    expect(row(ctx, hold.id).status).toBe("CHALLENGED");
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("the booker answers release: RELEASED MANUAL, the place hold behind moves up, staff told", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const hold = challengedBooker(ctx, grant.id);
    const behind = placeHold(ctx, { position: 2 });

    const out = await answerBookingHoldChallenge(ctx.deps, {
      actorHumanId: BOOKER_EDITOR,
      holdId: hold.id,
      answer: "release",
    });

    expect(row(ctx, hold.id)).toMatchObject({ status: "RELEASED", releasedReason: "MANUAL" });
    expect(row(ctx, behind.id).position).toBe(1);
    expect(out.keepOutcome).toBeNull();
    expect(out.requestlessIntents).toEqual([
      expect.objectContaining({ kind: "requestless_hold.answered", audience: "staff", by: "booker", staffHumanId: GIVER }),
    ]);
  });

  it("a place hold's challenge is answered by staff: release works, keep is refused", async () => {
    const ctx = buildGrantTestContext();
    const own = placeHold(ctx, {
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY),
    });

    await expect(
      answerBookingHoldChallenge(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: own.id, answer: "keep" }),
    ).rejects.toMatchObject({ code: "CHALLENGE_ANSWER_NEEDS_BOOK_OR_RELEASE" });
    await answerBookingHoldChallenge(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: own.id, answer: "release" });
    expect(row(ctx, own.id).status).toBe("RELEASED");
  });

  it("not the owner (another booker, an act, staff on a booker's hold, the named party) reads BOOKING_HOLD_NOT_FOUND", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, grantee: { kind: "org", orgId: OTHER_ORG } });
    const hold = challengedBooker(ctx, grant.id);
    const named = placeHold(ctx, {
      holder: PERSON,
      date: LATER,
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY),
    });

    for (const [actorHumanId, holdId] of [
      [STRANGER_ID, hold.id],
      [EDITOR_MEMBER, hold.id],
      [PERSON_ID, named.id],
    ] as const) {
      const err = await answerBookingHoldChallenge(ctx.deps, { actorHumanId, holdId, answer: "release" }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "BOOKING_HOLD_NOT_FOUND" });
      expect(err).not.toHaveProperty("meta.ownerKind");
    }
    expect(row(ctx, hold.id).status).toBe("CHALLENGED");
    expect(row(ctx, named.id).status).toBe("CHALLENGED");
  });

  it("an unchallenged hold → BOOKING_HOLD_NOT_CHALLENGED; a lapsed one → BOOKING_HOLD_CHALLENGE_LAPSED", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const active = bookerHold(ctx, grant.id);
    const lapsed = bookerHold(ctx, grant.id, {
      date: LATER,
      status: "CHALLENGED",
      challengedAt: new Date(NOW.getTime() - 2 * DAY),
      respondBy: new Date(NOW.getTime() - DAY),
    });

    await expect(
      answerBookingHoldChallenge(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: active.id, answer: "release" }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_CHALLENGED" });
    await expect(
      answerBookingHoldChallenge(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: lapsed.id, answer: "release" }),
    ).rejects.toMatchObject({ code: "BOOKING_HOLD_CHALLENGE_LAPSED" });
    // The refusal rolls its transaction back, settle included (as on the
    // request path); the lapse is a pure predicate, so the line's next
    // mutation settles it.
    expect(row(ctx, lapsed.id).status).toBe("CHALLENGED");
    await placeOwn(ctx, { dates: [LATER] });
    expect(row(ctx, lapsed.id)).toMatchObject({ status: "RELEASED", releasedReason: "EXPIRED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-004 lazy half: GRANT_ENDED
// ─────────────────────────────────────────────────────────────────────────────

describe("GRANT_ENDED lazy lapse", () => {
  it("a booker hold on an expired grant lapses on the next mutation of its line: released GRANT_ENDED, the act behind moves up and is told", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx, { expiresAt: new Date(NOW.getTime() + DAY) });
    const booker = bookerHold(ctx, grant.id, { position: 1 });
    const act = ctx.seedHold(REQUEST_A, { position: 2 });
    // The grant runs out.
    ctx.placeBookingGrants.rows.set(grant.id, { ...grant, expiresAt: new Date(NOW.getTime() - 1) });

    const out = await placeOwn(ctx);

    expect(row(ctx, booker.id)).toMatchObject({ status: "RELEASED", releasedReason: "GRANT_ENDED" });
    expect(row(ctx, act.id).position).toBe(1);
    expect(out.placed[0]).toMatchObject({ position: 2 });
    expect(out.notificationIntents).toContainEqual(
      expect.objectContaining({ kind: "hold.position_changed", holdId: act.id, position: 1 }),
    );
    expect(ctx.actions("booking_hold.released")).toContainEqual(
      expect.objectContaining({ entityId: booker.id, data: expect.objectContaining({ reason: "GRANT_ENDED" }) }),
    );
  });

  it("a revoked grant's hold reads lapsed on the staff projection before anyone settles it", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const booker = bookerHold(ctx, grant.id, { position: 1 });
    const act = ctx.seedHold(REQUEST_A, { position: 2 });
    ctx.placeBookingGrants.rows.set(grant.id, { ...grant, revokedAt: NOW });

    // Any line read settles it; reorder the act (now alone) to see the fresh line.
    const out = await reorderBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: act.id, toPosition: 1 });

    expect(out.line.map((h) => h.id)).toEqual([act.id]);
    expect(row(ctx, booker.id)).toMatchObject({ status: "RELEASED", releasedReason: "GRANT_ENDED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1 (step 6): TOCTOU on "own", the booker's deadline, what a
// booker's reply shows, public pages only, the grant row under the lock.
// ─────────────────────────────────────────────────────────────────────────────

/** A revoke that keeps the hold as the place's, as `revoke.ts` commits it. */
const keepOnRevoke = (ctx: Ctx, grant: { id: string }, holdId: string) => () => {
  const current = ctx.placeBookingGrants.rows.get(grant.id)!;
  ctx.placeBookingGrants.rows.set(grant.id, { ...current, revokedAt: NOW });
  const {
    grantId: _grantId,
    grantRevokedAt: _revokedAt,
    grantExpiresAt: _expiresAt,
    ...rest
  } = ctx.bookingHolds.rows.get(holdId) as BookingHoldRecord & {
    grantId: string;
    grantRevokedAt: Date | null;
    grantExpiresAt: Date | null;
  };
  ctx.bookingHolds.rows.set(holdId, { ...rest, ownerKind: "PLACE" } as BookingHoldRecord);
};

describe("a booker's own hold, re-read under the line lock (review B1)", () => {
  it("release: a revoke kept the hold as the place's after the gate → NOT_RESOURCE_OWNER, nothing released, nobody told", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, { position: 1 });
    const act = ctx.seedHold(REQUEST_A, { position: 2 });
    ctx.commitBeforeNextTx(keepOnRevoke(ctx, grant, mine.id));

    await expect(
      releaseBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: mine.id }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(row(ctx, mine.id)).toMatchObject({ ownerKind: "PLACE", status: "ACTIVE", position: 1 });
    expect(row(ctx, act.id).position).toBe(2);
    expect(ctx.actions("booking_hold.released")).toEqual([]);
  });

  it("release: a hold kept and then released by staff is not the former booker's to read back", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, { position: 1 });
    ctx.commitBeforeNextTx(() => {
      keepOnRevoke(ctx, grant, mine.id)();
      ctx.bookingHolds.rows.set(mine.id, {
        ...row(ctx, mine.id),
        status: "RELEASED",
        releasedReason: "MANUAL",
        releasedAt: NOW,
      } as BookingHoldRecord);
    });

    await expect(
      releaseBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: mine.id }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("answer release: a revoke kept the challenged hold as the place's after the gate → BOOKING_HOLD_NOT_FOUND, still CHALLENGED", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, {
      position: 1,
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY),
    });
    const behind = placeHold(ctx, { position: 2 });
    ctx.commitBeforeNextTx(keepOnRevoke(ctx, grant, mine.id));

    const err = await answerBookingHoldChallenge(ctx.deps, {
      actorHumanId: BOOKER_EDITOR,
      holdId: mine.id,
      answer: "release",
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "BOOKING_HOLD_NOT_FOUND" });
    expect(err).not.toHaveProperty("meta.ownerKind");
    expect(row(ctx, mine.id)).toMatchObject({ ownerKind: "PLACE", status: "CHALLENGED" });
    expect(row(ctx, behind.id).position).toBe(2);
    expect(ctx.actions("booking_hold.released")).toEqual([]);
  });
});

describe("challengeBookingHold: the deadline is the place's (review B2, H13)", () => {
  it("a booker's respondBy is refused (respond_by_staff_only); nothing written", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    for (const respondBy of [
      new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      new Date("2099-01-01T00:00:00.000Z"),
    ]) {
      await expect(
        challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id, respondBy }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        issues: [expect.objectContaining({ message: "respond_by_staff_only", path: ["respondBy"] })],
      });
    }
    expect(row(ctx, act.id).status).toBe("ACTIVE");
    expect(ctx.actions("booking_hold.challenged")).toEqual([]);
  });

  it("a booker's challenge without respondBy runs the 24h default", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id });

    expect(row(ctx, act.id).respondBy).toEqual(new Date(NOW.getTime() + DEFAULT_CHALLENGE_WINDOW_MS));
  });

  it("a booker cannot ask to also send terms (send_terms_staff_only), before anything is read or written", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    const err = await challengeBookingHold(ctx.deps, {
      actorHumanId: BOOKER_EDITOR,
      holdId: act.id,
      sendTermsToFirstHold: true,
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ message: "send_terms_staff_only" })],
    });
    // No request id of another act rides the refusal.
    expect(JSON.stringify(err)).not.toContain(REQUEST_A);
    expect(row(ctx, act.id).status).toBe("ACTIVE");
  });

  it("staff may set a deadline up to 30 days out; beyond it is refused (respond_by_too_late)", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const own = placeHold(ctx, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    await expect(
      challengeBookingHold(ctx.deps, {
        actorHumanId: EDITOR_MEMBER,
        holdId: own.id,
        respondBy: new Date(NOW.getTime() + MAX_CHALLENGE_WINDOW_MS + 1),
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ message: "respond_by_too_late", path: ["respondBy"] })],
    });
    expect(row(ctx, own.id).status).toBe("ACTIVE");

    const at = new Date(NOW.getTime() + MAX_CHALLENGE_WINDOW_MS);
    await challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: own.id, respondBy: at });
    expect(row(ctx, own.id)).toMatchObject({ status: "CHALLENGED", respondBy: at });
  });
});

describe("what a booker's reply shows (review B3, H17)", () => {
  it("release by a booker: its own hold in the booker view, no line; staff get the staff view and the line", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, { position: 1 });
    ctx.seedHold(REQUEST_A, { position: 2 });
    const own = placeHold(ctx, { position: 3 });

    const wire = toReleaseBookingHoldWire(
      await releaseBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: mine.id }),
    );
    expect(wire.line).toEqual([]);
    expect(wire.hold).toMatchObject({ id: mine.id, status: "RELEASED", ownerKind: "BOOKER" });
    expect(wire.hold).not.toHaveProperty("placedByHumanId");
    expect(wire.hold).not.toHaveProperty("bookingRequestId");
    expect(JSON.stringify(wire)).not.toContain(REQUEST_A);
    expect(JSON.stringify(wire)).not.toContain(BOOKER_EDITOR);
    expect(wire).not.toHaveProperty("viewer");

    const staffWire = toReleaseBookingHoldWire(
      await releaseBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: own.id }),
    );
    expect(staffWire.hold).toMatchObject({ id: own.id, placedByHumanId: EDITOR_MEMBER });
    expect(staffWire.line.map((h) => h.bookingRequestId)).toEqual([REQUEST_A]);
  });

  it("challenge by a booker: the challenged hold without its request id or the placer; staff see both", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    const out = await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id });
    // Server side keeps the staff view (the notifier routes on it).
    expect(out.hold.bookingRequestId).toBe(REQUEST_A);
    const wire = toChallengeBookingHoldWire(out);
    expect(wire.hold).toMatchObject({ id: act.id, status: "CHALLENGED", position: 1 });
    expect(wire.hold).not.toHaveProperty("bookingRequestId");
    expect(wire.hold).not.toHaveProperty("placedByHumanId");
    expect(JSON.stringify(wire)).not.toContain(REQUEST_A);
    expect(wire).not.toHaveProperty("viewer");

    const ctx2 = buildGrantTestContext();
    const grant2 = orgGrant(ctx2);
    const act2 = ctx2.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx2, grant2.id, { position: 2 });
    const staffWire = toChallengeBookingHoldWire(
      await challengeBookingHold(ctx2.deps, { actorHumanId: EDITOR_MEMBER, holdId: act2.id }),
    );
    expect(staffWire.hold).toMatchObject({ bookingRequestId: REQUEST_A, placedByHumanId: expect.any(String) });
  });

  it("a booker's refusal carries no line position (NOT_FIRST) and no agreement id (TERMS_AGREED); staff's do", async () => {
    {
      const ctx = buildGrantTestContext();
      const grant = orgGrant(ctx);
      ctx.seedHold(REQUEST_A, { position: 1 });
      const second = placeHold(ctx, { position: 2 });
      bookerHold(ctx, grant.id, { position: 3 });

      const err = await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: second.id }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "BOOKING_HOLD_NOT_FIRST", meta: { holdId: second.id } });
      expect(err).not.toHaveProperty("meta.position");
      await expect(
        challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: second.id }),
      ).rejects.toMatchObject({ code: "BOOKING_HOLD_NOT_FIRST", meta: { position: 2 } });
    }
    {
      const ctx = buildGrantTestContext();
      const grant = orgGrant(ctx);
      const act = ctx.seedHold(REQUEST_A, { position: 1 });
      const agreementId = ctx.seedTerms(REQUEST_A, { status: "ACCEPTED" });
      bookerHold(ctx, grant.id, { position: 2 });

      const err = await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "TERMS_AGREED_FOR_THIS_NIGHT", meta: { holdId: act.id, date: DATE } });
      expect(err).not.toHaveProperty("meta.agreementId");
      await expect(
        challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: act.id }),
      ).rejects.toMatchObject({ code: "TERMS_AGREED_FOR_THIS_NIGHT", meta: { agreementId } });
    }
  });
});

describe("named party by PUBLIC page only (review W4)", () => {
  it("an UNLISTED page, a banned person's page and a banned org's page read PAGE_NOT_FOUND; nothing written, no cap charged", async () => {
    const ctx = buildGrantTestContext();
    for (const namedPartyPageId of [UNLISTED_PAGE, BANNED_PAGE, BANNED_ORG_PAGE]) {
      await expect(placeOwn(ctx, { namedPartyPageId })).rejects.toMatchObject({
        code: "PAGE_NOT_FOUND",
        meta: { pageId: namedPartyPageId },
      });
    }
    expect(ctx.bookingHolds.rows.size).toBe(0);
    expect(ctx.actions(PARTY_NAMED_AUDIT_ACTION)).toEqual([]);
  });
});

describe("the booker's grant row under the lock (review W5, N6)", () => {
  it("challenge: the booker's grant row is read FOR SHARE before the line lock", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id });

    const shares = vi.mocked(ctx.placeBookingGrants.lockSharedAtPlace).mock.invocationCallOrder;
    const lines = vi.mocked(ctx.bookingHolds.lockLine).mock.invocationCallOrder;
    expect(vi.mocked(ctx.placeBookingGrants.lockSharedAtPlace)).toHaveBeenCalledWith({ id: grant.id, placeId: PLACE_ID });
    expect(shares).toHaveLength(1);
    expect(shares[0]!).toBeLessThan(lines[0]!);
  });

  it("challenge: the grant revoked between the gate and the transaction → the gate's refusal, nothing written", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });
    ctx.commitBeforeNextTx(() => {
      ctx.placeBookingGrants.rows.set(grant.id, { ...grant, revokedAt: NOW });
    });

    await expect(
      challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(row(ctx, act.id).status).toBe("ACTIVE");
    expect(ctx.actions("booking_hold.challenged")).toEqual([]);
    expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
  });

  it("staff challenges take no grant row lock", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    await challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: act.id });

    expect(ctx.placeBookingGrants.lockSharedAtPlace).not.toHaveBeenCalled();
  });

  it("placement: the actor stops acting for the grantee between the gate and a date's transaction (demoted) → that date gets no hold", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    ctx.commitBeforeNextTx(() => {
      // BOOKER_EDITOR loses the edit role in the booker org.
      vi.mocked(ctx.repos.authz.listOrgMembershipsByHumanId).mockImplementation(async () => []);
    });

    const out = await placeBooker(ctx);

    expect(out.placed).toEqual([]);
    expect(out.failed).toEqual([{ date: DATE, code: "PLACE_BOOKING_GRANT_ENDED" }]);
    expect(ctx.bookingHolds.rows.size).toBe(0);
  });
});

describe("a booker stays off other parties' threads and replies (review round 2)", () => {
  it("release by a booker: the act behind's reordered line names nobody; the place mover's audit says by booker", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, { position: 1 });
    ctx.seedHold(REQUEST_A, { position: 2 });
    const own = placeHold(ctx, { position: 3 });

    await releaseBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: mine.id });

    const reordered = ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_hold.reordered");
    expect(reordered).toHaveLength(1);
    expect(reordered[0]!.actor).toBeNull();
    expect(ctx.actions("booking_hold.reordered")).toContainEqual(
      expect.objectContaining({
        entityId: own.id,
        data: expect.objectContaining({ by: "booker", actorHumanId: BOOKER_EDITOR }),
      }),
    );
  });

  it("release by staff still stamps the staff member on the mover's thread", async () => {
    const ctx = buildGrantTestContext();
    const own = placeHold(ctx, { position: 1 });
    ctx.seedHold(REQUEST_A, { position: 2 });

    await releaseBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: own.id });

    const reordered = ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_hold.reordered");
    expect(reordered.map((e) => e.actor)).toEqual([EDITOR_MEMBER]);
  });

  it("answer release by a booker: the mover's audit says by booker, not staff", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, {
      position: 1,
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY),
    });
    const behind = placeHold(ctx, { position: 2 });

    await answerBookingHoldChallenge(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: mine.id, answer: "release" });

    expect(ctx.actions("booking_hold.reordered")).toContainEqual(
      expect.objectContaining({ entityId: behind.id, data: expect.objectContaining({ by: "booker" }) }),
    );
  });

  it("release: the booker demoted between the gate and the line lock → NOT_RESOURCE_OWNER, nothing released", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, { position: 1 });
    const act = ctx.seedHold(REQUEST_A, { position: 2 });
    ctx.commitBeforeNextTx(() => {
      vi.mocked(ctx.repos.authz.listOrgMembershipsByHumanId).mockImplementation(async () => []);
    });

    await expect(
      releaseBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: mine.id }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(row(ctx, mine.id).status).toBe("ACTIVE");
    expect(row(ctx, act.id).position).toBe(2);
    expect(ctx.actions("booking_hold.released")).toEqual([]);
  });

  it("answer release: the booker demoted between the gate and the line lock → BOOKING_HOLD_NOT_FOUND, still CHALLENGED", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const mine = bookerHold(ctx, grant.id, {
      position: 1,
      status: "CHALLENGED",
      challengedAt: NOW,
      respondBy: new Date(NOW.getTime() + DAY),
    });
    const behind = placeHold(ctx, { position: 2 });
    ctx.commitBeforeNextTx(() => {
      vi.mocked(ctx.repos.authz.listOrgMembershipsByHumanId).mockImplementation(async () => []);
    });

    const err = await answerBookingHoldChallenge(ctx.deps, {
      actorHumanId: BOOKER_EDITOR,
      holdId: mine.id,
      answer: "release",
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "BOOKING_HOLD_NOT_FOUND" });
    expect(row(ctx, mine.id).status).toBe("CHALLENGED");
    expect(row(ctx, behind.id).position).toBe(2);
    expect(ctx.actions("booking_hold.released")).toEqual([]);
  });

  it("challenge: a hold on another place's calendar refuses a booker CALENDAR_NOT_FOUND with no meta; staff keep the meta", async () => {
    const ctx = buildGrantTestContext();
    orgGrant(ctx);
    const stray = ctx.seedHold(REQUEST_A, { position: 1, calendarId: FOREIGN_CALENDAR_ID });
    // The booker gate reads the calendar first and refuses a foreign one, so
    // the mismatch check is only reached when the two reads disagree (the
    // calendar moved between them): the gate's read sees it at the place.
    vi.mocked(ctx.repos.calendars.findById).mockResolvedValueOnce({
      id: FOREIGN_CALENDAR_ID,
      placeId: PLACE_ID,
      name: "Elsewhere",
      isDefault: false,
    } as never);

    const err = await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: stray.id }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    expect(err).not.toHaveProperty("meta.bookingRequestId");
    expect(err).not.toHaveProperty("meta.placeId");
    expect(JSON.stringify(err)).not.toContain(REQUEST_A);

    await expect(
      challengeBookingHold(ctx.deps, { actorHumanId: EDITOR_MEMBER, holdId: stray.id }),
    ).rejects.toMatchObject({
      code: "CALENDAR_NOT_FOUND",
      meta: { reason: "hold_calendar_place_mismatch", bookingRequestId: REQUEST_A },
    });
  });

  it("challenge by a booker of another party's hold: only id, calendar, date, position, status and deadline", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    const out = await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id });
    expect(out.viewerIsHolder).toBe(false);
    const wire = toChallengeBookingHoldWire(out);
    expect(Object.keys(wire.hold).sort()).toEqual(
      ["calendarId", "date", "id", "position", "respondBy", "status"],
    );
    expect(wire.hold).toMatchObject({ id: act.id, calendarId: CALENDAR_ID, date: DATE, position: 1, status: "CHALLENGED" });

    // Its own hold (the mapper's other booker branch) keeps the booker view.
    const ownWire = toChallengeBookingHoldWire({ ...out, viewerIsHolder: true });
    expect(ownWire.hold).toHaveProperty("ownerKind");
    expect(ownWire.hold).not.toHaveProperty("bookingRequestId");
    expect(ownWire.hold).not.toHaveProperty("placedByHumanId");
  });

  it("challenge by a booker: the act's challenged line names nobody; staff are still stamped", async () => {
    const ctx = buildGrantTestContext();
    const grant = orgGrant(ctx);
    const act = ctx.seedHold(REQUEST_A, { position: 1 });
    bookerHold(ctx, grant.id, { position: 2 });

    await challengeBookingHold(ctx.deps, { actorHumanId: BOOKER_EDITOR, holdId: act.id });

    const challenged = ctx.entries(REQUEST_A).filter((e) => e.kind === "booking_hold.challenged");
    expect(challenged).toHaveLength(1);
    expect(challenged[0]!.actor).toBeNull();
    expect(ctx.actions("booking_hold.challenged")[0]!.data).toMatchObject({ actorHumanId: BOOKER_EDITOR });

    const staffCtx = buildGrantTestContext();
    const staffAct = staffCtx.seedHold(REQUEST_A, { position: 1 });
    placeHold(staffCtx, { position: 2 });
    await challengeBookingHold(staffCtx.deps, { actorHumanId: EDITOR_MEMBER, holdId: staffAct.id });
    expect(
      staffCtx.entries(REQUEST_A).filter((e) => e.kind === "booking_hold.challenged").map((e) => e.actor),
    ).toEqual([EDITOR_MEMBER]);
  });
});
