import { describe, expect, it } from "vitest";

import type { TxRepos } from "@th/ports/repos";

import { resolveStaffRecipientOrgId } from "../_shared/staff-recipient-org";
import {
  heldDatesOwnerOf,
  settleHeldDatesForEvent,
  settleHeldDatesForPublishedEvent,
  type HeldDatesOwner,
} from "../settle-held-dates-for-published-event";
import {
  ACT_A_ID,
  AGREEMENT_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  ORG_ID,
  OTHER_CALENDAR_ID,
  OUTSIDER_ID,
  PLACE_ID,
  REQUEST_A,
  REQUEST_B,
  REQUEST_C,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// FR-018 — a published event takes its dates from the holds on its calendar.
// The line mechanics are pinned here through the same fakes the hold use
// cases use; the hook sites (publish / save / recurrence) are pinned in
// their own suites and only assert THIS helper's writes.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
/** 20:00 America/Chicago (CDT) on DATE. */
const STARTS_AT = new Date("2026-06-21T01:00:00.000Z");
const PLACE_TZ = "America/Chicago";
/** A CHALLENGED hold whose clock is still running at NOW. */
const OPEN = { status: "CHALLENGED" as const, challengedAt: NOW, respondBy: new Date("2026-06-12T12:00:00.000Z") };
/** A CHALLENGED hold whose clock already passed at NOW. */
const LAPSED = { status: "CHALLENGED" as const, challengedAt: new Date("2026-06-01T12:00:00.000Z"), respondBy: new Date("2026-06-03T12:00:00.000Z") };
/** The harness venue is org-owned; an org event of that org is the common hook-site shape. */
const OWNER: HeldDatesOwner = { kind: "org", orgId: ORG_ID };

function build(options: Parameters<typeof buildHoldTestContext>[0] = {}) {
  const ctx = buildHoldTestContext(options);
  const tx = ctx.repos as unknown as TxRepos;
  /** Make REQUEST_A the event's provenance: agreement → request. */
  const seedProvenance = () => {
    ctx.agreements.set(AGREEMENT_ID, { id: AGREEMENT_ID, status: "ACTIVE", eventId: EVENT_ID, draftEventId: null });
    ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status: "ACCEPTED", agreementId: AGREEMENT_ID });
  };
  /**
   * The event row as the hook sites hand it in. VENUE-OWNED by default (the
   * harness venue is org-owned, the event belongs to that org) — the gate's
   * "confirmed by construction" arm. `owner: null` = ownerless community
   * listing; `stamp: true` = an active venue-confirmation stamp for THIS
   * place; `stampedFor` = a stamp issued for another place (stale, H1).
   */
  const event = (
    overrides: {
      calendarId?: string | null;
      startsAt?: Date;
      orgId?: string | null;
      humanId?: string | null;
      stamp?: boolean;
      stampedFor?: string;
    } = {},
  ) => ({
    id: EVENT_ID,
    startsAt: overrides.startsAt ?? STARTS_AT,
    calendarId: "calendarId" in overrides ? overrides.calendarId : CALENDAR_ID,
    orgId: "orgId" in overrides ? (overrides.orgId ?? null) : ORG_ID,
    humanId: overrides.humanId ?? null,
    placeId: PLACE_ID,
    venueConfirmedAt: overrides.stamp || overrides.stampedFor ? NOW : null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: overrides.stampedFor ?? (overrides.stamp ? PLACE_ID : null),
  });
  return { ...ctx, tx, seedProvenance, event };
}

describe("settleHeldDatesForEvent (FR-018)", () => {
  it("event with no calendar: outside the holds world — not a single read, no writes", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event({ calendarId: null }), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    expect(result).toEqual({ confirmed: [], released: [], intents: [], staffRecipientHint: null });
    expect(ctx.repos.calendars.findById).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.listLine).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("empty line: locks + reads, but writes nothing and owes nothing", async () => {
    const ctx = build();
    // A hold on the same date but ANOTHER calendar is not this line.
    const elsewhere = ctx.seedHold(REQUEST_B, { calendarId: OTHER_CALENDAR_ID });

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    expect(result).toEqual({ confirmed: [], released: [], intents: [], staffRecipientHint: null });
    expect(ctx.bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, date: DATE });
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(elsewhere.id)?.status).toBe("ACTIVE");
  });

  it("lapsed challenge is settled FIRST (EXPIRED, silent-to-staff expiry intents), then the line is taken", async () => {
    const ctx = build();
    const lapsed = ctx.seedHold(REQUEST_B, LAPSED);
    const active = ctx.seedHold(REQUEST_A);

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    expect(ctx.bookingHolds.rows.get(lapsed.id)).toMatchObject({ status: "RELEASED", releasedReason: "EXPIRED" });
    expect(ctx.bookingHolds.rows.get(active.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    expect(result.released.map((h) => h.id)).toEqual([active.id]);
    expect(result.intents.map((i) => [i.kind, i.audience, i.holdId])).toEqual([
      ["hold.expired", "act", lapsed.id],
      ["hold.expired", "staff", lapsed.id],
      ["hold.position_changed", "act", active.id],
      ["hold.released", "act", active.id],
      ["hold.released", "staff", active.id],
    ]);
  });

  it("another hold on the line has an OPEN challenge → HOLD_LINE_HAS_OPEN_CHALLENGE with confirm's meta shape; no writes", async () => {
    const ctx = build();
    const challenged = ctx.seedHold(REQUEST_B, OPEN);
    const other = ctx.seedHold(REQUEST_C);

    await expect(
      settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER }),
    ).rejects.toMatchObject({
      code: "HOLD_LINE_HAS_OPEN_CHALLENGE",
      meta: { holdId: null, challengedHoldId: challenged.id, calendarId: CALENDAR_ID, date: DATE },
    });

    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.rows.get(challenged.id)).toMatchObject({ status: "CHALLENGED", respondBy: OPEN.respondBy });
    expect(ctx.bookingHolds.rows.get(other.id)?.status).toBe("ACTIVE");
    expect(ctx.entries(REQUEST_B)).toEqual([]);
    expect(ctx.entries(REQUEST_C)).toEqual([]);
  });

  it("own request wins: its live hold → CONFIRMED, siblings SIBLING_CONFIRMED, competitors CONFIRMED_OTHER — Confirm's semantics, ledger names the event", async () => {
    const ctx = build();
    ctx.seedProvenance();
    const own = ctx.seedHold(REQUEST_A);
    const competitor = ctx.seedHold(REQUEST_B);
    const sibling = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });
    const siblingLineMate = ctx.seedHold(REQUEST_C, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-27" });

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    expect(ctx.bookingHolds.rows.get(own.id)).toMatchObject({ status: "CONFIRMED", confirmedAt: NOW });
    expect(ctx.bookingHolds.rows.get(competitor.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    expect(ctx.bookingHolds.rows.get(sibling.id)).toMatchObject({ status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });
    expect(ctx.bookingHolds.rows.get(siblingLineMate.id)?.position).toBe(1);
    expect(result.confirmed.map((h) => h.id)).toEqual([own.id]);
    expect(result.released.map((h) => h.id).sort()).toEqual([sibling.id, competitor.id].sort());

    // Ledger: winner's thread gets the sibling release then the confirm WITH the event id.
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: sibling.id, reason: "SIBLING_CONFIRMED" }, actor: STAFF_ID },
      { kind: "booking_hold.confirmed", data: { holdId: own.id, eventId: EVENT_ID }, actor: STAFF_ID },
    ]);
    expect(ctx.entries(REQUEST_B)).toEqual([
      { kind: "booking_hold.released", data: { holdId: competitor.id, reason: "CONFIRMED_OTHER" }, actor: STAFF_ID },
    ]);
    expect(ctx.entries(REQUEST_C)).toEqual([
      { kind: "booking_hold.reordered", data: { holdId: siblingLineMate.id, from: 2, to: 1 }, actor: STAFF_ID },
    ]);

    // Intents: the same shape and order confirm returns — nobody is told "you lost" for their own event.
    expect(result.intents).toEqual([
      { kind: "hold.confirmed", bookingRequestId: REQUEST_A, holdId: own.id, audience: "act", date: DATE },
      { kind: "hold.released", bookingRequestId: REQUEST_A, holdId: sibling.id, audience: "act", date: "2026-06-27", reason: "SIBLING_CONFIRMED" },
      { kind: "hold.lost_date", bookingRequestId: REQUEST_B, holdId: competitor.id, audience: "act", date: DATE, reason: "CONFIRMED_OTHER" },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_C, holdId: siblingLineMate.id, audience: "act", date: "2026-06-27", position: 1 },
    ]);
    expect(result.staffRecipientHint).toEqual({
      assigneeHumanId: ASSIGNEE_ID,
      placedByHumanId: STAFF_ID,
      orgId: ctx.place.orgIdsWithAccess[0],
      placeId: ctx.place.id,
    });
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      entity: "event",
      entityId: EVENT_ID,
      action: "event.held_dates_settled",
      data: expect.objectContaining({ confirmedHoldIds: [own.id], dates: [DATE] }),
    }));
  });

  it("own request wins even from a CHALLENGED hold (the venue saying yes early); its clock is cleared", async () => {
    const ctx = build();
    ctx.seedProvenance();
    const own = ctx.seedHold(REQUEST_A, OPEN);
    const competitor = ctx.seedHold(REQUEST_B);

    await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    expect(ctx.bookingHolds.rows.get(own.id)).toMatchObject({ status: "CONFIRMED", respondBy: null });
    expect(ctx.bookingHolds.rows.get(competitor.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
  });

  it("no provenance: every live hold → RELEASED (EVENT_SCHEDULED) with ledger {reason} and an act + assignee intent each", async () => {
    const ctx = build();
    const first = ctx.seedHold(REQUEST_A);
    const second = ctx.seedHold(REQUEST_B);

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    for (const hold of [first, second]) {
      expect(ctx.bookingHolds.rows.get(hold.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED", releasedAt: NOW });
    }
    expect(result.confirmed).toEqual([]);
    expect(result.released.map((h) => h.id)).toEqual([first.id, second.id]);
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: first.id, reason: "EVENT_SCHEDULED" }, actor: STAFF_ID },
    ]);
    expect(ctx.entries(REQUEST_B)).toEqual([
      { kind: "booking_hold.released", data: { holdId: second.id, reason: "EVENT_SCHEDULED" }, actor: STAFF_ID },
    ]);
    const staff = { assigneeHumanId: ASSIGNEE_ID, placedByHumanId: STAFF_ID };
    expect(result.intents).toEqual([
      { kind: "hold.released", bookingRequestId: REQUEST_A, holdId: first.id, audience: "act", date: DATE, reason: "EVENT_SCHEDULED" },
      { kind: "hold.released", bookingRequestId: REQUEST_A, holdId: first.id, audience: "staff", date: DATE, reason: "EVENT_SCHEDULED", staff },
      { kind: "hold.released", bookingRequestId: REQUEST_B, holdId: second.id, audience: "act", date: DATE, reason: "EVENT_SCHEDULED" },
      { kind: "hold.released", bookingRequestId: REQUEST_B, holdId: second.id, audience: "staff", date: DATE, reason: "EVENT_SCHEDULED", staff },
    ]);
    // No provenance → no assignee on the hint, but the venue routing is there.
    expect(result.staffRecipientHint).toEqual({
      assigneeHumanId: null,
      placedByHumanId: STAFF_ID,
      orgId: ctx.place.orgIdsWithAccess[0],
      placeId: ctx.place.id,
    });
    // The emptied line is never renumbered.
    expect(ctx.bookingHolds.renumberLine).not.toHaveBeenCalled();
  });

  it("provenance request exists but holds NO live hold on the line: every other act is released, nobody is confirmed", async () => {
    const ctx = build();
    ctx.seedProvenance();
    const other = ctx.seedHold(REQUEST_B);

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    expect(result.confirmed).toEqual([]);
    expect(ctx.bookingHolds.rows.get(other.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    expect(result.staffRecipientHint?.assigneeHumanId).toBe(ASSIGNEE_ID);
  });

  it("multi-date: startsAt's day + each SCHEDULED occurrence day is a line; locked in global sorted order; CANCELLED dates and other calendars untouched", async () => {
    const ctx = build();
    // Occurrences: 06-27 and 06-13 (out of order) SCHEDULED, 07-04 CANCELLED.
    ctx.eventDates.set(EVENT_ID, [
      { startsAt: new Date("2026-06-28T01:00:00.000Z"), status: "SCHEDULED" }, // 06-27 CDT
      { startsAt: new Date("2026-06-14T01:00:00.000Z"), status: "SCHEDULED" }, // 06-13 CDT
      { startsAt: new Date("2026-07-05T01:00:00.000Z"), status: "CANCELLED" }, // 07-04 CDT
    ]);
    const onStart = ctx.seedHold(REQUEST_A);
    const on13 = ctx.seedHold(REQUEST_B, { date: "2026-06-13" });
    const on27 = ctx.seedHold(REQUEST_C, { date: "2026-06-27" });
    const onCancelled = ctx.seedHold(REQUEST_B, { date: "2026-07-04" });
    const otherCalendar = ctx.seedHold(REQUEST_C, { calendarId: OTHER_CALENDAR_ID, date: DATE });
    const notOccupied = ctx.seedHold(REQUEST_A, { date: "2026-06-21" });

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    for (const hold of [onStart, on13, on27]) {
      expect(ctx.bookingHolds.rows.get(hold.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    }
    for (const hold of [onCancelled, otherCalendar, notOccupied]) {
      expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("ACTIVE");
    }
    expect(result.released.map((h) => h.date)).toEqual(["2026-06-13", DATE, "2026-06-27"]);
    // The FIRST lock calls are the up-front global-order sweep (settleLine re-locks re-entrantly after).
    const lockCalls = (ctx.bookingHolds.lockLine as unknown as { mock: { calls: unknown[][] } }).mock.calls.slice(0, 3);
    expect(lockCalls).toEqual([
      [{ calendarId: CALENDAR_ID, date: "2026-06-13" }],
      [{ calendarId: CALENDAR_ID, date: DATE }],
      [{ calendarId: CALENDAR_ID, date: "2026-06-27" }],
    ]);
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dates: ["2026-06-13", DATE, "2026-06-27"] }),
    }));
  });

  it("machine-caused (actor null): ledger actor is null and no routing hint is returned", async () => {
    const ctx = build();
    const hold = ctx.seedHold(REQUEST_A);

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: null, owner: OWNER });

    expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("RELEASED");
    expect(ctx.entries(REQUEST_A)[0]).toMatchObject({ actor: null });
    expect(result.intents).toHaveLength(2);
    expect(result.staffRecipientHint).toBeNull();
  });

  it("own request holds TWO of the event's dates + one it does not occupy: both occupied holds → CONFIRMED (one ledger row each), the other → SIBLING_CONFIRMED, competitors CONFIRMED_OTHER", async () => {
    const ctx = build();
    ctx.seedProvenance();
    // The event occupies DATE (startsAt) and 06-27 (a SCHEDULED occurrence).
    ctx.eventDates.set(EVENT_ID, [{ startsAt: new Date("2026-06-28T01:00:00.000Z"), status: "SCHEDULED" }]);
    const ownOnStart = ctx.seedHold(REQUEST_A);
    const competitorOnStart = ctx.seedHold(REQUEST_B);
    const ownOn27 = ctx.seedHold(REQUEST_A, { date: "2026-06-27" });
    const competitorOn27 = ctx.seedHold(REQUEST_C, { date: "2026-06-27" });
    const sibling = ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-07-04" });

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    // Neither of the request's holds on the event's OWN dates is a sibling of the other.
    expect(ctx.bookingHolds.rows.get(ownOnStart.id)).toMatchObject({ status: "CONFIRMED", confirmedAt: NOW });
    expect(ctx.bookingHolds.rows.get(ownOn27.id)).toMatchObject({ status: "CONFIRMED", confirmedAt: NOW });
    expect(ctx.bookingHolds.rows.get(sibling.id)).toMatchObject({ status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });
    expect(ctx.bookingHolds.rows.get(competitorOnStart.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    expect(ctx.bookingHolds.rows.get(competitorOn27.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    expect(result.confirmed.map((h) => h.id)).toEqual([ownOnStart.id, ownOn27.id]);
    expect(result.released.map((h) => h.id).sort()).toEqual([sibling.id, competitorOnStart.id, competitorOn27.id].sort());

    // Two booking_hold.confirmed rows on the winner's thread, one per taken line;
    // the sibling release is written once, on the first line.
    expect(ctx.entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: sibling.id, reason: "SIBLING_CONFIRMED" }, actor: STAFF_ID },
      { kind: "booking_hold.confirmed", data: { holdId: ownOnStart.id, eventId: EVENT_ID }, actor: STAFF_ID },
      { kind: "booking_hold.confirmed", data: { holdId: ownOn27.id, eventId: EVENT_ID }, actor: STAFF_ID },
    ]);
    expect(result.intents.filter((i) => i.kind === "hold.confirmed").map((i) => i.holdId)).toEqual([ownOnStart.id, ownOn27.id]);
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ confirmedHoldIds: [ownOnStart.id, ownOn27.id], dates: [DATE, "2026-06-27"] }),
    }));
  });

  describe("only a venue-owned or venue-confirmed event takes a line (booking-holds spec, 2026-09-07)", () => {
    it("unconfirmed THIRD-PARTY org event (owner not on the place, no stamp) → NO_OP: no access check, no hold read, no throw", async () => {
      const ctx = build();
      const hold = ctx.seedHold(REQUEST_B);

      const result = await settleHeldDatesForEvent(ctx.tx, {
        event: ctx.event({ orgId: OUTSIDER_ID }),
        now: NOW,
        actorHumanId: STAFF_ID,
        owner: { kind: "org", orgId: OUTSIDER_ID },
      });

      expect(result).toEqual({ confirmed: [], released: [], intents: [], staffRecipientHint: null });
      expect(ctx.repos.authz.getOrgMemberships).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.listForRequest).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.listLine).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("ACTIVE");
      expect(ctx.audit.log).not.toHaveBeenCalled();
    });

    it("unconfirmed third-party HUMAN event → NO_OP; the same human ON the place's access list is venue-owned and takes the line", async () => {
      const noCtx = build();
      const kept = noCtx.seedHold(REQUEST_B);
      const result = await settleHeldDatesForEvent(noCtx.tx, {
        event: noCtx.event({ orgId: null, humanId: STAFF_ID }),
        now: NOW,
        actorHumanId: STAFF_ID,
        owner: { kind: "human", humanId: STAFF_ID },
      });
      expect(result.released).toEqual([]);
      expect(noCtx.bookingHolds.lockLine).not.toHaveBeenCalled();
      expect(noCtx.bookingHolds.rows.get(kept.id)?.status).toBe("ACTIVE");

      const okCtx = build({ place: { humanIdsWithAccess: [STAFF_ID] } });
      const taken = okCtx.seedHold(REQUEST_B);
      await settleHeldDatesForEvent(okCtx.tx, {
        event: okCtx.event({ orgId: null, humanId: STAFF_ID }),
        now: NOW,
        actorHumanId: STAFF_ID,
        owner: { kind: "human", humanId: STAFF_ID },
      });
      expect(okCtx.bookingHolds.rows.get(taken.id)?.status).toBe("RELEASED");
    });

    it("venue-CONFIRMED third-party event (active stamp for this place) takes the line; the owner's place access is NOT re-checked", async () => {
      const ctx = build();
      const hold = ctx.seedHold(REQUEST_B);

      const result = await settleHeldDatesForEvent(ctx.tx, {
        // The owner's own publish: the actor is the third-party owner, who
        // holds no venue authority — the venue's stamp is the authority.
        event: ctx.event({ orgId: OUTSIDER_ID, stamp: true }),
        now: NOW,
        actorHumanId: OUTSIDER_ID,
        owner: { kind: "org", orgId: OUTSIDER_ID },
      });

      expect(ctx.bookingHolds.rows.get(hold.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
      expect(result.released.map((h) => h.id)).toEqual([hold.id]);
    });

    it("a stamp issued for ANOTHER place is not this venue's word (H1) → NO_OP", async () => {
      const ctx = build();
      const hold = ctx.seedHold(REQUEST_B);
      const result = await settleHeldDatesForEvent(ctx.tx, {
        event: ctx.event({ orgId: OUTSIDER_ID, stampedFor: "34343434-3434-4343-8343-343434343434" }),
        now: NOW,
        actorHumanId: STAFF_ID,
        owner: { kind: "org", orgId: OUTSIDER_ID },
      });
      expect(result.released).toEqual([]);
      expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("ACTIVE");
    });

    it("venue-confirmed third-party event on a place that is no longer ACTIVE → PLACE_NOT_ACTIVE, nothing read", async () => {
      const ctx = build({ place: { status: "SUSPENDED" } });
      ctx.seedHold(REQUEST_B);
      await expect(
        settleHeldDatesForEvent(ctx.tx, {
          event: ctx.event({ orgId: OUTSIDER_ID, stamp: true }),
          now: NOW,
          actorHumanId: OUTSIDER_ID,
          owner: { kind: "org", orgId: OUTSIDER_ID },
        }),
      ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
      expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
    });

    it("an UNSTAMPED community listing (no owner) → NO_OP without consulting the actor's staff role", async () => {
      const ctx = build();
      const hold = ctx.seedHold(REQUEST_B);
      const result = await settleHeldDatesForEvent(ctx.tx, {
        event: ctx.event({ orgId: null }),
        now: NOW,
        actorHumanId: OUTSIDER_ID,
        owner: { kind: "community" },
      });
      expect(result.released).toEqual([]);
      expect(ctx.repos.authz.getOrgMemberships).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("ACTIVE");
    });
  });

  describe("place access re-check (before any hold is touched)", () => {
    it("venue-owned event on a place that is no longer ACTIVE → PLACE_NOT_ACTIVE (the save path's own gate)", async () => {
      const ctx = build({ place: { status: "SUSPENDED" } });
      ctx.seedHold(REQUEST_B);

      await expect(
        settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER }),
      ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
      expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    });

    it("STAMPED community listing (no owner): the ACTOR must be venue staff — an EDITOR passes, an outsider is NOT_RESOURCE_OWNER, a VIEWER is INSUFFICIENT_ROLE", async () => {
      const community = { orgId: null, stamp: true } as const;
      const staffCtx = build();
      const taken = staffCtx.seedHold(REQUEST_B);
      await settleHeldDatesForEvent(staffCtx.tx, { event: staffCtx.event(community), now: NOW, actorHumanId: STAFF_ID, owner: { kind: "community" } });
      expect(staffCtx.bookingHolds.rows.get(taken.id)?.status).toBe("RELEASED");

      const outsiderCtx = build();
      outsiderCtx.seedHold(REQUEST_B);
      await expect(
        settleHeldDatesForEvent(outsiderCtx.tx, { event: outsiderCtx.event(community), now: NOW, actorHumanId: OUTSIDER_ID, owner: { kind: "community" } }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(outsiderCtx.bookingHolds.updateStatus).not.toHaveBeenCalled();

      const viewerCtx = build();
      viewerCtx.seedHold(REQUEST_B);
      await expect(
        settleHeldDatesForEvent(viewerCtx.tx, { event: viewerCtx.event(community), now: NOW, actorHumanId: VIEWER_ID, owner: { kind: "community" } }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(viewerCtx.bookingHolds.updateStatus).not.toHaveBeenCalled();
    });

    it("machine-caused (actor null): no access check at all — a suspended place is not what a job re-checks", async () => {
      const ctx = build({ place: { status: "SUSPENDED" } });
      const hold = ctx.seedHold(REQUEST_B);

      await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: null, owner: OWNER });

      expect(ctx.repos.authz.getOrgMemberships).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("RELEASED");
    });

    it("no calendar → neither the gate nor the access check runs (outside the holds world)", async () => {
      const ctx = build({ place: { status: "SUSPENDED" } });
      const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event({ calendarId: null, orgId: OUTSIDER_ID }), now: NOW, actorHumanId: STAFF_ID, owner: { kind: "org", orgId: OUTSIDER_ID } });
      expect(result.intents).toEqual([]);
      expect(ctx.repos.places.getById).not.toHaveBeenCalled();
    });
  });

  describe("explicit provenance (confirmVenueEvent hands in the request it confirms)", () => {
    it("event-first request with no agreement: its own hold WINS on the line and the hint names its assignee", async () => {
      const ctx = build();
      // No thread for this event (no agreement links it) — the default
      // derivation would find nothing and release everyone.
      const own = ctx.seedHold(REQUEST_A);
      const competitor = ctx.seedHold(REQUEST_B);

      const result = await settleHeldDatesForEvent(ctx.tx, {
        event: ctx.event(),
        now: NOW,
        actorHumanId: STAFF_ID,
        owner: OWNER,
        provenanceRequestId: REQUEST_A,
      });

      expect(ctx.repos.agreements.findByLinkedEventId).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(own.id)).toMatchObject({ status: "CONFIRMED" });
      expect(ctx.bookingHolds.rows.get(competitor.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
      expect(result.confirmed.map((h) => h.id)).toEqual([own.id]);
      expect(result.staffRecipientHint?.assigneeHumanId).toBe(ASSIGNEE_ID);
    });

    it("explicit null provenance releases every live hold even when the thread would have found one", async () => {
      const ctx = build();
      ctx.seedProvenance();
      const own = ctx.seedHold(REQUEST_A);

      await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER, provenanceRequestId: null });

      expect(ctx.bookingHolds.rows.get(own.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    });
  });

  it("staff hint on a multi-org venue names the org the ACTOR's access came through", async () => {
    const OTHER_ORG_ID = "23232323-2323-4232-8232-232323232323";
    const ctx = build({
      place: { orgIdsWithAccess: [OTHER_ORG_ID, ORG_ID] },
      memberships: [{ orgId: ORG_ID, humanId: STAFF_ID, role: "EDITOR" }],
    });
    ctx.seedHold(REQUEST_B);

    const result = await settleHeldDatesForEvent(ctx.tx, { event: ctx.event(), now: NOW, actorHumanId: STAFF_ID, owner: OWNER });

    expect(result.staffRecipientHint?.orgId).toBe(ORG_ID);
  });
});

describe("heldDatesOwnerOf", () => {
  it("org → org, human → human, neither → community", () => {
    expect(heldDatesOwnerOf({ orgId: ORG_ID, humanId: null })).toEqual({ kind: "org", orgId: ORG_ID });
    expect(heldDatesOwnerOf({ orgId: null, humanId: STAFF_ID })).toEqual({ kind: "human", humanId: STAFF_ID });
    expect(heldDatesOwnerOf({ orgId: null, humanId: null })).toEqual({ kind: "community" });
  });
});

describe("resolveStaffRecipientOrgId", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const getOrgMemberships = (rows: { orgId: string }[]) => ({ getOrgMemberships: async () => rows as never });

  it("no owning org → null; one → that org, without a membership read", async () => {
    const authz = { getOrgMemberships: async () => { throw new Error("must not read"); } };
    expect(await resolveStaffRecipientOrgId(authz as never, { orgIdsWithAccess: [] }, STAFF_ID)).toBeNull();
    expect(await resolveStaffRecipientOrgId(authz as never, { orgIdsWithAccess: [A] }, STAFF_ID)).toBe(A);
  });

  it("several owning orgs → the actor's, else the first", async () => {
    expect(await resolveStaffRecipientOrgId(getOrgMemberships([{ orgId: B }]) as never, { orgIdsWithAccess: [A, B] }, STAFF_ID)).toBe(B);
    expect(await resolveStaffRecipientOrgId(getOrgMemberships([]) as never, { orgIdsWithAccess: [A, B] }, STAFF_ID)).toBe(A);
  });
});

describe("settleHeldDatesForPublishedEvent (line mechanics only)", () => {
  // booking-the-night P2c, review W1: a settle can CONFIRM the provenance
  // request's hold — book its night — so it takes that request's booking
  // lock first, before any line lock (event row → booking lock → lines).
  it("takes the PROVENANCE request's booking lock before any line lock", async () => {
    const ctx = build();
    ctx.seedProvenance();
    ctx.seedHold(REQUEST_A);

    await settleHeldDatesForPublishedEvent(ctx.tx, {
      eventId: EVENT_ID, calendarId: CALENDAR_ID, occupiedDates: [DATE], provenanceRequestId: REQUEST_A, now: NOW, placeTz: PLACE_TZ, actorHumanId: STAFF_ID,
    });

    const booking = ctx.bookingHolds.lockRequestBooking as unknown as { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
    const lines = ctx.bookingHolds.lockLine as unknown as { mock: { invocationCallOrder: number[] } };
    expect(booking.mock.calls).toEqual([[REQUEST_A]]);
    for (const at of lines.mock.invocationCallOrder) {
      expect(booking.mock.invocationCallOrder[0]!).toBeLessThan(at);
    }
  });

  it("no provenance request → no booking lock", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);
    await settleHeldDatesForPublishedEvent(ctx.tx, {
      eventId: EVENT_ID, calendarId: CALENDAR_ID, occupiedDates: [DATE], provenanceRequestId: null, now: NOW, placeTz: PLACE_TZ, actorHumanId: STAFF_ID,
    });
    expect(ctx.bookingHolds.lockRequestBooking).not.toHaveBeenCalled();
  });

  it("no occupied dates → nothing locked, nothing read", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);
    const result = await settleHeldDatesForPublishedEvent(ctx.tx, {
      eventId: EVENT_ID, calendarId: CALENDAR_ID, occupiedDates: [], provenanceRequestId: null, now: NOW, placeTz: PLACE_TZ, actorHumanId: STAFF_ID,
    });
    expect(result).toEqual({ confirmed: [], released: [], intents: [] });
    expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
    expect(ctx.bookingHolds.listLine).not.toHaveBeenCalled();
  });

  it("a hold placed on a NEW sibling line between the pre-lock read and the locks → HOLD_LINE_CHANGED, nothing written", async () => {
    const ctx = build();
    ctx.seedProvenance();
    ctx.seedHold(REQUEST_A);
    // Sneak a sibling onto an unlocked line the moment the locks are taken.
    let sneaked = false;
    (ctx.bookingHolds.lockLine as unknown as { mockImplementation: (fn: () => Promise<void>) => void }).mockImplementation(async () => {
      if (!sneaked) {
        sneaked = true;
        ctx.seedHold(REQUEST_A, { calendarId: OTHER_CALENDAR_ID, date: "2026-06-29" });
      }
    });

    await expect(
      settleHeldDatesForPublishedEvent(ctx.tx, {
        eventId: EVENT_ID, calendarId: CALENDAR_ID, occupiedDates: [DATE], provenanceRequestId: REQUEST_A, now: NOW, placeTz: PLACE_TZ, actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "HOLD_LINE_CHANGED", meta: { calendarId: OTHER_CALENDAR_ID, date: "2026-06-29", reason: "line_set_grew" } });
    expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
  });

  it("a live member of the LOCKED line losing its release CAS is the lock's contract broken → HOLD_LINE_CHANGED, never a silent skip", async () => {
    const ctx = build();
    ctx.seedHold(REQUEST_A);
    ctx.bookingHolds.failNextUpdateStatus(1);

    await expect(
      settleHeldDatesForPublishedEvent(ctx.tx, {
        eventId: EVENT_ID, calendarId: CALENDAR_ID, occupiedDates: [DATE], provenanceRequestId: null, now: NOW, placeTz: PLACE_TZ, actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "HOLD_LINE_CHANGED", meta: { calendarId: CALENDAR_ID, date: DATE, reason: "locked_line_member_moved" } });
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });

  it("the act's own request id is what wins — not the placer, not the actor", async () => {
    const ctx = build();
    const winner = ctx.seedHold(REQUEST_B, { placedByHumanId: ACT_A_ID });
    const loser = ctx.seedHold(REQUEST_A);
    const result = await settleHeldDatesForPublishedEvent(ctx.tx, {
      eventId: EVENT_ID, calendarId: CALENDAR_ID, occupiedDates: [DATE], provenanceRequestId: REQUEST_B, now: NOW, placeTz: PLACE_TZ, actorHumanId: STAFF_ID,
    });
    expect(result.confirmed.map((h) => h.id)).toEqual([winner.id]);
    expect(ctx.bookingHolds.rows.get(loser.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
  });
});
