import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrgMembership, OrgRole } from "@th/ports/repos/authz";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  getEventProvenance,
  type GetEventProvenanceDeps,
} from "../get-event-provenance";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_HUMAN_ID = "bbbb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_ID = "cccc0000-cccc-4ccc-8ccc-cccccccccccc";
const FOREIGN_ORG_ID = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const EVENT_ID = "dddd0000-dddd-4ddd-8ddd-dddddddddddd";
const PLACE_ID = "eeee0000-eeee-4eee-8eee-eeeeeeeeeeee";
const FOREIGN_PLACE_ID = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
const AGREEMENT_ID = "ffff0000-ffff-4fff-8fff-ffffffffffff";
const REQUEST_ID = "12340000-1234-4234-8234-123412341234";
const PERFORMER_HUMAN_ID = "56780000-5678-4678-8678-567856785678";
const PERFORMER_ORG_ID = "9abc0000-9abc-4abc-8abc-9abc9abc9abc";
const TERMS_ID = "abcd0000-abcd-4bcd-8bcd-abcdabcdabcd";

/**
 * Org-owned event at the venue the agreement was negotiated for — the shape
 * `createEventFromAgreement` mints (owner = agreement counterparty, place =
 * the request's place).
 */
const ORG_EVENT: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "The Fake Band at Test Venue",
  status: "DRAFT",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2026-07-10T00:00:00.000Z"),
  endsAt: new Date("2026-07-10T03:00:00.000Z"),
  placeId: PLACE_ID,
  savedLocationId: null,
  categoryId: null,
  addressText: "123 Main St",
  countryCode: "US",
  region: "TN",
  locality: "Nashville",
  postalCode: "37203",
  lat: 36.15,
  lng: -86.78,
  slug: "the-fake-band-at-test-venue",
  shortId: "tfb1",
  regionCode: "us-tn",
  publishedAt: null,
  agreementPrimaryId: null,
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

function buildAgreement(
  overrides: Partial<AgreementRecord> = {},
): AgreementRecord {
  return {
    id: AGREEMENT_ID,
    type: "PERFORMANCE",
    status: "ACCEPTED",
    // Proposer = the act (booking accept mints it from the sender pair);
    // counterparty = the venue business side, which owns the minted event.
    proposerType: "human",
    proposerId: PERFORMER_HUMAN_ID,
    counterpartyType: "organization",
    counterpartyId: ORG_ID,
    placeId: PLACE_ID,
    eventId: EVENT_ID,
    draftEventId: null,
    payoutTermsId: null,
    title: "The Fake Band — Test Venue",
    description: null,
    proposedDate: new Date("2026-07-10T00:00:00.000Z"),
    proposedEndDate: null,
    guaranteeCents: 25_000,
    proposedAt: new Date("2026-06-02T00:00:00.000Z"),
    acceptedAt: new Date("2026-06-03T00:00:00.000Z"),
    declinedAt: null,
    declinedReason: null,
    expiresAt: null,
    fulfilledAt: null,
    sentForReviewByHumanId: null,
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    updatedAt: new Date("2026-06-03T00:00:00.000Z"),
    ...overrides,
  } satisfies AgreementRecord;
}

function buildRequest(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return {
    id: REQUEST_ID,
    direction: "TO_VENUE",
    placeId: PLACE_ID,
    placeName: "Test Venue",
    organizerOrgId: null,
    organizerOrgName: null,
    attachedEventId: null,
    attachedEventTitle: null,
    attachedEventStartsAt: null,
    calendarId: null,
    performerOwnerType: "human",
    performerOwnerId: PERFORMER_HUMAN_ID,
    contactName: null,
    contactEmail: null,
    source: "PLATFORM",
    embedId: null,
    claimTokenHash: null,
    claimTokenExpiresAt: null,
    claimedAt: null,
    message: "We'd love a Friday night slot.",
    preferredDates: ["2026-07-10"],
    expectedDraw: 80,
    genre: "punk",
    links: [],
    tags: [],
    assigneeHumanId: null,
    taxFormStatus: "NONE",
    intent: "PERFORM",
    spaceId: null,
    requestedStartsAt: null,
    requestedEndsAt: null,
    purpose: null,
    expectedAttendance: null,
    originEventId: null,
    parkedUnclaimedAt: null,
    lastMessageAt: new Date("2026-06-05T09:30:00.000Z"),
    actName: "The Fake Band (pitch copy)",
    lineupSize: null,
    setLengthMinutes: null,
    contactPhone: null,
    techNeeds: null,
    feeType: null,
    feeAmountCents: null,
    feeCurrency: null,
    linkMusic: null,
    linkVideo: null,
    linkSocial: null,
    linkEpk: null,
    status: "ACCEPTED",
    viewedAt: new Date("2026-06-02T00:00:00.000Z"),
    respondedAt: new Date("2026-06-03T00:00:00.000Z"),
    declineReason: null,
    agreementId: AGREEMENT_ID,
    verifiedStatsSnapshot: null,
    expiresAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-03T00:00:00.000Z"),
    ...overrides,
  } satisfies BookingRequestRecord;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps factory
// ─────────────────────────────────────────────────────────────────────────────

function createDeps() {
  const getEventById = vi.fn<[eventId: string], Promise<EventRecord | null>>(
    async () => ORG_EVENT,
  );
  const getOrgMembership = vi.fn<
    [params: { orgId: string; humanId: string }],
    Promise<OrgMembership | null>
  >(async ({ orgId, humanId }) => ({
    orgId,
    humanId,
    role: "EDITOR" as OrgRole,
  }));
  const findByLinkedEventId = vi.fn<
    [eventId: string],
    Promise<AgreementRecord | null>
  >(async () => null);
  const findByAgreementId = vi.fn<
    [agreementId: string],
    Promise<BookingRequestRecord | null>
  >(async () => null);
  // The event-first chain's lookup: consulted ONLY when no agreement is
  // anchored on the event.
  const findByOriginEventId = vi.fn<
    [eventId: string],
    Promise<BookingRequestRecord | null>
  >(async () => null);
  const getHumanById = vi.fn(async (id: string) => ({
    id,
    name: "Nina Fake",
  }));
  const getOrgById = vi.fn(async (id: string) => ({
    id,
    name: "Fake Band Collective",
  }));
  // Three lines by default; only the COUNT is surfaced, so the records are
  // deliberately minimal (the panel must not depend on their contents).
  const listLines = vi.fn<
    [payoutTermsId: string],
    Promise<PayoutTermsLineRecord[]>
  >(async () =>
    ["l1", "l2", "l3"].map(
      (id) => ({ id }) as unknown as PayoutTermsLineRecord,
    ),
  );

  // The venue: owned by ORG_ID, so `ORG_EVENT` is venue-owned by construction.
  const getPlaceById = vi.fn(async (id: string) => ({
    id,
    name: "Test Venue",
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [] as string[],
  }));

  const repos = {
    events: { getById: getEventById },
    authz: { getOrgMembership, getHumanDelegation: vi.fn(async () => null) },
    agreements: { findByLinkedEventId },
    bookingRequests: { findByAgreementId, findByOriginEventId },
    humans: { getById: getHumanById },
    organizations: { getById: getOrgById },
    payoutTerms: { listLines },
    places: { getById: getPlaceById },
  } as unknown as Repos;

  const logger = createTestLogger();
  const reportError = vi.fn();
  const deps: GetEventProvenanceDeps = { repos, logger, reportError };

  return {
    deps,
    logger,
    reportError,
    getEventById,
    getOrgMembership,
    findByLinkedEventId,
    findByAgreementId,
    findByOriginEventId,
    getHumanById,
    getOrgById,
    listLines,
    getPlaceById,
  };
}

const INPUT = { actorHumanId: ACTOR_ID, eventId: EVENT_ID } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("getEventProvenance", () => {
  let ctx: ReturnType<typeof createDeps>;

  beforeEach(() => {
    ctx = createDeps();
  });

  describe("the common case: no booking behind the event", () => {
    it("returns null when no agreement is anchored on the event", async () => {
      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toBeNull();
      expect(ctx.findByLinkedEventId).toHaveBeenCalledWith(EVENT_ID);
      // No agreement → the event-first origin lookup is the one fallback,
      // and it found nothing either.
      expect(ctx.findByOriginEventId).toHaveBeenCalledWith(EVENT_ID);
      // Not a swallow — an unbooked event is an ordinary answer, so nothing
      // is reported and no error is logged.
      expect(ctx.reportError).not.toHaveBeenCalled();
      expect(ctx.logger.error).not.toHaveBeenCalled();
      // And no agreement-chain read happened at all.
      expect(ctx.findByAgreementId).not.toHaveBeenCalled();
    });

    it("never consults the origin lookup when an agreement is anchored (regression: request-first output unchanged)", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.agreement?.id).toBe(AGREEMENT_ID);
      expect(result?.bookingRequest?.id).toBe(REQUEST_ID);
      expect(ctx.findByOriginEventId).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Event-first (venue-confirmation spec, "Two entry paths, one request"):
  // the builder named a venue it does not own, the save created the request
  // by `originEventId`, and there is no agreement until the venue accepts.
  // ───────────────────────────────────────────────────────────────────────────
  describe("event-first: a request by origin and no agreement", () => {
    /** Human-owned by the actor at a venue the actor does not own. */
    const THIRD_PARTY_EVENT: EventRecord = {
      ...ORG_EVENT,
      orgId: null,
      humanId: ACTOR_ID,
    };

    /** The row `createBookingRequestFromEvent` writes for that event. */
    function buildOriginRequest(
      overrides: Partial<BookingRequestRecord> = {},
    ): BookingRequestRecord {
      return buildRequest({
        status: "PENDING",
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        originEventId: EVENT_ID,
        agreementId: null,
        intent: "RENT",
        viewedAt: null,
        respondedAt: null,
        ...overrides,
      });
    }

    beforeEach(() => {
      ctx.getEventById.mockResolvedValue(THIRD_PARTY_EVENT);
    });

    it("returns the request leg, a null agreement, and the venue's stance (unconfirmed)", async () => {
      ctx.findByOriginEventId.mockResolvedValue(buildOriginRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toEqual({
        agreement: null,
        bookingRequest: {
          id: REQUEST_ID,
          status: "PENDING",
          direction: "TO_VENUE",
          senderDisplayName: "Nina Fake",
          lastMessageAt: new Date("2026-06-05T09:30:00.000Z"),
          intent: "RENT",
          placeId: PLACE_ID,
          placeName: "Test Venue",
          parked: false,
        },
        venueConfirmation: {
          state: "unconfirmed",
          ownerSide: "requester",
          placeName: "Test Venue",
        },
      });
      expect(ctx.findByOriginEventId).toHaveBeenCalledWith(EVENT_ID);
      expect(ctx.findByAgreementId).not.toHaveBeenCalled();
      expect(ctx.reportError).not.toHaveBeenCalled();
      expect(ctx.logger.error).not.toHaveBeenCalled();
    });

    it("reads a parked request (unclaimed venue) as parked", async () => {
      ctx.findByOriginEventId.mockResolvedValue(
        buildOriginRequest({
          parkedUnclaimedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.bookingRequest?.parked).toBe(true);
      expect(result?.venueConfirmation.state).toBe("unconfirmed");
    });

    it("reads confirmed (active stamp for this place) and withdrawn", async () => {
      ctx.findByOriginEventId.mockResolvedValue(buildOriginRequest());

      ctx.getEventById.mockResolvedValue({
        ...THIRD_PARTY_EVENT,
        venueConfirmedAt: new Date("2026-06-04T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
        venueConfirmationWithdrawnAt: null,
      });
      const confirmed = await getEventProvenance(ctx.deps, INPUT);
      expect(confirmed?.agreement).toBeNull();
      expect(confirmed?.venueConfirmation).toEqual({
        state: "confirmed",
        ownerSide: "requester",
        placeName: "Test Venue",
      });

      ctx.getEventById.mockResolvedValue({
        ...THIRD_PARTY_EVENT,
        venueConfirmedAt: new Date("2026-06-04T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
        venueConfirmationWithdrawnAt: new Date("2026-06-05T00:00:00.000Z"),
      });
      const withdrawn = await getEventProvenance(ctx.deps, INPUT);
      expect(withdrawn?.venueConfirmation.state).toBe("withdrawn");
      // The request leg is still there — the thread outlives the vouch.
      expect(withdrawn?.bookingRequest?.id).toBe(REQUEST_ID);
    });

    it("resolves an org-owned event-first request's sender name through the org", async () => {
      ctx.getEventById.mockResolvedValue({
        ...ORG_EVENT,
        orgId: FOREIGN_ORG_ID,
      });
      ctx.findByOriginEventId.mockResolvedValue(
        buildOriginRequest({
          performerOwnerType: "organization",
          performerOwnerId: FOREIGN_ORG_ID,
        }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.bookingRequest?.senderDisplayName).toBe(
        "Fake Band Collective",
      );
      expect(ctx.getOrgById).toHaveBeenCalledWith(FOREIGN_ORG_ID);
    });

    it("drops and REPORTS an origin request whose requester is not the event's owner (never leaks)", async () => {
      ctx.findByOriginEventId.mockResolvedValue(
        buildOriginRequest({
          performerOwnerType: "human",
          performerOwnerId: OTHER_HUMAN_ID,
        }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toBeNull();
      expect(ctx.logger.error).toHaveBeenCalledWith(
        "events.provenance.foreign_origin_request_dropped",
        expect.objectContaining({
          bookingRequestId: REQUEST_ID,
          reason: "request_owner_unrelated_to_event",
        }),
      );
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ step: "originRequestAssert" }),
          extra: expect.objectContaining({
            reason: "request_owner_unrelated_to_event",
          }),
        }),
      );
      // Nothing about the foreign row was resolved further.
      expect(ctx.getHumanById).not.toHaveBeenCalled();
    });

    it("drops and reports an origin request not anchored on this event (widened query)", async () => {
      ctx.findByOriginEventId.mockResolvedValue(
        buildOriginRequest({
          originEventId: "99999999-9999-4999-8999-999999999999",
        }),
      );

      expect(await getEventProvenance(ctx.deps, INPUT)).toBeNull();
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: "request_not_anchored_on_event",
          }),
        }),
      );
    });

    it("treats an anonymous requester pair as a mismatch (an event-first row is never anonymous)", async () => {
      ctx.findByOriginEventId.mockResolvedValue(
        buildOriginRequest({
          performerOwnerType: null,
          performerOwnerId: null,
          contactName: "Someone",
          contactEmail: "someone@example.com",
        }),
      );

      expect(await getEventProvenance(ctx.deps, INPUT)).toBeNull();
      expect(ctx.reportError).toHaveBeenCalledTimes(1);
    });

    it("keeps the drop when the reporter itself throws", async () => {
      ctx.reportError.mockImplementation(() => {
        throw new Error("sentry down");
      });
      ctx.findByOriginEventId.mockResolvedValue(
        buildOriginRequest({ performerOwnerId: OTHER_HUMAN_ID }),
      );

      await expect(getEventProvenance(ctx.deps, INPUT)).resolves.toBeNull();
    });

    it("is gated exactly like the agreement chain: a non-owner reads nothing, and no request row is touched", async () => {
      ctx.findByOriginEventId.mockResolvedValue(buildOriginRequest());

      await expect(
        getEventProvenance(ctx.deps, { ...INPUT, actorHumanId: OTHER_HUMAN_ID }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(ctx.findByOriginEventId).not.toHaveBeenCalled();
    });
  });

  describe("the full chain", () => {
    it("resolves agreement + originating request for a finalized event", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toEqual({
        agreement: {
          id: AGREEMENT_ID,
          status: "ACCEPTED",
          linkedVia: "EVENT",
          title: "The Fake Band — Test Venue",
          proposedDate: new Date("2026-07-10T00:00:00.000Z"),
          proposedEndDate: null,
          guaranteeCents: 25_000,
          // No payoutTermsId on the fixture → no lines read, count is 0.
          payoutLineCount: 0,
        },
        bookingRequest: {
          id: REQUEST_ID,
          status: "ACCEPTED",
          direction: "TO_VENUE",
          senderDisplayName: "Nina Fake",
          lastMessageAt: new Date("2026-06-05T09:30:00.000Z"),
          // The venue-confirmation leg rides BOTH chains off the same row.
          intent: "PERFORM",
          placeId: PLACE_ID,
          placeName: "Test Venue",
          parked: false,
        },
        // ORG_EVENT is owned by the venue's org: confirmed by construction.
        venueConfirmation: {
          state: "confirmed",
          ownerSide: "place",
          placeName: "Test Venue",
        },
      });
      expect(ctx.findByAgreementId).toHaveBeenCalledWith(AGREEMENT_ID);
    });

    it("reports DRAFT_EVENT when only the pre-finalize anchor links the event", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({ eventId: null, draftEventId: EVENT_ID }),
      );
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.agreement?.linkedVia).toBe("DRAFT_EVENT");
    });

    it("uses the org name for an org-typed act", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(
        buildRequest({
          performerOwnerType: "organization",
          performerOwnerId: PERFORMER_ORG_ID,
        }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.bookingRequest?.senderDisplayName).toBe(
        "Fake Band Collective",
      );
      expect(ctx.getOrgById).toHaveBeenCalledWith(PERFORMER_ORG_ID);
      expect(ctx.getHumanById).not.toHaveBeenCalled();
    });

    it("uses the submitted contact name for an anonymous embed inquiry", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(
        buildRequest({
          performerOwnerType: null,
          performerOwnerId: null,
          contactName: "Walk-in Wanda",
          contactEmail: "wanda@example.com",
          source: "EMBED",
        }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.bookingRequest?.senderDisplayName).toBe("Walk-in Wanda");
      // No entity to resolve — an anonymous sender costs zero name lookups.
      expect(ctx.getHumanById).not.toHaveBeenCalled();
      expect(ctx.getOrgById).not.toHaveBeenCalled();
    });

    it("keeps the payload minimal — no pitch, message body or contact details", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(
        buildRequest({ contactEmail: "leak@example.com" }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("leak@example.com");
      expect(serialized).not.toContain("Friday night slot");
      expect(serialized).not.toContain("pitch copy");
      expect(Object.keys(result?.bookingRequest ?? {})).toEqual([
        "id",
        "status",
        "direction",
        "senderDisplayName",
        "lastMessageAt",
        // The venue-confirmation leg: the venue's id/name (already public
        // on the place page) and the ask — still no pitch, body or contact.
        "intent",
        "placeId",
        "placeName",
        "parked",
      ]);
    });
  });

  describe("agreed terms (the editor's read-only Booking panel)", () => {
    it("surfaces the header terms and counts the payout lines when terms exist", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({
          payoutTermsId: TERMS_ID,
          proposedEndDate: new Date("2026-07-10T03:00:00.000Z"),
          guaranteeCents: 40_000,
        }),
      );
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.agreement).toMatchObject({
        title: "The Fake Band — Test Venue",
        proposedDate: new Date("2026-07-10T00:00:00.000Z"),
        proposedEndDate: new Date("2026-07-10T03:00:00.000Z"),
        guaranteeCents: 40_000,
        payoutLineCount: 3,
      });
      expect(ctx.listLines).toHaveBeenCalledTimes(1);
      expect(ctx.listLines).toHaveBeenCalledWith(TERMS_ID);
    });

    it("keeps null header fields null rather than inventing values", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({
          payoutTermsId: TERMS_ID,
          proposedDate: null,
          proposedEndDate: null,
          guaranteeCents: null,
        }),
      );
      ctx.listLines.mockResolvedValue([]);

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.agreement).toMatchObject({
        proposedDate: null,
        proposedEndDate: null,
        guaranteeCents: null,
        payoutLineCount: 0,
      });
    });

    it("reports 0 lines WITHOUT a read when the agreement has no payout terms", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({ payoutTermsId: null }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.agreement?.payoutLineCount).toBe(0);
      expect(ctx.listLines).not.toHaveBeenCalled();
      expect(ctx.reportError).not.toHaveBeenCalled();
    });

    it("propagates a lines-read failure rather than answering '0 lines'", async () => {
      // Same rule as the name lookups: repo failures are NOT swallowed. A
      // confident zero on a money panel is worse than an error.
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({ payoutTermsId: TERMS_ID }),
      );
      ctx.listLines.mockRejectedValue(new Error("lines db down"));

      await expect(getEventProvenance(ctx.deps, INPUT)).rejects.toThrow(
        "lines db down",
      );
      expect(ctx.reportError).not.toHaveBeenCalled();
    });

    it("does not read lines for a chain the backstop drops", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({
          payoutTermsId: TERMS_ID,
          eventId: "99999999-9999-4999-8999-999999999999",
          draftEventId: null,
        }),
      );

      await expect(getEventProvenance(ctx.deps, INPUT)).resolves.toBeNull();
      expect(ctx.listLines).not.toHaveBeenCalled();
    });
  });

  describe("authorization", () => {
    it("runs the gate BEFORE any provenance row is read", async () => {
      ctx.getOrgMembership.mockResolvedValue(null);

      await expect(getEventProvenance(ctx.deps, INPUT)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });

      // The whole point: the agreement and the request hang off a different
      // aggregate, so an unauthorized actor must not cause a single read of
      // them.
      expect(ctx.findByLinkedEventId).not.toHaveBeenCalled();
      expect(ctx.findByAgreementId).not.toHaveBeenCalled();
      expect(ctx.listLines).not.toHaveBeenCalled();
    });

    it("refuses an actor from another org — nothing at all comes back", async () => {
      // The cross-org actor holds a real role, just in the WRONG org.
      ctx.getOrgMembership.mockImplementation(async ({ orgId, humanId }) =>
        orgId === FOREIGN_ORG_ID
          ? { orgId, humanId, role: "OWNER" as OrgRole }
          : null,
      );
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      await expect(
        getEventProvenance(ctx.deps, {
          actorHumanId: OTHER_HUMAN_ID,
          eventId: EVENT_ID,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

      expect(ctx.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: OTHER_HUMAN_ID,
      });
      expect(ctx.findByLinkedEventId).not.toHaveBeenCalled();
    });

    it("refuses a VIEWER — the bar is ORG_EDIT_ROLES, same as the event editor", async () => {
      ctx.getOrgMembership.mockResolvedValue({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "VIEWER" as OrgRole,
      });

      await expect(getEventProvenance(ctx.deps, INPUT)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
    });

    it("allows the owner human of a human-owned event", async () => {
      ctx.getEventById.mockResolvedValue({
        ...ORG_EVENT,
        orgId: null,
        humanId: ACTOR_ID,
      });
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({
          counterpartyType: "human",
          counterpartyId: ACTOR_ID,
        }),
      );
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.agreement?.id).toBe(AGREEMENT_ID);
      expect(ctx.getOrgMembership).not.toHaveBeenCalled();
    });

    it("refuses a non-owner human on a human-owned event", async () => {
      ctx.getEventById.mockResolvedValue({
        ...ORG_EVENT,
        orgId: null,
        humanId: OTHER_HUMAN_ID,
      });

      await expect(getEventProvenance(ctx.deps, INPUT)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(ctx.findByLinkedEventId).not.toHaveBeenCalled();
    });

    it("refuses a COMMUNITY-stewardship listing outright", async () => {
      ctx.getEventById.mockResolvedValue({
        ...ORG_EVENT,
        stewardship: "COMMUNITY",
      } as EventRecord);

      await expect(getEventProvenance(ctx.deps, INPUT)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(ctx.findByLinkedEventId).not.toHaveBeenCalled();
    });

    it("throws EVENT_NOT_FOUND for a missing event", async () => {
      ctx.getEventById.mockResolvedValue(null);

      await expect(getEventProvenance(ctx.deps, INPUT)).rejects.toMatchObject({
        code: "EVENT_NOT_FOUND",
      });
    });

    it("rejects malformed input before anything is read", async () => {
      await expect(
        getEventProvenance(ctx.deps, {
          actorHumanId: "not-a-uuid",
          eventId: EVENT_ID,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(ctx.getEventById).not.toHaveBeenCalled();
    });

    it("rejects an unknown input key (.strict)", async () => {
      await expect(
        getEventProvenance(ctx.deps, { ...INPUT, orgId: ORG_ID }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("cross-aggregate backstop", () => {
    it("drops and reports an agreement not anchored on this event", async () => {
      // A repo that answered with SOMEONE ELSE'S agreement — the leak this
      // guard exists for.
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({
          eventId: "99999999-9999-4999-8999-999999999999",
          draftEventId: null,
        }),
      );
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toBeNull();
      expect(ctx.logger.error).toHaveBeenCalledWith(
        "events.provenance.foreign_chain_dropped",
        expect.objectContaining({ reason: "agreement_not_anchored_on_event" }),
      );
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: "agreement_not_anchored_on_event",
          }),
        }),
      );
    });

    it("drops and reports a request not anchored on this agreement", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(
        buildRequest({ agreementId: "77777777-7777-4777-8777-777777777777" }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toBeNull();
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: "request_not_anchored_on_agreement",
          }),
        }),
      );
    });

    it("drops and reports an agreement whose venue side is unrelated to the event", async () => {
      // Correctly anchored on the event id, but negotiated by two parties that
      // are neither the event's owner nor at its place: a chain that only the
      // FK says belongs here.
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({
          proposerType: "human",
          proposerId: PERFORMER_HUMAN_ID,
          counterpartyType: "organization",
          counterpartyId: FOREIGN_ORG_ID,
          placeId: FOREIGN_PLACE_ID,
        }),
      );
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toBeNull();
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: "agreement_venue_side_unrelated_to_event",
          }),
        }),
      );
    });

    it("accepts a hand-picked event linked at the agreement's place", async () => {
      // finalizeBookingAgreement lets a venue link an EXISTING event it can
      // edit; the owner then need not be an agreement party. The place match
      // is what keeps that legitimate case out of the drop branch.
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({
          counterpartyType: "organization",
          counterpartyId: FOREIGN_ORG_ID,
          placeId: PLACE_ID,
        }),
      );
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.agreement?.id).toBe(AGREEMENT_ID);
      expect(ctx.reportError).not.toHaveBeenCalled();
    });

    it("does not treat two null places as a match", async () => {
      ctx.getEventById.mockResolvedValue({ ...ORG_EVENT, placeId: null });
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({
          counterpartyType: "organization",
          counterpartyId: FOREIGN_ORG_ID,
          placeId: null,
        }),
      );
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toBeNull();
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: "agreement_venue_side_unrelated_to_event",
          }),
        }),
      );
    });

    it("survives a throwing reporter without changing the drop", async () => {
      ctx.reportError.mockImplementation(() => {
        throw new Error("sentry is down");
      });
      ctx.findByLinkedEventId.mockResolvedValue(
        buildAgreement({ eventId: null, draftEventId: null }),
      );
      ctx.findByAgreementId.mockResolvedValue(buildRequest());

      await expect(getEventProvenance(ctx.deps, INPUT)).resolves.toBeNull();
    });
  });

  describe("degradation", () => {
    it("returns the agreement with a null request when the thread link is gone", async () => {
      // BookingRequest.agreementId is onDelete: SetNull — a deleted agreement
      // row severs the thread link. The breadcrumb degrades, it does not
      // vanish, and this is NOT a swallow: nothing is reported.
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(null);

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result).toEqual({
        agreement: {
          id: AGREEMENT_ID,
          status: "ACCEPTED",
          linkedVia: "EVENT",
          title: "The Fake Band — Test Venue",
          proposedDate: new Date("2026-07-10T00:00:00.000Z"),
          proposedEndDate: null,
          guaranteeCents: 25_000,
          payoutLineCount: 0,
        },
        bookingRequest: null,
        venueConfirmation: {
          state: "confirmed",
          ownerSide: "place",
          placeName: "Test Venue",
        },
      });
      expect(ctx.reportError).not.toHaveBeenCalled();
      expect(ctx.logger.error).not.toHaveBeenCalled();
    });

    it("degrades to a null name and REPORTS a corrupt sender row", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(
        // Neither a performer owner pair nor contact fields — the
        // app-invariant violation getBookingRequestSender throws on.
        buildRequest({
          performerOwnerType: null,
          performerOwnerId: null,
          contactName: null,
          contactEmail: null,
        }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.bookingRequest?.id).toBe(REQUEST_ID);
      expect(result?.bookingRequest?.senderDisplayName).toBeNull();
      expect(ctx.logger.error).toHaveBeenCalledWith(
        "events.provenance.corrupt_sender_row",
        expect.objectContaining({ bookingRequestId: REQUEST_ID }),
      );
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ step: "senderDisplayName" }),
        }),
      );
    });

    it("keeps the breadcrumb when a throwing reporter meets a corrupt row", async () => {
      ctx.reportError.mockImplementation(() => {
        throw new Error("sentry is down");
      });
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(
        buildRequest({
          performerOwnerType: null,
          performerOwnerId: null,
          contactName: null,
          contactEmail: null,
        }),
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.bookingRequest?.senderDisplayName).toBeNull();
    });

    it("returns a null name when the sender's human row no longer resolves", async () => {
      ctx.findByLinkedEventId.mockResolvedValue(buildAgreement());
      ctx.findByAgreementId.mockResolvedValue(buildRequest());
      ctx.getHumanById.mockResolvedValue(
        null as unknown as { id: string; name: string },
      );

      const result = await getEventProvenance(ctx.deps, INPUT);

      expect(result?.bookingRequest?.senderDisplayName).toBeNull();
      // A missing name is not a corruption — no report.
      expect(ctx.reportError).not.toHaveBeenCalled();
    });

    it("propagates a repo failure rather than answering blank", async () => {
      ctx.findByLinkedEventId.mockRejectedValue(new Error("db down"));

      await expect(getEventProvenance(ctx.deps, INPUT)).rejects.toThrow(
        "db down",
      );
      expect(ctx.reportError).not.toHaveBeenCalled();
    });
  });
});

describe("venue confirmation (the requester's banner)", () => {
  const CHAIN = { findByLinkedEventId: async () => buildAgreement() };

  it("a venue-owned event is confirmed by construction, ownerSide venue, with the place's name", async () => {
    const d = createDeps();
    d.findByLinkedEventId.mockImplementation(CHAIN.findByLinkedEventId);
    const result = await getEventProvenance(d.deps, INPUT);
    expect(result?.venueConfirmation).toEqual({
      state: "confirmed",
      ownerSide: "place",
      placeName: "Test Venue",
    });
    expect(d.getPlaceById).toHaveBeenCalledWith(PLACE_ID);
  });

  it("a requester-owned event with an active stamp is confirmed, ownerSide requester", async () => {
    const d = createDeps();
    d.findByLinkedEventId.mockImplementation(CHAIN.findByLinkedEventId);
    // Human-owned by the actor, at a venue the actor does not own: the
    // RENT/USE shape a venue confirmation mints into the requester's admin.
    d.getEventById.mockResolvedValue({
      ...ORG_EVENT,
      orgId: null,
      humanId: ACTOR_ID,
      venueConfirmedAt: new Date("2026-06-04T00:00:00.000Z"),
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmationWithdrawnAt: null,
    });
    const result = await getEventProvenance(d.deps, INPUT);
    expect(result?.venueConfirmation).toEqual({
      state: "confirmed",
      ownerSide: "requester",
      placeName: "Test Venue",
    });
  });

  it("reads withdrawn and unconfirmed apart", async () => {
    const d = createDeps();
    d.findByLinkedEventId.mockImplementation(CHAIN.findByLinkedEventId);
    d.getEventById.mockResolvedValue({
      ...ORG_EVENT,
      orgId: null,
      humanId: ACTOR_ID,
      venueConfirmedAt: new Date("2026-06-04T00:00:00.000Z"),
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmationWithdrawnAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    expect((await getEventProvenance(d.deps, INPUT))?.venueConfirmation.state).toBe("withdrawn");

    d.getEventById.mockResolvedValue({ ...ORG_EVENT, orgId: null, humanId: ACTOR_ID });
    expect((await getEventProvenance(d.deps, INPUT))?.venueConfirmation.state).toBe("unconfirmed");
  });

  it("reads `none` — and never reads a place — when the event has no place", async () => {
    const d = createDeps();
    d.findByLinkedEventId.mockImplementation(async () =>
      buildAgreement({ placeId: null }),
    );
    d.getEventById.mockResolvedValue({ ...ORG_EVENT, placeId: null });
    const result = await getEventProvenance(d.deps, INPUT);
    expect(result?.venueConfirmation).toEqual({
      state: "none",
      ownerSide: null,
      placeName: null,
    });
    expect(d.getPlaceById).not.toHaveBeenCalled();
  });

  it("keeps a stamp the venue issued when the place row is gone (null name)", async () => {
    const d = createDeps();
    d.findByLinkedEventId.mockImplementation(CHAIN.findByLinkedEventId);
    d.getPlaceById.mockResolvedValue(null as never);
    d.getEventById.mockResolvedValue({
      ...ORG_EVENT,
      orgId: null,
      humanId: ACTOR_ID,
      venueConfirmedAt: new Date("2026-06-04T00:00:00.000Z"),
      venueConfirmedPlaceId: PLACE_ID,
    });
    const result = await getEventProvenance(d.deps, INPUT);
    expect(result?.venueConfirmation).toEqual({
      state: "confirmed",
      ownerSide: "requester",
      placeName: null,
    });
  });

  it("propagates a place-read failure rather than answering 'unconfirmed'", async () => {
    const d = createDeps();
    d.findByLinkedEventId.mockImplementation(CHAIN.findByLinkedEventId);
    d.getPlaceById.mockRejectedValue(new Error("places down"));
    await expect(getEventProvenance(d.deps, INPUT)).rejects.toThrow("places down");
  });
});
