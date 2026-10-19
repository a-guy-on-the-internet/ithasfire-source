import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import type { Ctx } from "../../context";
import { bookingRequestsRouter } from "../booking-requests";
import { createCaller } from "./test-helpers";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";
import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";

/**
 * Deps-wiring tests for bookingRequests.list: the use case's corrupt-row
 * swallow (skip one row, keep the list alive) reports through `reportError`,
 * so the router MUST thread `ctx.reportError` into the deps — a declared-but-
 * never-injected reporter would make the deliberate swallow invisible in prod
 * (ReporterPort convention; the exact bug class behind the Jun 2026 silent
 * search outage).
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const OWNED_ID = "44444444-4444-4444-8444-444444444444";
const CORRUPT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function buildRecord(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return {
    id: OWNED_ID,
    direction: "TO_VENUE",
    // Intent + placement (venue-confirmation-and-booking-intents spec). The
    // summary schema requires `intent`, and the claim path derives who owns
    // the minted event from it (PERFORM → venue; RENT / USE → requester).
    intent: "PERFORM",
    spaceId: null,
    requestedStartsAt: null,
    requestedEndsAt: null,
    expectedAttendance: null,
    purpose: null,
    originEventId: null,
    parkedUnclaimedAt: null,
    placeId: PLACE_ID,
    placeName: "Test Venue",
    calendarId: null,
    calendarName: null,
    organizerOrgId: null,
    organizerOrgName: null,
    attachedEventId: null,
    attachedEventTitle: null,
    attachedEventStartsAt: null,
    performerOwnerType: "human",
    performerOwnerId: ACTOR_ID,
    contactName: null,
    contactEmail: null,
    source: "PLATFORM",
    embedId: null,
    claimTokenHash: null,
    claimTokenExpiresAt: null,
    claimedAt: null,
    inquirerEmailMessageId: null,
    inquirerEmailUndeliverableAt: null,
    inquirerEmailUndeliverableStatus: null,
    message: "We'd love to play a Friday night slot.",
    preferredDates: ["2026-07-10"],
    expectedDraw: 80,
    genre: "punk",
    links: [],
    actName: null,
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
    status: "PENDING",
    viewedAt: null,
    respondedAt: null,
    declineReason: null,
    agreementId: null,
    verifiedStatsSnapshot: null,
    assigneeHumanId: null,
    tags: [],
    taxFormStatus: "NONE",
    lastMessageAt: null,
    expiresAt: new Date("2026-06-24T12:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
    // A spread of `Partial<union>` can never `satisfies` the union (every
    // discriminated key widens to `string | null`), so the annotation is a
    // cast, not a check — the field list above is what has to stay complete.
  } as BookingRequestRecord;
}

/** Sender-invariant violation — neither owner pair nor contact fields. */
function buildCorruptRecord(): BookingRequestRecord {
  return buildRecord({
    id: CORRUPT_ID,
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: null,
    contactEmail: null,
  });
}

function buildRepos(records: BookingRequestRecord[]): Ctx["repos"] {
  return {
    bookingRequests: {
      listForPerformer: vi.fn(async () => records),
      listForPlace: vi.fn(async () => records),
      // The bill (lineup v2): pre-bill rows — no acts. Present so the
      // corrupt-row assertion stays the ONLY report on this fixture.
      listActsForRequests: vi.fn(async () => []),
    },
    humans: {
      getByIds: vi.fn(async () => [{ id: ACTOR_ID, name: "Test Performer" }]),
    },
    organizations: { getByIds: vi.fn(async () => []) },
    places: { getById: vi.fn() },
    authz: {
      getOrgMemberships: vi.fn(async () => []),
      getOrgMembership: vi.fn(async () => null),
    },
    // Quiet threads: the batch unread count returns an empty map, so every
    // summary zero-fills to `unreadMessageCount: 0`. Present (not omitted) so
    // this fixture keeps exercising ONLY the corrupt-row report — a missing
    // repo would throw inside the unread lookup and fire a SECOND report.
    bookingRequestMessages: {
      countUnreadByRequest: vi.fn(async () => new Map<string, number>()),
    },
    // Stage projection (request → agreement → event). Present for the same
    // reason as the messages repo above: an omitted repo throws
    // NOT_CONFIGURED inside the stage lookup, which would take this fixture's
    // corrupt-row assertion off its intended path entirely.
    ...stageRepos(),
  } as unknown as Ctx["repos"];
}

/**
 * Empty-but-wired `agreements` + `events` repos for the LIST fixtures. The
 * stage lookup short-circuits before touching them when no row carries an
 * `agreementId`, but the use case's wiring guard runs unconditionally — the
 * deliberate "a missing repo is loud, not silently dead" posture.
 */
function stageRepos() {
  return {
    agreements: { findManyByIds: vi.fn(async () => []) },
    events: { findManyByIds: vi.fn(async () => []) },
    // Booking-holds workflow projection (holds + tags) — same wiring-guard
    // posture as the stage repos above.
    bookingHolds: {
      listLiveForRequests: vi.fn(async () => []),
      listRequestIdsWithConfirmedHold: vi.fn(async () => []),
    },
    bookingTags: { listForRequests: vi.fn(async () => []) },
  };
}

/**
 * Repos mock for the CREATE path (human sender pitching a human-owned place)
 * plus the post-commit venue-notification use case
 * (notify-booking-request-received: humans.getByIdWithIdentity +
 * entityPages.getByOwner for the owner's admin slug).
 */
/**
 * Ledger plumbing (booking timeline step 2). Every lifecycle transition
 * appends a SYSTEM entry from inside its own transaction, so any fixture whose
 * `tx` runs a transition needs the messages writer and the `lastMessageAt`
 * bump. Kept in one place so the fixtures below stay about what they test.
 */
function withLedger<T extends Record<string, unknown>>(mocks: T): T {
  return {
    ...mocks,
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
    bookingRequests: {
      ...((mocks.bookingRequests as Record<string, unknown>) ?? {}),
      touchLastMessageAt: vi.fn(async () => {}),
    },
  } as unknown as T;
}

function buildCreateRepos(): Ctx["repos"] {
  const place = {
    id: PLACE_ID,
    name: "Test Venue",
    verificationStatus: "VERIFIED",
    acceptsBookingRequests: true,
    humanIdsWithAccess: [OWNER_HUMAN_ID],
    orgIdsWithAccess: [],
  };
  const mocks = withLedger({
    bookingRequests: {
      findOpenByPerformerAndPlace: vi.fn(async () => null),
      create: vi.fn(async (input: Record<string, unknown>) =>
        buildRecord({
          ...(input as Partial<BookingRequestRecord>),
          id: OWNED_ID,
        }),
      ),
      // The bill (lineup-booking-requests v2): a PERFORM create writes its
      // act rows (at least the sender's SELF row) in the same tx.
      addActs: vi.fn(async () => []),
    },
    performerProfiles: {
      getByOwner: vi.fn(async () => ({
        id: "profile-1",
        ownerType: "human",
        ownerId: ACTOR_ID,
        enabledAt: new Date("2026-01-01T00:00:00.000Z"),
        disabledAt: null,
      })),
    },
    places: { getById: vi.fn(async () => place) },
    humans: {
      getById: vi.fn(async () => ({ id: ACTOR_ID, genreTags: [] })),
      getByIds: vi.fn(async () => [{ id: ACTOR_ID, name: "Test Performer" }]),
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Venue Owner" },
        identity: { username: "venueowner" },
      })),
    },
    organizations: {
      getById: vi.fn(async () => null),
      getByIds: vi.fn(async () => []),
      listMembers: vi.fn(async () => ({ items: [], total: 0 })),
    },
    entityPages: { getByOwner: vi.fn(async () => null) },
    authz: { getOrgMembership: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => {}) },
    humanStats: { findByHumanId: vi.fn(async () => null) },
    // No published events at the place = no existing bookings to collide
    // with — "nothing configured, don't block".
    events: {
      listPublishedByPlace: vi.fn(async () => ({
        items: [],
        nextCursor: null,
      })),
      listPublishedOccurrencesByPlace: vi.fn(async () => []),
    },
    // Calendar routing (FR-008) + the availability gate, which is
    // calendar-scoped since the picker's re-target (FR-007). No calendars at
    // all = the request routes calendarId null (unrouted) and no availability
    // rules apply — both keep every expectation in this suite intact.
    calendars: {
      findById: vi.fn(async () => null),
      findDefaultForPlace: vi.fn(async () => null),
      listByPlace: vi.fn(async () => []),
      listAvailabilityForPlace: vi.fn(async () => []),
      // Availability-onboarding FR-005 gate: CONFIGURED (rows exist, no
      // window policy) so this suite keeps testing wiring, not the gate.
      countAvailabilityForPlace: vi.fn(async () => 1),
    },
    // Venue booking standards (spec 2026-09-25): nothing configured, so the
    // create gate reads the platform list and blocks nothing — without it the
    // read would take the degrade branch and report on every create here.
    bookingStandards: createFakeBookingStandards(),
  });
  return {
    ...mocks,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
  } as unknown as Ctx["repos"];
}

const OWNER_HUMAN_ID = "77777777-7777-4777-8777-777777777777";

const createInput = {
  performerOwnerType: "human",
  performerOwnerId: ACTOR_ID,
  placeId: PLACE_ID,
  message: "We'd love to play a Friday night slot.",
  preferredDates: ["2026-08-14"],
  genre: "punk",
  actName: "The Ramblers",
} as const;

describe("bookingRequestsRouter.create — venue notification wiring (FR-008)", () => {
  it("fires the notification deps post-success: notify called with the variant + per-recipient key (sms disabled)", async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildCreateRepos(),
      actorHumanId: ACTOR_ID,
      notify: notify as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.test",
    });

    const result = await caller.create(createInput);

    expect(result.bookingRequestId).toBe(OWNED_ID);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: OWNER_HUMAN_ID,
        variant: "booking.request-received",
        idempotencyKey: `booking-request-received:${OWNED_ID}:${OWNER_HUMAN_ID}`,
        channels: { sms: { enabled: false } },
        payload: expect.objectContaining({
          placeName: "Test Venue",
          actName: "The Ramblers",
          source: "PLATFORM",
          inboxUrl: `https://ithasfire.test/admin/@venueowner/places/${PLACE_ID}/bookings`,
        }),
      }),
    );
  });

  it("prefers ctx.notifyWithEmail (mailer-bound) over ctx.notify when present", async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const notifyWithEmail = vi.fn(async () => ({ ok: true }));
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildCreateRepos(),
      actorHumanId: ACTOR_ID,
      notify: notify as unknown as Ctx["notify"],
      notifyWithEmail: notifyWithEmail as unknown as Ctx["notifyWithEmail"],
      publicAppUrl: "https://ithasfire.test",
    });

    await caller.create(createInput);

    expect(notifyWithEmail).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a throwing notify does NOT fail the mutation and reports via ctx.reportError (NFR-004)", async () => {
    const notify = vi.fn(async () => {
      throw new Error("notify pipeline down");
    });
    const reportError = vi.fn();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildCreateRepos(),
      actorHumanId: ACTOR_ID,
      notify: notify as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.test",
      reportError,
    });

    const result = await caller.create(createInput);

    expect(result.bookingRequestId).toBe(OWNED_ID);
    expect(notify).toHaveBeenCalledTimes(1);
    // The per-recipient swallow inside notifyBookingRequestReceived reports.
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "notifyBookingRequestReceived" },
      extra: {
        bookingRequestId: OWNED_ID,
        placeId: PLACE_ID,
        humanId: OWNER_HUMAN_ID,
      },
    });
  });

  it("missing publicAppUrl: mutation still succeeds, failure reported through the caller swallow", async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const reportError = vi.fn();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildCreateRepos(),
      actorHumanId: ACTOR_ID,
      notify: notify as unknown as Ctx["notify"],
      publicAppUrl: null,
      reportError,
    });

    const result = await caller.create(createInput);

    expect(result.bookingRequestId).toBe(OWNED_ID);
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "createBookingRequest" },
      extra: { bookingRequestId: OWNED_ID, placeId: PLACE_ID },
    });
  });
});

describe("bookingRequestsRouter.create — lineup wiring (lineup v2, FR-003 / FR-007)", () => {
  const TAGGED_ID = "abababab-abab-4bab-8bab-abababababab";
  const LINEUP_KEY = `bookingRequests:lineupTags:human:${ACTOR_ID}:daily`;

  /** The create fixture, plus what the taggable check reads (ACTIVE + a PUBLIC page). */
  function buildLineupRepos(): Ctx["repos"] {
    const repos = buildCreateRepos() as unknown as {
      humans: Record<string, unknown>;
      entityPages: Record<string, unknown>;
    };
    repos.humans.getByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        name: id === ACTOR_ID ? "Test Performer" : "Tagged Artist",
        status: "ACTIVE",
      })),
    );
    repos.entityPages.getByOwners = vi.fn(async (_type: string, ids: string[]) =>
      ids.map((ownerId) => ({
        id: `page-${ownerId}`,
        ownerType: "HUMAN",
        ownerId,
        displayName: null,
        visibility: "PUBLIC",
      })),
    );
    return repos as unknown as Ctx["repos"];
  }

  const taggedInput = {
    ...createInput,
    bill: { includeSelf: true, acts: [{ kind: "tagged", humanId: TAGGED_ID }] },
  } as const;

  it("threads ctx.rateLimit as the tag budget and sends the lineup invite ONCE, post-commit, via ctx.notifyWithEmail ?? ctx.notify", async () => {
    const notify = vi.fn(async (_input: { variant: string }) => ({ ok: true }));
    const consume = vi.fn(async (_key: string) => ({
      allowed: true,
      remaining: 20,
      retryAfterSeconds: 0,
    }));
    const repos = buildLineupRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      notify: notify as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.test",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    const result = await caller.create(taggedInput);

    expect(result.bookingRequestId).toBe(OWNED_ID);
    // Budget: one tag → one consume on the SENDER's lineup bucket.
    expect(consume.mock.calls.filter(([key]) => key === LINEUP_KEY)).toEqual([
      [LINEUP_KEY, 30, 86_400],
    ]);

    // Bill written in-tx: SELF row 0, the tagged act row 1.
    const addActs = (repos.bookingRequests as unknown as {
      addActs: ReturnType<typeof vi.fn>;
    }).addActs;
    expect(addActs).toHaveBeenCalledWith(OWNED_ID, [
      expect.objectContaining({ source: "SELF", sortOrder: 0 }),
      expect.objectContaining({ source: "TAGGED", actOwnerId: TAGGED_ID, sortOrder: 1 }),
    ]);

    // Invite: exactly one, to the tagged human, AFTER the bill write.
    const lineupIdx = notify.mock.calls
      .map(([input], index) => (input.variant === "booking.lineup-invited" ? index : -1))
      .filter((index) => index >= 0);
    expect(lineupIdx).toHaveLength(1);
    expect(notify.mock.calls[lineupIdx[0]!]![0]).toMatchObject({
      humanId: TAGGED_ID,
      idempotencyKey: `booking-lineup-invited:${OWNED_ID}:${TAGGED_ID}`,
      channels: { sms: { enabled: false } },
      payload: {
        senderName: "Test Performer",
        venueName: "Test Venue",
        targetUrl: `https://ithasfire.test/bookings/acts/${OWNED_ID}`,
      },
    });
    expect(notify.mock.invocationCallOrder[lineupIdx[0]!]!).toBeGreaterThan(
      addActs.mock.invocationCallOrder[0]!,
    );
  });

  it("an exhausted tag budget is TOO_MANY_REQUESTS and writes nothing", async () => {
    const consume = vi.fn(async (key: string) =>
      key === LINEUP_KEY
        ? { allowed: false, remaining: 0, retryAfterSeconds: 3600 }
        : { allowed: true, remaining: 9, retryAfterSeconds: 0 },
    );
    const repos = buildLineupRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      publicAppUrl: "https://ithasfire.test",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(caller.create(taggedInput)).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(repos.bookingRequests.create).not.toHaveBeenCalled();
  });
});

/**
 * Repos mock for the RESPOND path on an ANONYMOUS row (invite-to-claim,
 * FR-007): venue owner accepts → ACCEPTED + hashed claim token + post-commit
 * invite email through ctx.mailer.
 */
function buildRespondAnonymousRepos(): Ctx["repos"] {
  let current = buildRecord({
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "The Basement Tapes",
    contactEmail: "band@example.com",
    source: "EMBED",
  });
  const place = {
    id: PLACE_ID,
    name: "Test Venue",
    verificationStatus: "VERIFIED",
    acceptsBookingRequests: true,
    humanIdsWithAccess: [ACTOR_ID],
    orgIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
  };
  const mocks = withLedger({
    bookingRequests: {
      getById: vi.fn(async () => current),
      updateStatus: vi.fn(async (input: { status: string }) => {
        current = { ...current, status: input.status } as typeof current;
        return current;
      }),
      setClaimToken: vi.fn(
        async (input: {
          claimTokenHash: string;
          claimTokenExpiresAt: Date;
        }) => {
          current = {
            ...current,
            claimTokenHash: input.claimTokenHash,
            claimTokenExpiresAt: input.claimTokenExpiresAt,
          };
          return current;
        },
      ),
    },
    places: { getById: vi.fn(async () => place) },
    authz: { getOrgMemberships: vi.fn(async () => []) },
    agreements: { create: vi.fn() },
    payoutTerms: { clone: vi.fn(), createDraft: vi.fn() },
    audit: { log: vi.fn(async () => {}) },
  });
  return {
    ...mocks,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
  } as unknown as Ctx["repos"];
}

/** Working in-memory idempotency (test-helpers' default vi.fn()s return undefined, which the respond use case reads as a stuck lock). */
function buildIdempotency(): Ctx["idempotency"] {
  const results = new Map<string, unknown>();
  const claimed = new Set<string>();
  return {
    begin: vi.fn(async (key: string) => {
      if (claimed.has(key) || results.has(key)) return false;
      claimed.add(key);
      return true;
    }),
    commit: vi.fn(async (key: string, result: unknown) => {
      results.set(key, result);
      claimed.delete(key);
    }),
    fail: vi.fn(async (key: string) => {
      claimed.delete(key);
    }),
    get: vi.fn(async (key: string) => results.get(key) ?? null),
  } as unknown as Ctx["idempotency"];
}

describe("bookingRequestsRouter.respond — anonymous accept invite wiring (FR-007)", () => {
  it("accept on an anonymous row sends the invite email through ctx.mailer post-success", async () => {
    const send = vi.fn(async (_input: unknown) => ({
      result: { id: "msg-1", status: "sent" },
    }));
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildRespondAnonymousRepos(),
      idempotency: buildIdempotency(),
      actorHumanId: ACTOR_ID,
      mailer: {
        send,
        sendBatch: vi.fn(),
        health: vi.fn(),
      } as unknown as NonNullable<Ctx["mailer"]>,
      publicAppUrl: "https://ithasfire.test",
    });

    const result = await caller.respond({
      bookingRequestId: OWNED_ID,
      action: "accept",
    });

    expect(result).toEqual({ bookingRequestId: OWNED_ID, status: "ACCEPTED" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: { to: "band@example.com" },
      template: expect.objectContaining({
        key: "booking.invite_to_claim",
        variables: expect.objectContaining({
          placeName: "Test Venue",
          claimUrl: expect.stringContaining(
            "https://ithasfire.test/booking-requests/claim/",
          ),
        }),
      }),
    });
  });

  it("a throwing mailer does NOT fail the accept and reports via ctx.reportError (NFR-004)", async () => {
    const send = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const reportError = vi.fn();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildRespondAnonymousRepos(),
      idempotency: buildIdempotency(),
      actorHumanId: ACTOR_ID,
      mailer: {
        send,
        sendBatch: vi.fn(),
        health: vi.fn(),
      } as unknown as NonNullable<Ctx["mailer"]>,
      publicAppUrl: "https://ithasfire.test",
      reportError,
    });

    const result = await caller.respond({
      bookingRequestId: OWNED_ID,
      action: "accept",
    });

    expect(result.status).toBe("ACCEPTED");
    expect(send).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "respondToBookingRequest" },
      extra: { bookingRequestId: OWNED_ID, placeId: PLACE_ID },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// claim / resendInvite / listMySenders (booking-request-embed-button step 6)
// ─────────────────────────────────────────────────────────────────────────────

const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
const TERMS_ID = "66666666-6666-4666-8666-666666666666";
const PAYEE_ID = "77777777-7777-4777-8777-777777777777";
const ORG_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** 43 url-safe chars — matches CLAIM_TOKEN_PATTERN. */
const RAW_TOKEN = "a".repeat(43);

const claimablePlace = {
  id: PLACE_ID,
  name: "Test Venue",
  verificationStatus: "VERIFIED",
  acceptsBookingRequests: true,
  humanIdsWithAccess: [ACTOR_ID],
  orgIdsWithAccess: [],
  defaultPrimaryPayoutTermsId: null,
};

/** Repos for the CLAIM path (human sender redeeming an invite). */
function buildClaimRepos(recordOverrides: Partial<BookingRequestRecord> = {}) {
  const acceptedAnon = buildRecord({
    status: "ACCEPTED",
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "The Basement Tapes",
    contactEmail: "band@example.com",
    source: "EMBED",
    claimTokenHash: "hash-abc",
    claimTokenExpiresAt: new Date("2026-06-01T00:00:00.000Z"),
    ...recordOverrides,
  });
  const mocks = withLedger({
    bookingRequests: {
      findByClaimTokenHash: vi.fn(async () => acceptedAnon),
      claim: vi.fn(
        async (input: { performerOwnerId: string; claimedAt: Date }) => ({
          ...acceptedAnon,
          performerOwnerType: "human" as const,
          performerOwnerId: input.performerOwnerId,
          claimedAt: input.claimedAt,
          claimTokenHash: null,
          claimTokenExpiresAt: null,
        }),
      ),
      updateStatus: vi.fn(async (input: { agreementId?: string }) => ({
        ...acceptedAnon,
        performerOwnerType: "human" as const,
        performerOwnerId: ACTOR_ID,
        agreementId: input.agreementId ?? null,
      })),
      // The bill (lineup v2): a pre-bill inquiry — nothing to promote to SELF.
      listActsForRequests: vi.fn(async () => []),
    },
    performerProfiles: {
      getByOwner: vi.fn(async () => ({
        id: "profile-1",
        ownerType: "human",
        ownerId: ACTOR_ID,
        enabledAt: new Date("2026-01-01T00:00:00.000Z"),
        disabledAt: null,
      })),
    },
    places: { getById: vi.fn(async () => claimablePlace) },
    agreements: { create: vi.fn(async () => ({ id: AGREEMENT_ID })) },
    payoutTerms: {
      clone: vi.fn(),
      createDraft: vi.fn(async () => ({ id: TERMS_ID })),
      seedLinesIfEmpty: vi.fn(async () => true),
    },
    // Read ONLY on the requester-owned path (RENT / USE): the accept seeds a
    // 100% line to the requester's active, payout-enabled Payee.
    payees: {
      getBySubject: vi.fn(async () => ({ id: PAYEE_ID })),
      getById: vi.fn(async () => ({
        id: PAYEE_ID,
        status: "ACTIVE",
        payoutsEnabled: true,
      })),
    },
    authz: { getOrgMembership: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => {}) },
  });
  return {
    repos: {
      ...mocks,
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
    } as unknown as Ctx["repos"],
    mocks,
  };
}

describe("bookingRequestsRouter.claim (FR-007)", () => {
  it("happy path: injects ctx.actorHumanId, backfills the sender, mints the Agreement", async () => {
    const { repos, mocks } = buildClaimRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      idempotency: buildIdempotency(),
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.claim({
      rawToken: RAW_TOKEN,
      // Self sender: requireOwnerAccess passes ONLY because the router
      // injected ctx.actorHumanId (a mismatch throws NOT_RESOURCE_OWNER).
      performerOwnerType: "human",
      performerOwnerId: ACTOR_ID,
    });

    expect(result).toEqual({
      bookingRequestId: OWNED_ID,
      agreementId: AGREEMENT_ID,
    });
    expect(mocks.bookingRequests.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        id: OWNED_ID,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
      }),
    );
    expect(mocks.agreements.create).toHaveBeenCalledTimes(1);
    // PERFORM → the venue owns the show: a bare venue draft, no requester
    // payee read (the place has no default terms to clone).
    expect(mocks.payoutTerms.createDraft).toHaveBeenCalledTimes(1);
    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
  });

  it("RENT: the claimed row's intent drives the owner side — requester-owned terms are seeded on the mint", async () => {
    // A CHECK-valid RENT row ("BookingRequest_intent_shape_check": RENT / USE
    // need a requested WINDOW; a space is optional since 2026-09-22, and this
    // row carries one anyway — still legal). The anonymous embed inquiry path
    // only creates PERFORM rows today, so this pins the claim → owner-side
    // seam ahead of anonymous RENT inquiries existing.
    const { repos, mocks } = buildClaimRepos({
      intent: "RENT",
      spaceId: SPACE_ID,
      requestedStartsAt: new Date("2026-07-10T19:00:00.000Z"),
      requestedEndsAt: new Date("2026-07-10T23:00:00.000Z"),
      purpose: "Album release party",
    });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      idempotency: buildIdempotency(),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.claim({
        rawToken: RAW_TOKEN,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
      }),
    ).resolves.toEqual({ bookingRequestId: OWNED_ID, agreementId: AGREEMENT_ID });

    // Same mint as the owned accept (`defaultEventOwnerSideForIntent`): RENT
    // never clones the venue's default terms; it seeds ONE 100% line to the
    // requester's Payee on the fresh draft.
    expect(mocks.payoutTerms.clone).not.toHaveBeenCalled();
    expect(mocks.payees.getBySubject).toHaveBeenCalledWith({
      type: "HUMAN",
      id: ACTOR_ID,
    });
    expect(mocks.payoutTerms.seedLinesIfEmpty).toHaveBeenCalledWith(TERMS_ID, [
      expect.objectContaining({
        payeeId: PAYEE_ID,
        percent: 100,
        requiresConfirmation: false,
      }),
    ]);
  });

  it("passes typed token errors through (TOKEN_EXPIRED → FORBIDDEN + appCode)", async () => {
    const { repos, mocks } = buildClaimRepos({
      // Past relative to the test clock (2024-01-01).
      claimTokenExpiresAt: new Date("2023-06-01T00:00:00.000Z"),
    });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      idempotency: buildIdempotency(),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.claim({
        rawToken: RAW_TOKEN,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "TOKEN_EXPIRED" },
    });
    expect(mocks.bookingRequests.claim).not.toHaveBeenCalled();
  });

  it("rejects a smuggled actorHumanId (server-injected, .strict())", async () => {
    const { repos } = buildClaimRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      idempotency: buildIdempotency(),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.claim({
        rawToken: RAW_TOKEN,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        actorHumanId: OWNER_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

/** Repos for the RESEND path (venue owner re-emailing an invite). */
function buildResendRepos(placeOverrides: Partial<typeof claimablePlace> = {}) {
  const place = { ...claimablePlace, ...placeOverrides };
  const acceptedAnon = buildRecord({
    status: "ACCEPTED",
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "The Basement Tapes",
    contactEmail: "band@example.com",
    source: "EMBED",
    claimTokenHash: "hash-abc",
    claimTokenExpiresAt: new Date("2026-06-01T00:00:00.000Z"),
  });
  const mocks = {
    bookingRequests: {
      getById: vi.fn(async () => acceptedAnon),
      setClaimToken: vi.fn(
        async (input: {
          claimTokenHash: string;
          claimTokenExpiresAt: Date;
        }) => ({
          ...acceptedAnon,
          claimTokenHash: input.claimTokenHash,
          claimTokenExpiresAt: input.claimTokenExpiresAt,
        }),
      ),
    },
    places: { getById: vi.fn(async () => place) },
    authz: { getOrgMemberships: vi.fn(async () => []) },
    audit: { log: vi.fn(async () => {}) },
  };
  return {
    repos: {
      ...mocks,
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
    } as unknown as Ctx["repos"],
    mocks,
  };
}

const workingMailer = () => {
  const send = vi.fn(async () => ({
    result: { id: "msg-1", status: "sent" },
  }));
  return {
    mailer: {
      send,
      sendBatch: vi.fn(),
      health: vi.fn(),
    } as unknown as NonNullable<Ctx["mailer"]>,
    send,
  };
};

describe("bookingRequestsRouter.resendInvite (FR-007)", () => {
  it("happy path: rotates the token and re-sends the invite through ctx.mailer", async () => {
    const { repos, mocks } = buildResendRepos();
    const { mailer, send } = workingMailer();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      mailer,
      publicAppUrl: "https://ithasfire.test",
    });

    const result = await caller.resendInvite({ bookingRequestId: OWNED_ID });

    expect(result.bookingRequestId).toBe(OWNED_ID);
    expect(result.claimTokenExpiresAt).toBeInstanceOf(Date);
    expect(mocks.bookingRequests.setClaimToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: { to: "band@example.com" },
      template: expect.objectContaining({ key: "booking.invite_to_claim" }),
    });
  });

  it("RBAC failure passes through: non-owner actor → FORBIDDEN, no rotation, no email", async () => {
    const { repos, mocks } = buildResendRepos({
      humanIdsWithAccess: [OWNER_HUMAN_ID], // actor is NOT an owner
      orgIdsWithAccess: [],
    });
    const { mailer, send } = workingMailer();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      mailer,
      publicAppUrl: "https://ithasfire.test",
    });

    await expect(
      caller.resendInvite({ bookingRequestId: OWNED_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.bookingRequests.setClaimToken).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("enforces the per-actor 5/hour rate limit (re-emails a bearer credential)", async () => {
    const { repos } = buildResendRepos();
    const { mailer } = workingMailer();
    const deniedKey = `bookingRequests:resendInvite:${ACTOR_ID}`;
    const consume = vi.fn(async (key: string) =>
      key === deniedKey
        ? { allowed: false, remaining: 0, retryAfterSeconds: 1800 }
        : {
            allowed: true,
            remaining: Number.POSITIVE_INFINITY,
            retryAfterSeconds: 0,
          },
    );
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      mailer,
      publicAppUrl: "https://ithasfire.test",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(
      caller.resendInvite({ bookingRequestId: OWNED_ID }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(deniedKey, 5, 3600);
  });
});

/** Repos for listMySenders (owner-entity enumeration + request-history probe). */
function buildSendersRepos(args: {
  memberships: Array<{ orgId: string; role: string }>;
  orgs: Record<string, { id: string; name: string; slug?: string | null }>;
  /** newest-first records per ownerId ("self" keyed by ACTOR_ID). */
  latestByOwnerId?: Record<string, Date>;
}) {
  const listForPerformer = vi.fn(async ({ ownerId }: { ownerId: string }) => {
    const createdAt = args.latestByOwnerId?.[ownerId];
    return createdAt ? [buildRecord({ createdAt })] : [];
  });
  return {
    repos: {
      humans: {
        getByIdWithIdentity: vi.fn(async (id: string) => ({
          human: { id, name: "Test Performer" },
          identity: { email: "perf@example.com", username: "testperf" },
        })),
      },
      // listMySenders resolves sender labels in bulk via getByOwners (plural).
      // The fake only had the singular getByOwner, so every case failed with
      // "deps.repos.entityPages.getByOwners is not a function" — a stale fake,
      // not a router bug: the port declares getByOwners and the Prisma adapter
      // implements it. Returns [] so senders fall back to their default labels.
      entityPages: {
        getByOwner: vi.fn(async () => null),
        getByOwners: vi.fn(async () => []),
      },
      authz: {
        listOrgMembershipsByHumanId: vi.fn(async () => args.memberships),
      },
      organizations: {
        getById: vi.fn(async (id: string) => args.orgs[id] ?? null),
      },
      bookingRequests: { listForPerformer },
    } as unknown as Ctx["repos"],
    listForPerformer,
  };
}

describe("bookingRequestsRouter.listMySenders (FR-011)", () => {
  it("no orgs, no history → self only, self default", async () => {
    const { repos } = buildSendersRepos({ memberships: [], orgs: {} });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.listMySenders();

    expect(result.senders).toEqual([
      {
        ownerType: "human",
        ownerId: ACTOR_ID,
        displayName: "Test Performer",
        isDefault: true,
      },
    ]);
  });

  it("includes edit-role orgs, excludes viewer-role orgs; defaults to self when no history", async () => {
    const { repos } = buildSendersRepos({
      memberships: [
        { orgId: ORG_A_ID, role: "EDITOR" },
        { orgId: ORG_B_ID, role: "VIEWER" },
      ],
      orgs: {
        [ORG_A_ID]: { id: ORG_A_ID, name: "Edit Org", slug: "edit-org" },
        [ORG_B_ID]: { id: ORG_B_ID, name: "Viewer Org", slug: "viewer-org" },
      },
    });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.listMySenders();

    expect(result.senders).toEqual([
      {
        ownerType: "human",
        ownerId: ACTOR_ID,
        displayName: "Test Performer",
        isDefault: true,
      },
      {
        ownerType: "org",
        ownerId: ORG_A_ID,
        displayName: "Edit Org",
        isDefault: false,
      },
    ]);
  });

  it("tier 2: the sender of the most recent booking request wins over self", async () => {
    const { repos, listForPerformer } = buildSendersRepos({
      memberships: [{ orgId: ORG_A_ID, role: "OWNER" }],
      orgs: { [ORG_A_ID]: { id: ORG_A_ID, name: "Edit Org" } },
      latestByOwnerId: {
        [ACTOR_ID]: new Date("2026-06-01T00:00:00.000Z"),
        [ORG_A_ID]: new Date("2026-06-05T00:00:00.000Z"),
      },
    });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.listMySenders();

    expect(result.senders).toEqual([
      {
        ownerType: "human",
        ownerId: ACTOR_ID,
        displayName: "Test Performer",
        isDefault: false,
      },
      {
        ownerType: "org",
        ownerId: ORG_A_ID,
        displayName: "Edit Org",
        isDefault: true,
      },
    ]);
    // The history probe used the repo owner-type vocabulary ("organization").
    expect(listForPerformer).toHaveBeenCalledWith({
      ownerType: "organization",
      ownerId: ORG_A_ID,
    });
  });
});

describe("bookingRequestsRouter.list — reportError wiring", () => {
  it("threads ctx.reportError into the use case: corrupt row skipped AND reported", async () => {
    const reportError = vi.fn();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildRepos([buildRecord(), buildCorruptRecord()]),
      actorHumanId: ACTOR_ID,
      reportError,
    });

    const result = await caller.list({ scope: "performer" });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].id).toBe(OWNED_ID);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "listBookingRequests" },
      extra: { bookingRequestId: CORRUPT_ID, placeId: PLACE_ID },
    });
  });

  it("stays fail-open when ctx.reportError is not wired (row still skipped)", async () => {
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildRepos([buildCorruptRecord(), buildRecord()]),
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.list({ scope: "performer" });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].id).toBe(OWNED_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking stage over the wire (request → agreement → event)
// ─────────────────────────────────────────────────────────────────────────────

describe("bookingRequestsRouter.list — stage projection survives .output()", () => {
  const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
  const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
  const EVENT_STARTS_AT = new Date("2026-09-19T00:00:00.000Z");

  it("carries agreementStatus / eventId / eventStatus / eventStartsAt for a draft-anchored booking", async () => {
    // The `.output()` schema is `.strict()`, so this is the whole wire path:
    // a field the rail needs but the schema drops would fail HERE, not in core.
    const repos = {
      ...buildRepos([
        buildRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
      ]),
      agreements: {
        findManyByIds: vi.fn(async () => [
          {
            id: AGREEMENT_ID,
            status: "ACCEPTED",
            // Draft anchor only — no finalized link yet, which is where most
            // booked events actually sit.
            eventId: null,
            draftEventId: EVENT_ID,
          },
        ]),
      },
      events: {
        findManyByIds: vi.fn(async () => [
          { id: EVENT_ID, status: "DRAFT", startsAt: EVENT_STARTS_AT },
        ]),
      },
    } as unknown as Ctx["repos"];

    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.list({ scope: "performer" });

    expect(result.requests[0]).toMatchObject({
      agreementId: AGREEMENT_ID,
      agreementStatus: "ACCEPTED",
      eventId: EVENT_ID,
      eventStatus: "DRAFT",
      eventStartsAt: EVENT_STARTS_AT,
      // Venue-confirmation projection (Phase 2): the resolved event has no
      // place and no stamp, so it reads as a requester-owned, unconfirmed
      // event — and the `.strict()` output schema carries all three keys.
      venueConfirmation: {
        state: "unconfirmed",
        eventId: EVENT_ID,
        ownerSide: "requester",
      },
    });
  });

  it("reports all four as null for a request with no agreement", async () => {
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildRepos([buildRecord()]),
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.list({ scope: "performer" });

    expect(result.requests[0]).toMatchObject({
      agreementStatus: null,
      eventId: null,
      eventStatus: null,
      eventStartsAt: null,
      venueConfirmation: { state: "none", eventId: null, ownerSide: null },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Organizer → performer direction (organizer-booking-requests)
// ─────────────────────────────────────────────────────────────────────────────

const ORGANIZER_ORG_ID = "99999999-9999-4999-8999-999999999999";
const TARGET_ACT_ID = "12121212-1212-4121-8121-121212121212";

/** TO_PERFORMER record echoing what the adapter's createToPerformer returns. */
function buildOrganizerRecord(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return buildRecord({
    direction: "TO_PERFORMER",
    placeId: null,
    placeName: null,
    calendarId: null,
    calendarName: null,
    organizerOrgId: ORGANIZER_ORG_ID,
    organizerOrgName: "Corner Booking Collective",
    performerOwnerType: "human",
    performerOwnerId: TARGET_ACT_ID,
    ...overrides,
  } as Partial<BookingRequestRecord>);
}

function buildCreateToPerformerRepos(): Ctx["repos"] {
  const mocks = withLedger({
    bookingRequests: {
      findOpenByOrganizerAndPerformer: vi.fn(async () => null),
      createToPerformer: vi.fn(async () => buildOrganizerRecord()),
    },
    performerProfiles: {
      getByOwner: vi.fn(async () => ({
        id: "profile-1",
        ownerType: "human",
        ownerId: TARGET_ACT_ID,
        enabledAt: new Date("2026-01-01T00:00:00.000Z"),
        disabledAt: null,
        acceptsBookingRequests: true,
      })),
    },
    events: { getById: vi.fn(async () => null) },
    organizations: {
      getById: vi.fn(async () => ({
        id: ORGANIZER_ORG_ID,
        name: "Corner Booking Collective",
        slug: "corner-collective",
      })),
      listMembers: vi.fn(async () => ({ items: [], total: 0 })),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORGANIZER_ORG_ID,
        humanId: ACTOR_ID,
        role: "EDITOR",
      })),
    },
    audit: { log: vi.fn(async () => {}) },
  });
  return {
    ...mocks,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
  } as unknown as Ctx["repos"];
}

describe("bookingRequestsRouter.createToPerformer — act notification wiring (FR-006)", () => {
  const input = {
    organizerOrgId: ORGANIZER_ORG_ID,
    performerOwnerType: "human",
    performerOwnerId: TARGET_ACT_ID,
    message: "We'd love you to headline our Friday showcase.",
    preferredDates: ["2026-08-14"],
  } as const;

  it("creates and notifies the target act with the organizer variant + per-recipient key", async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildCreateToPerformerRepos(),
      actorHumanId: ACTOR_ID,
      notify: notify as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.test",
    });

    const result = await caller.createToPerformer(input);

    expect(result.bookingRequestId).toBe(OWNED_ID);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: TARGET_ACT_ID,
        variant: "booking.organizer-request-received",
        idempotencyKey: `organizer-booking-request-received:${OWNED_ID}:${TARGET_ACT_ID}`,
        channels: { sms: { enabled: false } },
        payload: expect.objectContaining({
          orgName: "Corner Booking Collective",
          requestsUrl:
            "https://ithasfire.test/account/settings/booking-requests",
        }),
      }),
    );
  });

  it("a throwing notify does NOT fail the mutation and reports via ctx.reportError", async () => {
    const notify = vi.fn(async () => {
      throw new Error("notify pipeline down");
    });
    const reportError = vi.fn();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: buildCreateToPerformerRepos(),
      actorHumanId: ACTOR_ID,
      notify: notify as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.test",
      reportError,
    });

    const result = await caller.createToPerformer(input);

    expect(result.bookingRequestId).toBe(OWNED_ID);
    // The per-recipient swallow inside the notify use case reports.
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "notifyOrganizerBookingRequestReceived" },
      }),
    );
  });

  it("list scope 'organizer' returns direction-tagged summaries (nullable placeId over the wire)", async () => {
    const repos = {
      bookingRequests: {
        listForOrganizer: vi.fn(async () => [buildOrganizerRecord()]),
      },
      humans: {
        getByIds: vi.fn(async () => [{ id: TARGET_ACT_ID, name: "The Act" }]),
      },
      organizations: { getByIds: vi.fn(async () => []) },
      authz: {
        getOrgMembership: vi.fn(async () => ({
          orgId: ORGANIZER_ORG_ID,
          humanId: ACTOR_ID,
          role: "VIEWER",
        })),
      },
      bookingRequestMessages: {
        countUnreadByRequest: vi.fn(async () => new Map([[OWNED_ID, 2]])),
      },
      ...stageRepos(),
    } as unknown as Ctx["repos"];
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.list({
      scope: "organizer",
      organizerOrgId: ORGANIZER_ORG_ID,
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].direction).toBe("TO_PERFORMER");
    expect(result.requests[0].placeId).toBeNull();
    expect(result.requests[0].organizerOrgName).toBe(
      "Corner Booking Collective",
    );
    expect(result.requests[0].performerDisplayName).toBe("The Act");
    // The per-side unread count survives the `.output()` schema — nothing
    // downstream of the use case strips it (the badge's whole wire path).
    expect(result.requests[0].unreadMessageCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Org-wide venue inbox (scope: "org-venues")
// ─────────────────────────────────────────────────────────────────────────────

const ORG_VENUES_ORG_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_PLACE_ID = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";

describe("bookingRequestsRouter.list — scope: org-venues", () => {
  function buildOrgVenueRepos(options: { member?: boolean } = {}) {
    const listForPlaces = vi.fn(async () => [
      buildRecord(),
      buildRecord({ id: SECOND_REQUEST_ID, placeId: SECOND_PLACE_ID }),
    ]);
    const repos = {
      bookingRequests: { listForPlaces },
      places: {
        listOwnedBySubject: vi.fn(async () => [
          { id: PLACE_ID, name: "Test Venue" },
          { id: SECOND_PLACE_ID, name: "Second Room" },
        ]),
      },
      humans: {
        getByIds: vi.fn(async () => [{ id: ACTOR_ID, name: "Test Performer" }]),
      },
      organizations: { getByIds: vi.fn(async () => []) },
      authz: {
        getOrgMembership: vi.fn(async () =>
          options.member === false
            ? null
            : { orgId: ORG_VENUES_ORG_ID, humanId: ACTOR_ID, role: "VIEWER" },
        ),
        getOrgMemberships: vi.fn(async () => []),
      },
      bookingRequestMessages: {
        countUnreadByRequest: vi.fn(async () => new Map([[OWNED_ID, 3]])),
      },
      ...stageRepos(),
    } as unknown as Ctx["repos"];
    return { repos, listForPlaces };
  }

  const SECOND_REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("threads the scope through to a set-shaped query over the org's owned places", async () => {
    const { repos, listForPlaces } = buildOrgVenueRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.list({
      scope: "org-venues",
      orgId: ORG_VENUES_ORG_ID,
    });

    expect(result.requests.map((r) => r.placeId)).toEqual([
      PLACE_ID,
      SECOND_PLACE_ID,
    ]);
    // The truncation flag survives the `.output()` schema — a capped inbox has
    // to be able to say so over the wire, not just in core.
    expect(result.ownedPlacesTruncated).toBe(false);
    expect(listForPlaces).toHaveBeenCalledWith({
      placeIds: [PLACE_ID, SECOND_PLACE_ID],
      statuses: undefined,
    });
  });

  it("gates on org membership — a non-member gets FORBIDDEN, not an empty list", async () => {
    const { repos, listForPlaces } = buildOrgVenueRepos({ member: false });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.list({ scope: "org-venues", orgId: ORG_VENUES_ORG_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(listForPlaces).not.toHaveBeenCalled();
  });

  it("never takes the actor from client input (.strict rejects it)", async () => {
    const { repos } = buildOrgVenueRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.list({
        scope: "org-venues",
        orgId: ORG_VENUES_ORG_ID,
        actorHumanId: "99999999-9999-4999-8999-999999999999",
      } as never),
    ).rejects.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Human-owned venue inbox (scope: "human-venues")
// ─────────────────────────────────────────────────────────────────────────────

describe("bookingRequestsRouter.list — scope: human-venues", () => {
  function buildHumanVenueRepos() {
    const listForPlaces = vi.fn(async () => [
      buildRecord(),
      buildRecord({ id: SECOND_REQUEST_ID, placeId: SECOND_PLACE_ID }),
    ]);
    const listOwnedBySubject = vi.fn(async () => [
      { id: PLACE_ID, name: "Red Rocks Amphitheatre" },
      { id: SECOND_PLACE_ID, name: "Second Room" },
    ]);
    const getOrgMembership = vi.fn(async () => null);
    const repos = {
      bookingRequests: { listForPlaces },
      places: { listOwnedBySubject },
      humans: {
        getByIds: vi.fn(async () => [{ id: ACTOR_ID, name: "Test Performer" }]),
      },
      organizations: { getByIds: vi.fn(async () => []) },
      authz: {
        getOrgMembership,
        getOrgMemberships: vi.fn(async () => []),
        // SCOPING, not a gate — the personal context folds the actor's orgs'
        // venues in alongside their own. The GATE methods above stay
        // untouched, which is what this suite asserts.
        listOrgMembershipsByHumanId: vi.fn(async () => []),
      },
      bookingRequestMessages: {
        countUnreadByRequest: vi.fn(async () => new Map()),
      },
      ...stageRepos(),
    } as unknown as Ctx["repos"];
    return { repos, listForPlaces, listOwnedBySubject, getOrgMembership };
  }

  const SECOND_REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("reads the ctx actor's HUMAN-owned places with no id in the input and no membership read", async () => {
    const { repos, listForPlaces, listOwnedBySubject, getOrgMembership } =
      buildHumanVenueRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.list({ scope: "human-venues" });

    expect(result.requests.map((r) => r.placeId)).toEqual([
      PLACE_ID,
      SECOND_PLACE_ID,
    ]);
    expect(result.ownedPlacesTruncated).toBe(false);
    // The owner is pinned to the ctx actor — there is no client-side knob.
    expect(listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      limit: 100,
    });
    expect(getOrgMembership).not.toHaveBeenCalled();
    expect(listForPlaces).toHaveBeenCalledWith({
      placeIds: [PLACE_ID, SECOND_PLACE_ID],
      statuses: undefined,
    });
  });

  it("rejects an unauthenticated caller", async () => {
    const { repos } = buildHumanVenueRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: null,
      auth: null,
      authToken: null,
    });

    await expect(
      caller.list({ scope: "human-venues" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Intents + unclaimed parking (venue-confirmation-and-booking-intents spec)
// ─────────────────────────────────────────────────────────────────────────────

const CALENDAR_ID = "ca1e0da1-4444-4444-8444-444444444444";
const SPACE_ID = "5face000-1111-4111-8111-111111111111";

/**
 * The create fixture, re-pointed at a place with ONE default calendar that
 * accepts every intent and schedules into `SPACE_ID`; optionally UNCLAIMED
 * (no verified ownership → the access lists are empty).
 */
function buildIntentCreateRepos(options: { unclaimed?: boolean } = {}): Ctx["repos"] {
  const base = buildCreateRepos() as unknown as Record<string, unknown>;
  const calendar = {
    id: CALENDAR_ID,
    placeId: PLACE_ID,
    name: "Main Calendar",
    isDefault: true,
    acceptsPerform: true,
    acceptsRent: true,
    acceptsUse: true,
    rentalMode: "REQUEST",
  };
  const place = {
    id: PLACE_ID,
    name: "Test Venue",
    status: "ACTIVE",
    verificationStatus: options.unclaimed ? "UNVERIFIED" : "VERIFIED",
    acceptsBookingRequests: !options.unclaimed,
    humanIdsWithAccess: options.unclaimed ? [] : [OWNER_HUMAN_ID],
    orgIdsWithAccess: [],
    phone: null,
    website: null,
    timezone: null,
  };
  const mocks = {
    ...base,
    places: { getById: vi.fn(async () => place) },
    calendars: {
      findById: vi.fn(async () => calendar),
      findDefaultForPlace: vi.fn(async () => calendar),
      listByPlace: vi.fn(async () => [
        { ...calendar, spaces: [{ id: SPACE_ID, placeId: PLACE_ID, name: "Room", status: "ACTIVE" }] },
      ]),
      listAvailabilityForPlace: vi.fn(async () => []),
      countAvailabilityForPlace: vi.fn(async () => (options.unclaimed ? 0 : 1)),
    },
  };
  return {
    ...mocks,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
  } as unknown as Ctx["repos"];
}

const rentInput = {
  performerOwnerType: "human",
  performerOwnerId: ACTOR_ID,
  placeId: PLACE_ID,
  intent: "RENT",
  spaceId: SPACE_ID,
  requestedStartsAt: "2026-10-04T23:00:00.000Z",
  requestedEndsAt: "2026-10-05T04:00:00.000Z",
  purpose: "Private birthday party",
  expectedAttendance: 60,
} as const;

describe("bookingRequestsRouter.create — intents (RENT | USE | PERFORM)", () => {
  it("RENT over the wire: ISO window strings coerce, the row lands with intent + space + window, no performer profile needed", async () => {
    const repos = buildIntentCreateRepos();
    (repos.performerProfiles as unknown as { getByOwner: ReturnType<typeof vi.fn> }).getByOwner = vi.fn(
      async () => null,
    );
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      publicAppUrl: "https://ithasfire.test",
    });

    const result = await caller.create(rentInput);

    expect(result).toEqual({ bookingRequestId: OWNED_ID });
    expect(repos.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "RENT",
        calendarId: CALENDAR_ID,
        spaceId: SPACE_ID,
        requestedStartsAt: new Date("2026-10-04T23:00:00.000Z"),
        requestedEndsAt: new Date("2026-10-05T04:00:00.000Z"),
        purpose: "Private birthday party",
        expectedAttendance: 60,
      }),
    );
    // Nothing writes the parked stamp any more (amendment 2026-09-25).
    expect(
      (repos.bookingRequests.create as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    ).not.toHaveProperty("parkedUnclaimedAt");
  });

  it("USE over the wire", async () => {
    const repos = buildIntentCreateRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      publicAppUrl: "https://ithasfire.test",
    });
    await caller.create({ ...rentInput, intent: "USE", purpose: "Community meeting" });
    expect(repos.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "USE", purpose: "Community meeting" }),
    );
  });

  it("PERFORM is the default: the existing pitch input is unchanged and routes with intent PERFORM", async () => {
    const repos = buildIntentCreateRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      publicAppUrl: "https://ithasfire.test",
    });
    await caller.create(createInput);
    expect(repos.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "PERFORM", spaceId: null }),
    );
  });

  it("maps the use case's INVALID_INPUT (calendar rejects intent / shape) to BAD_REQUEST", async () => {
    const repos = buildIntentCreateRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      publicAppUrl: "https://ithasfire.test",
    });
    // Shape: RENT without a WINDOW. (Without a SPACE is no longer a refusal
    // — ruling 2026-09-22, pinned in the sibling test below.)
    const { requestedStartsAt: _s, requestedEndsAt: _e, ...noWindow } = rentInput;
    await expect(caller.create(noWindow)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // visibilityHint is not on the wire schema (dropped from v1).
    await expect(caller.create({ ...rentInput, visibilityHint: "PUBLIC" } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(repos.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("RENT WITHOUT a space goes over the wire and persists spaceId: null (ruling 2026-09-22)", async () => {
    // The wire schema never demanded a room of its own — it defers to the
    // use case's refine. This pins that the transport passes a roomless RENT
    // straight through rather than 400ing it.
    const repos = buildIntentCreateRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      publicAppUrl: "https://ithasfire.test",
    });
    const { spaceId: _s, ...noSpace } = rentInput;

    await caller.create(noSpace);

    expect(repos.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "RENT", spaceId: null }),
    );
  });
});

describe("bookingRequestsRouter.create — per-actor ceiling", () => {
  it("enforces the 10/hour per-actor rate limit", async () => {
    const repos = buildIntentCreateRepos();
    const deniedKey = `bookingRequests:create:${ACTOR_ID}`;
    const consume = vi.fn(async (key: string) =>
      key === deniedKey
        ? { allowed: false, remaining: 0, retryAfterSeconds: 1800 }
        : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
    );
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      publicAppUrl: "https://ithasfire.test",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(caller.create(createInput)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(deniedKey, 10, 3600);
    expect(repos.bookingRequests.create).not.toHaveBeenCalled();
  });

});

describe("bookingRequestsRouter.create — unclaimed venue (amendment 2026-09-25)", () => {
  it("refuses over the wire: PRECONDITION_FAILED, appCode PLACE_NOT_TAKING_REQUESTS, the venue's name in meta; nothing written or sent", async () => {
    const repos = buildIntentCreateRepos({ unclaimed: true });
    const notify = vi.fn(async () => ({ ok: true }));
    const mailer = { send: vi.fn(async () => ({ result: { id: "m1", status: "sent" } })) };
    const reportError = vi.fn();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      notify: notify as unknown as Ctx["notify"],
      mailer: mailer as unknown as Ctx["mailer"],
      publicAppUrl: "https://ithasfire.test",
      reportError,
    });

    await expect(caller.create(createInput)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      meta: {
        appCode: "PLACE_NOT_TAKING_REQUESTS",
        placeId: PLACE_ID,
        placeName: "Test Venue",
      },
    });
    expect(repos.bookingRequests.create).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
