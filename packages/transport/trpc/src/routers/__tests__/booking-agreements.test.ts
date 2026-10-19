import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { bookingAgreementsRouter } from "../booking-agreements";
import { createCaller } from "./test-helpers";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

/**
 * Deps-wiring tests for bookingAgreements.createEventFromAgreement: the
 * router must thread actorHumanId, the full repo bag, idempotency, and
 * (crucially) ctx.reportError into the use case — the orphan-draft branch
 * reports through ReporterPort, and a declared-but-never-injected reporter
 * would silently un-Sentry it (house convention).
 *
 * The use case's own behavior is pinned in
 * packages/core/src/use-cases/booking-agreements/__tests__/create-event-from-agreement.test.ts;
 * here we only exercise the transport seam with a happy-path repo bag and an
 * error-mapping case.
 */

const ACTOR_ID = "23232323-2323-4323-8323-232323232323"; // VENUE_ADMIN
const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222222";
const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const TERMS_ID = "66666666-6666-4666-8666-666666666666";
const NEW_EVENT_ID = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";

function buildAgreement(overrides: Record<string, unknown> = {}) {
  return {
    id: AGREEMENT_ID,
    type: "PERFORMANCE",
    status: "ACCEPTED",
    proposerType: "human",
    proposerId: "11111111-1111-4111-8111-111111111111",
    counterpartyType: "organization",
    counterpartyId: VENUE_ORG_ID,
    placeId: PLACE_ID,
    eventId: null,
    draftEventId: null,
    payoutTermsId: TERMS_ID,
    title: "Booking — Test Venue",
    description: null,
    proposedDate: null,
    proposedEndDate: null,
    guaranteeCents: null,
    proposedAt: null,
    acceptedAt: null,
    declinedAt: null,
    declinedReason: null,
    expiresAt: null,
    fulfilledAt: null,
    sentForReviewByHumanId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildRepos(overrides: Record<string, unknown> = {}) {
  const agreement = buildAgreement(overrides);
  const place = {
    id: PLACE_ID,
    name: "Test Venue",
    status: "ACTIVE",
    orgIdsWithAccess: [VENUE_ORG_ID],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
  };
  const request = {
    id: REQUEST_ID,
    direction: "TO_VENUE",
    intent: "PERFORM",
    spaceId: null,
    requestedStartsAt: null,
    requestedEndsAt: null,
    purpose: null,
    placeId: PLACE_ID,
    performerOwnerType: "human",
    performerOwnerId: "11111111-1111-4111-8111-111111111111",
    contactName: null,
    contactEmail: null,
    actName: "The Fake Band",
    preferredDates: ["2026-07-10"],
    agreementId: AGREEMENT_ID,
  };

  const mocks = {
    agreements: {
      getById: vi.fn(async () => agreement),
      getByEventId: vi.fn(async () => null),
      setDraftEvent: vi.fn(async () => ({
        ...agreement,
        draftEventId: NEW_EVENT_ID,
      })),
      updateStatus: vi.fn(async () => ({
        ...agreement,
        eventId: NEW_EVENT_ID,
      })),
    },
    bookingRequests: {
      findByAgreementId: vi.fn(async () => request),
      // ── P3b (asks) ── the post-mint image copy reads the asks (none here).
      listAsks: vi.fn(async () => []),
      // Ledger plumbing: the create-event tx appends `booking_event.created`
      // to this request's thread, which bumps the inbox recency stamp.
      touchLastMessageAt: vi.fn(async () => {}),
      // The bill (lineup v2, FR-006): the mint locks + reads it in the
      // anchor tx. No act rows = a pre-bill request → the legacy headliner.
      lockBill: vi.fn(async () => {}),
      listActsForRequests: vi.fn(async () => []),
    },
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
    places: {
      getById: vi.fn(async () => place),
      updateTaxRate: vi.fn(async () => undefined),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: VENUE_ORG_ID,
        humanId: ACTOR_ID,
        role: "ADMIN",
      })),
      getOrgMemberships: vi.fn(async () => [
        { orgId: VENUE_ORG_ID, humanId: ACTOR_ID, role: "ADMIN" },
      ]),
    },
    organizations: {
      getById: vi.fn(async () => ({ id: VENUE_ORG_ID, name: "Venue Org" })),
    },
    humans: {
      getById: vi.fn(async () => ({ id: ACTOR_ID, name: "Venue Admin" })),
    },
    events: {
      upsertDraft: vi.fn(async (input: { orgId: string | null }) => ({
        id: NEW_EVENT_ID,
        orgId: input.orgId,
        humanId: null,
        status: "DRAFT",
        placeId: PLACE_ID,
        savedLocationId: null,
        postalCode: null,
        countryCode: null,
        region: null,
        addressText: null,
        instructionalAdmission: false,
      })),
      getById: vi.fn(async () => ({
        id: NEW_EVENT_ID,
        orgId: VENUE_ORG_ID,
        humanId: null,
        status: "DRAFT",
      })),
      linkPayoutTerms: vi.fn(async () => undefined),
      updateTaxRate: vi.fn(async () => undefined),
      setVenuePlacement: vi.fn(async () => undefined),
      // Place-address-withholding D1: a place-linked save takes the shared
      // place-location lock before reading the venue. A no-op in memory.
      lockLocationsAtPlace: vi.fn(async () => undefined),
      // booking-the-night P2c (W5 residual d): finalize takes the event row
      // inside its transaction, then the booking lock, then the booked line.
      lockRows: vi.fn(async () => undefined),
      // saveEvent runs assignSlugOnCreate after the draft lands. Null context
      // is the no-op branch: it returns early WITHOUT reporting, which is what
      // this test wants — a slugless draft is a legitimate best-effort outcome
      // (the slug is re-derived at publish), and the happy path here is about
      // dep wiring, not slug generation. Omitting the method entirely made the
      // call throw into the swallow branch and trip the reportError assertion.
      getSlugContext: vi.fn(async () => null),
    },
    // Calendars are REQUIRED on the aggregate since Step 5: one default
    // calendar with an ACTIVE space, mirroring what upsert-place mints — the
    // unrouted request gets fallback placement stamped silently (no report).
    calendars: {
      listByPlace: vi.fn(async () => [
        {
          id: "ca1e0da1-1111-4111-8111-111111111111",
          placeId: PLACE_ID,
          name: "Main Calendar",
          slug: "main",
          description: null,
          isDefault: true,
          defaultStartTime: null,
          defaultCategoryId: null,
          eventTemplate: null,
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          spaces: [
            {
              id: "0000f00d-1111-4111-8111-111111111111",
              placeId: PLACE_ID,
              name: "Main Space",
              capacity: null,
              sortOrder: 0,
              status: "ACTIVE",
              createdAt: new Date("2026-06-01T00:00:00.000Z"),
              updatedAt: new Date("2026-06-01T00:00:00.000Z"),
            },
          ],
        },
      ]),
    },
    eventHumans: {
      attach: vi.fn(async (input: Record<string, unknown>) => ({
        id: "ee11ee11-ee11-4e11-8e11-ee11ee11ee11",
        ...input,
      })),
    },
    placeLayouts: { getByPlace: vi.fn(async () => null) },
    resourceQuotas: {
      getEffectiveQuota: vi.fn(async () => ({
        limitValue: BigInt("9007199254740991"),
        currentUsage: 0n,
      })),
      hasPendingExpansionRequest: vi.fn(async () => false),
      incrementUsage: vi.fn(async () => undefined),
    },
    payoutTerms: {
      listLines: vi.fn(async () => []),
      activate: vi.fn(async () => ({ id: TERMS_ID, status: "ACTIVE" })),
      getById: vi.fn(async () => ({ id: TERMS_ID, status: "ACTIVE" })),
    },
    payees: { getByIds: vi.fn(async () => []) },
    // freeze-the-deal: finalize locks the event's terms rows before its fence
    // (the minted draft is not frozen, so the fence passes).
    deals: { lockTerms: vi.fn(async () => true) },
    audit: { log: vi.fn(async () => undefined) },
    // booking-the-night review W1: the manual mint reads the request's holds
    // and checks the night's line under its lock. An empty line here.
    bookingHolds: {
      listForRequest: vi.fn(async () => []),
      lockLine: vi.fn(async () => undefined),
      // booking-the-night P2c: finalize serializes on the request's booking
      // lock (event row -> booking lock -> lines). A no-op in memory.
      lockRequestBooking: vi.fn(async () => undefined),
      listLine: vi.fn(async () => []),
    },
  };

  const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(mocks));
  return { mocks, repos: { ...mocks, tx } as unknown as Ctx["repos"] };
}

function makeIdempotency() {
  const results = new Map<string, unknown>();
  return {
    begin: vi.fn(async () => true),
    commit: vi.fn(async (key: string, value: unknown) => {
      results.set(key, value);
    }),
    fail: vi.fn(async () => undefined),
    get: vi.fn(async (key: string) => results.get(key) ?? null),
  } as unknown as Ctx["idempotency"];
}

describe("bookingAgreements.createEventFromAgreement", () => {
  it("wires deps, threads the actor, and returns the use-case output", async () => {
    const { mocks, repos } = buildRepos();
    const reportError = vi.fn();
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: ACTOR_ID,
      reportError,
    });

    const result = await caller.createEventFromAgreement({
      agreementId: AGREEMENT_ID,
    });

    expect(result).toEqual({
      eventId: NEW_EVENT_ID,
      alreadyLinked: false,
      finalized: true,
    });
    expect(mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(mocks.eventHumans.attach).toHaveBeenCalledWith(
      expect.objectContaining({ role: "PERFORMER", sortOrder: 0 }),
    );
    // No orphan branch on the happy path.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("maps typed domain errors through toTrpcError", async () => {
    const { repos } = buildRepos({ status: "DRAFT" });
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.createEventFromAgreement({ agreementId: AGREEMENT_ID }),
    ).rejects.toMatchObject({
      // AGREEMENT_NOT_ACCEPTED maps to a client error, never INTERNAL.
      code: expect.not.stringMatching(/INTERNAL_SERVER_ERROR/),
    });
  });

  it("maps TERMS_EDITOR_ONLY to FORBIDDEN when the act side tries to send for review", async () => {
    // The linked request names the proposer human as the act, so this
    // actor (the performer, not the venue) may not touch the terms.
    const { repos } = buildRepos({ status: "DRAFT" });
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      caller.sendForReview({ agreementId: AGREEMENT_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "TERMS_EDITOR_ONLY",
    });
  });

  it("rejects unauthenticated callers", async () => {
    const { repos } = buildRepos();
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: null,
      auth: null,
    });

    await expect(
      caller.cancel({ agreementId: AGREEMENT_ID, reason: "No longer needed." }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects unauthenticated callers (createEventFromAgreement)", async () => {
    const { repos } = buildRepos();
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: null,
      auth: null,
    });

    await expect(
      caller.createEventFromAgreement({ agreementId: AGREEMENT_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("bookingAgreements.get — the bill (lineup v3, FR-011)", () => {
  it("the venue-facing bill survives .output(): passed absent, positions dense, ids only for joined acts", async () => {
    const { mocks, repos } = buildRepos();
    const JOINED = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";
    const PASSED = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
    const row = (over: Record<string, unknown>) => ({
      id: crypto.randomUUID(),
      bookingRequestId: REQUEST_ID,
      actOwnerType: null,
      actOwnerId: null,
      externalName: null,
      externalUrl: null,
      role: "PERFORMER",
      customRoleLabel: null,
      confirmation: "CONFIRMED",
      invitedAt: null,
      respondedAt: null,
      declineReason: null,
      removedAt: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      ...over,
    });
    mocks.bookingRequests.listActsForRequests = vi.fn(async () => [
      row({ source: "TAGGED", actOwnerType: "human", actOwnerId: PASSED, sortOrder: 0, confirmation: "DECLINED" }),
      row({ source: "TAGGED", actOwnerType: "human", actOwnerId: JOINED, sortOrder: 1, role: "DJ" }),
      row({ source: "EXTERNAL", externalName: "The Weeds", externalUrl: "https://weeds.example", sortOrder: 2 }),
    ]) as never;
    Object.assign(mocks.humans, {
      getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: "Della Wire" }))),
    });
    Object.assign(mocks.organizations, {
      getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: "Venue Org" }))),
    });
    // The file's shared request is the mint's minimal shape; the agreement
    // read projects the pitch, so this one is a full TO_VENUE row.
    const fullRequest = {
      ...(await mocks.bookingRequests.findByAgreementId()),
      status: "ACCEPTED",
      message: "We'd love to play.",
      expectedDraw: 80,
      genre: "punk",
      links: [],
      calendarId: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    mocks.bookingRequests.findByAgreementId = vi.fn(async () => fullRequest) as never;
    // `repos` is a copy of the bag, so the new repo goes on it directly.
    Object.assign(repos, {
      entityPages: { getByOwners: vi.fn(async () => []) },
    });
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.get({ agreementId: AGREEMENT_ID });

    expect(result.billUnavailable).toBe(false);
    expect(result.bill).toEqual([
      expect.objectContaining({
        source: "TAGGED",
        displayName: "Della Wire",
        confirmation: "CONFIRMED",
        role: "DJ",
        sortOrder: 0,
        joinedAs: { ownerType: "human", ownerId: JOINED },
      }),
      expect.objectContaining({
        source: "EXTERNAL",
        displayName: "The Weeds",
        href: null,
        sortOrder: 1,
        joinedAs: null,
      }),
    ]);
    expect(JSON.stringify(result.bill)).not.toContain(PASSED);
  });
});

describe("bookingAgreements.cancel", () => {
  const REASON = "The room is no longer available that night.";

  it("wires deps, threads the actor, CASes to CANCELLED and pings the other side", async () => {
    const { mocks, repos } = buildRepos({ status: "PROPOSED" });
    const notify = vi.fn(async () => ({}) as never);
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: ACTOR_ID,
      notify,
    });

    // Fake `updateStatus` echoes the agreement; override so status reads back.
    mocks.agreements.updateStatus.mockResolvedValueOnce({
      ...buildAgreement({ status: "CANCELLED" }),
    } as never);

    const result = await caller.cancel({ agreementId: AGREEMENT_ID, reason: REASON });

    expect(result).toEqual({
      agreementId: AGREEMENT_ID,
      status: "CANCELLED",
      acceptedAt: null,
      declinedAt: null,
    });
    expect(mocks.agreements.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: AGREEMENT_ID,
        status: "CANCELLED",
        expectedFrom: ["DRAFT", "PROPOSED", "ACCEPTED"],
        expectEventIdNull: true,
      }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.cancelled",
        data: expect.objectContaining({ actorHumanId: ACTOR_ID, reason: REASON }),
      }),
    );
    // The other party (the performer human) is pinged, best-effort.
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: expect.stringContaining(":cancelled:"),
      }),
    );
  });

  it("threads ctx.reportError so a swallowed notify failure reaches Sentry", async () => {
    const { mocks, repos } = buildRepos({ status: "PROPOSED" });
    const notifyError = new Error("notify down");
    const notify = vi.fn(async () => {
      throw notifyError;
    });
    const reportError = vi.fn();
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: ACTOR_ID,
      notify,
      reportError,
    });
    mocks.agreements.updateStatus.mockResolvedValueOnce({
      ...buildAgreement({ status: "CANCELLED" }),
    } as never);

    await expect(
      caller.cancel({ agreementId: AGREEMENT_ID, reason: REASON }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      notifyError,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "booking-agreements.notify-party",
          eventKey: "cancelled",
        }),
      }),
    );
  });

  it("maps AGREEMENT_NOT_CANCELLABLE to CONFLICT on a terminal agreement", async () => {
    const { mocks, repos } = buildRepos({ status: "DECLINED" });
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.cancel({ agreementId: AGREEMENT_ID, reason: REASON }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "AGREEMENT_NOT_CANCELLABLE",
    });
    expect(mocks.agreements.updateStatus).not.toHaveBeenCalled();
  });

  it("maps TERMS_EDITOR_ONLY to FORBIDDEN when the act tries to cancel", async () => {
    const { repos } = buildRepos({ status: "PROPOSED" });
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      caller.cancel({ agreementId: AGREEMENT_ID, reason: REASON }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "TERMS_EDITOR_ONLY" });
  });

  it("rejects a markup-only reason at the boundary", async () => {
    const { mocks, repos } = buildRepos({ status: "PROPOSED" });
    const { caller } = createCaller(bookingAgreementsRouter, {
      repos,
      idempotency: makeIdempotency(),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.cancel({ agreementId: AGREEMENT_ID, reason: "<b></b>" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.agreements.updateStatus).not.toHaveBeenCalled();
  });
});
