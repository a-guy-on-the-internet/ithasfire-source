import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { ClaimBookingRequestRecordInput } from "@th/types/repos/booking-requests";
import { createFakeBookingRequestActs } from "@th/test-utils/fakes/booking-request-acts";

import { claimBookingRequest } from "../claim-booking-request";
import type { ClaimBookingRequestDeps } from "../claim-booking-request";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  CLONED_TERMS_ID,
  NOW,
  ORG_ID,
  OTHER_HUMAN_ID,
  PLACE_ID,
  REQUEST_ID,
  TERMS_ID,
  buildBookingRequestRecord,
  buildPerformerProfile,
  buildPlaceRecord,
  makeFakeIdempotency,
  systemEntriesFor,
  withTx,
} from "./helpers";

const RAW_TOKEN = randomBytes(32).toString("base64url");
const TOKEN_HASH = createHash("sha256")
  .update(RAW_TOKEN, "utf8")
  .digest("hex");
const FUTURE_EXPIRY = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
const VENUE_OWNER_ID = "99999999-9999-4999-8999-999999999999";

/** ACCEPTED anonymous request holding the live claim token. */
function buildClaimableRequest(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return buildBookingRequestRecord({
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "The Basement Tapes",
    contactEmail: "band@example.com",
    source: "EMBED",
    status: "ACCEPTED",
    respondedAt: new Date("2026-06-09T12:00:00.000Z"),
    claimTokenHash: TOKEN_HASH,
    claimTokenExpiresAt: FUTURE_EXPIRY,
    ...overrides,
  });
}

type BuildDepsOptions = {
  request?: BookingRequestRecord | null;
  place?: PlaceRecord | null;
  membership?: OrgMembership | null;
  profile?: PerformerProfileRecord | null;
  /** Force the repo `claim` CAS to lose (concurrent-redeem loser path). */
  claimConflict?: boolean;
};

function buildDeps(options: BuildDepsOptions = {}) {
  let current =
    options.request === undefined
      ? buildClaimableRequest()
      : options.request;
  const place =
    options.place === undefined
      ? buildPlaceRecord({ humanIdsWithAccess: [VENUE_OWNER_ID] })
      : options.place;

  const bookingRequests = {
    findByClaimTokenHash: vi.fn(async (hash: string) =>
      current && current.claimTokenHash === hash ? current : null,
    ),
    findOpenByPerformerAndPlace: vi.fn(async () =>
      // Claim-wins scenario: pretend the claimer ALWAYS has another open
      // request at this place — the claim must never even consult this.
      buildBookingRequestRecord({ id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f" }),
    ),
    claim: vi.fn(async (input: ClaimBookingRequestRecordInput) => {
      // Mirror the adapter CAS: token hash still matching + unclaimed +
      // ACCEPTED, exactly one winner.
      if (
        options.claimConflict ||
        !current ||
        current.claimTokenHash !== input.expectedClaimTokenHash ||
        current.claimedAt !== null ||
        current.status !== "ACCEPTED"
      ) {
        throw {
          code: "conflict",
          message: "booking_request_already_claimed",
        } as const;
      }
      current = {
        ...current,
        performerOwnerType: input.performerOwnerType,
        performerOwnerId: input.performerOwnerId,
        claimedAt: input.claimedAt,
        claimTokenHash: null,
        claimTokenExpiresAt: null,
      };
      return current;
    }),
    updateStatus: vi.fn(
      async (input: { id: string; agreementId?: string | null }) => {
        if (!current || current.status !== "ACCEPTED") {
          throw {
            code: "conflict",
            message: "booking_request_status_changed",
          } as const;
        }
        current = {
          ...current,
          agreementId: input.agreementId ?? current.agreementId,
        };
        return current;
      },
    ),
  };
  const places = { getById: vi.fn(async () => place) };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
  };
  const performerProfiles = {
    getByOwner: vi.fn(async () =>
      options.profile === undefined ? buildPerformerProfile() : options.profile,
    ),
  };
  const payoutTerms = {
    // `settlementCurrency` gates the pitch seed's guarantee: a fee ask in
    // another currency must never become a `guaranteeCents` floor.
    clone: vi.fn(async () => ({
      id: CLONED_TERMS_ID,
      settlementCurrency: "usd",
    })),
    createDraft: vi.fn(async () => ({ id: TERMS_ID })),
  };
  // Pitch-seed context read (the routed calendar's default show time).
  const calendars = { listByPlace: vi.fn(async () => []) };
  const agreements = {
    create: vi.fn(async (input: Record<string, unknown>) => ({
      id: AGREEMENT_ID,
      ...input,
    })),
  };
  const audit = { log: vi.fn(async () => {}) };

  const mocks = {
    bookingRequests,
    places,
    authz,
    performerProfiles,
    payoutTerms,
    agreements,
    audit,
    calendars,
  };

  // `reposBase` carries the ledger repos `withTx` autowires; the claim mints
  // the Agreement and appends `booking_agreement.drafted` inside this tx.
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

  const idempotency = makeFakeIdempotency();

  const deps: ClaimBookingRequestDeps = {
    repos: { ...reposBase, tx } as unknown as ClaimBookingRequestDeps["repos"],
    idempotency,
    clock: { now: () => NOW },
  };

  return { deps, mocks, readCurrent: () => current };
}

const humanClaimInput = {
  actorHumanId: ACTOR_ID,
  rawToken: RAW_TOKEN,
  performerOwnerType: "human",
  performerOwnerId: ACTOR_ID,
} as const;

describe("claimBookingRequest", () => {
  it("human sender happy path: backfills identity, consumes the token, mints the Agreement like owned accept", async () => {
    const { deps, mocks, readCurrent } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [VENUE_OWNER_ID],
        defaultPrimaryPayoutTermsId: TERMS_ID,
      }),
    });

    const result = await claimBookingRequest(deps, humanClaimInput);

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      agreementId: AGREEMENT_ID,
    });

    // Identity backfilled + token consumed via the single-winner CAS.
    expect(mocks.bookingRequests.claim).toHaveBeenCalledWith({
      id: REQUEST_ID,
      expectedClaimTokenHash: TOKEN_HASH,
      performerOwnerType: "human",
      performerOwnerId: ACTOR_ID,
      claimedAt: NOW,
    });
    expect(readCurrent()).toMatchObject({
      performerOwnerType: "human",
      performerOwnerId: ACTOR_ID,
      claimedAt: NOW,
      claimTokenHash: null,
      claimTokenExpiresAt: null,
      agreementId: AGREEMENT_ID,
    });

    // Agreement parity with the owned accept path (shared internals): same
    // PayoutTerms cloning args, same DRAFT header shape.
    expect(mocks.payoutTerms.clone).toHaveBeenCalledWith({
      sourcePayoutTermsId: TERMS_ID,
      isDefault: false,
      resetConfirmations: true,
      statusOverride: "PENDING",
      // Snapshot of the place default: the booked event never inherits ABSORB.
      resetFeeMode: true,
    });
    expect(mocks.payoutTerms.createDraft).not.toHaveBeenCalled();
    expect(mocks.agreements.create).toHaveBeenCalledWith({
      type: "PERFORMANCE",
      status: "DRAFT",
      proposerType: "human",
      proposerId: ACTOR_ID,
      counterpartyType: "human",
      counterpartyId: VENUE_OWNER_ID,
      placeId: PLACE_ID,
      payoutTermsId: CLONED_TERMS_ID,
      title: "Booking — Test Venue",
      // Header seeded from the pitch, exactly as the owned accept does: the
      // sole preferred date `2026-07-10` anchored at the 19:00 default in the
      // platform-fallback zone (this place carries no timezone).
      proposedDate: new Date("2026-07-11T00:00:00.000Z"),
      // No setLengthMinutes / GUARANTEE ask / operational asks on the fixture.
      proposedEndDate: null,
      guaranteeCents: null,
      description: null,
    });
    expect(mocks.bookingRequests.updateStatus).toHaveBeenCalledWith({
      id: REQUEST_ID,
      status: "ACCEPTED",
      expectedFrom: ["ACCEPTED"],
      agreementId: AGREEMENT_ID,
    });

    // Same context read as the owned accept — the two mints must not diverge
    // on what an accepted pitch produces.
    expect(mocks.calendars.listByPlace).not.toHaveBeenCalled(); // unrouted fixture

    // Audit — and no token material in it (not even the hash).
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.claimed",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          performerOwnerType: "human",
          performerOwnerId: ACTOR_ID,
          agreementId: AGREEMENT_ID,
        }),
      }),
    );
    const auditJson = JSON.stringify(mocks.audit.log.mock.calls);
    expect(auditJson).not.toContain(RAW_TOKEN);
    expect(auditJson).not.toContain(TOKEN_HASH);
  });

  it("falls back to a bare PENDING PRIMARY draft when the place has no default terms (parity with owned accept)", async () => {
    const { deps, mocks } = buildDeps();

    await claimBookingRequest(deps, humanClaimInput);

    expect(mocks.payoutTerms.clone).not.toHaveBeenCalled();
    expect(mocks.payoutTerms.createDraft).toHaveBeenCalledWith({
      kind: "PRIMARY",
      settlementCurrency: "usd",
    });
    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({ payoutTermsId: TERMS_ID }),
    );
  });

  it("org sender: requires an edit-level org role and proposes as the organization", async () => {
    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" },
      profile: buildPerformerProfile({
        ownerType: "organization",
        ownerId: ORG_ID,
      }),
    });

    const result = await claimBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      rawToken: RAW_TOKEN,
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
    });

    expect(result.agreementId).toBe(AGREEMENT_ID);
    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        proposerType: "organization",
        proposerId: ORG_ID,
      }),
    );
  });

  it("derives an organization counterparty when the place is org-owned", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
    });

    await claimBookingRequest(deps, humanClaimInput);

    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        counterpartyType: "organization",
        counterpartyId: ORG_ID,
      }),
    );
  });

  it("rejects a sender the actor doesn't control (human mismatch)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      claimBookingRequest(deps, {
        ...humanClaimInput,
        performerOwnerId: OTHER_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.bookingRequests.claim).not.toHaveBeenCalled();
  });

  it("rejects an org sender without an edit-level role", async () => {
    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" },
    });

    await expect(
      claimBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        rawToken: RAW_TOKEN,
        performerOwnerType: "org",
        performerOwnerId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(mocks.bookingRequests.claim).not.toHaveBeenCalled();
  });

  it("requires performer mode on the claiming sender", async () => {
    const { deps, mocks } = buildDeps({ profile: null });

    await expect(
      claimBookingRequest(deps, humanClaimInput),
    ).rejects.toMatchObject({ code: "PERFORMER_MODE_REQUIRED" });
    expect(mocks.bookingRequests.findByClaimTokenHash).not.toHaveBeenCalled();
  });

  it("unknown token → TOKEN_INVALID", async () => {
    const { deps } = buildDeps();

    await expect(
      claimBookingRequest(deps, {
        ...humanClaimInput,
        rawToken: randomBytes(32).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("expired token → TOKEN_EXPIRED", async () => {
    const { deps, mocks } = buildDeps({
      request: buildClaimableRequest({
        claimTokenExpiresAt: new Date(NOW.getTime() - 1000),
      }),
    });

    await expect(
      claimBookingRequest(deps, humanClaimInput),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(mocks.bookingRequests.claim).not.toHaveBeenCalled();
  });

  it("expired token → immediate retry still gets TOKEN_EXPIRED, never IDEMPOTENCY_LOCK_IN_PROGRESS", async () => {
    // Expired-link retries are a NORMAL user path. The token gates run
    // OUTSIDE the idempotency envelope, so a deterministic failure leaves no
    // failed marker behind — and the fake idempotency now mirrors the real
    // adapters' 15-minute failure retention, so this test would fail if the
    // gates ever moved back inside begin/fail.
    const { deps } = buildDeps({
      request: buildClaimableRequest({
        claimTokenExpiresAt: new Date(NOW.getTime() - 1000),
      }),
    });

    await expect(
      claimBookingRequest(deps, humanClaimInput),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    await expect(
      claimBookingRequest(deps, humanClaimInput),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("counterparty divergence (documented): a dual-access place (direct human AND orgs) yields the lexicographically-smallest ORG at claim time — unlike respond, which follows the actor's access path", async () => {
    const laterOrgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // "a…" > "2…" (ORG_ID)
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [VENUE_OWNER_ID],
        // NOT in sorted order on purpose: the adapter's ownership filter
        // returns these unordered, so the pick must be deterministic
        // regardless of array order — [0] would have chosen laterOrgId here.
        orgIdsWithAccess: [laterOrgId, ORG_ID],
      }),
    });

    await claimBookingRequest(deps, humanClaimInput);

    expect(mocks.agreements.create).toHaveBeenCalledWith(
      expect.objectContaining({
        counterpartyType: "organization",
        counterpartyId: ORG_ID,
      }),
    );
  });

  it("already-claimed row (defensive: hash somehow live) → TOKEN_INVALID/already_claimed", async () => {
    const { deps } = buildDeps({
      request: buildClaimableRequest({
        performerOwnerType: "human",
        performerOwnerId: OTHER_HUMAN_ID,
        claimedAt: new Date("2026-06-09T13:00:00.000Z"),
      }),
    });

    await expect(
      claimBookingRequest(deps, humanClaimInput),
    ).rejects.toMatchObject({
      code: "TOKEN_INVALID",
      meta: { reason: "already_claimed" },
    });
  });

  it("token on a non-ACCEPTED row (defensive) → INVALID_STATUS", async () => {
    const { deps } = buildDeps({
      request: buildClaimableRequest({ status: "DECLINED" }),
    });

    await expect(
      claimBookingRequest(deps, humanClaimInput),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("double-redeem race: the CAS loser gets TOKEN_INVALID/token_no_longer_active and mints nothing", async () => {
    const { deps, mocks } = buildDeps({ claimConflict: true });

    await expect(
      claimBookingRequest(deps, humanClaimInput),
    ).rejects.toMatchObject({
      code: "TOKEN_INVALID",
      // Accurate for BOTH ways of losing the CAS (concurrent claim OR a
      // concurrent resend rotation) — "already_claimed" would lie for the
      // rotation case.
      meta: { reason: "token_no_longer_active" },
    });
    expect(mocks.agreements.create).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.updateStatus).not.toHaveBeenCalled();
  });

  it("two sequential redeems by different senders: exactly one winner, loser sees TOKEN_INVALID", async () => {
    // Same single-winner guarantee end-to-end through the use case: after the
    // first claim consumes the token (hash NULLed), the second sender's
    // lookup misses. (True write-time concurrency is pinned by the adapter
    // integration test; different senders also mean different idempotency
    // keys, so no cache replay masks the loss.)
    const { deps, mocks } = buildDeps();

    const winner = await claimBookingRequest(deps, humanClaimInput);
    expect(winner.agreementId).toBe(AGREEMENT_ID);

    await expect(
      claimBookingRequest(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        rawToken: RAW_TOKEN,
        performerOwnerType: "human",
        performerOwnerId: OTHER_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    expect(mocks.agreements.create).toHaveBeenCalledTimes(1);
  });

  it("claim wins over the open-pair rule: an existing open request at the place is never consulted", async () => {
    const { deps, mocks } = buildDeps();

    const result = await claimBookingRequest(deps, humanClaimInput);

    expect(result.agreementId).toBe(AGREEMENT_ID);
    // The fake would RETURN an open row if asked — the claim must not ask.
    expect(
      mocks.bookingRequests.findOpenByPerformerAndPlace,
    ).not.toHaveBeenCalled();
  });

  it("idempotent replay by the same sender: cached result, no second Agreement, no TOKEN_INVALID", async () => {
    const { deps, mocks } = buildDeps();

    const first = await claimBookingRequest(deps, humanClaimInput);
    // The token is consumed (hash NULLed) — an id-keyed cache would be
    // unreachable here; the hash-keyed cache makes the replay a friendly
    // no-op instead of TOKEN_INVALID.
    const second = await claimBookingRequest(deps, humanClaimInput);

    expect(second).toEqual(first);
    expect(mocks.bookingRequests.claim).toHaveBeenCalledTimes(1);
    expect(mocks.agreements.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed raw token at the input boundary (no lookup)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      claimBookingRequest(deps, {
        ...humanClaimInput,
        rawToken: "too-short",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.findByClaimTokenHash).not.toHaveBeenCalled();
  });
  it("logs booking_agreement.drafted — the draft must not appear on the thread from nowhere", async () => {
    // The anonymous accept already logged `booking_request.accepted` with
    // `agreementId: null`; THIS is the moment the agreement exists. There is
    // deliberately no "claimed" kind: claiming is an identity backfill, not a
    // change to the booking's state.
    const { deps } = buildDeps();

    await claimBookingRequest(deps, humanClaimInput);

    expect(systemEntriesFor(deps.repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_agreement.drafted",
        systemData: { agreementId: AGREEMENT_ID },
        authorHumanId: ACTOR_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });
});

/**
 * The claim path mints the Agreement through the SAME shared internals as the
 * owned accept, so it must seed the header from the pitch identically — an
 * embed inquiry that named a date and a fee cannot lose them just because the
 * submitter arrived via a claim link.
 */
describe("claimBookingRequest — the mint seeds the Agreement from the pitch", () => {
  it("seeds dates, the guarantee, and the operational asks", async () => {
    const { deps, mocks } = buildDeps({
      request: buildClaimableRequest({
        preferredDates: ["2026-09-15"],
        setLengthMinutes: 45,
        lineupSize: 4,
        techNeeds: "Two vocal mics.",
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
      place: buildPlaceRecord({
        humanIdsWithAccess: [VENUE_OWNER_ID],
        defaultPrimaryPayoutTermsId: TERMS_ID,
      }),
    });

    await claimBookingRequest(deps, humanClaimInput);

    const header = mocks.agreements.create.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect((header.proposedDate as Date).toISOString()).toBe(
      "2026-09-16T00:00:00.000Z",
    );
    expect((header.proposedEndDate as Date).toISOString()).toBe(
      "2026-09-16T00:45:00.000Z",
    );
    expect(header.guaranteeCents).toBe(50_000);
    expect(header.description).toContain("- Lineup: 4 performers");
    expect(header.description).toContain("Two vocal mics.");
    // Still DRAFT + PENDING — nothing binds on one click.
    expect(header.status).toBe("DRAFT");
  });

  it("does NOT seed a guarantee from a DOOR_SPLIT ask", async () => {
    const { deps, mocks } = buildDeps({
      request: buildClaimableRequest({
        feeType: "DOOR_SPLIT",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
    });

    await claimBookingRequest(deps, humanClaimInput);

    const header = mocks.agreements.create.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(header.guaranteeCents).toBeNull();
    expect(header.description).toContain("Fee ask: door split");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The bill on claim (lineup-booking-requests v2): the inquiry's own act —
// free-text row 0, written from the form's actName — becomes the claimant's
// SELF row once the claim gives the request a sender pair.
// ─────────────────────────────────────────────────────────────────────────────

describe("claimBookingRequest — the inquiry's own act becomes SELF", () => {
  /** Swap an act store that reads the sender pair off the LIVE request row. */
  function withActs(built: ReturnType<typeof buildDeps>) {
    const acts = createFakeBookingRequestActs({
      senderOf: () => {
        const row = built.readCurrent();
        if (!row) return undefined;
        return row.performerOwnerType && row.performerOwnerId
          ? { ownerType: row.performerOwnerType, ownerId: row.performerOwnerId }
          : null;
      },
    });
    const bookingRequests = built.deps.repos.bookingRequests as unknown as Record<
      string,
      unknown
    >;
    for (const method of [
      "addActs",
      "listActsForRequests",
      "getActForOwner",
      "setActConfirmation",
      "lockBill",
      "promoteActToSelf",
    ] as const) {
      bookingRequests[method] = acts[method];
    }
    return acts;
  }

  it("row 0 (EXTERNAL) → SELF for the claimant; the extra free-text acts stay as they are", async () => {
    const built = buildDeps();
    const acts = withActs(built);
    const [own, extra] = await acts.addActs(REQUEST_ID, [
      { source: "EXTERNAL", externalName: "The Basement Tapes", sortOrder: 0 },
      {
        source: "EXTERNAL",
        externalName: "Openers",
        externalUrl: "https://openers.example",
        sortOrder: 1,
      },
    ]);

    await claimBookingRequest(built.deps, humanClaimInput);

    const bill = await acts.listActsForRequests([REQUEST_ID]);
    expect(bill).toEqual([
      expect.objectContaining({
        id: own!.id,
        source: "SELF",
        actOwnerType: "human",
        actOwnerId: ACTOR_ID,
        externalName: null,
        externalUrl: null,
        confirmation: "CONFIRMED",
        sortOrder: 0,
      }),
      expect.objectContaining({
        id: extra!.id,
        source: "EXTERNAL",
        externalName: "Openers",
        externalUrl: "https://openers.example",
      }),
    ]);
    expect(built.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.claimed",
        data: expect.objectContaining({ selfActId: own!.id }),
      }),
    );
  });

  it("an ORG claimant gets an org SELF row", async () => {
    const built = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" } as OrgMembership,
      profile: buildPerformerProfile({ ownerType: "organization", ownerId: ORG_ID }),
    });
    const acts = withActs(built);
    await acts.addActs(REQUEST_ID, [
      { source: "EXTERNAL", externalName: "The Basement Tapes", sortOrder: 0 },
    ]);

    await claimBookingRequest(built.deps, {
      ...humanClaimInput,
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
    });

    expect(await acts.listActsForRequests([REQUEST_ID])).toEqual([
      expect.objectContaining({
        source: "SELF",
        actOwnerType: "organization",
        actOwnerId: ORG_ID,
      }),
    ]);
  });

  it("a pre-bill inquiry (no act rows) converts nothing", async () => {
    const built = buildDeps();
    const acts = withActs(built);
    const promote = vi.spyOn(acts, "promoteActToSelf");
    (built.deps.repos.bookingRequests as unknown as Record<string, unknown>).promoteActToSelf =
      promote;

    await expect(claimBookingRequest(built.deps, humanClaimInput)).resolves.toMatchObject({
      bookingRequestId: REQUEST_ID,
    });
    expect(promote).not.toHaveBeenCalled();
    expect(built.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.claimed",
        data: expect.objectContaining({ selfActId: null }),
      }),
    );
  });

  it("a failed conversion rolls the whole claim back (one transaction)", async () => {
    const built = buildDeps();
    const acts = withActs(built);
    await acts.addActs(REQUEST_ID, [
      { source: "EXTERNAL", externalName: "The Basement Tapes", sortOrder: 0 },
    ]);
    (built.deps.repos.bookingRequests as unknown as Record<string, unknown>).promoteActToSelf =
      vi.fn(async () => {
        throw { code: "conflict", message: "booking_request_act_duplicate" };
      });

    await expect(claimBookingRequest(built.deps, humanClaimInput)).rejects.toBeDefined();
    // The fixture's tx restores the request snapshot on throw — unclaimed.
    expect(built.readCurrent()?.claimedAt).toBeNull();
    expect(built.mocks.agreements.create).not.toHaveBeenCalled();
  });
});
