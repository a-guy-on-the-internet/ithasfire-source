import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import type {
  SetBookingRequestClaimTokenInput,
  UpdateBookingRequestStatusInput,
} from "@th/types/repos/booking-requests";

import { respondToBookingRequest } from "../respond-to-booking-request";
import type { RespondToBookingRequestDeps } from "../respond-to-booking-request";
import { deriveCounterparty } from "../_shared/accept-in-tx";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  CLONED_TERMS_ID,
  NOW,
  ORG_ID,
  OTHER_HUMAN_ID,
  REQUEST_ID,
  TERMS_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  makeFakeIdempotency,
  withTx,
} from "./helpers";

const PUBLIC_APP_URL = "https://ithasfire.test";

type BuildDepsOptions = {
  /** An ACTIVE / payout-enabled Payee for the requester (owner-side terms seed). */
  requesterPayee?: { id: string; status: string; payoutsEnabled: boolean } | null;
  request?: BookingRequestRecord | null;
  place?: PlaceRecord | null;
  memberships?: OrgMembership[];
  /**
   * Simulate the adapter's write-time CAS losing to a concurrent transition
   * that is invisible to the in-tx re-read (READ COMMITTED takes no lock):
   * `updateStatus` throws the adapter's conflict.
   */
  updateStatusConflict?: boolean;
  /** Simulate N claimTokenHash unique collisions before setClaimToken succeeds. */
  claimTokenCollisions?: number;
  /** Make mailer.send reject (NFR-004 swallow path). */
  mailerFails?: boolean;
  /** Override the claim-link base URL dep (null = unconfigured). */
  publicAppUrl?: string | null;
  /** Routed calendar's `defaultStartTime` for the pitch-seed anchor. */
  calendarDefaultStartTime?: string | null;
  /** Make the calendars read throw (pitch-seed deliberate-swallow path). */
  calendarsFail?: boolean;
};

/** The place's single calendar, the one every routed fixture points at. */
const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function buildDeps(options: BuildDepsOptions = {}) {
  let current =
    options.request === undefined
      ? buildBookingRequestRecord()
      : options.request;
  const place =
    options.place === undefined ? buildPlaceRecord() : options.place;
  let collisionsRemaining = options.claimTokenCollisions ?? 0;

  const bookingRequests = {
    getById: vi.fn(async () => current),
    // ── P3b (asks) ── the accept seeds an answered SET_LENGTH ask (none here).
    listAsks: vi.fn(async () => []),
    updateStatus: vi.fn(async (input: UpdateBookingRequestStatusInput) => {
      // Mirror the adapter contract: the transition only applies when the
      // row is still in one of the expected statuses.
      if (
        options.updateStatusConflict ||
        !current ||
        !input.expectedFrom.includes(current.status)
      ) {
        throw {
          code: "conflict",
          message: "booking_request_status_changed",
        } as const;
      }
      current = {
        ...current,
        status: input.status,
        respondedAt: input.respondedAt ?? current.respondedAt,
        declineReason: input.declineReason ?? current.declineReason,
        agreementId: input.agreementId ?? current.agreementId,
      };
      return current;
    }),
    setClaimToken: vi.fn(async (input: SetBookingRequestClaimTokenInput) => {
      if (collisionsRemaining > 0) {
        collisionsRemaining -= 1;
        throw {
          code: "conflict",
          message: "claim_token_hash_collision",
        } as const;
      }
      // Mirror the adapter CAS: status + anonymous-unclaimed re-checked.
      if (
        !current ||
        !input.expectedFrom.includes(current.status) ||
        current.performerOwnerId !== null ||
        current.claimedAt !== null
      ) {
        throw {
          code: "conflict",
          message: "booking_request_status_changed",
        } as const;
      }
      current = {
        ...current,
        claimTokenHash: input.claimTokenHash,
        claimTokenExpiresAt: input.claimTokenExpiresAt,
      };
      return current;
    }),
  };
  const places = { getById: vi.fn(async () => place) };
  const authz = {
    getOrgMemberships: vi.fn(async () => options.memberships ?? []),
  };
  const payoutTerms = {
    // `settlementCurrency` is load-bearing for the pitch seed: a fee ask in
    // another currency must never become a `guaranteeCents` floor.
    clone: vi.fn(async () => ({
      id: CLONED_TERMS_ID,
      settlementCurrency: "usd",
    })),
    createDraft: vi.fn(async () => ({ id: TERMS_ID })),
    seedLinesIfEmpty: vi.fn(async () => true),
  };
  // Requester-side Payee lookup (requester-owned terms seed). None by
  // default; suites seed one via `options.requesterPayee`.
  const payees = {
    getBySubject: vi.fn(async () =>
      options.requesterPayee ? { id: options.requesterPayee.id } : null,
    ),
    getById: vi.fn(async () => options.requesterPayee ?? null),
  };
  const agreements = {
    create: vi.fn(async (input: Record<string, unknown>) => ({
      id: AGREEMENT_ID,
      ...input,
    })),
  };
  const audit = { log: vi.fn(async () => {}) };
  // Pitch-seed context read (venue-hierarchy FR-009 template default). Only
  // ever consulted for a routed request with a DATE-ONLY preferred date.
  const calendars = {
    listByPlace: vi.fn(async () => {
      if (options.calendarsFail) throw new Error("calendars down");
      return [
        {
          id: CALENDAR_ID,
          defaultStartTime: options.calendarDefaultStartTime ?? null,
        },
      ];
    }),
  };

  const mocks = {
    bookingRequests,
    places,
    authz,
    payoutTerms,
    payees,
    agreements,
    audit,
    calendars,
  };

  const idempotency = makeFakeIdempotency();

  const mailerSend = vi.fn(async (_input: unknown) => {
    if (options.mailerFails) throw new Error("smtp down");
    return { result: { id: "msg-1", status: "sent" } };
  });
  const mailer = {
    send: mailerSend,
    sendBatch: vi.fn(),
    health: vi.fn(),
  } as unknown as MailerPort;
  const reportError = vi.fn();

  // withTx is passthrough (no rollback); the collision-retry tests need real
  // rollback semantics — a failed tx must not leave the row half-transitioned
  // — so snapshot/restore `current` around each tx callback.
  const reposBase = withTx(mocks) as unknown as Record<string, unknown>;
  // `reposBase` (not the bare `mocks` bag) is what the callback receives — it
  // carries the ledger repos `withTx` autowires, which every transition now
  // writes to from inside this transaction.
  const tx = vi.fn(async <R,>(fn: (t: unknown) => Promise<R>): Promise<R> => {
    const snapshot = current;
    try {
      return await fn(reposBase);
    } catch (error) {
      current = snapshot;
      throw error;
    }
  });

  const deps: RespondToBookingRequestDeps = {
    repos: {
      ...reposBase,
      tx,
    } as unknown as RespondToBookingRequestDeps["repos"],
    idempotency,
    clock: { now: () => NOW },
    mailer,
    publicAppUrl:
      options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
    reportError,
  };

  return { deps, mocks, mailerSend, reportError };
}

/** Anonymous embed inquiry record used across the FR-007 fork tests. */
function buildAnonymousRequest(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return buildBookingRequestRecord({
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "The Basement Tapes",
    contactEmail: "band@example.com",
    actName: "The Basement Tapes",
    source: "EMBED",
    ...overrides,
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Extract the raw token from the claim link in a mailer.send call. */
function extractRawToken(sendMock: { mock: { calls: unknown[][] } }): string {
  const call = sendMock.mock.calls.at(-1)?.[0] as {
    template: { variables: { claimUrl: string } };
  };
  const claimUrl = call.template.variables.claimUrl;
  const match = claimUrl.match(/\/booking-requests\/claim\/([A-Za-z0-9_-]+)$/);
  expect(match, `claimUrl shape: ${claimUrl}`).not.toBeNull();
  return match![1]!;
}

describe("respondToBookingRequest", () => {
  it("accept clones the place's default payout terms into a PENDING instance", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ defaultPrimaryPayoutTermsId: TERMS_ID }),
    });

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
    expect(mocks.payoutTerms.clone).toHaveBeenCalledWith({
      sourcePayoutTermsId: TERMS_ID,
      isDefault: false,
      resetConfirmations: true,
      statusOverride: "PENDING",
      // Snapshot of the place default: the booked event never inherits ABSORB.
      resetFeeMode: true,
    });
    expect(mocks.payoutTerms.createDraft).not.toHaveBeenCalled();
    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PERFORMANCE",
        status: "DRAFT",
        proposerType: "human",
        proposerId: ACTOR_ID,
        placeId: buildPlaceRecord().id,
        payoutTermsId: CLONED_TERMS_ID,
      }),
    );
    expect(mocks.bookingRequests.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ACCEPTED",
        expectedFrom: ["PENDING", "VIEWED"],
        respondedAt: NOW,
        agreementId: AGREEMENT_ID,
      }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.accepted" }),
    );
  });

  it("accept creates a bare PENDING PRIMARY draft when the place has no default terms", async () => {
    const { deps, mocks } = buildDeps();

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mocks.payoutTerms.clone).not.toHaveBeenCalled();
    expect(mocks.payoutTerms.createDraft).toHaveBeenCalledWith({
      kind: "PRIMARY",
      settlementCurrency: "usd",
    });
    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({ payoutTermsId: TERMS_ID }),
    );
  });

  // Owner-side terms (venue-confirmation spec "Who mints, who owns"): a
  // RENT / USE booking produces a REQUESTER-owned event, so its terms are
  // "100% requester, no venue line" — never the venue's cloned defaults.
  /** The act on the thread — deliberately NOT the venue actor, so a seed that looked up the actor's Payee would fail. */
  const REQUESTER_HUMAN_ID = "18181818-1818-4181-8181-181818181818";
  const REQUESTER_ORG_ID = "42424242-4242-4242-8424-424242424242";

  it.each(["RENT", "USE"] as const)("%s accept: does NOT clone the venue default; mints a bare draft and seeds ONE 100% REQUESTER line when the requester has a payout-ready Payee", async (intent) => {
    const REQUESTER_PAYEE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ defaultPrimaryPayoutTermsId: TERMS_ID }),
      request: buildBookingRequestRecord({
        intent,
        spaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        performerOwnerType: "human",
        performerOwnerId: REQUESTER_HUMAN_ID,
      }),
      requesterPayee: { id: REQUESTER_PAYEE_ID, status: "ACTIVE", payoutsEnabled: true },
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mocks.payoutTerms.clone).not.toHaveBeenCalled();
    expect(mocks.payoutTerms.createDraft).toHaveBeenCalledWith({ kind: "PRIMARY", settlementCurrency: "usd" });
    expect(mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.payees.getBySubject).toHaveBeenCalledWith({ type: "HUMAN", id: REQUESTER_HUMAN_ID });
    expect(mocks.payees.getBySubject).not.toHaveBeenCalledWith(expect.objectContaining({ id: ACTOR_ID }));
    expect(mocks.payoutTerms.seedLinesIfEmpty).toHaveBeenCalledWith(TERMS_ID, [
      {
        payeeId: REQUESTER_PAYEE_ID,
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
        requiresConfirmation: false,
      },
    ]);
    expect(mocks.agreements.create).toHaveBeenCalledWith(expect.objectContaining({ payoutTermsId: TERMS_ID }));
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.accepted",
        data: expect.objectContaining({ eventOwnerSide: "requester", requesterLineSeeded: true, clonedFromDefaultTerms: false }),
      }),
    );
  });

  it("RENT accept with an ORG requester: the seed looks up the ORG's Payee, never the actor's", async () => {
    const ORG_PAYEE_ID = "abababab-abab-4bab-8bab-abababababab";
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ defaultPrimaryPayoutTermsId: TERMS_ID }),
      request: buildBookingRequestRecord({
        intent: "RENT",
        spaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        performerOwnerType: "organization",
        performerOwnerId: REQUESTER_ORG_ID,
      }),
      requesterPayee: { id: ORG_PAYEE_ID, status: "ACTIVE", payoutsEnabled: true },
    });

    await respondToBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "accept" });

    expect(mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.payees.getBySubject).toHaveBeenCalledWith({ type: "ORGANIZATION", id: REQUESTER_ORG_ID });
    expect(mocks.payees.getBySubject).not.toHaveBeenCalledWith(expect.objectContaining({ id: ACTOR_ID }));
    expect(mocks.payoutTerms.seedLinesIfEmpty).toHaveBeenCalledWith(TERMS_ID, [expect.objectContaining({ payeeId: ORG_PAYEE_ID, percent: 100 })]);
  });

  it("RENT accept without a payout-ready requester Payee: bare draft, NO line seeded (the agreement editor adds one later)", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ defaultPrimaryPayoutTermsId: TERMS_ID }),
      request: buildBookingRequestRecord({
        intent: "RENT",
        spaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        performerOwnerType: "human",
        performerOwnerId: REQUESTER_HUMAN_ID,
      }),
      requesterPayee: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "PENDING", payoutsEnabled: false },
    });

    await respondToBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "accept" });

    expect(mocks.payees.getBySubject).toHaveBeenCalledWith({ type: "HUMAN", id: REQUESTER_HUMAN_ID });
    expect(mocks.payoutTerms.clone).not.toHaveBeenCalled();
    expect(mocks.payoutTerms.seedLinesIfEmpty).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventOwnerSide: "requester", requesterLineSeeded: false }) }),
    );
  });

  it("PERFORM accept never consults the requester's Payee (venue-owned terms, cloned as before)", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ defaultPrimaryPayoutTermsId: TERMS_ID }),
      requesterPayee: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "ACTIVE", payoutsEnabled: true },
    });
    await respondToBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "accept" });
    expect(mocks.payoutTerms.clone).toHaveBeenCalledTimes(1);
    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
    expect(mocks.payoutTerms.seedLinesIfEmpty).not.toHaveBeenCalled();
  });

  it("derives a human counterparty for a direct human owner", async () => {
    const { deps, mocks } = buildDeps();

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        counterpartyType: "human",
        counterpartyId: ACTOR_ID,
      }),
    );
  });

  it("derives an organization counterparty when access comes via an owning org", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" }],
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        counterpartyType: "organization",
        counterpartyId: ORG_ID,
      }),
    );
  });

  it("accept is idempotent on retry: same agreementId, no second Agreement / PayoutTerms", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ defaultPrimaryPayoutTermsId: TERMS_ID }),
    });

    const input = {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    };

    const first = await respondToBookingRequest(deps, input);
    const second = await respondToBookingRequest(deps, input);

    expect(second).toEqual(first);
    expect(second.agreementId).toBe(AGREEMENT_ID);
    expect(mocks.agreements.create).toHaveBeenCalledTimes(1);
    expect(mocks.payoutTerms.clone).toHaveBeenCalledTimes(1);
  });

  // ── Anonymous accept fork (booking-request-embed-button FR-007) ───────────

  it("anonymous accept: hashed 30-day claim token + ACCEPTED, NO Agreement, invite email with the raw token", async () => {
    const { deps, mocks, mailerSend } = buildDeps({
      request: buildAnonymousRequest(),
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    // ACCEPTED, and NO agreement/payout terms minted (deferred to claim).
    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      status: "ACCEPTED",
    });
    expect(mocks.agreements.create).not.toHaveBeenCalled();
    expect(mocks.payoutTerms.clone).not.toHaveBeenCalled();
    expect(mocks.payoutTerms.createDraft).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ACCEPTED",
        expectedFrom: ["PENDING", "VIEWED"],
        respondedAt: NOW,
      }),
    );
    expect(
      mocks.bookingRequests.updateStatus.mock.calls[0]![0],
    ).not.toHaveProperty("agreementId");

    // Token stored HASHED with the 30-day expiry (CLAIM_TOKEN_TTL_DAYS).
    const expectedExpiry = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(mocks.bookingRequests.setClaimToken).toHaveBeenCalledTimes(1);
    const tokenWrite = mocks.bookingRequests.setClaimToken.mock.calls[0]![0];
    expect(tokenWrite).toMatchObject({
      id: REQUEST_ID,
      claimTokenExpiresAt: expectedExpiry,
      expectedFrom: ["ACCEPTED"],
    });
    expect(tokenWrite.claimTokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Invite email: right template, recipient, vars; the claim link carries
    // the RAW token whose sha256 is exactly the stored hash.
    expect(mailerSend).toHaveBeenCalledTimes(1);
    const send = mailerSend.mock.calls[0]![0];
    expect(send).toMatchObject({
      to: { to: "band@example.com" },
      template: {
        key: "booking.invite_to_claim",
        variables: expect.objectContaining({
          placeName: "Test Venue",
          actName: "The Basement Tapes",
          expiresAtISO: expectedExpiry.toISOString(),
        }),
      },
      idempotencyKey: `booking-invite:${REQUEST_ID}:${expectedExpiry.getTime()}`,
    });
    const rawToken = extractRawToken(mailerSend);
    expect(rawToken).not.toBe(tokenWrite.claimTokenHash);
    expect(sha256Hex(rawToken)).toBe(tokenWrite.claimTokenHash);

    // The RAW token never reaches persistence or the audit trail (the hash
    // never reaches audit either).
    const persistedJson = JSON.stringify([
      mocks.bookingRequests.updateStatus.mock.calls,
      mocks.bookingRequests.setClaimToken.mock.calls,
      mocks.audit.log.mock.calls,
    ]);
    expect(persistedJson).not.toContain(rawToken);
    expect(JSON.stringify(mocks.audit.log.mock.calls)).not.toContain(
      tokenWrite.claimTokenHash,
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.accepted",
        data: expect.objectContaining({ inviteToClaim: true }),
      }),
    );
  });

  it("anonymous accept: email failure is swallowed AND reported — the accept still succeeds (NFR-004)", async () => {
    const { deps, mocks, mailerSend, reportError } = buildDeps({
      request: buildAnonymousRequest(),
      mailerFails: true,
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(result.status).toBe("ACCEPTED");
    expect(mocks.bookingRequests.setClaimToken).toHaveBeenCalledTimes(1);
    expect(mailerSend).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "respondToBookingRequest" },
      extra: {
        bookingRequestId: REQUEST_ID,
        placeId: buildPlaceRecord().id,
      },
    });
  });

  it("anonymous accept: missing publicAppUrl is reported through the swallow; accept succeeds, no email attempted", async () => {
    const { deps, mailerSend, reportError } = buildDeps({
      request: buildAnonymousRequest(),
      publicAppUrl: null,
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(result.status).toBe("ACCEPTED");
    expect(mailerSend).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "respondToBookingRequest" },
      extra: {
        bookingRequestId: REQUEST_ID,
        placeId: buildPlaceRecord().id,
      },
    });
  });

  it("anonymous accept is idempotent on retry: one token write, one email", async () => {
    const { deps, mocks, mailerSend } = buildDeps({
      request: buildAnonymousRequest(),
    });

    const input = {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    };
    const first = await respondToBookingRequest(deps, input);
    const second = await respondToBookingRequest(deps, input);

    expect(second).toEqual(first);
    expect(mocks.bookingRequests.setClaimToken).toHaveBeenCalledTimes(1);
    expect(mailerSend).toHaveBeenCalledTimes(1);
  });

  it("anonymous accept retries ONCE with a fresh token on a claimTokenHash collision", async () => {
    const { deps, mocks, mailerSend } = buildDeps({
      request: buildAnonymousRequest(),
      claimTokenCollisions: 1,
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(result.status).toBe("ACCEPTED");
    expect(mocks.bookingRequests.setClaimToken).toHaveBeenCalledTimes(2);
    const firstHash =
      mocks.bookingRequests.setClaimToken.mock.calls[0]![0].claimTokenHash;
    const secondHash =
      mocks.bookingRequests.setClaimToken.mock.calls[1]![0].claimTokenHash;
    expect(secondHash).not.toBe(firstHash);

    // The email carries the SECOND (winning) generation.
    const rawToken = extractRawToken(mailerSend);
    expect(sha256Hex(rawToken)).toBe(secondHash);
  });

  it("anonymous accept: a second collision propagates (retry-once, not retry-forever)", async () => {
    const { deps, mocks, mailerSend } = buildDeps({
      request: buildAnonymousRequest(),
      claimTokenCollisions: 2,
    });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ message: "claim_token_hash_collision" });
    expect(mocks.bookingRequests.setClaimToken).toHaveBeenCalledTimes(2);
    expect(mailerSend).not.toHaveBeenCalled();
  });

  it("declines an anonymous embed inquiry unchanged (no owner fields read)", async () => {
    // FR-006: markViewed / decline / expire work unchanged for anonymous rows.
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "The Basement Tapes",
        contactEmail: "band@example.com",
        source: "EMBED",
      }),
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "calendar full",
    });

    expect(result.status).toBe("DECLINED");
    expect(mocks.agreements.create).not.toHaveBeenCalled();
  });

  it("decline records the reason and stamps respondedAt", async () => {
    const { deps, mocks } = buildDeps();

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "Calendar is full this summer.",
    });

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      status: "DECLINED",
      holdNotificationIntents: [],
    });
    expect(mocks.bookingRequests.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "DECLINED",
        expectedFrom: ["PENDING", "VIEWED"],
        respondedAt: NOW,
        declineReason: "Calendar is full this summer.",
      }),
    );
    expect(mocks.agreements.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.declined" }),
    );
  });

  it("TO_VENUE decline without a reason is rejected (direction-aware gate, same shape as the old refine)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "decline",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: [
        expect.objectContaining({
          message: "decline_reason_required",
          path: ["declineReason"],
        }),
      ],
    });

    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
  });

  it("declineReason is sanitized plain text (NFR-003): tags stripped before the length checks", async () => {
    const { deps, mocks } = buildDeps();

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "<img src=x onerror=alert(1)>Calendar   is full.",
    });

    expect(mocks.bookingRequests.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ declineReason: "Calendar is full." }),
    );
  });

  it("rejects a non-owner with forbidden", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: ["12121212-1212-4121-8121-121212121212"],
      }),
    });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects an org VIEWER (respond requires an edit-level org role)", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" }],
    });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(mocks.agreements.create).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
  });

  it("allows an org EDITOR to respond", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" }],
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(result.status).toBe("ACCEPTED");
  });

  it("treats an open request whose TTL already lapsed as expired", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        status: "VIEWED",
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

    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
  });

  it("surfaces a conflict when a concurrent transition wins the write-time race", async () => {
    // The in-tx re-read still sees PENDING (no lock under READ COMMITTED),
    // but the guarded write loses to a concurrently committed transition.
    const { deps } = buildDeps({ updateStatusConflict: true });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_status_changed",
    });
  });

  it("rejects an EXPIRED request with a specific invalid_status message", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({ status: "EXPIRED" }),
    });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_EXPIRED" });
  });

  it("rejects other terminal statuses with invalid_status", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({ status: "WITHDRAWN" }),
    });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "decline",
        declineReason: "too late",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("throws not_found for a missing request", async () => {
    const { deps } = buildDeps({ request: null });

    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
  });
});

/**
 * The pitch → agreement handoff. Before this, an accept minted a header with
 * only a title, so the venue retyped the pitch it had just read — and because
 * `createEventFromAgreement` inherits from the AGREEMENT, everything dropped
 * here was dropped from the event too.
 */
describe("respondToBookingRequest — accept seeds the Agreement from the pitch", () => {
  /** The header args the accept passed to `agreements.create`. */
  function mintedHeader(mocks: {
    agreements: { create: { mock: { calls: unknown[][] } } };
  }): Record<string, unknown> {
    return mocks.agreements.create.mock.calls[0]![0] as Record<string, unknown>;
  }

  it("seeds a full GUARANTEE pitch: date, end from the set length, guarantee, and the operational asks", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        preferredDates: ["2026-09-15"],
        setLengthMinutes: 45,
        lineupSize: 4,
        techNeeds: "4 DIs and a drum riser.",
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    const header = mintedHeader(mocks);
    // 19:00 America/Chicago (the place carries no zone) on 2026-09-15.
    expect((header.proposedDate as Date).toISOString()).toBe(
      "2026-09-16T00:00:00.000Z",
    );
    expect((header.proposedEndDate as Date).toISOString()).toBe(
      "2026-09-16T00:45:00.000Z",
    );
    expect(header.guaranteeCents).toBe(50_000);
    expect(header.description).toContain("- Lineup: 4 performers");
    expect(header.description).toContain("- Set length: 45 minutes");
    expect(header.description).toContain("4 DIs and a drum riser.");
    // The guarantee has a structured home; the prose must not repeat it.
    expect(header.description).not.toContain("Fee ask:");
  });

  // ── P3b (asks) ── venue-booking-standards V10: a SET_LENGTH ask the sender
  // answered BEFORE the accept fills the set length the pitch left empty, so
  // the draft terms' end is start + minutes. The pitch's own value wins.
  it("seeds the end from an ANSWERED set-length ask when the pitch left set length empty", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        preferredDates: ["2026-09-15"],
        setLengthMinutes: null,
      }),
    });
    mocks.bookingRequests.listAsks.mockResolvedValue([
      {
        id: "a5a5a5a5-0000-4000-8000-000000000001",
        kind: "SET_LENGTH",
        status: "ANSWERED",
        answerMinutes: 50,
        answeredAt: new Date("2026-06-09T00:00:00.000Z"),
      },
      {
        id: "a5a5a5a5-0000-4000-8000-000000000002",
        kind: "SET_LENGTH",
        status: "WITHDRAWN",
        answerMinutes: null,
        answeredAt: null,
      },
    ] as never);

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    const header = mintedHeader(mocks);
    expect((header.proposedEndDate as Date).toISOString()).toBe(
      "2026-09-16T00:50:00.000Z",
    );
  });

  it("the pitch's own set length wins over an answered ask", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        preferredDates: ["2026-09-15"],
        setLengthMinutes: 45,
      }),
    });
    mocks.bookingRequests.listAsks.mockResolvedValue([
      { kind: "SET_LENGTH", status: "ANSWERED", answerMinutes: 90, answeredAt: NOW },
    ] as never);
    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });
    expect((mintedHeader(mocks).proposedEndDate as Date).toISOString()).toBe(
      "2026-09-16T00:45:00.000Z",
    );
  });

  it("does NOT seed a guarantee from a DOOR_SPLIT ask — and invents no percentage", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ defaultPrimaryPayoutTermsId: TERMS_ID }),
      request: buildBookingRequestRecord({
        feeType: "DOOR_SPLIT",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    const header = mintedHeader(mocks);
    expect(header.guaranteeCents).toBeNull();
    expect(header.description).toContain("Fee ask: door split (asking $500.00)");
    // A PayoutTermsLine cannot express a split without a percentage the act
    // never stated — the cloned venue defaults are left exactly as they were.
    expect(mocks.payoutTerms.clone).toHaveBeenCalledWith({
      sourcePayoutTermsId: TERMS_ID,
      isDefault: false,
      resetConfirmations: true,
      statusOverride: "PENDING",
      // Snapshot of the place default: the booked event never inherits ABSORB.
      resetFeeMode: true,
    });
  });

  it("does NOT seed a guarantee from a NEGOTIABLE ask", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({ feeType: "NEGOTIABLE" }),
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(mintedHeader(mocks).guaranteeCents).toBeNull();
  });

  it("honors a preferred date that CARRIES a time, over the calendar's default", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        calendarId: CALENDAR_ID,
        preferredDates: ["2026-09-15T21:00"],
      }),
      calendarDefaultStartTime: "19:30",
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    // 21:00 America/Chicago (CDT) = 02:00Z. The act picked this slot out of
    // the venue's own availability; a template default must not overwrite it.
    expect((mintedHeader(mocks).proposedDate as Date).toISOString()).toBe(
      "2026-09-16T02:00:00.000Z",
    );
  });

  it("anchors a DATE-ONLY pitch at the routed calendar's defaultStartTime", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        calendarId: CALENDAR_ID,
        preferredDates: ["2026-09-15"],
      }),
      calendarDefaultStartTime: "20:30",
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect((mintedHeader(mocks).proposedDate as Date).toISOString()).toBe(
      "2026-09-16T01:30:00.000Z",
    );
  });

  it("uses the VENUE's timezone when the place has one", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({
        timezone: "America/New_York",
        defaultPrimaryPayoutTermsId: TERMS_ID,
      }),
      request: buildBookingRequestRecord({ preferredDates: ["2026-09-15"] }),
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    // 19:00 EDT = 23:00Z — one hour earlier than the Chicago fallback.
    expect((mintedHeader(mocks).proposedDate as Date).toISOString()).toBe(
      "2026-09-15T23:00:00.000Z",
    );
  });

  it("a request with NO preferred dates, fee, or set length seeds nothing and still accepts", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        preferredDates: [],
        expectedDraw: null,
        genre: null,
      }),
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(result.status).toBe("ACCEPTED");
    expect(mintedHeader(mocks)).toMatchObject({
      proposedDate: null,
      proposedEndDate: null,
      guaranteeCents: null,
      description: null,
    });
  });

  it("a failing calendars read degrades to 19:00 — accept still succeeds, and it is REPORTED", async () => {
    const { deps, mocks, reportError } = buildDeps({
      request: buildBookingRequestRecord({
        calendarId: CALENDAR_ID,
        preferredDates: ["2026-09-15"],
      }),
      calendarsFail: true,
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    // A venue unable to accept a booking because a template lookup hiccuped
    // is far worse than a suggested show time being half an hour off.
    expect(result.status).toBe("ACCEPTED");
    expect((mintedHeader(mocks).proposedDate as Date).toISOString()).toBe(
      "2026-09-16T00:00:00.000Z",
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "resolveCalendarDefaultStartTime" },
      }),
    );
  });

  it("skips the calendar read entirely when the pitch named its own time", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        calendarId: CALENDAR_ID,
        preferredDates: ["2026-09-15T21:00"],
      }),
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect((mintedHeader(mocks).proposedDate as Date).toISOString()).toBe(
      "2026-09-16T02:00:00.000Z",
    );
  });

  it("seeding never activates the terms — the mint stays DRAFT + PENDING", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ defaultPrimaryPayoutTermsId: TERMS_ID }),
      request: buildBookingRequestRecord({
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
    });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    // The whole reason a money field may be seeded at all: nothing binds
    // until the counterparty accepts it back.
    expect(mintedHeader(mocks).status).toBe("DRAFT");
    expect(mocks.payoutTerms.clone).toHaveBeenCalledWith(
      expect.objectContaining({ statusOverride: "PENDING" }),
    );
  });
});

describe("respondToBookingRequest — authz before the idempotency cache (review 2026-07-21)", () => {
  it("an unauthorized actor replaying a COMPLETED respond gets the authz error, never the cached response", async () => {
    const { deps, mocks } = buildDeps();

    // Legitimate owner completes the respond → cached.
    const first = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });
    expect(first.status).toBe("ACCEPTED");

    // A stranger who knows the UUID must NOT be able to read the outcome
    // (status + minted agreementId) off the cache.
    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    // And the probe never re-ran the mutation either.
    expect(mocks.agreements.create).toHaveBeenCalledTimes(1);
  });

  it("a SECOND authorized editor replaying gets the cached response (actor-independent key preserved)", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [ACTOR_ID, OTHER_HUMAN_ID],
      }),
    });

    const first = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    const replay = await respondToBookingRequest(deps, {
      actorHumanId: OTHER_HUMAN_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(replay).toEqual(first);
    // Cached — the second editor's call never re-minted.
    expect(mocks.agreements.create).toHaveBeenCalledTimes(1);
  });

  it("an unauthorized probe no longer arms the failed-marker against the real responder", async () => {
    const { deps } = buildDeps();

    // Stranger probes first (pre-fix this armed a 15-minute failed marker on
    // the shared key, turning the owner's respond into
    // IDEMPOTENCY_LOCK_IN_PROGRESS).
    await expect(
      respondToBookingRequest(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        bookingRequestId: REQUEST_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    // The real owner still succeeds immediately.
    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });
    expect(result.status).toBe("ACCEPTED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking-holds FR-009: a DECLINED request leaves every line it was in.
// ─────────────────────────────────────────────────────────────────────────────

describe("respondToBookingRequest — decline releases holds (FR-009)", () => {
  const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const OTHER_REQUEST_ID = "45454545-4545-4545-8545-454545454545";

  it("releases the request's live holds (REQUEST_CLOSED) in the decline tx and returns the movers' intents", async () => {
    const { deps } = buildDeps();
    const { holdsOf, systemEntriesFor } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    const theirs = holds.seed({ bookingRequestId: OTHER_REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "Booked that night already.",
    });

    expect(result.status).toBe("DECLINED");
    expect(holds.rows.get(mine.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
    expect(holds.rows.get(theirs.id)?.position).toBe(1);
    expect(result.holdNotificationIntents).toEqual([
      { kind: "hold.position_changed", bookingRequestId: OTHER_REQUEST_ID, holdId: theirs.id, audience: "act", date: "2026-07-10", position: 1 },
    ]);
    expect(systemEntriesFor(deps.repos, REQUEST_ID).map((e) => e.systemKind)).toEqual([
      "booking_request.declined",
      "booking_hold.released",
    ]);
  });

  it("locks the line BEFORE reading it or releasing the hold (decline never renumbers an unlocked line)", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    holds.seed({ bookingRequestId: OTHER_REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "Booked that night already.",
    });

    expect(holds.lockLine).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, date: "2026-07-10" });
    const firstLock = holds.lockLine.mock.invocationCallOrder[0]!;
    for (const order of holds.listLine.mock.invocationCallOrder) expect(firstLock).toBeLessThan(order);
    for (const order of holds.updateStatus.mock.invocationCallOrder) expect(firstLock).toBeLessThan(order);
  });

  it("a REPLAYED decline (idempotency cache) carries no hold intents — they were dispatched once, by the committing call", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    holds.seed({ bookingRequestId: OTHER_REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
    const input = {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline" as const,
      declineReason: "Booked that night already.",
    };

    const first = await respondToBookingRequest(deps, input);
    expect(first.holdNotificationIntents).toHaveLength(1);

    const replay = await respondToBookingRequest(deps, input);
    expect(replay).toEqual({ bookingRequestId: REQUEST_ID, status: "DECLINED" });
    expect(replay.holdNotificationIntents).toBeUndefined();
  });

  // booking-the-night P2c, round 3 (W5, orchestrator ruling): a night that is
  // BOOKED (a CONFIRMED hold — an event-first request whose hold a venue
  // confirm made CONFIRMED before anyone answered) is not declined away. The
  // undo is Cancel booking; the sender's Withdraw refuses the same way.
  it("a BOOKED night (a CONFIRMED hold) → BOOKING_NIGHT_BOOKED with no meta; the request stays open, the hold stays CONFIRMED, nothing written", async () => {
    const { deps, mocks } = buildDeps();
    const { holdsOf, systemEntriesFor } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    const booked = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10", status: "CONFIRMED" });
    const theirs = holds.seed({ bookingRequestId: OTHER_REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });

    const error = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "Changed our minds.",
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    // Decided under the request's booking lock, before any write.
    expect(holds.lockRequestBooking).toHaveBeenCalledWith(REQUEST_ID);
    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
    expect(holds.rows.get(booked.id)).toMatchObject({ status: "CONFIRMED" });
    expect(holds.rows.get(theirs.id)).toMatchObject({ status: "ACTIVE" });
    expect(systemEntriesFor(deps.repos, REQUEST_ID)).toEqual([]);
  });

  // Round 3, W3: the refusal above is DETERMINISTIC — it re-fails identically
  // until Cancel booking frees the night — so its failed marker must not lock
  // the venue out of exactly that retry: Cancel booking, then decline again.
  it("the refused decline keeps a 1-second failed marker (not the adapters' 15-minute default); after Cancel booking the decline succeeds without IDEMPOTENCY_LOCK_IN_PROGRESS", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    const booked = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10", status: "CONFIRMED" });
    // The helpers' fake idempotency keeps a failed marker for `keepSec` and
    // blocks `begin` while it is live, like the real adapters.
    const fail = vi.fn(deps.idempotency.fail.bind(deps.idempotency));
    deps.idempotency.fail = fail;
    const input = { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "decline" as const, declineReason: "Changed our minds." };
    vi.useFakeTimers({ now: NOW });
    try {
      await expect(respondToBookingRequest(deps, input)).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
      expect(fail).toHaveBeenCalledWith(`bookingRequest:respond:${REQUEST_ID}:decline`, expect.any(String), 1);

      // Cancel booking: the booked hold goes RELEASED (BOOKING_CANCELLED);
      // the request stays PENDING, open to the venue's decline. Two seconds
      // later — well inside the adapters' default 15-minute retention — the
      // venue declines again.
      holds.rows.set(booked.id, { ...holds.rows.get(booked.id)!, status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
      vi.setSystemTime(NOW.getTime() + 2_000);

      const second = await respondToBookingRequest(deps, input);
      expect(second.status).toBe("DECLINED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a NON-deterministic failure (a lost status CAS) keeps the default retention: an immediate retry is IDEMPOTENCY_LOCK_IN_PROGRESS", async () => {
    const { deps } = buildDeps({ updateStatusConflict: true });
    const fail = vi.fn(deps.idempotency.fail.bind(deps.idempotency));
    deps.idempotency.fail = fail;
    const input = { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "decline" as const, declineReason: "Changed our minds." };
    vi.useFakeTimers({ now: NOW });
    try {
      await expect(respondToBookingRequest(deps, input)).rejects.toBeDefined();
      expect(fail).toHaveBeenCalledWith(expect.any(String), expect.any(String), undefined);
      vi.setSystemTime(NOW.getTime() + 2_000);
      await expect(respondToBookingRequest(deps, input)).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });
    } finally {
      vi.useRealTimers();
    }
  });

  // Round 3, W4: a request whose booking was CANCELLED (the night freed, the
  // request kept as history) is never accepted into new terms. Decided under
  // the request's booking lock, like every other request-state write.
  it("accept on a request whose booking was cancelled → BOOKING_CANCELLED (no meta), under the booking lock; nothing written", async () => {
    const { deps, mocks } = buildDeps();
    const { holdsOf, systemEntriesFor } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10", status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });

    const error = await respondToBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "accept" }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "BOOKING_CANCELLED" });
    expect((error as { meta?: unknown }).meta).toBeUndefined();
    expect(holds.lockRequestBooking).toHaveBeenCalledWith(REQUEST_ID);
    const lockAt = vi.mocked(holds.lockRequestBooking).mock.invocationCallOrder[0]!;
    for (const order of vi.mocked(holds.listForRequest).mock.invocationCallOrder) expect(lockAt).toBeLessThan(order);
    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
    expect(mocks.agreements.create).not.toHaveBeenCalled();
    expect(systemEntriesFor(deps.repos, REQUEST_ID)).toEqual([]);
  });

  it("the decline of a cancelled booking still goes through (the request closes as history)", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10", status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
    const result = await respondToBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "decline", declineReason: "Not this time." });
    expect(result.status).toBe("DECLINED");
  });

  it("an accept takes the booking lock BEFORE its reads and writes (and a plain accept still succeeds)", async () => {
    const { deps, mocks } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    const result = await respondToBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "accept" });
    expect(result.status).toBe("ACCEPTED");
    const lockAt = vi.mocked(holds.lockRequestBooking).mock.invocationCallOrder[0]!;
    for (const order of mocks.bookingRequests.updateStatus.mock.invocationCallOrder) expect(lockAt).toBeLessThan(order);
  });

  it("an accept leaves holds alone (no intents on the accept output)", async () => {
    const { deps } = buildDeps();
    const { holdsOf } = await import("./helpers");
    const holds = holdsOf(deps.repos);
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });

    const result = await respondToBookingRequest(deps, { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "accept" });

    expect(result.status).toBe("ACCEPTED");
    expect(result.holdNotificationIntents).toBeUndefined();
    expect(holds.rows.get(mine.id)?.status).toBe("ACTIVE");
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// `deriveCounterparty` — the Agreement's venue side (booking-accept-is-the-
// mint-point spec, FR-006 "Revised 2026-09-08"). A grant holder is never
// the venue counterparty (since holds-without-a-request FR-002 it never
// reaches an accept at all). The precedence is pinned case by case because `accept-agreement`'s
// claim-path pick and `requirePlaceOwnership`'s human-first resolution both
// lean on it.
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveCounterparty — the venue side of an accept", () => {
  const GRANTEE_ID = "17171717-1717-4171-8171-171717171717";
  const OTHER_ORG_ID = "23232323-2323-4232-8232-232323232323";
  /** Sorts BEFORE ACTOR_ID: the "smallest id" pick must not win for a direct owner. */
  const CO_OWNER_A_ID = "10101010-1010-4101-8101-101010101010";

  it("direct owner → the actor", () => {
    const place = buildPlaceRecord({ humanIdsWithAccess: [ACTOR_ID], orgIdsWithAccess: [] });
    expect(deriveCounterparty({ via: "human", orgId: null }, place, ACTOR_ID)).toEqual({
      type: "human",
      id: ACTOR_ID,
    });
  });

  it("co-owner B accepting → B, never the smallest owner id (B's own mint must not fail NOT_RESOURCE_OWNER)", () => {
    const place = buildPlaceRecord({ humanIdsWithAccess: [CO_OWNER_A_ID, ACTOR_ID], orgIdsWithAccess: [] });
    expect(deriveCounterparty({ via: "human", orgId: null }, place, ACTOR_ID)).toEqual({
      type: "human",
      id: ACTOR_ID,
    });
  });

  it("org member → the membership's org", () => {
    const place = buildPlaceRecord({ humanIdsWithAccess: [], orgIdsWithAccess: [ORG_ID] });
    expect(deriveCounterparty({ via: "org", orgId: ORG_ID }, place, ACTOR_ID)).toEqual({
      type: "organization",
      id: ORG_ID,
    });
  });

  // holds-without-a-request FR-002: the staff gate has no grant arm, so no
  // `via: "grant"` reaches here (was: a grantee at an org-owned place → the
  // org; at a human-owned place → its smallest owner). Rule 3 (an owning org,
  // whoever asks) still stands for any non-human, non-org answer.
  it("an owning org answers when the authority names none (deterministic smallest id when several own it)", () => {
    const place = buildPlaceRecord({ humanIdsWithAccess: [], orgIdsWithAccess: [OTHER_ORG_ID, ORG_ID] });
    expect(deriveCounterparty({ via: "org", orgId: null }, place, GRANTEE_ID)).toEqual({
      type: "organization",
      id: ORG_ID,
    });
  });

  it("dual access: a direct human owner of a place an org ALSO owns → the actor (today's behaviour — the owner check precedes the place's org list)", () => {
    const place = buildPlaceRecord({ humanIdsWithAccess: [ACTOR_ID], orgIdsWithAccess: [ORG_ID] });
    expect(deriveCounterparty({ via: "human", orgId: null }, place, ACTOR_ID)).toEqual({
      type: "human",
      id: ACTOR_ID,
    });
  });

  it("a place with no owner at all, no org named → NOT_RESOURCE_OWNER no_venue_counterparty", () => {
    const place = buildPlaceRecord({ humanIdsWithAccess: [], orgIdsWithAccess: [] });
    expect(() => deriveCounterparty({ via: "org", orgId: null }, place, GRANTEE_ID)).toThrowError(
      expect.objectContaining({
        code: "NOT_RESOURCE_OWNER",
        meta: expect.objectContaining({ entity: "place", reason: "no_venue_counterparty", placeId: place.id }),
      }),
    );
  });
});

describe("respondToBookingRequest — the sender hears the answer (booking-the-night N9 / FR-008)", () => {
  const withHook = (options: Parameters<typeof buildDeps>[0] = {}) => {
    const built = buildDeps(options);
    const hook = vi.fn(async () => {});
    built.deps.notifyBookingRequestResponded = hook;
    return { ...built, hook };
  };

  it("an accept fires `booking.request-responded` once, post-commit, with the minted agreement and no reason", async () => {
    const { deps, hook } = withHook();

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ id: REQUEST_ID, status: "ACCEPTED" }),
      action: "accepted",
      agreementId: AGREEMENT_ID,
      reason: null,
      actorHumanId: ACTOR_ID,
    });
  });

  it("a decline fires it with the venue's reason", async () => {
    const { deps, hook } = withHook();

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "Booked that night already.",
    });

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "declined",
        reason: "Booked that night already.",
        bookingRequest: expect.objectContaining({ status: "DECLINED" }),
      }),
    );
  });

  it("an anonymous accept (invite-to-claim) does not fire it — the inquirer has its own email", async () => {
    const { deps, hook } = withHook({ request: buildAnonymousRequest() });

    await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "accept",
    });

    expect(hook).not.toHaveBeenCalled();
  });

  it("an idempotent replay never tells the sender twice", async () => {
    const { deps, hook } = withHook();
    const input = { actorHumanId: ACTOR_ID, bookingRequestId: REQUEST_ID, action: "accept" as const };

    await respondToBookingRequest(deps, input);
    await respondToBookingRequest(deps, input);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("a throwing hook is swallowed — logged at error AND reported (guarded); the answer stands", async () => {
    const { deps, hook, reportError } = withHook();
    hook.mockRejectedValueOnce(new Error("notify down"));
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const result = await respondToBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      action: "decline",
      declineReason: "Booked that night already.",
    });

    expect(result.status).toBe("DECLINED");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notify down" }),
      expect.objectContaining({
        tags: { useCase: "respondToBookingRequest", step: "request_responded" },
      }),
    );
  });
});
