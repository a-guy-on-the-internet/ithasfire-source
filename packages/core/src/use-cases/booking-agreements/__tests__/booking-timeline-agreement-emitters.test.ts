import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { cancelBookingAgreement } from "../cancel-booking-agreement";
import { pullBackBookingAgreement } from "../pull-back-booking-agreement";
import { reopenBookingAgreement } from "../reopen-booking-agreement";
import { respondToBookingAgreement } from "../respond-to-booking-agreement";
import { sendBookingAgreementForReview } from "../send-booking-agreement-for-review";
import { bookingThreadSideForAgreementSide } from "../_shared/booking-ledger";
import {
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  systemEntriesFor,
  withTx,
} from "../../booking-requests/__tests__/helpers";
import {
  AGREEMENT_ID,
  NOW,
  PERFORMER_ID,
  VENUE_ADMIN_ID,
  VENUE_ORG_ID,
  buildAgreementRecord,
  makeAgreementsRepoFake,
  makeAuditFake,
  makeAuthzFake,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING TIMELINE — the AGREEMENT-side emitters (step 2).
//
// "We see the agreement get hammered out there, it gets logged as an entry in
// the message history." Two things are non-obvious here and are what these
// tests exist for:
//
//  1. THE RELATION DIRECTION. There is no `Agreement.bookingRequestId` column —
//     `BookingRequest.agreementId` is the FK. So every agreement transition has
//     to look BACKWARDS to find its ledger, and must NO-OP (never crash) for an
//     agreement that has no booking request at all.
//  2. THE SIDE MAPPING. `AgreementSide` is proposer/counterparty; the thread's
//     axis is VENUE/PERFORMER, and the two mint sites lay the parties out as
//     MIRRORS of each other.
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function buildDeps(
  agreement: AgreementRecord | null,
  options: { request?: BookingRequestRecord | null } = {},
) {
  const agreements = makeAgreementsRepoFake(agreement);
  const request =
    options.request === undefined
      ? buildBookingRequestRecord({
          id: REQUEST_ID,
          agreementId: AGREEMENT_ID,
          // Proposer side of the fixture agreement — so proposer ⇒ PERFORMER.
          performerOwnerType: "human",
          performerOwnerId: PERFORMER_ID,
        })
      : options.request;

  const mocks = {
    agreements: agreements.repo,
    authz: makeAuthzFake(),
    audit: makeAuditFake(),
    organizations: {
      listMembers: vi.fn(async () => ({ items: [], total: 0 })),
    },
    bookingRequests: {
      findByAgreementId: vi.fn(async () => request),
    },
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
  };
  const repos = withTx(mocks);

  return {
    deps: { repos, clock: { now: () => NOW } } as never,
    repos,
    agreements,
  };
}

describe("booking timeline — agreement transitions", () => {
  it("sent_for_review names the side that sent it", async () => {
    const { deps, repos } = buildDeps(buildAgreementRecord({ status: "DRAFT" }));

    await sendBookingAgreementForReview(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_agreement.sent_for_review",
        // The venue org is the COUNTERPARTY on a TO_VENUE agreement ⇒ VENUE.
        systemData: { agreementId: AGREEMENT_ID, actorSide: "PLACE" },
        authorHumanId: VENUE_ADMIN_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("pulled_back records the actor so the copy can say who", async () => {
    const { deps, repos } = buildDeps(
      buildAgreementRecord({ status: "PROPOSED" }),
    );

    // Only the terms editor (the venue on TO_VENUE) may pull back — the act
    // side is refused before any ledger write (`agreement-editor-side.ts`).
    await pullBackBookingAgreement(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_agreement.pulled_back",
        // The venue org is the COUNTERPARTY on a TO_VENUE agreement ⇒ VENUE.
        systemData: { agreementId: AGREEMENT_ID, actorSide: "PLACE" },
        authorHumanId: VENUE_ADMIN_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("reopened lands on the thread", async () => {
    const { deps, repos } = buildDeps(
      buildAgreementRecord({ status: "ACCEPTED", eventId: null }),
    );

    await reopenBookingAgreement(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_agreement.reopened",
        systemData: { agreementId: AGREEMENT_ID, actorSide: "PLACE" },
        authorHumanId: VENUE_ADMIN_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("accepted lands on the thread", async () => {
    const { deps, repos } = buildDeps(
      buildAgreementRecord({ status: "PROPOSED" }),
    );

    await respondToBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
      action: "accept",
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_agreement.accepted",
        systemData: { agreementId: AGREEMENT_ID, actorSide: "PERFORMER" },
        authorHumanId: PERFORMER_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("declined COPIES the reason given at that moment", async () => {
    const { deps, repos } = buildDeps(
      buildAgreementRecord({ status: "PROPOSED" }),
    );

    // Only the ACT responds on a linked agreement (`ACT_RESPONSE_ONLY`).
    await respondToBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
      action: "decline",
      declineReason: "The guarantee is below what we need for the night.",
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_agreement.declined",
        systemData: {
          agreementId: AGREEMENT_ID,
          actorSide: "PERFORMER",
          reason: "The guarantee is below what we need for the night.",
        },
        authorHumanId: PERFORMER_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("cancelled COPIES the editor's reason, on the editor's side", async () => {
    const { deps, repos } = buildDeps(
      buildAgreementRecord({ status: "ACCEPTED", acceptedAt: NOW }),
    );

    // Only the terms editor (the venue on TO_VENUE) may cancel.
    await cancelBookingAgreement(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
      reason: "We double-booked the room; sorry.",
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_agreement.cancelled",
        systemData: {
          agreementId: AGREEMENT_ID,
          actorSide: "PLACE",
          reason: "We double-booked the room; sorry.",
        },
        authorHumanId: VENUE_ADMIN_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("NO-OPS (never crashes) for an agreement with no booking request", async () => {
    // Agreements minted by the event-scoped path were never asked for through
    // the inbox — they have no thread, and that is not an error.
    const { deps, repos, agreements } = buildDeps(
      buildAgreementRecord({ status: "DRAFT" }),
      { request: null },
    );

    await expect(
      sendBookingAgreementForReview(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      }),
    ).resolves.toMatchObject({ status: "PROPOSED" });

    // The transition itself still happened.
    expect(agreements.record()?.status).toBe("PROPOSED");
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([]);
  });

  it("fails the WHOLE transition when the ledger write fails (same tx)", async () => {
    const { deps, repos } = buildDeps(
      buildAgreementRecord({ status: "PROPOSED" }),
    );
    (
      repos as unknown as {
        bookingRequestMessages: { create: unknown };
      }
    ).bookingRequestMessages.create = vi.fn(async () => {
      throw new Error("ledger write failed");
    });

    await expect(
      pullBackBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      }),
    ).rejects.toThrow("ledger write failed");

    // The audit row sits AFTER the append inside the same tx callback, so its
    // absence is the structural proof the append is inside the transaction.
    expect(
      (repos as unknown as { audit: { log: { mock: { calls: unknown[] } } } })
        .audit.log.mock.calls,
    ).toHaveLength(0);
  });
});

describe("bookingThreadSideForAgreementSide", () => {
  const toVenue = buildBookingRequestRecord({
    performerOwnerType: "human",
    performerOwnerId: PERFORMER_ID,
  });
  const toVenueAgreement = buildAgreementRecord();

  it("TO_VENUE: proposer is the ACT, counterparty is the venue", () => {
    expect(
      bookingThreadSideForAgreementSide(toVenue, toVenueAgreement, "proposer"),
    ).toBe("PERFORMER");
    expect(
      bookingThreadSideForAgreementSide(
        toVenue,
        toVenueAgreement,
        "counterparty",
      ),
    ).toBe("VENUE");
  });

  it("TO_PERFORMER: the layout is MIRRORED — proposer is the organizer", () => {
    // The organizer mint (`createOrganizerAcceptAgreement`) puts the ORG on
    // the proposer side and the act on the counterparty side. A constant
    // proposer⇒PERFORMER mapping would label every organizer transition with
    // the wrong side.
    const toPerformer = buildOrganizerBookingRequestRecord({
      performerOwnerType: "human",
      performerOwnerId: PERFORMER_ID,
    });
    const organizerAgreement = buildAgreementRecord({
      proposerType: "organization",
      proposerId: VENUE_ORG_ID,
      counterpartyType: "human",
      counterpartyId: PERFORMER_ID,
    });

    expect(
      bookingThreadSideForAgreementSide(
        toPerformer,
        organizerAgreement,
        "proposer",
      ),
    ).toBe("VENUE");
    expect(
      bookingThreadSideForAgreementSide(
        toPerformer,
        organizerAgreement,
        "counterparty",
      ),
    ).toBe("PERFORMER");
  });

  it("falls back to the direction rule when the act pair is not yet backfilled", () => {
    // Unclaimed anonymous inquiry — structurally unreachable with a live
    // agreement, but a ledger write must never crash a transition.
    const anon = buildBookingRequestRecord({
      performerOwnerType: null,
      performerOwnerId: null,
      contactName: "The Basement Tapes",
      contactEmail: "band@example.com",
    });
    expect(
      bookingThreadSideForAgreementSide(anon, toVenueAgreement, "proposer"),
    ).toBe("PERFORMER");
    expect(
      bookingThreadSideForAgreementSide(anon, toVenueAgreement, "counterparty"),
    ).toBe("VENUE");
  });
});
