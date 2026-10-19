import { describe, expect, it, vi } from "vitest";

import { BOOKING_REASON_MAX } from "../../booking-requests/messages/_shared/system-entries";
import { renderNotification } from "../../comms/renderers";
import {
  dispatchVenueConfirmationIntents,
  type DispatchVenueConfirmationIntentsDeps,
} from "../notify-venue-confirmation-intents";
import {
  WITHDRAW_REASON_MAX,
  withdrawVenueConfirmation,
  withdrawVenueConfirmationInputSchema,
  withdrawVenueConfirmationWireOutputSchema,
} from "../withdraw-venue-confirmation";
import {
  buildVenueConfirmationContext,
  EARLIER,
  EDITOR_ID,
  EVENT_ID,
  NOW,
  OWNER_ID,
  PLACE_ID,
  REQUEST_ID,
  REQUESTER_ID,
  STRANGER_ID,
  VENUE_ORG_ID,
  VIEWER_ID,
} from "./venue-confirmation-test-context";

const REASON = "We double-booked the room that night.";

describe("withdrawVenueConfirmation", () => {
  describe("input", () => {
    it("requires a non-empty reason ≤ 1000 chars (BOOKING_REASON_MAX), sanitized BEFORE the bounds apply", () => {
      const ok = withdrawVenueConfirmationInputSchema.safeParse({
        actorHumanId: OWNER_ID,
        eventId: EVENT_ID,
        reason: "  <b>Not</b> our show  ",
      });
      expect(ok.success).toBe(true);
      if (ok.success) expect(ok.data.reason).toBe("Not our show");
      expect(
        withdrawVenueConfirmationInputSchema.safeParse({ actorHumanId: OWNER_ID, eventId: EVENT_ID, reason: "   " })
          .success,
      ).toBe(false);
      // One cap for every booking reason (FR-013): 1000, shared with the
      // booking thread — the old 500 is gone.
      expect(WITHDRAW_REASON_MAX).toBe(BOOKING_REASON_MAX);
      expect(BOOKING_REASON_MAX).toBe(1000);
      expect(
        withdrawVenueConfirmationInputSchema.safeParse({
          actorHumanId: OWNER_ID,
          eventId: EVENT_ID,
          reason: "x".repeat(1000),
        }).success,
      ).toBe(true);
      expect(
        withdrawVenueConfirmationInputSchema.safeParse({
          actorHumanId: OWNER_ID,
          eventId: EVENT_ID,
          reason: "x".repeat(1001),
        }).success,
      ).toBe(false);
      expect(
        withdrawVenueConfirmationInputSchema.safeParse({ actorHumanId: OWNER_ID, eventId: EVENT_ID }).success,
      ).toBe(false);
    });
  });

  describe("loads + authority", () => {
    it("EVENT_NOT_FOUND before any write — the repo's P2025 is never reached", async () => {
      const ctx = buildVenueConfirmationContext();
      await expect(
        withdrawVenueConfirmation(ctx.deps, {
          actorHumanId: OWNER_ID,
          eventId: "e9e9e9e9-e9e9-4e9e-8e9e-e9e9e9e9e9e9",
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
      expect(ctx.eventsRepo.withdrawVenueConfirmation).not.toHaveBeenCalled();
    });

    it("an address-only event: INVALID_STATUS event_has_no_place", async () => {
      const ctx = buildVenueConfirmationContext({ event: { placeId: null } });
      await expect(
        withdrawVenueConfirmation(ctx.deps, { actorHumanId: OWNER_ID, eventId: EVENT_ID, reason: REASON }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "event_has_no_place" });
    });

    it.each([
      ["a VIEWER-role member", VIEWER_ID, "INSUFFICIENT_ROLE"],
      ["a stranger", STRANGER_ID, "NOT_RESOURCE_OWNER"],
      ["the requester themselves", REQUESTER_ID, "NOT_RESOURCE_OWNER"],
    ])("refuses %s (%s) and writes nothing", async (_label, actorHumanId, code) => {
      const ctx = buildVenueConfirmationContext({ event: { venueConfirmedAt: EARLIER } });
      await expect(
        withdrawVenueConfirmation(ctx.deps, { actorHumanId, eventId: EVENT_ID, reason: REASON }),
      ).rejects.toMatchObject({ code });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
    });

    // holds-without-a-request FR-002: was "withdraws via grant". Withdrawing
    // the place's vouch is staff-only; a grantee is refused, nothing written.
    it("REFUSES a booking grantee and writes nothing", async () => {
      const ctx = buildVenueConfirmationContext({ event: { venueConfirmedAt: EARLIER } });
      ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: STRANGER_ID });
      await expect(
        withdrawVenueConfirmation(ctx.deps, {
          actorHumanId: STRANGER_ID,
          eventId: EVENT_ID,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.eventsRepo.withdrawVenueConfirmation).not.toHaveBeenCalled();
    });
  });

  describe("the withdrawal", () => {
    it("withdraws a confirmed event in ONE tx: keeps placeId, records the reason, audits, tells the owner — no ledger without a request link", async () => {
      const ctx = buildVenueConfirmationContext({
        event: { venueConfirmedAt: EARLIER, venueConfirmedByHumanId: OWNER_ID },
      });
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: REASON,
      });

      expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
      expect(ctx.eventsRepo.withdrawVenueConfirmation).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        placeId: PLACE_ID,
        reason: REASON,
        at: NOW,
      });
      expect(result.alreadyWithdrawn).toBe(false);
      expect(result.event).toEqual({
        eventId: EVENT_ID,
        placeId: PLACE_ID,
        venueConfirmed: false,
        venueOwned: false,
        stamped: false,
        // History is kept; only the withdrawn pair changes.
        venueConfirmedAt: EARLIER,
        venueConfirmedByHumanId: OWNER_ID,
        venueConfirmationRequestId: null,
        venueConfirmationWithdrawnAt: NOW,
        venueConfirmationWithdrawnReason: REASON,
      });
      expect(ctx.events.get(EVENT_ID)?.placeId).toBe(PLACE_ID);
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "event",
          entityId: EVENT_ID,
          action: "event.place_confirmation_withdrawn",
          data: expect.objectContaining({ actorHumanId: EDITOR_ID, reason: REASON, declined: false }),
        }),
      );
      expect(result.notificationIntents).toEqual([
        {
          kind: "event.place_confirmation_withdrawn",
          eventId: EVENT_ID,
          placeId: PLACE_ID,
          bookingRequestId: null,
          recipient: { type: "human", humanId: REQUESTER_ID },
          at: NOW,
          reason: REASON,
        },
      ]);
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });

    it("with the event linked to a request: appends booking_event.place_confirmation_withdrawn { reason } on that thread", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: { venueConfirmedAt: EARLIER, venueConfirmationRequestId: REQUEST_ID },
      });
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: REASON,
      });
      expect(ctx.entries(REQUEST_ID)).toEqual([
        {
          kind: "booking_event.place_confirmation_withdrawn",
          data: { eventId: EVENT_ID, reason: REASON },
          actor: EDITOR_ID,
        },
      ]);
      expect(result.notificationIntents[0]).toMatchObject({ bookingRequestId: REQUEST_ID });
    });

    it("a reason at the full 1000 cap withdraws end to end: the thread entry, the stamp and the owner's intent all carry it", async () => {
      // Pins every bound on the way: the input (1000), the intent schema the
      // output is parsed through (was 500), and the thread entry (1000).
      const long = "r".repeat(BOOKING_REASON_MAX);
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: { venueConfirmedAt: EARLIER, venueConfirmationRequestId: REQUEST_ID },
      });
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: long,
      });
      expect(result.event.venueConfirmationWithdrawnReason).toBe(long);
      expect(result.notificationIntents).toEqual([
        expect.objectContaining({ kind: "event.place_confirmation_withdrawn", reason: long }),
      ]);
      expect(ctx.entries(REQUEST_ID)).toEqual([
        expect.objectContaining({ data: { eventId: EVENT_ID, reason: long } }),
      ]);

      // The owner is TOLD it: the real dispatcher plans the send from the
      // intent, and the real renderer definition renders that payload (its
      // schema was the last 500 bound on this path).
      const notify = vi.fn(async (_input: unknown) => ({ ok: true }));
      await dispatchVenueConfirmationIntents(
        {
          repos: {
            events: { getById: async () => ({ id: EVENT_ID, title: "Loud Band Night" }) },
            places: { getById: async () => ({ id: PLACE_ID, name: "The Corner Stage" }) },
            humans: { getByIdWithIdentity: async () => ({ identity: { username: "sam" } }) },
            organizations: { getById: async () => null, listMembers: async () => ({ items: [], total: 0 }) },
            entityPages: { getByOwner: async () => null },
          } as unknown as DispatchVenueConfirmationIntentsDeps["repos"],
          notify: notify as unknown as DispatchVenueConfirmationIntentsDeps["notify"],
          publicAppUrl: "https://ithasfire.test/",
        },
        { intents: result.notificationIntents },
      );
      expect(notify).toHaveBeenCalledTimes(1);
      const sent = notify.mock.calls[0]![0] as { variant: string; payload: unknown };
      expect(sent.variant).toBe("event.venue-confirmation-withdrawn");
      const rendered = renderNotification(sent.variant, sent.payload, { now: NOW });
      expect(rendered.inApp?.body).toContain(`Reason: ${long}`);
      expect(rendered.email?.text).toContain(long);
    });

    it("a NEVER-confirmed event is a valid target: the withdrawal records a decline ('not mine'), and the audit says so", async () => {
      const ctx = buildVenueConfirmationContext();
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: "Not our event.",
      });
      expect(result.alreadyWithdrawn).toBe(false);
      expect(result.event).toMatchObject({
        venueConfirmed: false,
        venueConfirmedAt: null,
        venueConfirmationWithdrawnAt: NOW,
        venueConfirmationWithdrawnReason: "Not our event.",
      });
      expect(ctx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ declined: true }) }),
      );
      expect(result.notificationIntents).toHaveLength(1);
    });

    it("an ownerless COMMUNITY listing is withdrawn but owes nobody an intent", async () => {
      const ctx = buildVenueConfirmationContext({ event: { orgId: null, humanId: null, venueConfirmedAt: EARLIER } });
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: REASON,
      });
      expect(result.event.venueConfirmed).toBe(false);
      expect(result.notificationIntents).toEqual([]);
    });
  });

  describe("venue-owned refusal", () => {
    it.each([
      ["org-owned", { orgId: VENUE_ORG_ID, humanId: null }],
      ["human-owned", { orgId: null, humanId: OWNER_ID }],
    ])("a %s event is confirmed by construction: INVALID_STATUS venue_owned_event, nothing written", async (_label, owner) => {
      const ctx = buildVenueConfirmationContext({ event: { ...owner, venueConfirmedAt: EARLIER } });
      await expect(
        withdrawVenueConfirmation(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID, reason: REASON }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "venue_owned_event" });
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.eventsRepo.withdrawVenueConfirmation).not.toHaveBeenCalled();
    });
  });

  describe("idempotency", () => {
    it("already withdrawn with the SAME reason: alreadyWithdrawn, nothing appended, no audit, no intent", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: {
          venueConfirmedAt: EARLIER,
          venueConfirmationRequestId: REQUEST_ID,
          venueConfirmationWithdrawnAt: EARLIER,
          venueConfirmationWithdrawnReason: REASON,
        },
      });
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: REASON,
      });
      expect(result.alreadyWithdrawn).toBe(true);
      expect(result.event.venueConfirmationWithdrawnAt).toEqual(EARLIER);
      expect(result.notificationIntents).toEqual([]);
      expect(ctx.repos.tx).not.toHaveBeenCalled();
      expect(ctx.audit.log).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });

    it("already withdrawn with a DIFFERENT reason: overwrites, re-stamps withdrawnAt, appends, and announces again", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: {
          venueConfirmedAt: EARLIER,
          venueConfirmationRequestId: REQUEST_ID,
          venueConfirmationWithdrawnAt: EARLIER,
          venueConfirmationWithdrawnReason: "old reason",
        },
      });
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: REASON,
      });
      expect(result.alreadyWithdrawn).toBe(false);
      expect(result.event).toMatchObject({
        venueConfirmationWithdrawnAt: NOW,
        venueConfirmationWithdrawnReason: REASON,
      });
      expect(ctx.entries(REQUEST_ID).map((e) => e.kind)).toEqual(["booking_event.place_confirmation_withdrawn"]);
      expect(result.notificationIntents[0]).toMatchObject({ reason: REASON, at: NOW });
    });
  });

  describe("H1 — bound to the authorized place", () => {
    it("withdraws with placeId = the place authorized against; the CAS losing is INVALID_STATUS event_moved with nothing written", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: { venueConfirmedAt: EARLIER, venueConfirmationRequestId: REQUEST_ID },
      });
      await withdrawVenueConfirmation(ctx.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID, reason: REASON });
      expect(ctx.eventsRepo.withdrawVenueConfirmation).toHaveBeenCalledWith(expect.objectContaining({ placeId: PLACE_ID }));

      const raced = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: { venueConfirmedAt: EARLIER, venueConfirmationRequestId: REQUEST_ID },
      });
      raced.eventsRepo.withdrawVenueConfirmation.mockRejectedValueOnce({ code: "event_place_mismatch" });
      await expect(
        withdrawVenueConfirmation(raced.deps, { actorHumanId: EDITOR_ID, eventId: EVENT_ID, reason: REASON }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "event_moved" });
      expect(raced.audit.log).not.toHaveBeenCalled();
      expect(raced.entries(REQUEST_ID)).toEqual([]);
    });
  });

  describe("concurrency — the tx re-read", () => {
    it("a withdrawal that raced an identical committed one sees it inside the tx: no second append/audit/intent", async () => {
      const ctx = buildVenueConfirmationContext({
        requests: [{ id: REQUEST_ID }],
        event: { venueConfirmedAt: EARLIER, venueConfirmationRequestId: REQUEST_ID },
      });
      const stale = ctx.events.get(EVENT_ID)!;
      ctx.eventsRepo.getById.mockImplementationOnce(async () => {
        ctx.events.set(EVENT_ID, {
          ...stale,
          venueConfirmationWithdrawnAt: EARLIER,
          venueConfirmationWithdrawnReason: REASON,
        });
        return stale;
      });
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: REASON,
      });
      expect(result.alreadyWithdrawn).toBe(true);
      expect(result.notificationIntents).toEqual([]);
      expect(ctx.eventsRepo.withdrawVenueConfirmation).not.toHaveBeenCalled();
      expect(ctx.audit.log).not.toHaveBeenCalled();
      expect(ctx.entries(REQUEST_ID)).toEqual([]);
    });
  });

  describe("wire shape", () => {
    it("the wire schema strips notificationIntents", async () => {
      const ctx = buildVenueConfirmationContext({ event: { venueConfirmedAt: EARLIER } });
      const result = await withdrawVenueConfirmation(ctx.deps, {
        actorHumanId: EDITOR_ID,
        eventId: EVENT_ID,
        reason: REASON,
      });
      expect(Object.keys(withdrawVenueConfirmationWireOutputSchema.parse(result)).sort()).toEqual([
        "alreadyWithdrawn",
        "event",
      ]);
    });
  });
});
