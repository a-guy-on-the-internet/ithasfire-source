import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { UpdateBookingRequestStatusInput } from "@th/types/repos/booking-requests";

import { respondToBookingRequest } from "../respond-to-booking-request";
import type { RespondToBookingRequestDeps } from "../respond-to-booking-request";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  ATTACHED_EVENT_ID,
  NOW,
  ORGANIZER_ORG_ID,
  ORG_ID,
  OTHER_HUMAN_ID,
  PLACE_ID,
  REQUEST_ID,
  TERMS_ID,
  buildOrganizerBookingRequestRecord,
  makeFakeIdempotency,
  withTx,
} from "./helpers";

type OrganizerRecord = ReturnType<typeof buildOrganizerBookingRequestRecord>;

type BuildDepsOptions = {
  request?: OrganizerRecord | null;
  /** Org-act membership (requireOwnerAccess org path). */
  membership?: OrgMembership | null;
  /** Attached event returned by events.getById (null = deleted/absent). */
  event?: {
    id: string;
    placeId: string | null;
    startsAt: Date;
    endsAt: Date | null;
  } | null;
  bookingDefaults?: { actName: string | null } | null;
  entityPage?: { displayName: string | null } | null;
  human?: { id: string; name: string | null } | null;
  notifierFails?: boolean;
};

function buildDeps(options: BuildDepsOptions = {}) {
  let current: OrganizerRecord | null =
    options.request === undefined
      ? buildOrganizerBookingRequestRecord()
      : options.request;

  const bookingRequests = {
    getById: vi.fn(async () => current),
    updateStatus: vi.fn(async (input: UpdateBookingRequestStatusInput) => {
      if (!current || !input.expectedFrom.includes(current.status)) {
        throw {
          code: "conflict",
          message: "booking_request_status_changed",
        } as const;
      }
      current = {
        ...current,
        status: input.status as OrganizerRecord["status"],
        respondedAt: input.respondedAt ?? current.respondedAt,
        declineReason: input.declineReason ?? current.declineReason,
        agreementId: input.agreementId ?? current.agreementId,
      };
      return current;
    }),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
    getOrgMemberships: vi.fn(async () => []),
  };
  const payoutTerms = {
    clone: vi.fn(async () => {
      throw new Error("clone must never run in the TO_PERFORMER direction");
    }),
    createDraft: vi.fn(async () => ({ id: TERMS_ID })),
  };
  const agreements = {
    create: vi.fn(async (input: Record<string, unknown>) => ({
      id: AGREEMENT_ID,
      ...input,
    })),
  };
  const events = {
    getById: vi.fn(async () => options.event ?? null),
  };
  const performerBookingDefaults = {
    getByOwner: vi.fn(async () => options.bookingDefaults ?? null),
  };
  const entityPages = {
    getByOwner: vi.fn(async () => options.entityPage ?? null),
  };
  const humans = {
    getById: vi.fn(async () =>
      options.human === undefined
        ? { id: ACTOR_ID, name: "Alice Act" }
        : options.human,
    ),
  };
  const organizations = { getById: vi.fn(async () => null) };
  const places = {
    getById: vi.fn(async () => {
      throw new Error("places must never load in the TO_PERFORMER direction");
    }),
  };
  const audit = { log: vi.fn(async () => {}) };

  const mocks = {
    bookingRequests,
    authz,
    payoutTerms,
    agreements,
    events,
    performerBookingDefaults,
    entityPages,
    humans,
    organizations,
    places,
    audit,
  };

  // `reposBase` carries the ledger repos `withTx` autowires; the accept
  // appends its entries inside this tx.
  const reposBase = withTx(mocks) as unknown as Record<string, unknown>;
  const tx = vi.fn(async <R,>(fn: (t: unknown) => Promise<R>): Promise<R> => {
    const snapshot = current;
    try {
      return await fn(reposBase);
    } catch (error) {
      current = snapshot;
      throw error;
    }
  });

  const notify = vi.fn(async () => {
    if (options.notifierFails) throw new Error("notify down");
  });
  const reportError = vi.fn();

  const deps: RespondToBookingRequestDeps = {
    repos: { ...reposBase, tx } as unknown as RespondToBookingRequestDeps["repos"],
    idempotency: makeFakeIdempotency(),
    clock: { now: () => NOW },
    notifyBookingRequestResponded: notify,
    reportError,
  };

  return { deps, mocks, notify, reportError };
}

describe("respondToBookingRequest — TO_PERFORMER direction", () => {
  it("accept mints the organizer-proposed agreement (org proposer, act counterparty, null place, bare PENDING draft terms)", async () => {
    const { deps, mocks, notify } = buildDeps();

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      status: "ACCEPTED",
      agreementId: AGREEMENT_ID,
    });
    // Bare PENDING PRIMARY draft — never the venue clone path.
    expect(mocks.payoutTerms.createDraft).toHaveBeenCalledWith({
      kind: "PRIMARY",
      settlementCurrency: "usd",
    });
    expect(mocks.payoutTerms.clone).not.toHaveBeenCalled();
    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PERFORMANCE",
        status: "DRAFT",
        proposerType: "organization",
        proposerId: ORGANIZER_ORG_ID,
        counterpartyType: "human",
        counterpartyId: ACTOR_ID,
        placeId: null,
        // No attached event, so the org's OWN preferred date seeds the header
        // (2026-07-10 at the 19:00 default, platform zone — this direction has
        // no venue anchor). The 2026-07-21 precedence is unchanged: an
        // attached event still wins, as the next test proves.
        proposedDate: new Date("2026-07-11T00:00:00.000Z"),
        proposedEndDate: null,
        title: "Booking — Alice Act",
        payoutTermsId: TERMS_ID,
      }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.accepted",
        data: expect.objectContaining({
          direction: "TO_PERFORMER",
          organizerOrgId: ORGANIZER_ORG_ID,
        }),
      }),
    );
    // Venue machinery never ran.
    expect(mocks.places.getById).not.toHaveBeenCalled();
    // Organizer notified post-commit.
    expect(notify).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ id: REQUEST_ID }),
      action: "accepted",
      agreementId: AGREEMENT_ID,
      reason: null,
      actorHumanId: ACTOR_ID,
    });
  });

  it("accept auto-populates the agreement dates + place from the attached event (decision 2026-07-21)", async () => {
    const startsAt = new Date("2026-08-14T19:00:00.000Z");
    const endsAt = new Date("2026-08-14T22:00:00.000Z");
    const { deps, mocks } = buildDeps({
      request: buildOrganizerBookingRequestRecord({
        attachedEventId: ATTACHED_EVENT_ID,
        attachedEventTitle: "East Side Showcase",
        attachedEventStartsAt: startsAt,
      }),
      event: { id: ATTACHED_EVENT_ID, placeId: PLACE_ID, startsAt, endsAt },
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        proposedDate: startsAt,
        proposedEndDate: endsAt,
      }),
    );
  });

  it("accept tolerates a deleted attached event (null place, dates fall back to the pitch)", async () => {
    const { deps, mocks } = buildDeps({
      request: buildOrganizerBookingRequestRecord({
        attachedEventId: ATTACHED_EVENT_ID,
      }),
      event: null,
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: null,
        // The event is gone, so there is nothing to inherit from — the pitch
        // seed takes over rather than leaving the venue a blank header.
        proposedDate: new Date("2026-07-11T00:00:00.000Z"),
        proposedEndDate: null,
      }),
    );
  });

  it("resolves the agreement title from PerformerBookingDefaults.actName first", async () => {
    const { deps, mocks } = buildDeps({
      bookingDefaults: { actName: "The Midnight Ramblers" },
      entityPage: { displayName: "Should Not Win" },
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Booking — The Midnight Ramblers" }),
    );
  });

  it("falls back to the entity page displayName before the canonical name", async () => {
    const { deps, mocks } = buildDeps({
      entityPage: { displayName: "Stage Name" },
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Booking — Stage Name" }),
    );
  });

  it("decline records the reason, audits and notifies the organizer with the hub target", async () => {
    const { deps, mocks, notify } = buildDeps();

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "Sorry, we're already booked that weekend.",
    });

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      status: "DECLINED",
    });
    expect(mocks.agreements.create).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "DECLINED",
        declineReason: "Sorry, we're already booked that weekend.",
      }),
    );
    // The act's reason reaches the organiser (N9: one variant, with the reason).
    expect(notify).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ id: REQUEST_ID }),
      action: "declined",
      agreementId: null,
      reason: "Sorry, we're already booked that weekend.",
      actorHumanId: ACTOR_ID,
    });
  });

  it("TO_PERFORMER decline WITHOUT a reason is valid (spec: no reason required) and stores null", async () => {
    const { deps, mocks, notify } = buildDeps();

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
    });

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      status: "DECLINED",
    });
    expect(mocks.bookingRequests.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "DECLINED", declineReason: null }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ action: "declined" }),
    );
  });

  it("an unauthorized actor replaying a COMPLETED respond gets the authz error, never the cache (review 2026-07-21)", async () => {
    const { deps, mocks } = buildDeps();

    const first = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });
    expect(first.status).toBe("ACCEPTED");

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.agreements.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a random human who is not the target act (venue-side actors included)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.agreements.create).not.toHaveBeenCalled();
  });

  it("org-act targets require an edit role in the ACT org (not the sender org)", async () => {
    const { deps } = buildDeps({
      request: buildOrganizerBookingRequestRecord({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
      membership: {
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "VIEWER",
      } as OrgMembership,
    });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("org-act editor can accept — counterparty is the act ORG", async () => {
    const { deps, mocks } = buildDeps({
      request: buildOrganizerBookingRequestRecord({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
      membership: {
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "EDITOR",
      } as OrgMembership,
      // Org acts resolve via entity page / org name, not humans.
      entityPage: { displayName: "The Collective" },
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(result.agreementId).toBe(AGREEMENT_ID);
    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        counterpartyType: "organization",
        counterpartyId: ORG_ID,
        title: "Booking — The Collective",
      }),
    );
  });

  it("rejects responding to an expired request before the sweep runs", async () => {
    const { deps } = buildDeps({
      request: buildOrganizerBookingRequestRecord({
        expiresAt: new Date(NOW.getTime() - 1000),
      }),
    });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_EXPIRED" });
  });

  it("swallows a failing organizer notifier and reports it — the accept still succeeds", async () => {
    const { deps, reportError } = buildDeps({ notifierFails: true });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(result.status).toBe("ACCEPTED");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "respondToBookingRequest", step: "request_responded" },
      }),
    );
  });

  it("replays the cached response on a repeat accept (idempotency envelope)", async () => {
    const { deps, mocks } = buildDeps();

    const first = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });
    const second = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(second).toEqual(first);
    expect(mocks.agreements.create).toHaveBeenCalledTimes(1);
  });
});
