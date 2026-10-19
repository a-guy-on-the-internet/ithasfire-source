import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { OrgMembership } from "@th/ports/repos/authz";

import { listBookingRequests } from "../list-booking-requests";
import type { ListBookingRequestsDeps } from "../list-booking-requests";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  EVENT_ID,
  ORGANIZER_ORG_ID,
  ORG_ID,
  OTHER_HUMAN_ID,
  type SeededThreadMessage,
  buildAgreementRecord,
  buildOrganizerBookingRequestRecord,
  buildStageEventRecord,
  buildStageRepos,
  buildUnreadCountingRepo,
} from "./helpers";

type OrganizerRecord = ReturnType<typeof buildOrganizerBookingRequestRecord>;

type BuildDepsOptions = {
  organizerRecords?: OrganizerRecord[];
  inboxRecords?: OrganizerRecord[];
  membership?: OrgMembership | null;
  messages?: SeededThreadMessage[];
  /** Agreements/events "in the database" for the stage projection. */
  agreements?: AgreementRecord[];
  events?: ReturnType<typeof buildStageEventRecord>[];
};

function buildDeps(options: BuildDepsOptions = {}) {
  const bookingRequests = {
    listForOrganizer: vi.fn(async () => options.organizerRecords ?? []),
    listForPerformerInbox: vi.fn(async () => options.inboxRecords ?? []),
    listForPerformer: vi.fn(async () => []),
    listForPlace: vi.fn(async () => []),
  };
  const places = { getById: vi.fn(async () => null) };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
    getOrgMemberships: vi.fn(async () => []),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: "Target Act" })),
    ),
  };
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: "Act Org" })),
    ),
  };

  // Same semantics as the real repo (zero-unread requests absent, SYSTEM
  // entries never counted) because it IS the real in-memory repo — the rule
  // lives in one place. See `buildUnreadCountingRepo`.
  const bookingRequestMessages = buildUnreadCountingRepo(options.messages);

  // Stage projection (request → agreement → event) — empty by default.
  const stage = buildStageRepos({
    ...(options.agreements ? { agreements: options.agreements } : {}),
    ...(options.events ? { events: options.events } : {}),
  });

  const deps: ListBookingRequestsDeps = {
    repos: {
      bookingRequests,
      places,
      authz,
      humans,
      organizations,
      bookingRequestMessages,
      agreements: stage.agreements,
      bookingHolds: stage.bookingHolds,
      bookingTags: stage.bookingTags,
      events: stage.events,
    } as unknown as ListBookingRequestsDeps["repos"],
  };

  return {
    deps,
    mocks: {
      bookingRequests,
      places,
      authz,
      humans,
      organizations,
      bookingRequestMessages,
      agreements: stage.agreements,
      bookingHolds: stage.bookingHolds,
      bookingTags: stage.bookingTags,
      events: stage.events,
    },
  };
}

describe("listBookingRequests — organizer / performer-inbox scopes", () => {
  it("organizer scope lists the org's outbound requests via the direction-scoped repo method", async () => {
    const record = buildOrganizerBookingRequestRecord({
      attachedEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachedEventTitle: "East Side Showcase",
      attachedEventStartsAt: new Date("2026-08-14T19:00:00.000Z"),
    });
    const { deps, mocks } = buildDeps({
      organizerRecords: [record],
      membership: {
        orgId: ORGANIZER_ORG_ID,
        humanId: ACTOR_ID,
        role: "VIEWER", // membership-any suffices for viewing
      } as OrgMembership,
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "organizer",
      organizerOrgId: ORGANIZER_ORG_ID,
    });

    expect(mocks.bookingRequests.listForOrganizer).toHaveBeenCalledWith({
      organizerOrgId: ORGANIZER_ORG_ID,
      statuses: undefined,
    });
    // The direction-scoped venue/performer methods never run.
    expect(mocks.bookingRequests.listForPlace).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.listForPerformer).not.toHaveBeenCalled();

    expect(result.requests).toHaveLength(1);
    const summary = result.requests[0]!;
    expect(summary.direction).toBe("TO_PERFORMER");
    expect(summary.placeId).toBeNull();
    expect(summary.organizerOrgId).toBe(ORGANIZER_ORG_ID);
    expect(summary.organizerOrgName).toBe("Corner Booking Collective");
    expect(summary.attachedEventTitle).toBe("East Side Showcase");
    // The performer display name resolves to the TARGET act.
    expect(summary.performerDisplayName).toBe("Target Act");
  });

  it("organizer scope requires org membership", async () => {
    const { deps } = buildDeps({ membership: null });

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "organizer",
        organizerOrgId: ORGANIZER_ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("organizer scope requires organizerOrgId", async () => {
    const { deps } = buildDeps();

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "organizer",
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });

  it("performer-inbox scope defaults to the actor's human identity", async () => {
    const record = buildOrganizerBookingRequestRecord();
    const { deps, mocks } = buildDeps({ inboxRecords: [record] });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer-inbox",
    });

    expect(mocks.bookingRequests.listForPerformerInbox).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: ACTOR_ID,
      statuses: undefined,
    });
    expect(mocks.bookingRequests.listForPerformer).not.toHaveBeenCalled();
    expect(result.requests[0]!.direction).toBe("TO_PERFORMER");
    expect(result.requests[0]!.organizerOrgName).toBe(
      "Corner Booking Collective",
    );
  });

  it("performer-inbox rejects viewing another human's inbox", async () => {
    const { deps } = buildDeps();

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "performer-inbox",
        performerOwnerType: "human",
        performerOwnerId: OTHER_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("performer-inbox for an org act requires membership (any role)", async () => {
    const record = buildOrganizerBookingRequestRecord({
      performerOwnerType: "organization",
      performerOwnerId: ORG_ID,
    });
    const { deps, mocks } = buildDeps({
      inboxRecords: [record],
      membership: {
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "SCANNER",
      } as OrgMembership,
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer-inbox",
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
    });

    expect(mocks.bookingRequests.listForPerformerInbox).toHaveBeenCalledWith({
      ownerType: "organization",
      ownerId: ORG_ID,
      statuses: undefined,
    });
    expect(result.requests).toHaveLength(1);
  });

  // ── Unread counts across the TO_PERFORMER direction ───────────────────────

  it("organizer scope reads the thread as side VENUE (the sender org occupies the VENUE slot)", async () => {
    // The subtle one: on a TO_PERFORMER row the enum's VENUE slot is the
    // SENDER organizer org, not a place. Reading this as PERFORMER would badge
    // the organizer with its own outbound pitch and hide the act's reply.
    const record = buildOrganizerBookingRequestRecord();
    const { deps, mocks } = buildDeps({
      organizerRecords: [record],
      membership: {
        orgId: ORGANIZER_ORG_ID,
        humanId: ACTOR_ID,
        role: "VIEWER",
      } as OrgMembership,
      messages: [
        // The act's reply — unread FOR the organizer.
        { bookingRequestId: record.id, authorSide: "PERFORMER" },
        // A SYSTEM ledger entry — NEVER unread (inverted with the system-entry
        // migration: unread means a human is waiting on you).
        { bookingRequestId: record.id, authorSide: "SYSTEM" },
        // The organizer's OWN outbound message must never badge its own row.
        { bookingRequestId: record.id, authorSide: "VENUE" },
      ],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "organizer",
      organizerOrgId: ORGANIZER_ORG_ID,
    });

    expect(
      mocks.bookingRequestMessages.countUnreadByRequest,
    ).toHaveBeenCalledWith({ bookingRequestIds: [record.id], side: "VENUE" });
    // ONE — the act's reply only. Not the SYSTEM entry, not the organizer's own.
    expect(result.requests[0]!.unreadMessageCount).toBe(1);
  });

  it("performer-inbox scope reads the thread as side PERFORMER", async () => {
    const record = buildOrganizerBookingRequestRecord();
    const { deps, mocks } = buildDeps({
      inboxRecords: [record],
      messages: [
        // The organizer's pitch/follow-ups — unread FOR the act.
        { bookingRequestId: record.id, authorSide: "VENUE" },
        // The act's own reply must not badge its own inbox row.
        { bookingRequestId: record.id, authorSide: "PERFORMER" },
      ],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer-inbox",
    });

    expect(
      mocks.bookingRequestMessages.countUnreadByRequest,
    ).toHaveBeenCalledWith({
      bookingRequestIds: [record.id],
      side: "PERFORMER",
    });
    expect(result.requests[0]!.unreadMessageCount).toBe(1);
  });

  it("performer scope (sent list) still calls the TO_VENUE-scoped repo method", async () => {
    const { deps, mocks } = buildDeps();

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer",
    });

    expect(mocks.bookingRequests.listForPerformer).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: ACTOR_ID,
      statuses: undefined,
    });
    expect(mocks.bookingRequests.listForPerformerInbox).not.toHaveBeenCalled();
  });

  // ── Booking STAGE projection on the TO_PERFORMER scopes ───────────────────
  // A rail that only lights up on the venue inbox is a non-starter: these two
  // scopes are the same booking seen from the other two seats.

  it("organizer scope carries the agreement + event stage (draft anchor resolved)", async () => {
    const { deps, mocks } = buildDeps({
      organizerRecords: [
        buildOrganizerBookingRequestRecord({
          status: "ACCEPTED",
          agreementId: AGREEMENT_ID,
        }),
      ],
      membership: {
        orgId: ORGANIZER_ORG_ID,
        humanId: ACTOR_ID,
        role: "VIEWER",
      } as OrgMembership,
      agreements: [
        buildAgreementRecord({ status: "ACCEPTED", draftEventId: EVENT_ID }),
      ],
      events: [
        buildStageEventRecord({
          id: EVENT_ID,
          status: "DRAFT",
          startsAt: new Date("2026-09-19T00:00:00.000Z"),
        }),
      ],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "organizer",
      organizerOrgId: ORGANIZER_ORG_ID,
    });

    expect(result.requests[0]).toMatchObject({
      agreementStatus: "ACCEPTED",
      eventId: EVENT_ID,
      eventStatus: "DRAFT",
      eventStartsAt: new Date("2026-09-19T00:00:00.000Z"),
    });
    expect(mocks.agreements.findManyByIds).toHaveBeenCalledTimes(1);
  });

  it("performer-inbox scope carries the agreement + event stage", async () => {
    const { deps } = buildDeps({
      inboxRecords: [
        buildOrganizerBookingRequestRecord({
          status: "ACCEPTED",
          agreementId: AGREEMENT_ID,
        }),
      ],
      agreements: [
        buildAgreementRecord({ status: "COUNTERED", eventId: EVENT_ID }),
      ],
      events: [buildStageEventRecord({ id: EVENT_ID, status: "PUBLISHED" })],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer-inbox",
    });

    expect(result.requests[0]).toMatchObject({
      agreementStatus: "COUNTERED",
      eventId: EVENT_ID,
      eventStatus: "PUBLISHED",
    });
  });
});
