import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { UpdateBookingRequestStatusInput } from "@th/types/repos/booking-requests";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { markBookingRequestViewed } from "../mark-booking-request-viewed";
import { withdrawBookingRequest } from "../withdraw-booking-request";
import { createBookingRequest } from "../create-booking-request";
import { createOrganizerBookingRequest } from "../create-organizer-booking-request";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  NOW,
  ORGANIZER_ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  TERMS_ID,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  buildPlaceRecord,
  makeFakeIdempotency,
  systemEntriesFor,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING TIMELINE — the REQUEST-side emitters (step 2).
//
// "We see the agreement get hammered out there, it gets logged as an entry in
// the message history." These tests pin the two things that make the thread a
// LEDGER rather than a log: the right kind + params land for every lifecycle
// transition, and the entry rides the transition's OWN transaction — a
// transition that fails writes no entry, and an entry that fails fails the
// transition. A booking is a ledger; a missing entry is a lying ledger.
//
// The agreement-side emitters live in
// `booking-agreements/__tests__/booking-timeline-agreement-emitters.test.ts`;
// `booking_event.modified` lives in
// `events/__tests__/booking-event-modified.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

// ── mark viewed ──────────────────────────────────────────────────────────────

function buildViewedDeps(options: { failLedger?: boolean } = {}) {
  const request = buildBookingRequestRecord();
  const markViewed = vi.fn(async ({ now }: { now: Date }) =>
    buildBookingRequestRecord({ status: "VIEWED", viewedAt: now }),
  );
  const bookingRequests = { getById: vi.fn(async () => request), markViewed };
  const audit = { log: vi.fn(async () => {}) };
  const places = { getById: vi.fn(async () => buildPlaceRecord()) };
  const authz = { getOrgMemberships: vi.fn(async () => []) };

  const bookingRequestMessages = createFakeBookingRequestMessagesRepo();
  if (options.failLedger) {
    bookingRequestMessages.create = vi.fn(async () => {
      throw new Error("ledger write failed");
    });
  }

  const mocks = {
    bookingRequests,
    places,
    authz,
    audit,
    bookingRequestMessages,
  };
  const repos = withTx(mocks);
  return {
    deps: { repos, clock: { now: () => NOW } } as never,
    repos,
    markViewed,
    audit,
  };
}

describe("booking timeline — booking_request.viewed", () => {
  it("appends one viewed entry, attributed to the human who opened it", async () => {
    const { deps, repos } = buildViewedDeps();

    await markBookingRequestViewed(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_request.viewed",
        systemData: {},
        // Recorded so the copy can say who; the row is still SYSTEM-sided,
        // which is what keeps it out of unread counts.
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("writes NOTHING when the request is already VIEWED (idempotent no-op)", async () => {
    const request = buildBookingRequestRecord({ status: "VIEWED" });
    const mocks = {
      bookingRequests: {
        getById: vi.fn(async () => request),
        markViewed: vi.fn(),
      },
      places: { getById: vi.fn(async () => buildPlaceRecord()) },
      authz: { getOrgMemberships: vi.fn(async () => []) },
      audit: { log: vi.fn(async () => {}) },
    };
    const repos = withTx(mocks);

    await markBookingRequestViewed(
      { repos, clock: { now: () => NOW } } as never,
      { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID },
    );

    // Re-opening the inbox must not re-log "viewed" forever.
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([]);
  });

  it("fails the WHOLE transition when the ledger write fails (same tx)", async () => {
    const { deps, markViewed, audit } = buildViewedDeps({ failLedger: true });

    await expect(
      markBookingRequestViewed(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toThrow("ledger write failed");

    // The CAS ran, but it is inside the transaction the throw aborts — the
    // audit row after the append never ran, which is the structural proof the
    // append is INSIDE the transition's tx and not bolted on after it.
    expect(markViewed).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
  });
});

// ── withdraw ─────────────────────────────────────────────────────────────────

describe("booking timeline — booking_request.withdrawn", () => {
  function buildWithdrawDeps(request: BookingRequestRecord | null) {
    const mocks = {
      bookingRequests: {
        getById: vi.fn(async () => request),
        updateStatus: vi.fn(async (input: UpdateBookingRequestStatusInput) =>
          buildBookingRequestRecord({ ...request!, status: input.status }),
        ),
      },
      authz: { getOrgMembership: vi.fn(async () => null) },
      audit: { log: vi.fn(async () => {}) },
    };
    const repos = withTx(mocks);
    return { deps: { repos, clock: { now: () => NOW } } as never, repos };
  }

  it("appends one withdrawn entry attributed to the sender", async () => {
    const { deps, repos } = buildWithdrawDeps(buildBookingRequestRecord());

    await withdrawBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_request.withdrawn",
        systemData: {},
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("writes NOTHING on the idempotent already-WITHDRAWN replay", async () => {
    const { deps, repos } = buildWithdrawDeps(
      buildBookingRequestRecord({ status: "WITHDRAWN" }),
    );

    await withdrawBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([]);
  });
});

// ── open (both directions) ───────────────────────────────────────────────────

describe("booking timeline — booking_request.opened", () => {
  it("opens the ledger on a TO_VENUE platform pitch", async () => {
    const place = buildPlaceRecord({ acceptsBookingRequests: true });
    const created = buildBookingRequestRecord({ id: REQUEST_ID });
    const mocks = {
      bookingRequests: {
        findOpenByPerformerAndPlace: vi.fn(async () => null),
        create: vi.fn(async () => created),
      },
      performerProfiles: {
        getByOwner: vi.fn(async () => ({
          id: "p1",
          ownerType: "human",
          ownerId: ACTOR_ID,
          enabledAt: NOW,
          disabledAt: null,
        })),
      },
      places: { getById: vi.fn(async () => place) },
      humans: { getById: vi.fn(async () => ({ id: ACTOR_ID, genreTags: [] })) },
      humanStats: { findByHumanId: vi.fn(async () => null) },
      authz: { getOrgMembership: vi.fn(async () => null) },
      audit: { log: vi.fn(async () => {}) },
      calendars: {
        findById: vi.fn(async () => null),
        findDefaultForPlace: vi.fn(async () => null),
        listByPlace: vi.fn(async () => []),
        listAvailabilityForPlace: vi.fn(async () => []),
        // FR-005 gate: CONFIGURED (rows exist, no window policy) so this
        // fixture keeps describing the timeline, not the gate.
        countAvailabilityForPlace: vi.fn(async () => 1),
      },
      events: {
        listPublishedOccurrencesByPlace: vi.fn(async () => []),
      },
    };
    const repos = withTx(mocks);

    await createBookingRequest({ repos, clock: { now: () => NOW } } as never, {
      actorHumanId: ACTOR_ID,
      performerOwnerType: "human",
      performerOwnerId: ACTOR_ID,
      placeId: PLACE_ID,
      message: "We'd love to play a Friday night slot.",
      preferredDates: ["2026-07-10"],
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_request.opened",
        // Both facts the copy branches on: which way it flows, and whether it
        // came through an embed.
        systemData: { direction: "TO_PLACE", source: "PLATFORM" },
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("opens the ledger on a TO_PERFORMER organizer request", async () => {
    const created = buildOrganizerBookingRequestRecord({ id: REQUEST_ID });
    const mocks = {
      bookingRequests: {
        findOpenByOrganizerAndPerformer: vi.fn(async () => null),
        createToPerformer: vi.fn(async () => created),
      },
      performerProfiles: {
        getByOwner: vi.fn(async () => ({
          id: "p1",
          ownerType: "human",
          ownerId: ACTOR_ID,
          enabledAt: NOW,
          disabledAt: null,
          acceptsBookingRequests: true,
        })),
      },
      events: { getById: vi.fn(async () => null) },
      authz: {
        getOrgMembership: vi.fn(async () => ({
          orgId: ORGANIZER_ORG_ID,
          humanId: ACTOR_ID,
          role: "ADMIN",
        })),
      },
      audit: { log: vi.fn(async () => {}) },
    };
    const repos = withTx(mocks);

    await createOrganizerBookingRequest(
      { repos, clock: { now: () => NOW } } as never,
      {
        actorHumanId: ACTOR_ID,
        organizerOrgId: ORGANIZER_ORG_ID,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        message: "We'd love you to headline our Friday showcase.",
        preferredDates: ["2026-07-10"],
      },
    );

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_request.opened",
        systemData: { direction: "TO_PERFORMER", source: "PLATFORM" },
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });
});

// ── respond (accept / decline / anonymous accept / idempotent replay) ────────

function buildRespondDeps(
  options: { request?: BookingRequestRecord } = {},
): { deps: never; repos: Record<string, unknown> } {
  let current = options.request ?? buildBookingRequestRecord();
  const place = buildPlaceRecord({
    humanIdsWithAccess: [ACTOR_ID],
    defaultPrimaryPayoutTermsId: null,
  });

  const mocks = {
    bookingRequests: {
      getById: vi.fn(async () => current),
      // ── P3b (asks) ── the accept seeds an answered SET_LENGTH ask (none here).
      listAsks: vi.fn(async () => []),
      updateStatus: vi.fn(async (input: UpdateBookingRequestStatusInput) => {
        current = {
          ...current,
          status: input.status,
          declineReason: input.declineReason ?? current.declineReason,
          agreementId: input.agreementId ?? current.agreementId,
        } as BookingRequestRecord;
        return current;
      }),
      setClaimToken: vi.fn(async () => current),
    },
    places: { getById: vi.fn(async () => place) },
    authz: { getOrgMemberships: vi.fn(async () => []) },
    payoutTerms: {
      clone: vi.fn(),
      createDraft: vi.fn(async () => ({ id: TERMS_ID })),
    },
    agreements: { create: vi.fn(async () => ({ id: AGREEMENT_ID })) },
    audit: { log: vi.fn(async () => {}) },
  };
  const repos = withTx(mocks);

  return {
    deps: {
      repos,
      idempotency: makeFakeIdempotency(),
      clock: { now: () => NOW },
      // The anonymous fork sends an invite email post-commit; a missing mailer
      // is a reported swallow, never a failed accept.
      reportError: vi.fn(),
    } as never,
    repos: repos as unknown as Record<string, unknown>,
  };
}

describe("booking timeline — respond", () => {
  it("accept logs ONE entry, carrying the draft it produced", async () => {
    const { deps, repos } = buildRespondDeps();

    await (
      await import("../respond-to-booking-request")
    ).respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    // NOT two. A companion `booking_agreement.drafted` in the SAME transaction
    // would carry the same agreementId this entry already links, and would be
    // unorderable against it: `createdAt` defaults to Postgres
    // CURRENT_TIMESTAMP (the TRANSACTION timestamp, identical for both rows)
    // and the thread's `[createdAt asc, id asc]` tie-break falls through to a
    // random uuid v4 — so "Draft agreement created" rendered above "Request
    // accepted" about half the time.
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_request.accepted",
        systemData: { agreementId: AGREEMENT_ID },
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("a REPLAYED accept (idempotency envelope) does not duplicate the entry", async () => {
    const { deps, repos } = buildRespondDeps();
    const { respondToBookingRequest } = await import(
      "../respond-to-booking-request"
    );
    const input = {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    } as const;

    await respondToBookingRequest(deps, input);
    // Second call: the envelope serves the cached response BEFORE the
    // transaction opens, so nothing re-appends.
    await respondToBookingRequest(deps, input);

    expect(
      systemEntriesFor(repos, REQUEST_ID).map((e) => e.systemKind),
    ).toEqual(["booking_request.accepted"]);
  });

  it("decline COPIES the reason onto the entry", async () => {
    const { deps, repos } = buildRespondDeps();

    await (
      await import("../respond-to-booking-request")
    ).respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "Fully booked through October.",
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_request.declined",
        // Copied, not read live off the mutable request row.
        systemData: { reason: "Fully booked through October." },
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("accepting an ANONYMOUS embed inquiry records agreementId: null", async () => {
    const { deps, repos } = buildRespondDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "The Basement Tapes",
        contactEmail: "band@example.com",
        source: "EMBED",
      }),
    });

    await (
      await import("../respond-to-booking-request")
    ).respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    // NO agreement is minted on an anonymous accept — the draft arrives later,
    // at claim time. The nullable field exists precisely for this.
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_request.accepted",
        systemData: { agreementId: null },
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  // The OTHER accept branch. It mirrors the TO_VENUE one line for line, which
  // is exactly why it needs its own pin: the two drifted apart once already.
  it("a TO_PERFORMER accept also logs ONE entry", async () => {
    let current = buildOrganizerBookingRequestRecord();
    const mocks = {
      bookingRequests: {
        getById: vi.fn(async () => current),
        updateStatus: vi.fn(async (input: UpdateBookingRequestStatusInput) => {
          current = {
            ...current,
            status: input.status,
            agreementId: input.agreementId ?? current.agreementId,
          } as typeof current;
          return current;
        }),
      },
      // The act is a HUMAN and the actor IS that human — self-access, no
      // membership lookup.
      authz: { getOrgMemberships: vi.fn(async () => []) },
      performerBookingDefaults: { getByOwner: vi.fn(async () => null) },
      entityPages: { getByOwner: vi.fn(async () => null) },
      humans: { getById: vi.fn(async () => ({ id: ACTOR_ID, name: "Dana" })) },
      organizations: { getById: vi.fn(async () => null) },
      events: { getById: vi.fn(async () => null) },
      payoutTerms: { createDraft: vi.fn(async () => ({ id: TERMS_ID })) },
      agreements: { create: vi.fn(async () => ({ id: AGREEMENT_ID })) },
      audit: { log: vi.fn(async () => {}) },
    };
    const repos = withTx(mocks);

    await (
      await import("../respond-to-booking-request")
    ).respondToBookingRequest(
      {
        repos,
        idempotency: makeFakeIdempotency(),
        clock: { now: () => NOW },
        reportError: vi.fn(),
      } as never,
      {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      },
    );

    expect(
      systemEntriesFor(repos as unknown as Record<string, unknown>, REQUEST_ID),
    ).toEqual([
      {
        systemKind: "booking_request.accepted",
        systemData: { agreementId: AGREEMENT_ID },
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });
});
