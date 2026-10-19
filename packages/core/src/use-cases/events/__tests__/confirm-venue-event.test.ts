import { beforeEach, describe, expect, it, vi } from "vitest";

import { LEGACY_OWNER_SIDE } from "../../../lib/legacy-place-values";

import {
  confirmVenueEvent as confirmVenueEventRaw,
  confirmVenueEventInputSchema,
  confirmVenueEventWireOutputSchema,
} from "../confirm-venue-event";
import {
  AGREEMENT_ID,
  buildVenueConfirmationContext,
  CALENDAR_ID,
  EARLIER,
  EDITOR_ID,
  EVENT_ID,
  HELD_DATE,
  NOW,
  OTHER_PLACE_ID,
  OTHER_REQUEST_ID,
  OWNER_ID,
  PLACE_ID,
  REQUEST_ID,
  REQUESTER_ID,
  REQUESTER_ORG_ID,
  STRANGER_ID,
  VENUE_ORG_ID,
  VIEWER_ID,
} from "./venue-confirmation-test-context";

// The shared mint is a boundary here. Since booking-the-night FR-011 (P2c)
// confirm never calls it — the mock stays so every suite can pin that.
const createEventFromAgreementMock = vi.fn();
/**
 * R3-1: every confirm carries the start the venue SAW. The fixture events all
 * start at the stage builder's default, so the suites that are not about the
 * check pass exactly that; the R3-1 suite below passes its own.
 */
const SEEN_STARTS_AT = "2026-09-19T00:00:00.000Z";
type ConfirmArgs = Parameters<typeof confirmVenueEventRaw>;
function confirmVenueEvent(deps: ConfirmArgs[0], input: Record<string, unknown>) {
  return confirmVenueEventRaw(deps, { expectedStartsAt: SEEN_STARTS_AT, ...input });
}

vi.mock("../../booking-agreements/create-event-from-agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../booking-agreements/create-event-from-agreement")>()),
  createEventFromAgreement: (...args: unknown[]) => createEventFromAgreementMock(...args),
}));

beforeEach(() => {
  createEventFromAgreementMock.mockReset();
});

describe("confirmVenueEvent", () => {
  describe("input", () => {
    it("is strict and requires uuids", () => {
      expect(
        confirmVenueEventInputSchema.safeParse({ actorHumanId: OWNER_ID, expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID }).success,
      ).toBe(true);
      expect(
        confirmVenueEventInputSchema.safeParse({ actorHumanId: OWNER_ID, expectedStartsAt: SEEN_STARTS_AT, eventId: "nope" }).success,
      ).toBe(false);
      expect(
        confirmVenueEventInputSchema.safeParse({ actorHumanId: OWNER_ID, expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID, extra: 1 }).success,
      ).toBe(false);
    });

    it("accepts the by-request shape with an optional ownerOverride; an override alongside an eventId is rejected", () => {
      expect(
        confirmVenueEventInputSchema.safeParse({ actorHumanId: OWNER_ID, expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID }).success,
      ).toBe(true);
      expect(
        confirmVenueEventInputSchema.safeParse({ actorHumanId: OWNER_ID, expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID, ownerOverride: "requester" }).success,
      ).toBe(true);
      expect(
        confirmVenueEventInputSchema.safeParse({ actorHumanId: OWNER_ID, expectedStartsAt: SEEN_STARTS_AT, bookingRequestId: REQUEST_ID, ownerOverride: "act" }).success,
      ).toBe(false);
      expect(
        confirmVenueEventInputSchema.safeParse({ actorHumanId: OWNER_ID, expectedStartsAt: SEEN_STARTS_AT, eventId: EVENT_ID, bookingRequestId: REQUEST_ID, ownerOverride: "place" }).success,
      ).toBe(false);
      expect(confirmVenueEventInputSchema.safeParse({ actorHumanId: OWNER_ID }).success).toBe(false);
    });
  });

  describe("loads + authority", () => {
    it("EVENT_NOT_FOUND before any place read or write — the repo's P2025 is never the caller's error", async () => {
      const ctx = buildVenueConfirmationContext();
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: OWNER_ID, eventId: "e9e9e9e9-e9e9-4e9e-8e9e-e9e9e9e9e9e9" }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
      expect(ctx.repos.places.getById).not.toHaveBeenCalled();
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    });

    it("an address-only event (no placeId) cannot be confirmed: INVALID_STATUS event_has_no_place", async () => {
      const ctx = buildVenueConfirmationContext({ event: { placeId: null } });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: OWNER_ID, eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "event_has_no_place" });
    });

    it("PLACE_NOT_FOUND when the event's place vanished", async () => {
      const ctx = buildVenueConfirmationContext({ event: { placeId: OTHER_PLACE_ID } });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: OWNER_ID, eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    });

    it.each([
      ["a VIEWER-role member", VIEWER_ID, "INSUFFICIENT_ROLE"],
      ["a stranger", STRANGER_ID, "NOT_RESOURCE_OWNER"],
      ["the requester themselves", REQUESTER_ID, "NOT_RESOURCE_OWNER"],
    ])("refuses %s (%s) and writes nothing", async (_label, actorHumanId, code) => {
      const ctx = buildVenueConfirmationContext();
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId, eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    });

    it.each([
      ["the direct human owner", OWNER_ID, "human"],
      ["an org EDITOR", EDITOR_ID, "org"],
    ])("%s confirms (via %s)", async (_label, actorHumanId, via) => {
      const ctx = buildVenueConfirmationContext();
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId, eventId: EVENT_ID });
      expect(result.alreadyConfirmed).toBe(false);
      expect(result.event.venueConfirmed).toBe(true);
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "event",
          entityId: EVENT_ID,
          action: "event.place_confirmed",
          data: expect.objectContaining({ actorHumanId, via }),
        }),
      );
      // The staff gate has no grant arm (holds-without-a-request FR-002).
      expect(ctx.audit.log.mock.calls[0]?.[0].data).not.toHaveProperty("grantId");
    });

    // holds-without-a-request FR-002: confirming SOMEONE ELSE's event is the
    // place's call. Was: an active grant on the event's calendar confirmed
    // via grant. Now a grantee is refused like a stranger and nothing is
    // written.
    it("REFUSES a booking grantee (whole-place or on the event's calendar) and writes nothing", async () => {
      for (const calendarId of [null, CALENDAR_ID]) {
        const ctx = buildVenueConfirmationContext();
        ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: STRANGER_ID, calendarId });
        await expect(
          confirmVenueEvent(ctx.deps, { actorHumanId: STRANGER_ID, eventId: EVENT_ID }),
        ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
        expect(ctx.repos.tx).not.toHaveBeenCalled();
        expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
      }
    });
  });

  describe("the stamp", () => {
    it("stamps the event in ONE tx, audits, and owes the requester one intent — no ledger entry without a request", async () => {
      const ctx = buildVenueConfirmationContext();
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });

      expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
      expect(ctx.eventsRepo.setVenueConfirmation).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        placeId: PLACE_ID,
        confirmedByHumanId: EDITOR_ID,
        bookingRequestId: null,
        at: NOW,
        // R3-1: the CAS pins the start the venue saw.
        expectedStartsAt: new Date(SEEN_STARTS_AT),
      });
      expect(result.event).toEqual({
        eventId: EVENT_ID,
        placeId: PLACE_ID,
        venueConfirmed: true,
        venueOwned: false,
        stamped: true,
        venueConfirmedAt: NOW,
        venueConfirmedByHumanId: EDITOR_ID,
        venueConfirmationRequestId: null,
        venueConfirmationWithdrawnAt: null,
        venueConfirmationWithdrawnReason: null,
      });
      expect(result.notificationIntents).toEqual([
        {
          kind: "event.place_confirmed",
          eventId: EVENT_ID,
          placeId: PLACE_ID,
          bookingRequestId: null,
          recipient: { type: "human", humanId: REQUESTER_ID },
          at: NOW,
        },
      ]);
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });

    it("with a linked request: appends booking_event.place_confirmed { ownerSide: requester } on that thread and links it on the stamp", async () => {
      const ctx = buildVenueConfirmationContext({ requests: [{ id: REQUEST_ID }] });
      const result = await confirmVenueEvent(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        bookingRequestId: REQUEST_ID,
      });
      expect(ctx.eventsRepo.setVenueConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ bookingRequestId: REQUEST_ID }),
      );
      expect(result.event.venueConfirmationRequestId).toBe(REQUEST_ID);
      expect(ctx.entries(REQUEST_ID)).toEqual([
        {
          kind: "booking_event.place_confirmed",
          data: { eventId: EVENT_ID, ownerSide: "requester" },
          actor: EDITOR_ID,
        },
      ]);
      expect(result.notificationIntents[0]).toMatchObject({ bookingRequestId: REQUEST_ID });
    });

    it("an org-owned third-party event routes the intent to the org", async () => {
      const ctx = buildVenueConfirmationContext({ event: { orgId: REQUESTER_ORG_ID, humanId: null } });
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });
      expect(result.notificationIntents[0]?.recipient).toEqual({ type: "org", orgId: REQUESTER_ORG_ID });
    });

    it("an ownerless COMMUNITY listing is stamped but owes nobody an intent", async () => {
      const ctx = buildVenueConfirmationContext({ event: { orgId: null, humanId: null } });
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });
      expect(result.event.venueConfirmed).toBe(true);
      expect(result.notificationIntents).toEqual([]);
    });

    it("BOOKING_REQUEST_NOT_FOUND for an unknown request; INVALID_INPUT for a request at ANOTHER place — nothing written either way", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, placeId: OTHER_PLACE_ID }],
      });
      await expect(
        confirmVenueEvent(ctx.deps, {
          actorHumanId: EDITOR_ID,
          eventId: EVENT_ID,
          bookingRequestId: "45454545-4545-4545-8545-454545454545",
        }),
      ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
      await expect(
        confirmVenueEvent(ctx.deps, {
          actorHumanId: EDITOR_ID,
          eventId: EVENT_ID,
          bookingRequestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "booking_request_place_mismatch" });
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    });

    it("re-confirming a WITHDRAWN event clears the withdrawal, keeps the earlier request link, and announces again", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: {
          venueConfirmedAt: EARLIER,
          venueConfirmedByHumanId: OWNER_ID,
          venueConfirmationRequestId: REQUEST_ID,
          venueConfirmationWithdrawnAt: EARLIER,
          venueConfirmationWithdrawnReason: "double booked",
        },
      });
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });
      expect(result.alreadyConfirmed).toBe(false);
      expect(result.event).toMatchObject({
        venueConfirmed: true,
        venueConfirmedAt: NOW,
        venueConfirmationRequestId: REQUEST_ID,
        venueConfirmationWithdrawnAt: null,
        venueConfirmationWithdrawnReason: null,
      });
      expect(ctx.entries(REQUEST_ID).map((e) => e.kind)).toEqual(["booking_event.place_confirmed"]);
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reconfirmed: true }) }),
      );
      expect(result.notificationIntents).toHaveLength(1);
    });
  });

  describe("request link — owner and status", () => {
    it("a request from ANOTHER act (human owner pair) cannot be attached: INVALID_INPUT booking_request_owner_mismatch", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, performerOwnerType: "human", performerOwnerId: STRANGER_ID }],
      });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "booking_request_owner_mismatch" });
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });

    it("an org-act request matches only an event owned by that org", async () => {
      const mismatch = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, performerOwnerType: "organization", performerOwnerId: REQUESTER_ORG_ID }],
      });
      await expect(
        confirmVenueEvent(mismatch.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "booking_request_owner_mismatch" });

      const match = buildVenueConfirmationContext({
        event: { orgId: REQUESTER_ORG_ID, humanId: null },
        requests: [{ id: REQUEST_ID, performerOwnerType: "organization", performerOwnerId: REQUESTER_ORG_ID }],
      });
      const result = await confirmVenueEvent(match.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        bookingRequestId: REQUEST_ID,
      });
      expect(result.event.venueConfirmationRequestId).toBe(REQUEST_ID);
    });

    it("an ANONYMOUS request (no owner pair) passes the owner check", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, performerOwnerType: null, performerOwnerId: null } as never],
      });
      const result = await confirmVenueEvent(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        bookingRequestId: REQUEST_ID,
      });
      expect(result.event.venueConfirmationRequestId).toBe(REQUEST_ID);
      expect(ctx.entries(REQUEST_ID).map((e) => e.kind)).toEqual(["booking_event.place_confirmed"]);
    });

    it.each(["DECLINED", "WITHDRAWN", "EXPIRED"] as const)(
      "a %s request is closed: INVALID_STATUS booking_request_closed, nothing written",
      async (status) => {
        const ctx = buildVenueConfirmationContext({ requests: [{ id: REQUEST_ID, status }] });
        await expect(
          confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID, bookingRequestId: REQUEST_ID }),
        ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_request_closed" });
        expect(ctx.repos.tx).not.toHaveBeenCalled();
      },
    );

    it.each(["PENDING", "VIEWED", "ACCEPTED"] as const)("a %s request is attachable", async (status) => {
      const ctx = buildVenueConfirmationContext({ requests: [{ id: REQUEST_ID, status }] });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID, bookingRequestId: REQUEST_ID }),
      ).resolves.toMatchObject({ alreadyConfirmed: false });
    });
  });

  describe("H1 — the stamp is bound to the authorized place", () => {
    it("stamps with placeId = the place authorized against, and the record carries venueConfirmedPlaceId", async () => {
      const ctx = buildVenueConfirmationContext();
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });
      expect(ctx.eventsRepo.setVenueConfirmation).toHaveBeenCalledWith(expect.objectContaining({ placeId: PLACE_ID }));
      expect(ctx.events.get(EVENT_ID)?.venueConfirmedPlaceId).toBe(PLACE_ID);
      expect(result.event.venueConfirmed).toBe(true);
    });

    it("a stamp issued for ANOTHER place reads as unconfirmed here, and confirming re-stamps for this one", async () => {
      const ctx = buildVenueConfirmationContext({
        event: { venueConfirmedAt: EARLIER, venueConfirmedPlaceId: OTHER_PLACE_ID },
      });
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });
      expect(result.alreadyConfirmed).toBe(false);
      expect(result.event).toMatchObject({ venueConfirmed: true, venueConfirmedAt: NOW });
      expect(ctx.events.get(EVENT_ID)?.venueConfirmedPlaceId).toBe(PLACE_ID);
    });

    it("the CAS losing (event moved after the read) is INVALID_STATUS event_moved — no ledger, audit or intent", async () => {
      const ctx = buildVenueConfirmationContext({ requests: [{ id: REQUEST_ID }] });
      ctx.eventsRepo.setVenueConfirmation.mockRejectedValueOnce({ code: "event_place_mismatch" });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "event_moved", meta: { eventId: EVENT_ID, placeId: PLACE_ID } });
      expect(ctx.audit.log).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });
  });

  describe("concurrency — the tx re-read", () => {
    it("a confirm that raced a committed one sees it inside the tx: no second stamp, ledger, audit or intent", async () => {
      const ctx = buildVenueConfirmationContext({ requests: [{ id: REQUEST_ID }] });
      const stale = ctx.events.get(EVENT_ID)!;
      // Pre-tx read returns the unconfirmed row; a concurrent writer commits
      // before our tx re-reads it.
      ctx.eventsRepo.getById.mockImplementationOnce(async () => {
        ctx.events.set(EVENT_ID, {
          ...stale,
          venueConfirmedAt: EARLIER,
          venueConfirmedPlaceId: PLACE_ID,
          venueConfirmedByHumanId: OWNER_ID,
          venueConfirmationRequestId: REQUEST_ID,
          // What the adapter's stamp records (N1).
          venueConfirmedStartsAt: stale.startsAt,
        });
        return stale;
      });
      const result = await confirmVenueEvent(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        bookingRequestId: REQUEST_ID,
      });
      expect(result.alreadyConfirmed).toBe(true);
      expect(result.event).toMatchObject({ venueConfirmedAt: EARLIER, venueConfirmedByHumanId: OWNER_ID });
      expect(result.notificationIntents).toEqual([]);
      expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
      expect(ctx.audit.log).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });
  });

  describe("venue-owned events (confirmed by construction)", () => {
    it.each([
      ["org-owned", { orgId: VENUE_ORG_ID, humanId: null }],
      ["human-owned", { orgId: null, humanId: OWNER_ID }],
    ])("a %s event IS stamped (SQL-read consistency) but the owner is NOT told, and the ledger says ownerSide: venue", async (_label, owner) => {
      const ctx = buildVenueConfirmationContext({ event: owner, requests: [{ id: REQUEST_ID }] });
      const before = ctx.events.get(EVENT_ID)!;
      expect(before.venueConfirmedAt ?? null).toBeNull();

      const result = await confirmVenueEvent(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        bookingRequestId: REQUEST_ID,
      });
      expect(result.event).toMatchObject({ venueOwned: true, venueConfirmed: true, stamped: true });
      expect(ctx.eventsRepo.setVenueConfirmation).toHaveBeenCalledTimes(1);
      expect(result.notificationIntents).toEqual([]);
      expect(ctx.entries(REQUEST_ID)).toEqual([
        {
          kind: "booking_event.place_confirmed",
          data: { eventId: EVENT_ID, ownerSide: "place" },
          actor: EDITOR_ID,
        },
      ]);
    });
  });

  describe("idempotency", () => {
    it("an already-stamped, not-withdrawn event returns alreadyConfirmed with the current state — no tx, no ledger, no audit, no intent", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: {
          venueConfirmedAt: EARLIER,
          venueConfirmedByHumanId: OWNER_ID,
          venueConfirmationRequestId: REQUEST_ID,
        },
      });
      const result = await confirmVenueEvent(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        bookingRequestId: REQUEST_ID,
      });
      expect(result.alreadyConfirmed).toBe(true);
      expect(result.event).toMatchObject({
        venueConfirmed: true,
        venueConfirmedAt: EARLIER,
        venueConfirmedByHumanId: OWNER_ID,
      });
      expect(result.notificationIntents).toEqual([]);
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.audit.log).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });

    it("calling twice stamps once and announces once", async () => {
      const ctx = buildVenueConfirmationContext();
      const first = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });
      const second = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });
      expect(first.notificationIntents).toHaveLength(1);
      expect(second).toMatchObject({ alreadyConfirmed: true, notificationIntents: [] });
      expect(ctx.eventsRepo.setVenueConfirmation).toHaveBeenCalledTimes(1);
    });
  });

  describe("wire shape", () => {
    it("the wire schema strips every intent + the routing hint and nothing else", async () => {
      const ctx = buildVenueConfirmationContext();
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });
      expect(Object.keys(result).sort()).toEqual([
        "alreadyConfirmed",
        "event",
        "holdNotificationIntents",
        "minted",
        "notificationIntents",
        "staffRecipientHint",
      ]);
      const wire = confirmVenueEventWireOutputSchema.parse(result);
      expect(Object.keys(wire).sort()).toEqual(["alreadyConfirmed", "event", "minted"]);
      expect(confirmVenueEventWireOutputSchema.safeParse({ ...wire, notificationIntents: [] }).success).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Request variant — the event is resolved (or minted) from the request
  // (spec Use Cases › Confirmation: "minting first via the existing path when
  // there is no event yet — with ownerOverride defaulting by intent").
  // ───────────────────────────────────────────────────────────────────────────
  describe("by booking request", () => {
    it("event-first (originEventId): stamps THAT event, links the request, ledger ownerSide: requester — no mint", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, originEventId: EVENT_ID, intent: "RENT" }],
      });
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID });

      expect(createEventFromAgreementMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ alreadyConfirmed: false, minted: false });
      expect(result.event).toMatchObject({ eventId: EVENT_ID, venueConfirmed: true, venueConfirmationRequestId: REQUEST_ID });
      expect(ctx.eventsRepo.setVenueConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: EVENT_ID, placeId: PLACE_ID, bookingRequestId: REQUEST_ID }),
      );
      expect(ctx.entries(REQUEST_ID)).toEqual([
        { kind: "booking_event.place_confirmed", data: { eventId: EVENT_ID, ownerSide: "requester" }, actor: EDITOR_ID },
      ]);
      expect(result.notificationIntents).toEqual([
        expect.objectContaining({ kind: "event.place_confirmed", eventId: EVENT_ID, bookingRequestId: REQUEST_ID, recipient: { type: "human", humanId: REQUESTER_ID } }),
      ]);
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "event.place_confirmed", data: expect.objectContaining({ ownerSide: "requester", minted: false }) }),
      );
    });

    // booking-the-night N15 / FR-011: venue confirmation is for events built
    // FIRST. A request that was not created from an event is booked by the
    // sender agreeing terms (or the venue booking without terms) — the
    // request variant refuses it before anything is read, minted, booked or
    // stamped, whatever its agreement anchors.
    it.each([
      ["terms finalize-linked to an event", { requests: [{ id: REQUEST_ID, agreementId: AGREEMENT_ID, status: "ACCEPTED" }], agreements: [{ id: AGREEMENT_ID, eventId: EVENT_ID }] }],
      ["terms anchoring a LIVE minted draft", { requests: [{ id: REQUEST_ID, agreementId: AGREEMENT_ID, status: "ACCEPTED" }], agreements: [{ id: AGREEMENT_ID, draftEventId: EVENT_ID }] }],
      ["agreed terms with no event yet (the old mint-first path)", { requests: [{ id: REQUEST_ID, agreementId: AGREEMENT_ID, status: "ACCEPTED", intent: "USE" }], agreements: [{ id: AGREEMENT_ID }] }],
      ["an open request with no terms", { requests: [{ id: REQUEST_ID, status: "PENDING" }] }],
    ])("a request with NO origin event (%s) → VENUE_CONFIRMATION_NOT_FOR_REQUESTS: nothing minted, booked or stamped", async (_label, shape) => {
      const ctx = buildVenueConfirmationContext(shape as never);
      ctx.seedHold(REQUEST_ID);

      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "VENUE_CONFIRMATION_NOT_FOR_REQUESTS", meta: { bookingRequestId: REQUEST_ID } });
      expect(createEventFromAgreementMock).not.toHaveBeenCalled();
      expect(ctx.eventsRepo.getById).not.toHaveBeenCalled();
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });

    it("FR-011 is asked AFTER the venue authority: a stranger on such a request is NOT_RESOURCE_OWNER, never told what the request is", async () => {
      const ctx = buildVenueConfirmationContext({ requests: [{ id: REQUEST_ID, status: "PENDING" }] });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: STRANGER_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });

    it("the venue-calendar (by EVENT) confirm still links a non-event-first request: unchanged by FR-011", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, agreementId: AGREEMENT_ID, status: "ACCEPTED" }],
        agreements: [{ id: AGREEMENT_ID }],
      });
      const result = await confirmVenueEvent(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        bookingRequestId: REQUEST_ID,
      });
      expect(result).toMatchObject({ alreadyConfirmed: false, minted: false, event: { eventId: EVENT_ID, venueConfirmed: true } });
    });

    it("ownerOverride on an EXISTING event may only agree with it: INVALID_STATUS owner_override_conflicts_with_event, nothing written", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }],
      });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID, ownerOverride: "place" }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "owner_override_conflicts_with_event", meta: { ownerSide: "requester", ownerOverride: "place" } });
      // A web build from before 2026-10-18 sends the old spelling: read as "place".
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID, ownerOverride: LEGACY_OWNER_SIDE }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "owner_override_conflicts_with_event", meta: { ownerSide: "requester", ownerOverride: "place" } });
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();

      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID, ownerOverride: "requester" }),
      ).resolves.toMatchObject({ alreadyConfirmed: false });
    });

    it("venue-side authority on the REQUEST's place is asserted before any event is read: a stranger is NOT_RESOURCE_OWNER, a VIEWER INSUFFICIENT_ROLE", async () => {
      for (const [actorHumanId, code] of [[STRANGER_ID, "NOT_RESOURCE_OWNER"], [VIEWER_ID, "INSUFFICIENT_ROLE"]] as const) {
        const ctx = buildVenueConfirmationContext({ requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }] });
        await expect(
          confirmVenueEvent(ctx.deps, { actorHumanId, bookingRequestId: REQUEST_ID }),
        ).rejects.toMatchObject({ code });
        expect(ctx.eventsRepo.getById).not.toHaveBeenCalled();
        expect(createEventFromAgreementMock).not.toHaveBeenCalled();
      }
    });

    it("BOOKING_REQUEST_NOT_FOUND / closed / TO_PERFORMER requests are refused before anything is read", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [
          { id: REQUEST_ID, status: "DECLINED", originEventId: EVENT_ID },
          { id: OTHER_REQUEST_ID, direction: "TO_PERFORMER", originEventId: EVENT_ID } as never,
        ],
      });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: "45454545-4545-4545-8545-45454545dead" }),
      ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_request_closed" });
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: OTHER_REQUEST_ID }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "booking_request_not_venue_bound" });
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    });

    it("the resolved event must still be at the request's place (an origin event that moved → booking_request_place_mismatch, nothing written)", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, originEventId: EVENT_ID, placeId: OTHER_PLACE_ID }],
      });
      // The venue owns BOTH places; the request was made at OTHER_PLACE_ID
      // and its origin event has since moved to PLACE_ID.
      ctx.repos.places.getById = vi.fn(async (id: string) =>
        id === OTHER_PLACE_ID ? { ...ctx.place, id: OTHER_PLACE_ID } : id === PLACE_ID ? ctx.place : null,
      ) as typeof ctx.repos.places.getById;
      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "booking_request_place_mismatch" });
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Confirmation takes the line (booking-holds spec, 2026-09-07).
  // ───────────────────────────────────────────────────────────────────────────
  describe("confirmation takes the line", () => {
    it("PUBLISHED event on a calendar: the request's own hold is CONFIRMED, competitors lose the date, intents + hint ride the output, all in the one tx", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }, { id: OTHER_REQUEST_ID, performerOwnerId: STRANGER_ID }],
      });
      const own = ctx.seedHold(REQUEST_ID);
      const competitor = ctx.seedHold(OTHER_REQUEST_ID);

      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID });

      expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
      expect(ctx.bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, date: HELD_DATE });
      expect(ctx.bookingHolds.rows.get(own.id)).toMatchObject({ status: "CONFIRMED", confirmedAt: NOW });
      expect(ctx.bookingHolds.rows.get(competitor.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
      expect(result.holdNotificationIntents.map((i) => [i.kind, i.bookingRequestId])).toEqual([
        ["hold.confirmed", REQUEST_ID],
        ["hold.lost_date", OTHER_REQUEST_ID],
      ]);
      expect(result.staffRecipientHint).toEqual({
        assigneeHumanId: null,
        placedByHumanId: EDITOR_ID,
        orgId: VENUE_ORG_ID,
        placeId: PLACE_ID,
      });
      expect(ctx.entries(REQUEST_ID).map((e) => e.kind)).toEqual(["booking_hold.confirmed", "booking_event.place_confirmed"]);
      expect(ctx.entries(REQUEST_ID)[0]).toMatchObject({ data: { holdId: own.id, eventId: EVENT_ID } });
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "event.place_confirmed",
          data: expect.objectContaining({ heldDatesConfirmed: [own.id], heldDatesReleased: [competitor.id] }),
        }),
      );
    });

    it("direct confirm by eventId: provenance comes from the event's booking thread", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, agreementId: AGREEMENT_ID, status: "ACCEPTED" }],
        agreements: [{ id: AGREEMENT_ID, eventId: EVENT_ID }],
      });
      const own = ctx.seedHold(REQUEST_ID);

      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID });

      expect(ctx.bookingHolds.rows.get(own.id)).toMatchObject({ status: "CONFIRMED" });
      expect(result.holdNotificationIntents.map((i) => i.kind)).toEqual(["hold.confirmed"]);
    });

    it.each([
      ["a DRAFT", { status: "DRAFT" as const }],
      ["an event with no calendar", { calendarId: null }],
    ])("%s takes nothing: no hold read, empty hold intents, null hint", async (_label, event) => {
      const ctx = buildVenueConfirmationContext({ event, requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }] });
      const hold = ctx.seedHold(OTHER_REQUEST_ID);
      const result = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID });
      expect(result.event.venueConfirmed).toBe(true);
      expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("ACTIVE");
      expect(result.holdNotificationIntents).toEqual([]);
      expect(result.staffRecipientHint).toBeNull();
    });

    it("an already-confirmed event takes nothing on a repeat confirm", async () => {
      const ctx = buildVenueConfirmationContext({ requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }] });
      await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID });
      ctx.bookingHolds.lockLine.mockClear();
      const hold = ctx.seedHold(OTHER_REQUEST_ID);
      const replay = await confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID });
      expect(replay.alreadyConfirmed).toBe(true);
      expect(ctx.bookingHolds.lockLine).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(hold.id)?.status).toBe("ACTIVE");
    });

    it("an OPEN challenge on the line refuses the confirmation: HOLD_LINE_HAS_OPEN_CHALLENGE, the stamp rolls back with it, no ledger / audit / intent", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }, { id: OTHER_REQUEST_ID, performerOwnerId: STRANGER_ID }],
      });
      const challenged = ctx.seedHold(OTHER_REQUEST_ID, {
        status: "CHALLENGED",
        challengedAt: NOW,
        respondBy: new Date("2026-09-04T12:00:00.000Z"),
      });
      // The harness tx is passthrough; emulate the rollback the real one
      // performs so the assertion is about the committed state.
      const originalTx = ctx.repos.tx;
      ctx.repos.tx = (async (fn: (tx: unknown) => Promise<unknown>) => {
        const snapshot = new Map(ctx.events);
        try {
          return await originalTx(fn as never);
        } catch (err) {
          ctx.events.clear();
          for (const [k, v] of snapshot) ctx.events.set(k, v);
          throw err;
        }
      }) as typeof ctx.repos.tx;

      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({
        code: "HOLD_LINE_HAS_OPEN_CHALLENGE",
        meta: { challengedHoldId: challenged.id, calendarId: CALENDAR_ID, date: HELD_DATE },
      });

      expect(ctx.eventsRepo.setVenueConfirmation).toHaveBeenCalledTimes(1); // attempted, then rolled back
      expect(ctx.events.get(EVENT_ID)?.venueConfirmedAt ?? null).toBeNull();
      expect(ctx.bookingHolds.updateStatus).not.toHaveBeenCalled();
      expect(ctx.bookingHolds.rows.get(challenged.id)?.status).toBe("CHALLENGED");
      expect(ctx.audit.log).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });
  });
});

// booking-the-night review round 4: the request variant applies the same
// event resolution as every booking path (spec N11, owner rulings
// 2026-10-01). Since P2c (FR-011) it only serves event-first requests and
// never mints, so no night is ever booked through it.
describe("confirmVenueEvent (request variant) — the shared booking rules (review round 4)", () => {
  const DRAFT_ID = "d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5";

  it.each([["CANCELLED"], ["ARCHIVED"]])(
    "an event-first request whose origin is %s → INVALID_STATUS event_first_origin_not_live: nothing minted, stamped or booked",
    async (status) => {
      const ctx = buildVenueConfirmationContext({
        event: { status: status as never },
        requests: [{ id: REQUEST_ID, originEventId: EVENT_ID, intent: "RENT" }],
      });

      await expect(
        confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "event_first_origin_not_live", meta: { eventId: EVENT_ID } });
      expect(createEventFromAgreementMock).not.toHaveBeenCalled();
      expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
      expect(ctx.repos.tx).not.toHaveBeenCalled();
    },
  );

  it("a dead origin with a LIVE legacy draft anchored → still refused (no legacy-draft exception)", async () => {
    const ctx = buildVenueConfirmationContext({
      event: { status: "CANCELLED" },
      requests: [{ id: REQUEST_ID, originEventId: EVENT_ID, agreementId: AGREEMENT_ID, status: "ACCEPTED" }],
      agreements: [{ id: AGREEMENT_ID, draftEventId: DRAFT_ID }],
    });
    ctx.seedEvent({ id: DRAFT_ID, status: "DRAFT" });

    await expect(
      confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "event_first_origin_not_live" });
    expect(createEventFromAgreementMock).not.toHaveBeenCalled();
    expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
  });

  it("event-first, terms finalized against an event that is now CANCELLED → INVALID_STATUS linked_event_not_live, nothing stamped", async () => {
    const LINKED_ID = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
    const ctx = buildVenueConfirmationContext({
      requests: [{ id: REQUEST_ID, originEventId: EVENT_ID, agreementId: AGREEMENT_ID, status: "ACCEPTED" }],
      agreements: [{ id: AGREEMENT_ID, eventId: LINKED_ID }],
    });
    ctx.seedEvent({ id: LINKED_ID, status: "CANCELLED" });

    await expect(
      confirmVenueEvent(ctx.deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "linked_event_not_live", meta: { eventId: LINKED_ID } });
    expect(createEventFromAgreementMock).not.toHaveBeenCalled();
    expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
  });

});

describe("confirmVenueEvent — R3-1: a confirmation is a vouch for the DATE the venue saw", () => {
  it("a show the organizer moved after the venue's screen loaded: EVENT_MOVED, nothing written", async () => {
    const ctx = buildVenueConfirmationContext();
    await expect(
      confirmVenueEvent(ctx.deps, {
        actorHumanId: OWNER_ID,
        eventId: EVENT_ID,
        // The venue's stale screen showed a later date.
        expectedStartsAt: "2026-12-10T01:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "EVENT_MOVED",
      meta: {
        eventId: EVENT_ID,
        expectedStartsAt: "2026-12-10T01:00:00.000Z",
        startsAt: SEEN_STARTS_AT,
      },
    });
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("a move that lands between the check and the write is refused by the stamp's CAS: EVENT_MOVED, no stamp", async () => {
    const ctx = buildVenueConfirmationContext();
    const seen = ctx.events.get(EVENT_ID)!;
    // The pre-tx read sees the date the venue saw; the organizer's move
    // commits before the stamp.
    ctx.eventsRepo.getById.mockImplementationOnce(async () => {
      ctx.events.set(EVENT_ID, {
        ...seen,
        startsAt: new Date("2026-09-12T00:00:00.000Z"),
      });
      return seen;
    });

    await expect(
      confirmVenueEvent(ctx.deps, { actorHumanId: OWNER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_MOVED" });
    const row = ctx.events.get(EVENT_ID)!;
    expect(row.venueConfirmedAt ?? null).toBeNull();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("the matching date stamps, and records it as the confirmed start", async () => {
    const ctx = buildVenueConfirmationContext();

    const result = await confirmVenueEvent(ctx.deps, {
      actorHumanId: OWNER_ID,
      eventId: EVENT_ID,
    });

    expect(result.alreadyConfirmed).toBe(false);
    expect(ctx.events.get(EVENT_ID)!.venueConfirmedStartsAt).toEqual(
      new Date(SEEN_STARTS_AT),
    );
  });

  it("a stamp for a date the organizer has since moved away from is NOT 'already confirmed': confirming the new date the venue sees re-stamps it", async () => {
    const ctx = buildVenueConfirmationContext({
      event: {
        venueConfirmedAt: new Date("2026-09-01T00:00:00.000Z"),
        venueConfirmedStartsAt: new Date("2026-12-10T01:00:00.000Z"),
      },
    });

    const result = await confirmVenueEvent(ctx.deps, {
      actorHumanId: OWNER_ID,
      eventId: EVENT_ID,
    });

    expect(result.alreadyConfirmed).toBe(false);
    expect(ctx.eventsRepo.setVenueConfirmation).toHaveBeenCalledTimes(1);
    expect(ctx.events.get(EVENT_ID)!.venueConfirmedStartsAt).toEqual(
      new Date(SEEN_STARTS_AT),
    );
  });

  it("the request variant compares too when the event already exists (event-first)", async () => {
    const ctx = buildVenueConfirmationContext({
      requests: [{ id: REQUEST_ID, originEventId: EVENT_ID }],
    });
    await expect(
      confirmVenueEvent(ctx.deps, {
        actorHumanId: OWNER_ID,
        bookingRequestId: REQUEST_ID,
        expectedStartsAt: "2026-12-10T01:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "EVENT_MOVED" });
    expect(ctx.eventsRepo.setVenueConfirmation).not.toHaveBeenCalled();
  });
});

describe("confirmVenueEvent — follower outbox (the venue's page only)", () => {
  const ANNOUNCEABLE = { gateType: "NONE", visibility: "PUBLIC", locationMode: "EXACT" } as const;
  function withFollowFakes(ctx: ReturnType<typeof buildVenueConfirmationContext>) {
    const enqueue = vi.fn();
    const getByOwner = vi.fn(async (type: string, id: string) => ({ id: `${type}:${id}`, ownerType: type, ownerId: id, visibility: "PUBLIC", allowFollows: true }));
    const original = ctx.repos.tx;
    (ctx.repos as { tx: unknown }).tx = vi.fn((fn: (tx: any) => unknown) =>
      original(async (tx: any) => fn({ ...tx, entityPages: { getByOwner }, entityEventNotices: { enqueue } })));
    return { enqueue, getByOwner };
  }

  it("stamping a published, public, ungated event enqueues the venue's page and nothing else", async () => {
    const ctx = buildVenueConfirmationContext({ event: ANNOUNCEABLE, place: { locationMode: "EXACT" } });
    const { enqueue } = withFollowFakes(ctx);
    await confirmVenueEvent(ctx.deps, { actorHumanId: OWNER_ID, eventId: EVENT_ID });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({ entityPageId: `PLACE:${PLACE_ID}`, eventId: EVENT_ID, at: NOW });
  });

  it.each([
    ["a DRAFT", { status: "DRAFT" }],
    ["a gated event", { gateType: "PASSWORD" }],
    ["an event with no gateType (fails closed)", { gateType: undefined }],
    ["a private event", { visibility: "PRIVATE" }],
  ] as const)("stamping %s enqueues nothing", async (_label, patch) => {
    const ctx = buildVenueConfirmationContext({ event: { ...ANNOUNCEABLE, ...patch } as never, place: { locationMode: "EXACT" } });
    const { enqueue } = withFollowFakes(ctx);
    await confirmVenueEvent(ctx.deps, { actorHumanId: OWNER_ID, eventId: EVENT_ID });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a private-address venue enqueues nothing even when it stamps", async () => {
    const ctx = buildVenueConfirmationContext({ event: ANNOUNCEABLE, place: { locationMode: "OBSCURED" } });
    const { enqueue } = withFollowFakes(ctx);
    await confirmVenueEvent(ctx.deps, { actorHumanId: OWNER_ID, eventId: EVENT_ID });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
