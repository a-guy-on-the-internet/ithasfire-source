import { describe, expect, it, vi } from "vitest";

import { requestClaimEmailChallenge } from "../request-claim-email-challenge";
import type { RequestClaimEmailChallengeDeps } from "../request-claim-email-challenge";

import type { PlaceRecord } from "@th/ports/repos/places";

const NOW = new Date("2026-07-05T00:00:00.000Z");
const ACTOR = "11111111-1111-4111-8111-111111111111";
const PLACE = "33333333-3333-4333-8333-333333333333";

function buildPlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE,
    name: "The Fillmore",
    slug: "the-fillmore",
    createdAt: NOW,
    updatedAt: NOW,
    formattedAddress: "1805 Geary Blvd",
    addressLine1: "1805 Geary Blvd",
    addressLine2: null,
    city: "San Francisco",
    region: "CA",
    postalCode: "94115",
    countryCode: "US",
    capacity: 1200,
    lat: null,
    lng: null,
    phone: null,
    website: "https://thefillmore.com",
    websiteSource: "USER_STUB",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    listedInDirectory: false,
    acceptsBookingRequests: false,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    ...overrides,
  } satisfies PlaceRecord;
}

function buildDeps(
  overrides: { place?: PlaceRecord; active?: unknown } = {},
) {
  const created: Record<string, unknown> = {};
  const challengeRepo = {
    getActiveForPlaceHuman: vi.fn(async () => overrides.active ?? null),
    create: vi.fn(async (input: any) => {
      created.input = input;
      return {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ...input,
        verifiedAt: null,
        attempts: 0,
        createdAt: NOW,
      };
    }),
  };
  const placesRepo = {
    getById: vi.fn(async () => overrides.place ?? buildPlace()),
  };
  const mailer = { send: vi.fn(async () => ({ result: {} })) };

  const deps = {
    repos: {
      places: placesRepo,
      placeClaimEmailChallenges: challengeRepo,
    },
    mailer,
    clock: { now: () => NOW },
  } as unknown as RequestClaimEmailChallengeDeps;

  return { deps, challengeRepo, mailer, created };
}

describe("requestClaimEmailChallenge", () => {
  it("issues a code to a matching venue-domain address and emails it", async () => {
    const { deps, challengeRepo, mailer, created } = buildDeps();
    const out = await requestClaimEmailChallenge(deps, {
      actorHumanId: ACTOR,
      placeId: PLACE,
      email: "booking@thefillmore.com",
    });
    expect(out.challengeId).toBeTruthy();
    expect(challengeRepo.create).toHaveBeenCalledOnce();
    // stored hash, never plaintext
    expect((created.input as any).codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mailer.send).toHaveBeenCalledOnce();
  });

  it("rejects a free-email address with CLAIM_FREE_EMAIL_NOT_ALLOWED", async () => {
    const { deps } = buildDeps();
    await expect(
      requestClaimEmailChallenge(deps, {
        actorHumanId: ACTOR,
        placeId: PLACE,
        email: "someone@gmail.com",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_FREE_EMAIL_NOT_ALLOWED" });
  });

  it("rejects an address not matching the venue domain", async () => {
    const { deps } = buildDeps();
    await expect(
      requestClaimEmailChallenge(deps, {
        actorHumanId: ACTOR,
        placeId: PLACE,
        email: "owner@othervenue.com",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_EMAIL_DOMAIN_MISMATCH" });
  });

  it("rejects when the place has no website", async () => {
    const { deps } = buildDeps({ place: buildPlace({ website: null }) });
    await expect(
      requestClaimEmailChallenge(deps, {
        actorHumanId: ACTOR,
        placeId: PLACE,
        email: "owner@thefillmore.com",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_PLACE_HAS_NO_WEBSITE" });
  });

  it("reuses an active challenge instead of minting a second code", async () => {
    const activeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const active = {
      id: activeId,
      expiresAt: new Date(NOW.getTime() + 30_000),
    };
    const { deps, challengeRepo } = buildDeps({ active });
    const out = await requestClaimEmailChallenge(deps, {
      actorHumanId: ACTOR,
      placeId: PLACE,
      email: "owner@thefillmore.com",
    });
    expect(out.challengeId).toBe(activeId);
    expect(challengeRepo.create).not.toHaveBeenCalled();
  });
});
