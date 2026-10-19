import { describe, expect, it, vi } from "vitest";

import { getDefaultPayoutTerms } from "../get-default-payout-terms";
import type { GetDefaultPayoutTermsDeps } from "../get-default-payout-terms";
import type { OrganizationRecord } from "@th/types/repos/organizations";
import type { PlaceRecord } from "@th/types/repos/places";
import type { HumanRecord } from "@th/types/repos/humans";
import type { PayoutTermsRecord } from "@th/ports/repos/payout-terms";
import type { PlaceAccessContext } from "@th/types/repos/authz";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTOR_ID = "aaaa0000-0000-4000-8000-000000000001";
const ORG_ID = "bbbb0000-0000-4000-8000-000000000002";
const PLACE_ID = "cccc0000-0000-4000-8000-000000000003";
const HUMAN_ID = ACTOR_ID; // self-access by default
const PT_PRIMARY_ID = "eeee0000-0000-4000-8000-000000000005";
const PT_RESALE_ID = "ffff0000-0000-4000-8000-000000000006";
const OTHER_HUMAN_ID = "aaaa1111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_ORG: OrganizationRecord = {
  id: ORG_ID,
  name: "Test Org",
  slug: "test-org",
  status: "ACTIVE",
  defaultLocale: null,
  defaultPrimaryPayoutTermsId: PT_PRIMARY_ID,
  defaultResalePayoutTermsId: PT_RESALE_ID,
  trustTier: "NEW",
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date(),
};

const DEFAULT_PLACE: PlaceRecord = {
  id: PLACE_ID,
  name: "Test Venue",
  slug: "test-venue",
  formattedAddress: "123 Main St",
  addressLine1: "123 Main St",
  addressLine2: null,
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  countryCode: "US",
  capacity: 500,
  lat: 30.2672,
  lng: -97.7431,
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  orgIdsWithAccess: [ORG_ID],
  humanIdsWithAccess: [],
  defaultPrimaryPayoutTermsId: PT_PRIMARY_ID,
  defaultResalePayoutTermsId: PT_RESALE_ID,
};

const DEFAULT_HUMAN: HumanRecord = {
  id: HUMAN_ID,
  name: "Pat Person",
  status: "ACTIVE",
  roles: [],
  locale: null,
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: PT_PRIMARY_ID,
  defaultResalePayoutTermsId: PT_RESALE_ID,
  trustTier: "NEW",
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date(),
};

const makePT = (
  id: string,
  kind: string = "PRIMARY_SPLIT",
): PayoutTermsRecord => ({
  id,
  kind: kind as PayoutTermsRecord["kind"],
  status: "ACTIVE",
  feeMode: null,
  feePolicyId: null,
  payoutSchedule: "WEEK_OF_EVENT",
  isDefault: false,
  settlementCurrency: "usd",
  version: 1,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
});

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeDeps(overrides?: {
  org?: OrganizationRecord | null;
  place?: PlaceRecord | null;
  human?: HumanRecord | null;
  membership?: { role: string } | null;
  placeAccessContext?: PlaceAccessContext | null;
  payoutTerms?: Map<string, PayoutTermsRecord | null>;
}) {
  const org = overrides?.org === undefined ? DEFAULT_ORG : overrides.org;
  const place =
    overrides?.place === undefined ? DEFAULT_PLACE : overrides.place;
  const human =
    overrides?.human === undefined ? DEFAULT_HUMAN : overrides.human;
  const membership =
    overrides?.membership === undefined
      ? { role: "OWNER" }
      : overrides.membership;
  const placeAccessCtx =
    overrides?.placeAccessContext === undefined
      ? { placeId: PLACE_ID, owningOrgIds: [ORG_ID], verifiedHumanOwnerIds: [] }
      : overrides.placeAccessContext;
  const ptMap =
    overrides?.payoutTerms ??
    new Map<string, PayoutTermsRecord | null>([
      [PT_PRIMARY_ID, makePT(PT_PRIMARY_ID)],
      [PT_RESALE_ID, makePT(PT_RESALE_ID, "RESALE")],
    ]);

  const mocks = {
    organizations: {
      getById: vi.fn().mockResolvedValue(org),
    },
    places: {
      getById: vi.fn().mockResolvedValue(place),
    },
    humans: {
      getById: vi.fn().mockResolvedValue(human),
    },
    payoutTerms: {
      getById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(ptMap.get(id) ?? null),
        ),
    },
    authz: {
      getOrgMembership: vi.fn().mockResolvedValue(membership),
      getPlaceAccessContext: vi.fn().mockResolvedValue(placeAccessCtx),
    },
  };

  const deps: GetDefaultPayoutTermsDeps = {
    repos: mocks as unknown as GetDefaultPayoutTermsDeps["repos"],
  };

  return { deps, mocks };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getDefaultPayoutTerms", () => {
  // =======================================================================
  // Org entity
  // =======================================================================
  describe("entity: org", () => {
    it("returns both default payout terms IDs and hydrated records", async () => {
      const { deps } = makeDeps();

      const result = await getDefaultPayoutTerms(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
      });

      expect(result).toEqual({
        defaultPrimaryPayoutTermsId: PT_PRIMARY_ID,
        defaultResalePayoutTermsId: PT_RESALE_ID,
        primaryPayoutTerms: expect.objectContaining({ id: PT_PRIMARY_ID }),
        resalePayoutTerms: expect.objectContaining({ id: PT_RESALE_ID }),
      });
    });

    it("returns nulls when org has no defaults set", async () => {
      const { deps } = makeDeps({
        org: {
          ...DEFAULT_ORG,
          defaultPrimaryPayoutTermsId: null,
          defaultResalePayoutTermsId: null,
        },
      });

      const result = await getDefaultPayoutTerms(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
      });

      expect(result).toEqual({
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: null,
        primaryPayoutTerms: null,
        resalePayoutTerms: null,
      });
    });

    it("throws not_found when org does not exist", async () => {
      const { deps } = makeDeps({ org: null });

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
          entity: { kind: "org", orgId: ORG_ID },
        }),
      ).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
    });

    it("throws forbidden when actor lacks sufficient role", async () => {
      const { deps } = makeDeps({ membership: null });

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
          entity: { kind: "org", orgId: ORG_ID },
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });

    it.each(["OWNER", "ADMIN", "EDITOR", "FINANCE"] as const)(
      "allows access with %s role",
      async (role) => {
        const { deps } = makeDeps({ membership: { role } });

        const result = await getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
          entity: { kind: "org", orgId: ORG_ID },
        });

        expect(result.defaultPrimaryPayoutTermsId).toBe(PT_PRIMARY_ID);
      },
    );

    it("rejects MEMBER role", async () => {
      const { deps } = makeDeps({ membership: { role: "MEMBER" } });

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
          entity: { kind: "org", orgId: ORG_ID },
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });
  });

  // =======================================================================
  // Place entity
  // =======================================================================
  describe("entity: place", () => {
    it("returns place-level defaults with hydrated records", async () => {
      const { deps } = makeDeps();

      const result = await getDefaultPayoutTerms(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "place", placeId: PLACE_ID },
      });

      expect(result).toEqual({
        defaultPrimaryPayoutTermsId: PT_PRIMARY_ID,
        defaultResalePayoutTermsId: PT_RESALE_ID,
        primaryPayoutTerms: expect.objectContaining({ id: PT_PRIMARY_ID }),
        resalePayoutTerms: expect.objectContaining({ id: PT_RESALE_ID }),
      });
    });

    it("throws not_found when place access context is null", async () => {
      const { deps } = makeDeps({ placeAccessContext: null });

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
          entity: { kind: "place", placeId: PLACE_ID },
        }),
      ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    });

    it("allows access via verified human ownership", async () => {
      const { deps } = makeDeps({
        membership: null,
        placeAccessContext: {
          placeId: PLACE_ID,
          owningOrgIds: [],
          verifiedHumanOwnerIds: [ACTOR_ID],
        },
      });

      const result = await getDefaultPayoutTerms(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "place", placeId: PLACE_ID },
      });

      expect(result.defaultPrimaryPayoutTermsId).toBe(PT_PRIMARY_ID);
    });

    it("throws forbidden when actor has no access to the place", async () => {
      const { deps } = makeDeps({
        membership: null,
        placeAccessContext: {
          placeId: PLACE_ID,
          owningOrgIds: [ORG_ID],
          verifiedHumanOwnerIds: [],
        },
      });

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
          entity: { kind: "place", placeId: PLACE_ID },
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });
  });

  // =======================================================================
  // Human entity
  // =======================================================================
  describe("entity: human", () => {
    it("returns human defaults when actor is self", async () => {
      const { deps } = makeDeps();

      const result = await getDefaultPayoutTerms(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "human", humanId: ACTOR_ID },
      });

      expect(result).toEqual({
        defaultPrimaryPayoutTermsId: PT_PRIMARY_ID,
        defaultResalePayoutTermsId: PT_RESALE_ID,
        primaryPayoutTerms: expect.objectContaining({ id: PT_PRIMARY_ID }),
        resalePayoutTerms: expect.objectContaining({ id: PT_RESALE_ID }),
      });
    });

    it("throws forbidden when trying to read another human's defaults", async () => {
      const { deps } = makeDeps();

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
          entity: { kind: "human", humanId: OTHER_HUMAN_ID },
        }),
      ).rejects.toMatchObject({ code: "CANNOT_READ_OTHER_HUMAN_DEFAULTS" });
    });

    it("throws not_found when human does not exist", async () => {
      const { deps } = makeDeps({ human: null });

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
          entity: { kind: "human", humanId: ACTOR_ID },
        }),
      ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
    });
  });

  // =======================================================================
  // Hydration edge cases
  // =======================================================================
  describe("hydration", () => {
    it("returns null PayoutTerms when the referenced record no longer exists", async () => {
      const { deps } = makeDeps({
        payoutTerms: new Map(), // empty — no records found
      });

      const result = await getDefaultPayoutTerms(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
      });

      // IDs are still returned, but hydrated records are null
      expect(result.defaultPrimaryPayoutTermsId).toBe(PT_PRIMARY_ID);
      expect(result.defaultResalePayoutTermsId).toBe(PT_RESALE_ID);
      expect(result.primaryPayoutTerms).toBeNull();
      expect(result.resalePayoutTerms).toBeNull();
    });

    it("does not call payoutTerms.getById when IDs are null", async () => {
      const { deps, mocks } = makeDeps({
        org: {
          ...DEFAULT_ORG,
          defaultPrimaryPayoutTermsId: null,
          defaultResalePayoutTermsId: null,
        },
      });

      await getDefaultPayoutTerms(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
      });

      expect(mocks.payoutTerms.getById).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Input validation
  // =======================================================================
  describe("input validation", () => {
    it("rejects invalid actorHumanId", async () => {
      const { deps } = makeDeps();

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: "not-a-uuid",
          entity: { kind: "org", orgId: ORG_ID },
        }),
      ).rejects.toThrow();
    });

    it("rejects missing entity", async () => {
      const { deps } = makeDeps();

      await expect(
        getDefaultPayoutTerms(deps, {
          actorHumanId: ACTOR_ID,
        }),
      ).rejects.toThrow();
    });
  });
});
