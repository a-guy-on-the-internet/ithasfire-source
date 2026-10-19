import { vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { EventRecord } from "@th/ports/repos/events";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookingRequestMessageRow,
  CountUnreadByRequestInput,
} from "@th/ports/repos/booking-request-messages";
import {
  createFakeBookingRequestMessagesRepo,
  type FakeBookingRequestMessagesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";
import { createFakeBookingRequestActs } from "@th/test-utils/fakes/booking-request-acts";
import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";

import {
  createFakeBookingHoldsRepo,
  createFakeBookingTagsRepo,
  createFakePlaceBookingGrantsRepo,
  type FakeBookingHoldsRepo,
} from "../../booking-holds/__tests__/fakes";

/** The holds fake {@link withTx} wired into a repos bag. */
export function holdsOf(repos: unknown): FakeBookingHoldsRepo {
  return (repos as { bookingHolds: FakeBookingHoldsRepo }).bookingHolds;
}

export const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_HUMAN_ID = "12121212-1212-4121-8121-121212121212";
export const ORG_ID = "22222222-2222-4222-8222-222222222222";
export const PLACE_ID = "33333333-3333-4333-8333-333333333333";
export const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
export const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
export const TERMS_ID = "66666666-6666-4666-8666-666666666666";
export const CLONED_TERMS_ID = "77777777-7777-4777-8777-777777777777";
export const PROFILE_ID = "88888888-8888-4888-8888-888888888888";
export const NOW = new Date("2026-06-10T12:00:00.000Z");

export function buildPlaceRecord(
  overrides: Partial<PlaceRecord> = {},
): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "Test Venue",
    slug: "test-venue",
    formattedAddress: "123 Main St",
    addressLine1: "123 Main St",
    addressLine2: null,
    city: "City",
    region: "ST",
    postalCode: "12345",
    countryCode: "US",
    capacity: null,
    lat: null,
    lng: null,
    phone: null,
    website: null,
    /**
     * Address-derived IANA zone (venue-hierarchy FR-004). Null by default so
     * the pitch-seed anchor exercises the PLATFORM fallback
     * (`America/Chicago`) unless a suite opts into a real venue zone.
     */
    timezone: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: true,
    acceptsBookingRequests: true,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [ACTOR_ID],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } satisfies PlaceRecord;
}

export function buildBookingRequestRecord(
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
    calendarName: null,
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
    links: ["https://example.com/epk"],
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
    billRecorded: false,
    lastMessageAt: null,
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
    expiresAt: new Date("2026-06-24T12:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  } satisfies BookingRequestRecord;
}

export const ORGANIZER_ORG_ID = "99999999-9999-4999-8999-999999999999";
export const ATTACHED_EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * TO_PERFORMER (organizer → act) record builder. Shape mirrors the adapter's
 * `toToPerformerRecord` output: no venue anchor, no anonymous/claim columns,
 * owned act pair (the TARGET in this direction).
 */
export function buildOrganizerBookingRequestRecord(
  overrides: Partial<
    Extract<BookingRequestRecord, { direction: "TO_PERFORMER" }>
  > = {},
): Extract<BookingRequestRecord, { direction: "TO_PERFORMER" }> {
  return {
    id: REQUEST_ID,
    direction: "TO_PERFORMER",
    placeId: null,
    placeName: null,
    organizerOrgId: ORGANIZER_ORG_ID,
    organizerOrgName: "Corner Booking Collective",
    attachedEventId: null,
    attachedEventTitle: null,
    attachedEventStartsAt: null,
    calendarId: null,
    calendarName: null,
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
    message: "We'd love you to headline our Friday showcase.",
    preferredDates: ["2026-07-10"],
    expectedDraw: null,
    genre: null,
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
    billRecorded: false,
    lastMessageAt: null,
    status: "PENDING",
    viewedAt: null,
    respondedAt: null,
    declineReason: null,
    agreementId: null,
    verifiedStatsSnapshot: null,
    expiresAt: new Date("2026-06-24T12:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking STAGE fixtures (request → agreement → event)
// ─────────────────────────────────────────────────────────────────────────────

export const SECOND_AGREEMENT_ID = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";
export const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
export const SECOND_EVENT_ID = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";

/**
 * Two-party booking `Agreement` (agreement.prisma). Defaults to the shape a
 * fresh accept produces: DRAFT, no event on either link column.
 */
export function buildAgreementRecord(
  overrides: Partial<AgreementRecord> = {},
): AgreementRecord {
  return {
    id: AGREEMENT_ID,
    type: "PERFORMANCE",
    status: "DRAFT",
    proposerType: "human",
    proposerId: ACTOR_ID,
    counterpartyType: "organization",
    counterpartyId: ORG_ID,
    placeId: PLACE_ID,
    eventId: null,
    draftEventId: null,
    payoutTermsId: null,
    title: "Friday night",
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
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  } satisfies AgreementRecord;
}

/**
 * Minimal `EventRecord` for the stage projection, which reads exactly three
 * columns (`id`, `status`, `startsAt`). Cast rather than fully populated —
 * same posture as the event fixtures in `use-cases/events/__tests__`; filling
 * 40 unrelated columns here would only invite drift.
 */
export function buildStageEventRecord(
  overrides: Partial<EventRecord> & { id: string },
): EventRecord {
  return {
    status: "DRAFT",
    startsAt: new Date("2026-09-19T00:00:00.000Z"),
    ...overrides,
  } as EventRecord;
}

/**
 * The `agreements` + `events` repo pair the LIST surfaces need for the stage
 * rail, backed by in-memory sets and spied so suites can assert the BATCHING
 * contract (at most ONE call each per page, never one per row).
 *
 * Either lookup can be forced to throw — that is how the deliberate-swallow
 * branch (degrade every row to null stage + report) gets exercised.
 */
export function buildStageRepos(
  options: {
    agreements?: readonly AgreementRecord[];
    events?: readonly EventRecord[];
    agreementsError?: Error;
    eventsError?: Error;
  } = {},
) {
  const agreementRows = options.agreements ?? [];
  const eventRows = options.events ?? [];

  const agreements = {
    findManyByIds: vi.fn(async (ids: string[]) => {
      if (options.agreementsError) throw options.agreementsError;
      // Mirrors the port contract: missing ids are silently omitted.
      return agreementRows.filter((row) => ids.includes(row.id));
    }),
  };
  const events = {
    findManyByIds: vi.fn(async (ids: string[]) => {
      if (options.eventsError) throw options.eventsError;
      return eventRows.filter((row) => ids.includes(row.id));
    }),
  };

  // Booking-holds workflow projection repos (`resolveBookingWorkflow`) —
  // in-memory fakes so a list suite that does not care about holds/tags
  // still passes the unwired-repo guard; seed them to exercise the projection.
  const bookingHolds = createFakeBookingHoldsRepo();
  const bookingTags = createFakeBookingTagsRepo();

  return { agreements, events, bookingHolds, bookingTags };
}

export function buildPerformerProfile(
  overrides: Partial<PerformerProfileRecord> = {},
): PerformerProfileRecord {
  return {
    id: PROFILE_ID,
    ownerType: "human",
    ownerId: ACTOR_ID,
    enabledAt: new Date("2026-05-01T00:00:00.000Z"),
    disabledAt: null,
    acceptsBookingRequests: false,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  } satisfies PerformerProfileRecord;
}

/**
 * Minimal in-memory IdempotencyPort honoring begin/commit/fail/get semantics.
 *
 * Mirrors the REAL adapters' failure-retention behavior (redis-adapter /
 * prisma-adapter): `fail()` does NOT release the key — it writes a `failed`
 * marker retained for `keepSec` (default 15 min) that blocks `begin` until it
 * expires, while `get` keeps returning null. An earlier version of this fake
 * deleted the key on `fail()`, which made a whole bug class untestable: a
 * deterministic domain failure (e.g. expired claim token) arming 15 minutes
 * of IDEMPOTENCY_LOCK_IN_PROGRESS for the user's retry.
 */
export function makeFakeIdempotency(): IdempotencyPort {
  const results = new Map<string, unknown>();
  /** key → in-progress lock expiry (epoch ms). */
  const inProgress = new Map<string, number>();
  /** key → failed-marker retention expiry (epoch ms). */
  const failed = new Map<string, number>();

  const isLive = (map: Map<string, number>, key: string) => {
    const until = map.get(key);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      map.delete(key);
      return false;
    }
    return true;
  };

  return {
    async begin(key, ttlSec = 60) {
      if (results.has(key)) return false;
      // A retained failed marker blocks re-acquisition, exactly like the
      // Redis `SET NX` against a live `failed:` key / the Prisma
      // `expiresAt > now` guard.
      if (isLive(failed, key) || isLive(inProgress, key)) return false;
      inProgress.set(key, Date.now() + ttlSec * 1000);
      return true;
    },
    async commit(key, result) {
      results.set(key, result);
      inProgress.delete(key);
      failed.delete(key);
    },
    async fail(key, _error, keepSec = 15 * 60) {
      inProgress.delete(key);
      failed.set(key, Date.now() + keepSec * 1000);
    },
    async get<T>(key: string) {
      return (results.get(key) as T | undefined) ?? null;
    },
    async run(key, ttlSec, fn) {
      const prior = results.get(key);
      if (prior !== undefined) {
        return { fresh: false, result: prior as never };
      }
      const result = await fn();
      results.set(key, result);
      return { fresh: true, result };
    },
  };
}

/**
 * Wrap a bag of fake repos with a passthrough `tx` (the same mocks serve as
 * both root repos and tx repos, mirroring how neighboring tests fake `tx`).
 *
 * LEDGER AUTOWIRING. Every booking lifecycle transition now appends a system
 * entry (`appendBookingSystemEntry`) from inside its own transaction, which
 * means each one touches `tx.bookingRequestMessages.create` and
 * `tx.bookingRequests.touchLastMessageAt`. Rather than make ~15 unrelated
 * suites restate that plumbing, this injects a real in-memory
 * {@link createFakeBookingRequestMessagesRepo} and a `touchLastMessageAt` stub
 * whenever the bag does not already carry them — so a suite that does not care
 * about the ledger keeps passing, and a suite that does can either seed its
 * own or read the injected one back with {@link ledgerOf}.
 *
 * Injection is `??`-style (never overwrite): a suite that supplies its own —
 * e.g. one that makes `create` throw to prove a failed entry fails the whole
 * transition — keeps it.
 */
export function withTx<T extends Record<string, unknown>>(
  mocks: T,
): T & { tx: Repos["tx"] } {
  const bag: Record<string, unknown> = { ...mocks };

  bag.bookingRequestMessages =
    mocks.bookingRequestMessages ?? createFakeBookingRequestMessagesRepo();
  // Booking-holds (spec 2026-08-25): decline / withdraw / expire release the
  // request's live holds in-tx (FR-009), and the list surfaces project holds
  // + tags — same autowiring posture as the ledger above: an in-memory fake
  // unless the suite supplies its own.
  bag.bookingHolds = mocks.bookingHolds ?? createFakeBookingHoldsRepo();
  bag.bookingTags = mocks.bookingTags ?? createFakeBookingTagsRepo();
  // Venue-confirmation spec: the hold / confirm sites now gate through
  // `requirePlaceBookingAuthority`, which reads grants when the actor is not
  // staff. Empty by default — every existing NOT_RESOURCE_OWNER /
  // INSUFFICIENT_ROLE expectation holds; seed one to exercise the hook.
  bag.placeBookingGrants =
    mocks.placeBookingGrants ?? createFakePlaceBookingGrantsRepo();
  // Venue booking standards (spec 2026-09-25): the create paths read the
  // routed calendar's standards before any write. Empty by default — nothing
  // configured resolves to the SUGGESTED-only platform list, which blocks
  // nothing, so every pre-standards expectation holds; seed rows to test it.
  bag.bookingStandards =
    mocks.bookingStandards ?? createFakeBookingStandards();
  // ── P4b (deal terms) ── every PayoutTermsLine writer takes the terms row
  // lock first (`DealsRepo.lockTerms`). Default: the row exists and the lock
  // is granted; a suite that cares supplies its own `deals`.
  bag.deals = mocks.deals ?? { lockTerms: vi.fn(async () => true) };

  const bookingRequests = mocks.bookingRequests as
    | Record<string, unknown>
    | undefined;
  if (bookingRequests && !bookingRequests.touchLastMessageAt) {
    bag.bookingRequests = {
      ...bookingRequests,
      touchLastMessageAt: vi.fn(async () => {}),
    };
  }
  // `findByAgreementId` is how the AGREEMENT transitions reach their ledger
  // (there is no `Agreement.bookingRequestId` column). Default to "this
  // agreement has no booking request", which is a real production shape
  // (agreements minted outside the inbox) and makes every emit a no-op unless
  // a suite opts in.
  if (!bag.bookingRequests) {
    bag.bookingRequests = {
      findByAgreementId: vi.fn(async () => null),
      touchLastMessageAt: vi.fn(async () => {}),
    };
  } else {
    const current = bag.bookingRequests as Record<string, unknown>;
    if (!current.findByAgreementId) {
      bag.bookingRequests = {
        ...current,
        findByAgreementId: vi.fn(async () => null),
      };
    }
  }

  // The bill (lineup-booking-requests v2): an in-memory act store backs any
  // of the act methods the suite did not supply itself, so creating a
  // request (which now writes its bill in-tx), listing requests (which
  // batch-read bills) and minting an event (which locks + reads the bill)
  // keep working in suites that do not care about acts. Copies the bag's
  // object ONLY when a method is actually missing — a suite that supplies
  // all of them keeps its own object untouched.
  {
    const current = bag.bookingRequests as Record<string, unknown>;
    const ACT_METHODS = [
      "addActs",
      "listActsForRequests",
      "getActForOwner",
      "setActConfirmation",
      "lockBill",
      "promoteActToSelf",
      // v3 (FR-001 / FR-009): suites remove, restore, reorder and re-role
      // acts on the same in-memory store.
      "softRemoveAct",
      "restoreAct",
      "setActSortOrders",
      "setActRole",
    ] as const;
    if (ACT_METHODS.some((method) => current[method] === undefined)) {
      // SELF rows take the sender pair off the REQUEST (adapter contract):
      // the row the suite's own `create` just returned in this bag (the
      // create path writes its bill in the same tx, right after the insert),
      // else the suite's `getById`, when it has one.
      const getById = current.getById as
        | ((id: string) => Promise<BookingRequestRecord | null>)
        | undefined;
      const created = new Map<string, BookingRequestRecord>();
      const acts = createFakeBookingRequestActs({
        senderOf: async (requestId) => {
          const request =
            created.get(requestId) ??
            (getById ? await getById(requestId) : null);
          if (!request) return undefined;
          return request.performerOwnerType !== null &&
            request.performerOwnerId !== null
            ? {
                ownerType: request.performerOwnerType,
                ownerId: request.performerOwnerId,
              }
            : null;
        },
      });
      const filled: Record<string, unknown> = { ...current };
      for (const method of ACT_METHODS) {
        filled[method] = current[method] ?? acts[method];
      }
      // Remember what `create` returns so a SELF row can find its sender.
      // Wrapped in a vi.fn that delegates, so the suite's own mock still
      // records every call and still honours `mockRejectedValueOnce`.
      const create = current.create as
        | ((input: unknown) => Promise<BookingRequestRecord>)
        | undefined;
      if (typeof create === "function") {
        filled.create = vi.fn(async (input: unknown) => {
          const record = await create(input);
          if (record && typeof record.id === "string") {
            created.set(record.id, record);
          }
          return record;
        });
      }
      bag.bookingRequests = filled;
    }
  }

  const tx = vi.fn(
    async <R>(fn: (tx: TxRepos) => Promise<R>): Promise<R> =>
      fn(bag as unknown as TxRepos),
  ) as unknown as Repos["tx"];
  return { ...(bag as T), tx };
}

/** A thread row a list-surface test seeds to produce an unread badge. */
export type SeededThreadMessage = Partial<BookingRequestMessageRow> & {
  bookingRequestId: string;
};

/**
 * The `bookingRequestMessages` stub the LIST surfaces need: seeded thread rows
 * plus a spied `countUnreadByRequest`.
 *
 * The counting itself is delegated to
 * {@link createFakeBookingRequestMessagesRepo} rather than re-implemented.
 * Three suites used to hand-roll the unread rule (`authorSide !== side &&
 * readAt == null`) and when the rule changed — SYSTEM entries stopped counting,
 * because unread means "a human is waiting on you" — two were updated and one
 * was not. It stayed green only because it happened to seed no SYSTEM rows:
 * green by construction, on a rule it no longer implemented. One
 * implementation, no drift.
 *
 * The spy wrapper survives because the suites assert the BATCHING contract
 * (ONE call for the whole page, never one per row) and because `unreadError`
 * is how the deliberate-swallow branch is exercised.
 */
export function buildUnreadCountingRepo(
  messages: readonly SeededThreadMessage[] = [],
  options: { unreadError?: Error } = {},
): FakeBookingRequestMessagesRepo {
  const repo = createFakeBookingRequestMessagesRepo();
  for (const message of messages) repo.seed(message);
  const countUnreadByRequest = vi.fn(
    async (input: CountUnreadByRequestInput) => {
      if (options.unreadError) throw options.unreadError;
      return repo.countUnreadByRequest(input);
    },
  );
  return { ...repo, countUnreadByRequest };
}

/** The ledger fake {@link withTx} wired into a repos bag. */
export function ledgerOf(repos: unknown): FakeBookingRequestMessagesRepo {
  return (repos as { bookingRequestMessages: FakeBookingRequestMessagesRepo })
    .bookingRequestMessages;
}

/**
 * The system entries a transition appended to one request's thread, in
 * insertion order. `[]` when the transition wrote nothing — which is what a
 * no-op/idempotent replay must produce.
 */
export function systemEntriesFor(
  repos: unknown,
  bookingRequestId: string,
): Array<{
  systemKind: string | null;
  systemData: Record<string, unknown> | null;
  authorHumanId: string | null;
  authorSide: string;
}> {
  return [...ledgerOf(repos).rows.values()]
    .filter(
      (row) => row.bookingRequestId === bookingRequestId && row.systemKind,
    )
    .map((row) => ({
      systemKind: row.systemKind,
      systemData: row.systemData,
      authorHumanId: row.authorHumanId,
      authorSide: row.authorSide,
    }));
}
