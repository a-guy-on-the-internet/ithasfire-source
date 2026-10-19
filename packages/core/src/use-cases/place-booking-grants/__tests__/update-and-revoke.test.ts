import { describe, expect, it, vi } from "vitest";

import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";

import { LEGACY_AUDIT_ACTIONS } from "../../../lib/legacy-place-values";
import { isHoldLapsed } from "../../booking-holds/_shared/booking-hold-lapse";
import { previewGrantRevoke } from "../preview-revoke";
import { revokePlaceBookingGrant } from "../revoke";
import { updatePlaceBookingGrant } from "../update";
import {
  ADMIN_MEMBER,
  BOOKER_ADMIN,
  BOOKER_EDITOR,
  BOOKER_ORG,
  CALENDAR_ID,
  DATE,
  DIRECT_OWNER_ID,
  EDITOR_MEMBER,
  EVENT_GRANT,
  EVENT_MANAGER,
  EVENT_OTHER_GRANT,
  EVENT_PAST,
  FOREIGN_CALENDAR_ID,
  FOREIGN_PLACE_ID,
  NOW,
  OTHER_CALENDAR_ID,
  OTHER_ORG,
  PERSON_ID,
  PLACE_ID,
  REQUEST_A,
  STRANGER_ID,
  buildGrantTestContext,
} from "./grant-test-context";

const DAY = 24 * 60 * 60 * 1000;
const LATER = "2026-06-27";
const BOOKER = { kind: "org" as const, orgId: BOOKER_ORG };

type Ctx = ReturnType<typeof buildGrantTestContext>;

const activeOrgGrant = (ctx: Ctx, over: Record<string, unknown> = {}) =>
  ctx.placeBookingGrants.seed({ placeId: PLACE_ID, grantee: BOOKER, ...over });

const bookerHold = (
  ctx: Ctx,
  grantId: string,
  over: Partial<BookingHoldRecord> & { date?: string; calendarId?: string } = {},
) =>
  ctx.bookingHolds.seed({
    ownerKind: "BOOKER",
    grantId,
    holder: BOOKER,
    calendarId: CALENDAR_ID,
    date: DATE,
    placedByHumanId: BOOKER_EDITOR,
    ...over,
  } as never);

// ─────────────────────────────────────────────────────────────────────────────

describe("updatePlaceBookingGrant", () => {
  const update = (ctx: Ctx, grantId: string, over: Record<string, unknown> = {}) =>
    updatePlaceBookingGrant(ctx.deps, {
      actorHumanId: ADMIN_MEMBER,
      placeId: PLACE_ID,
      grantId,
      ...over,
    });

  it("moves the expiry (clearing the warning stamp) and audits before / after", async () => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx, {
      expiresAt: new Date(NOW.getTime() + 3 * DAY),
      expiryWarnedAt: NOW,
    });
    const later = new Date(NOW.getTime() + 60 * DAY);
    const out = await update(ctx, grant.id, { expiresAt: later });
    expect(out).toMatchObject({ changed: true, grant: { expiresAt: later, status: "active" } });
    expect(ctx.placeBookingGrants.rows.get(grant.id)?.expiryWarnedAt).toBeNull();
    expect(ctx.actions("place_booking_grant.updated")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          before: { calendarId: null, expiresAt: grant.expiresAt!.toISOString() },
          after: { calendarId: null, expiresAt: later.toISOString() },
        }),
      }),
    ]);
  });

  it("an edit that changes nothing writes nothing", async () => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx, { calendarId: CALENDAR_ID });
    const out = await update(ctx, grant.id, { calendarId: CALENDAR_ID });
    expect(out.changed).toBe(false);
    expect(ctx.placeBookingGrants.update).not.toHaveBeenCalled();
    expect(ctx.auditRows).toEqual([]);
  });

  it("an EDITOR, a grantee and a stranger are refused; a grant of another place reads not found", async () => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx);
    await expect(
      update(ctx, grant.id, { actorHumanId: EDITOR_MEMBER, expiresAt: null }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      update(ctx, grant.id, { actorHumanId: BOOKER_ADMIN, expiresAt: null }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      update(ctx, grant.id, { actorHumanId: STRANGER_ID, expiresAt: null }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    const foreign = ctx.placeBookingGrants.seed({ placeId: FOREIGN_PLACE_ID, grantee: BOOKER });
    await expect(
      update(ctx, foreign.id, { calendarId: CALENDAR_ID }),
    ).rejects.toMatchObject({ code: "PLACE_BOOKING_GRANT_NOT_FOUND" });
    expect(ctx.placeBookingGrants.update).not.toHaveBeenCalled();
  });

  it("refuses a calendar of another place and an expiry in the past", async () => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx);
    await expect(update(ctx, grant.id, { calendarId: FOREIGN_CALENDAR_ID })).rejects.toMatchObject({
      code: "CALENDAR_NOT_FOUND",
    });
    await expect(
      update(ctx, grant.id, { expiresAt: new Date(NOW.getTime() - 1) }),
    ).rejects.toMatchObject({ code: "EXPIRES_AT_IN_PAST" });
  });

  it.each([
    ["revoked", { revokedAt: NOW }],
    ["declined", { acceptedAt: null, declinedAt: NOW }],
    ["expired", { expiresAt: new Date(NOW.getTime() - 1) }],
  ])("a %s grant is ENDED: give a new one", async (reason, over) => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx, over);
    await expect(
      update(ctx, grant.id, { expiresAt: new Date(NOW.getTime() + DAY) }),
    ).rejects.toMatchObject({ code: "PLACE_BOOKING_GRANT_ENDED", meta: { reason } });
  });

  it.each([
    ["expires", (id: string, ctx: ReturnType<typeof buildGrantTestContext>) => {
      ctx.placeBookingGrants.rows.set(id, {
        ...ctx.placeBookingGrants.rows.get(id)!,
        expiresAt: new Date(NOW.getTime() - 1),
      });
    }],
    ["is declined", (id: string, ctx: ReturnType<typeof buildGrantTestContext>) => {
      ctx.placeBookingGrants.rows.set(id, {
        ...ctx.placeBookingGrants.rows.get(id)!,
        declinedAt: NOW,
      });
    }],
  ])("a grant that %s between the read and the write is ENDED: not revived, no audit row", async (_n, end) => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx, { expiresAt: new Date(NOW.getTime() + DAY) });
    ctx.commitBeforeNextTx(() => end(grant.id, ctx));
    const farther = new Date(NOW.getTime() + 30 * DAY);
    await expect(update(ctx, grant.id, { expiresAt: farther })).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_ENDED",
      meta: { reason: "ended" },
    });
    expect(ctx.placeBookingGrants.rows.get(grant.id)?.expiresAt?.getTime()).not.toBe(
      farther.getTime(),
    );
    expect(ctx.actions("place_booking_grant.updated")).toHaveLength(0);
  });

  it("narrowing to one calendar is refused while the booker holds dates on another; allowed when its holds fit", async () => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx);
    bookerHold(ctx, grant.id, { calendarId: OTHER_CALENDAR_ID });
    bookerHold(ctx, grant.id, { date: LATER });
    await expect(update(ctx, grant.id, { calendarId: CALENDAR_ID })).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_SCOPE_HAS_HOLDS",
      meta: { holdCount: 1 },
    });
    expect(ctx.placeBookingGrants.rows.get(grant.id)?.calendarId).toBeNull();

    const fits = buildGrantTestContext();
    const g2 = activeOrgGrant(fits);
    bookerHold(fits, g2.id, { date: LATER });
    await expect(update(fits, g2.id, { calendarId: CALENDAR_ID })).resolves.toMatchObject({
      changed: true,
      grant: { calendarId: CALENDAR_ID },
    });
  });

  it("narrowing writes the grant row FIRST, then counts the holds under that lock; a refusal rolls the write back", async () => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx);
    bookerHold(ctx, grant.id, { calendarId: OTHER_CALENDAR_ID });
    await expect(update(ctx, grant.id, { calendarId: CALENDAR_ID })).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_SCOPE_HAS_HOLDS",
    });
    const write = vi.mocked(ctx.placeBookingGrants.update).mock.invocationCallOrder[0]!;
    const count = vi.mocked(ctx.bookingHolds.listLiveForGrant).mock.invocationCallOrder[0]!;
    const lock = vi.mocked(ctx.placeBookingGrants.lockPlace).mock.invocationCallOrder[0]!;
    expect(lock).toBeLessThan(write);
    expect(write).toBeLessThan(count);
    // Rolled back: scope unchanged, no audit row.
    expect(ctx.placeBookingGrants.rows.get(grant.id)?.calendarId).toBeNull();
    expect(ctx.actions("place_booking_grant.updated")).toHaveLength(0);
  });

  it("a hold placed under the grant after the edit's first read still blocks the narrowing", async () => {
    const ctx = buildGrantTestContext();
    const grant = activeOrgGrant(ctx);
    // The booker's hold commits while the edit's UPDATE holds the grant row
    // (write, then count): the in-tx count after the write sees it.
    const write = ctx.placeBookingGrants.update.getMockImplementation()!;
    vi.mocked(ctx.placeBookingGrants.update).mockImplementationOnce(async (input) => {
      const row = await write(input);
      bookerHold(ctx, grant.id, { calendarId: OTHER_CALENDAR_ID });
      return row;
    });
    await expect(update(ctx, grant.id, { calendarId: CALENDAR_ID })).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_SCOPE_HAS_HOLDS",
      meta: { holdCount: 1 },
    });
    expect(ctx.placeBookingGrants.rows.get(grant.id)?.calendarId).toBeNull();
  });

  it("an overlapping grant given before the edit's transaction is EXISTS (checked under the place's lock); an expiry-only edit takes no lock", async () => {
    const ctx = buildGrantTestContext();
    const main = activeOrgGrant(ctx, { calendarId: CALENDAR_ID });
    let racer: { id: string } | undefined;
    ctx.commitBeforeNextTx(() => {
      racer = activeOrgGrant(ctx, { calendarId: OTHER_CALENDAR_ID });
    });
    const error = await update(ctx, main.id, { calendarId: OTHER_CALENDAR_ID }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PLACE_BOOKING_GRANT_EXISTS",
      meta: { grantId: racer!.id },
    });
    expect(ctx.placeBookingGrants.rows.has(racer!.id)).toBe(true);
    expect(ctx.placeBookingGrants.rows.get(main.id)?.calendarId).toBe(CALENDAR_ID);

    const expiry = buildGrantTestContext();
    const g = activeOrgGrant(expiry);
    await update(expiry, g.id, { expiresAt: new Date(NOW.getTime() + DAY) });
    expect(expiry.placeBookingGrants.lockPlace).not.toHaveBeenCalled();
  });

  it("widening to the whole place while another grant covers a calendar for the same grantee is EXISTS", async () => {
    const ctx = buildGrantTestContext();
    const main = activeOrgGrant(ctx, { calendarId: CALENDAR_ID });
    const patio = activeOrgGrant(ctx, { calendarId: OTHER_CALENDAR_ID });
    await expect(update(ctx, patio.id, { calendarId: null })).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_EXISTS",
      meta: { grantId: main.id },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The line on DATE: the booker's hold at 1st, Act A's request hold behind it.
 * On LATER: a second booker hold (alone). Plus noise that must never be
 * touched: another grant's booker hold, a PLACE hold, a released booker hold.
 */
function revokeScene() {
  const ctx = buildGrantTestContext();
  const grant = activeOrgGrant(ctx);
  const other = ctx.placeBookingGrants.seed({
    placeId: PLACE_ID,
    grantee: { kind: "org", orgId: OTHER_ORG },
  });
  const first = bookerHold(ctx, grant.id, { position: 1 });
  const actHold = ctx.seedHold(REQUEST_A, { position: 2 });
  const later = bookerHold(ctx, grant.id, { date: LATER, position: 1 });
  const otherGrantHold = ctx.bookingHolds.seed({
    ownerKind: "BOOKER",
    grantId: other.id,
    holder: { kind: "org", orgId: OTHER_ORG },
    calendarId: OTHER_CALENDAR_ID,
    date: DATE,
  });
  const placeHold = ctx.bookingHolds.seed({
    ownerKind: "PLACE",
    holder: null,
    calendarId: OTHER_CALENDAR_ID,
    date: LATER,
  });
  const gone = bookerHold(ctx, grant.id, {
    date: "2026-06-25",
    status: "RELEASED",
    releasedReason: "MANUAL",
    releasedAt: NOW,
  });

  ctx.seedConfirmedEvent({ id: EVENT_GRANT, owner: { orgId: BOOKER_ORG }, stampedBy: { grantId: grant.id } });
  ctx.seedConfirmedEvent({ id: EVENT_MANAGER, owner: { orgId: BOOKER_ORG }, stampedBy: "manager" });
  ctx.seedConfirmedEvent({
    id: EVENT_OTHER_GRANT,
    owner: { orgId: OTHER_ORG },
    stampedBy: { grantId: other.id },
  });
  ctx.seedConfirmedEvent({
    id: EVENT_PAST,
    owner: { orgId: BOOKER_ORG },
    stampedBy: { grantId: grant.id },
    startsAt: new Date(NOW.getTime() - DAY),
  });
  return { ctx, grant, other, first, actHold, later, otherGrantHold, placeHold, gone };
}

describe("previewGrantRevoke", () => {
  it("lists exactly the grant's live holds (default release) and its upcoming grant-confirmed events (default stay)", async () => {
    const { ctx, grant, first, later } = revokeScene();
    const out = await previewGrantRevoke(ctx.deps, {
      actorHumanId: DIRECT_OWNER_ID,
      placeId: PLACE_ID,
      grantId: grant.id,
    });
    expect(out.grant).toMatchObject({ id: grant.id, status: "active" });
    expect(out.holds.map((h) => [h.hold.id, h.defaultAction])).toEqual([
      [first.id, "release"],
      [later.id, "release"],
    ]);
    expect(out.events.map((e) => [e.event.eventId, e.defaultAction])).toEqual([
      [EVENT_GRANT, "stay"],
    ]);
  });

  it("recognises an event stamped under the grant whichever spelling its audit row carries", async () => {
    // Rows written before 2026-10-18 carry the old action spelling
    // (`lib/legacy-place-values`); both read as the grant's stamp, and an old
    // manager stamp still is not.
    const LEGACY_GRANT_EVENT = "e7e7e7e7-e7e7-4e7e-8e7e-e7e7e7e7e7e7";
    const LEGACY_MANAGER_EVENT = "e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e8";
    const { ctx, grant } = revokeScene();
    ctx.seedConfirmedEvent({
      id: LEGACY_GRANT_EVENT,
      owner: { orgId: BOOKER_ORG },
      stampedBy: { grantId: grant.id },
      startsAt: new Date("2026-06-22T01:00:00.000Z"),
      spelling: "legacy",
    });
    ctx.seedConfirmedEvent({
      id: LEGACY_MANAGER_EVENT,
      owner: { orgId: BOOKER_ORG },
      stampedBy: "manager",
      spelling: "legacy",
    });
    expect(
      ctx.auditRows.find((row) => row.entityId === LEGACY_GRANT_EVENT)?.action,
    ).toBe(LEGACY_AUDIT_ACTIONS["event.place_confirmed_by_grant"]);
    expect(
      ctx.auditRows.find((row) => row.entityId === EVENT_GRANT)?.action,
    ).toBe("event.place_confirmed_by_grant");

    const out = await previewGrantRevoke(ctx.deps, {
      actorHumanId: DIRECT_OWNER_ID,
      placeId: PLACE_ID,
      grantId: grant.id,
    });
    expect(out.events.map((e) => e.event.eventId)).toEqual([
      EVENT_GRANT,
      LEGACY_GRANT_EVENT,
    ]);
    // The filter asked for both spellings of every stamping action.
    expect(ctx.audit.listForEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: expect.arrayContaining([
          "event.place_confirmed_by_grant",
          LEGACY_AUDIT_ACTIONS["event.place_confirmed_by_grant"],
          "event.place_confirmed_by_manager",
          LEGACY_AUDIT_ACTIONS["event.place_confirmed_by_manager"],
          "event.place_confirmed",
          LEGACY_AUDIT_ACTIONS["event.place_confirmed"],
        ]),
      }),
    );
  });

  it("a newer place-confirmed row over an old grant stamp makes the event no longer the grant's", async () => {
    const { ctx, grant } = revokeScene();
    ctx.auditRows.push({
      id: "later-direct-confirm",
      entity: "event",
      entityId: EVENT_GRANT,
      action: LEGACY_AUDIT_ACTIONS["event.place_confirmed"],
      data: { placeId: PLACE_ID },
      at: new Date("2026-06-02T00:00:00.000Z"),
    });
    const out = await previewGrantRevoke(ctx.deps, {
      actorHumanId: DIRECT_OWNER_ID,
      placeId: PLACE_ID,
      grantId: grant.id,
    });
    expect(out.events).toEqual([]);
  });

  it("is for managers only; another place's grant id reads not found", async () => {
    const { ctx, grant } = revokeScene();
    const preview = (actorHumanId: string, grantId = grant.id) =>
      previewGrantRevoke(ctx.deps, { actorHumanId, placeId: PLACE_ID, grantId });
    await expect(preview(EDITOR_MEMBER)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(preview(BOOKER_ADMIN)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    const foreign = ctx.placeBookingGrants.seed({ placeId: FOREIGN_PLACE_ID, grantee: BOOKER });
    await expect(preview(ADMIN_MEMBER, foreign.id)).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_NOT_FOUND",
    });
  });
});

describe("revokePlaceBookingGrant", () => {
  const revoke = (ctx: Ctx, grantId: string, over: Record<string, unknown> = {}) =>
    revokePlaceBookingGrant(ctx.deps, {
      actorHumanId: ADMIN_MEMBER,
      placeId: PLACE_ID,
      grantId,
      ...over,
    });

  it("releases unkept holds GRANT_ENDED with the line renumbered and the act behind told; a kept hold becomes a PLACE hold naming the booker", async () => {
    const { ctx, grant, first, actHold, later, otherGrantHold, placeHold, gone } = revokeScene();
    const out = await revoke(ctx, grant.id, { keepHoldIds: [later.id] });

    // The grant.
    expect(out).toMatchObject({ alreadyRevoked: false, grant: { status: "revoked", revokedAt: NOW } });

    // Released: GRANT_ENDED, out of the line.
    expect(out.released.map((h) => h.id)).toEqual([first.id]);
    expect(ctx.bookingHolds.rows.get(first.id)).toMatchObject({
      status: "RELEASED",
      releasedReason: "GRANT_ENDED",
      releasedAt: NOW,
    });
    // The act behind moved up 2 → 1, on its thread and in an intent.
    expect(ctx.bookingHolds.rows.get(actHold.id)).toMatchObject({ position: 1, status: "ACTIVE" });
    expect(out.holdNotificationIntents).toContainEqual(
      expect.objectContaining({
        kind: "hold.position_changed",
        bookingRequestId: REQUEST_A,
        holdId: actHold.id,
        audience: "act",
        position: 1,
      }),
    );
    expect(ctx.entries(REQUEST_A)).toContainEqual(
      expect.objectContaining({ kind: "booking_hold.reordered", data: { holdId: actHold.id, from: 2, to: 1 } }),
    );

    // Kept: same row, now the place's, naming the booker, no grant.
    expect(out.kept.map((h) => h.id)).toEqual([later.id]);
    const kept = ctx.bookingHolds.rows.get(later.id)!;
    expect(kept).toMatchObject({
      ownerKind: "PLACE",
      holder: BOOKER,
      status: "ACTIVE",
      position: 1,
      date: LATER,
    });
    expect(kept).not.toHaveProperty("grantId");

    // Nothing else moved.
    expect(ctx.bookingHolds.rows.get(otherGrantHold.id)).toEqual(otherGrantHold);
    expect(ctx.bookingHolds.rows.get(placeHold.id)).toEqual(placeHold);
    expect(ctx.bookingHolds.rows.get(gone.id)).toEqual(gone);

    // The booker is told once, with its own dates.
    expect(out.notificationIntents).toEqual([
      {
        kind: "grant.revoked",
        grantId: grant.id,
        placeId: PLACE_ID,
        calendarId: null,
        audience: "grantee",
        grantee: BOOKER,
        releasedHolds: [{ holdId: first.id, date: DATE }],
        keptHolds: [{ holdId: later.id, date: LATER }],
      },
    ]);

    // Audit: each hold and the grant.
    expect(ctx.actions("booking_hold.released")).toEqual([
      expect.objectContaining({
        entityId: first.id,
        data: expect.objectContaining({ reason: "GRANT_ENDED", grantId: grant.id }),
      }),
    ]);
    expect(ctx.actions("booking_hold.kept_as_place_hold")).toEqual([
      expect.objectContaining({ entityId: later.id }),
    ]);
    expect(ctx.actions("place_booking_grant.revoked")).toEqual([
      expect.objectContaining({
        entityId: grant.id,
        data: expect.objectContaining({
          releasedHoldIds: [first.id],
          keptHoldIds: [later.id],
        }),
      }),
    ]);
    // The grant no longer authorises.
    expect(
      await ctx.placeBookingGrants.findActiveForActor({
        placeId: PLACE_ID,
        humanIds: [],
        orgIds: [BOOKER_ORG],
        now: NOW,
      }),
    ).toBeNull();
    // Events stay unless asked.
    expect(out.withdrawals).toEqual([]);
    expect(ctx.events.get(EVENT_GRANT)?.venueConfirmationWithdrawnAt).toBeNull();
    // Lock order (hold-line.ts): the grant row (the revoke CAS) first, then
    // every line, in sorted order (`lockLines`), before the first hold
    // write. Later calls are settleLine's re-entrant re-locks of the same
    // lines.
    const lockLine = vi.mocked(ctx.bookingHolds.lockLine).mock;
    expect(lockLine.calls.slice(0, 2)).toEqual([
      [{ calendarId: CALENDAR_ID, date: DATE }],
      [{ calendarId: CALENDAR_ID, date: LATER }],
    ]);
    for (const [key] of lockLine.calls) {
      expect([DATE, LATER]).toContain((key as { date: string }).date);
    }
    const grantWrite = vi.mocked(ctx.placeBookingGrants.revoke).mock.invocationCallOrder[0]!;
    const firstHoldWrite = Math.min(
      ...vi.mocked(ctx.bookingHolds.updateStatus).mock.invocationCallOrder,
      ...vi.mocked(ctx.bookingHolds.convertBookerHoldToPlace).mock.invocationCallOrder,
    );
    expect(grantWrite).toBeLessThan(lockLine.invocationCallOrder[0]!);
    expect(lockLine.invocationCallOrder[1]!).toBeLessThan(firstHoldWrite);
  });

  it("trap l: the lazy GRANT_ENDED branch is armed when the revoke settles its lines, and still releases only the unkept holds", async () => {
    const { ctx, grant, first, later } = revokeScene();
    // What the line settle sees: a kept hold whose grant already reads
    // revoked (the stamp is the transaction's first write), so a settle
    // without the exemption would release it GRANT_ENDED before the keep.
    const seenAtSettle: Array<{ id: string; lapse: unknown }> = [];
    vi.mocked(ctx.bookingHolds.lockLine).mockImplementation(async (key) => {
      if (key.date !== LATER) return;
      const row = await ctx.bookingHolds.getById(later.id);
      seenAtSettle.push({ id: later.id, lapse: row && isHoldLapsed(row, NOW, "America/Chicago") });
    });

    const out = await revoke(ctx, grant.id, { keepHoldIds: [later.id] });

    // The first lock on LATER's line is the settle's.
    expect(seenAtSettle[0]).toEqual({ id: later.id, lapse: "GRANT_ENDED" });
    expect(out.kept.map((h) => h.id)).toEqual([later.id]);
    expect(out.released.map((h) => h.id)).toEqual([first.id]);
    expect(ctx.bookingHolds.rows.get(later.id)).toMatchObject({ ownerKind: "PLACE", holder: BOOKER, status: "ACTIVE" });
    // No settle-written release (those carry `actorHumanId: null` and no grant).
    expect(
      ctx.actions("booking_hold.released").filter((r) => (r.data as { grantId?: string }).grantId !== grant.id),
    ).toEqual([]);
  });

  it("is idempotent: revoking again touches no hold, sends no notice, writes no second audit row", async () => {
    const { ctx, grant } = revokeScene();
    await revoke(ctx, grant.id);
    const snapshot = new Map(ctx.bookingHolds.rows);
    const again = await revoke(ctx, grant.id);
    expect(again).toMatchObject({
      alreadyRevoked: true,
      released: [],
      kept: [],
      notificationIntents: [],
      holdNotificationIntents: [],
      grant: { status: "revoked" },
    });
    expect(ctx.bookingHolds.rows).toEqual(snapshot);
    expect(ctx.actions("place_booking_grant.revoked")).toHaveLength(1);
    expect(ctx.placeBookingGrants.revoke).toHaveBeenCalledTimes(1);
  });

  it("a revoke that loses the CAS to a concurrent one reads as already revoked and touches no hold", async () => {
    const { ctx, grant, first } = revokeScene();
    // The other revoke commits between this call's read and its write.
    vi.mocked(ctx.placeBookingGrants.revoke).mockImplementationOnce(async () => {
      ctx.placeBookingGrants.rows.set(grant.id, { ...grant, revokedAt: NOW });
      return null;
    });
    const out = await revoke(ctx, grant.id);
    expect(out.alreadyRevoked).toBe(true);
    expect(ctx.bookingHolds.rows.get(first.id)?.status).toBe("ACTIVE");
  });

  it("withdraws the place's confirmation on the chosen events after commit; others stay; an unlisted id is left alone", async () => {
    const { ctx, grant } = revokeScene();
    const out = await revoke(ctx, grant.id, {
      withdrawEventIds: [EVENT_GRANT, EVENT_MANAGER],
      withdrawReason: "Booking arrangement ended",
    });
    expect(out.withdrawals).toEqual([
      { eventId: EVENT_GRANT, outcome: "withdrawn" },
      { eventId: EVENT_MANAGER, outcome: "not_listed" },
    ]);
    expect(ctx.events.get(EVENT_GRANT)).toMatchObject({
      venueConfirmationWithdrawnReason: "Booking arrangement ended",
    });
    expect(ctx.events.get(EVENT_MANAGER)?.venueConfirmationWithdrawnAt).toBeNull();
    expect(out.venueConfirmationIntents).toEqual([
      expect.objectContaining({
        kind: "event.place_confirmation_withdrawn",
        eventId: EVENT_GRANT,
        recipient: { type: "org", orgId: BOOKER_ORG },
      }),
    ]);
    // Never cancelled (H15).
    expect(ctx.events.get(EVENT_GRANT)?.status).toBe("DRAFT");
    // Audit: the revoke row names what was REQUESTED; a second row, after
    // the withdrawals ran, what each one did.
    expect(ctx.actions("place_booking_grant.revoked")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          withdrawEventIdsRequested: [EVENT_GRANT, EVENT_MANAGER],
        }),
      }),
    ]);
    expect(ctx.actions("place_booking_grant.revoked")[0]?.data).not.toHaveProperty(
      "withdrawEventIds",
    );
    expect(ctx.actions("place_booking_grant.revoke_withdrawals")).toEqual([
      expect.objectContaining({
        entityId: grant.id,
        data: {
          actorHumanId: ADMIN_MEMBER,
          placeId: PLACE_ID,
          withdrawals: [
            { eventId: EVENT_GRANT, outcome: "withdrawn" },
            { eventId: EVENT_MANAGER, outcome: "not_listed" },
          ],
        },
      }),
    ]);
  });

  it("no withdrawals asked → no outcomes row; a failing outcomes write is reported, and the revoke still answers", async () => {
    const none = revokeScene();
    await revoke(none.ctx, none.grant.id);
    expect(none.ctx.actions("place_booking_grant.revoke_withdrawals")).toHaveLength(0);

    const { ctx, grant } = revokeScene();
    const reportError = vi.fn();
    const realLog = ctx.audit.log.getMockImplementation()!;
    ctx.audit.log.mockImplementation(async (entry) => {
      if (entry.action === "place_booking_grant.revoke_withdrawals") {
        throw new Error("audit down");
      }
      return realLog(entry);
    });
    const out = await revokePlaceBookingGrant(
      { ...ctx.deps, reportError },
      {
        actorHumanId: ADMIN_MEMBER,
        placeId: PLACE_ID,
        grantId: grant.id,
        withdrawEventIds: [EVENT_GRANT],
        withdrawReason: "Ended",
      },
    );
    expect(out).toMatchObject({
      alreadyRevoked: false,
      withdrawals: [{ eventId: EVENT_GRANT, outcome: "withdrawn" }],
    });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "revokePlaceBookingGrant", step: "withdrawals_audit" },
      extra: { grantId: grant.id, placeId: PLACE_ID },
    });
  });

  it("a failing withdrawal is reported and returned as failed; the revoke still stands, and a throwing reporter changes nothing", async () => {
    const { ctx, grant, first } = revokeScene();
    const reportError = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    ctx.failNextWithdraw();
    const out = await revokePlaceBookingGrant(
      { ...ctx.deps, reportError, logger: logger as never },
      {
        actorHumanId: ADMIN_MEMBER,
        placeId: PLACE_ID,
        grantId: grant.id,
        withdrawEventIds: [EVENT_GRANT],
        withdrawReason: "Ended",
      },
    );
    expect(out.withdrawals).toEqual([{ eventId: EVENT_GRANT, outcome: "failed" }]);
    expect(out.alreadyRevoked).toBe(false);
    expect(ctx.bookingHolds.rows.get(first.id)?.status).toBe("RELEASED");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "revokePlaceBookingGrant", step: "withdraw_venue_confirmation" },
      extra: { grantId: grant.id, placeId: PLACE_ID, eventId: EVENT_GRANT },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "place_booking_grants.revoke.withdraw_failed",
      expect.objectContaining({ eventId: EVENT_GRANT }),
    );

    // Retrying the revoke finishes the withdrawal; a throwing reporter on a
    // second failure still answers `failed`, not an exception.
    const retry = await revoke(ctx, grant.id, {
      withdrawEventIds: [EVENT_GRANT],
      withdrawReason: "Ended",
    });
    expect(retry).toMatchObject({
      alreadyRevoked: true,
      withdrawals: [{ eventId: EVENT_GRANT, outcome: "withdrawn" }],
    });

    const scene2 = revokeScene();
    scene2.ctx.failNextWithdraw();
    const throwing = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      revokePlaceBookingGrant(
        { ...scene2.ctx.deps, reportError: throwing },
        {
          actorHumanId: ADMIN_MEMBER,
          placeId: PLACE_ID,
          grantId: scene2.grant.id,
          withdrawEventIds: [EVENT_GRANT],
          withdrawReason: "Ended",
        },
      ),
    ).resolves.toMatchObject({ withdrawals: [{ eventId: EVENT_GRANT, outcome: "failed" }] });
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("a withdrawal needs a reason", async () => {
    const { ctx, grant } = revokeScene();
    await expect(revoke(ctx, grant.id, { withdrawEventIds: [EVENT_GRANT] })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(ctx.placeBookingGrants.revoke).not.toHaveBeenCalled();
  });

  it("an EDITOR, the grantee and a stranger are refused; another place's grant id reads not found; nothing moves", async () => {
    const { ctx, grant, first } = revokeScene();
    await expect(revoke(ctx, grant.id, { actorHumanId: EDITOR_MEMBER })).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    await expect(revoke(ctx, grant.id, { actorHumanId: BOOKER_ADMIN })).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    await expect(revoke(ctx, grant.id, { actorHumanId: STRANGER_ID })).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    const foreign = ctx.placeBookingGrants.seed({ placeId: FOREIGN_PLACE_ID, humanId: PERSON_ID });
    await expect(revoke(ctx, foreign.id)).rejects.toMatchObject({
      code: "PLACE_BOOKING_GRANT_NOT_FOUND",
    });
    expect(ctx.placeBookingGrants.revoke).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(first.id)?.status).toBe("ACTIVE");
    expect(ctx.placeBookingGrants.rows.get(grant.id)?.revokedAt).toBeNull();
  });

  it("a keep id that is not one of the grant's holds converts nothing", async () => {
    const { ctx, grant, otherGrantHold, first } = revokeScene();
    const out = await revoke(ctx, grant.id, { keepHoldIds: [otherGrantHold.id] });
    expect(out.kept).toEqual([]);
    expect(ctx.bookingHolds.rows.get(otherGrantHold.id)).toMatchObject({ ownerKind: "BOOKER" });
    expect(ctx.bookingHolds.rows.get(first.id)?.status).toBe("RELEASED");
  });
});
