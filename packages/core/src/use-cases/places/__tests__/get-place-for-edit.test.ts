import { describe, expect, it, vi } from "vitest";

import { getPlaceForEdit } from "../get-place-for-edit";
import type { GetPlaceForEditDeps } from "../get-place-for-edit";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: overrides.id ?? DEFAULT_PLACE_ID,
    name: overrides.name ?? "Test Place",
    slug: "test-place",
    formattedAddress: overrides.formattedAddress ?? "123 Main St",
    addressLine1: overrides.addressLine1 ?? "123 Main St",
    addressLine2: overrides.addressLine2 ?? null,
    city: overrides.city ?? "City",
    region: overrides.region ?? "ST",
    postalCode: overrides.postalCode ?? "12345",
    countryCode: overrides.countryCode ?? "US",
    capacity: overrides.capacity ?? null,
    lat: overrides.lat ?? null,
    lng: overrides.lng ?? null,
    status: overrides.status ?? "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "UNVERIFIED",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? [],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [DEFAULT_ACTOR_ID],
    phone: overrides.phone ?? null,
    website: overrides.website ?? null,
    listedInDirectory: overrides.listedInDirectory ?? false,
    acceptsBookingRequests: overrides.acceptsBookingRequests ?? false,
    acceptsCommunityListings: overrides.acceptsCommunityListings ?? false,
    attendeeReviewsPublic: overrides.attendeeReviewsPublic ?? false,
    communityReviewsEnabled: overrides.communityReviewsEnabled ?? true,
    defaultPrimaryPayoutTermsId: overrides.defaultPrimaryPayoutTermsId ?? null,
    defaultResalePayoutTermsId: overrides.defaultResalePayoutTermsId ?? null,
    createdAt: overrides.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-01T00:00:00.000Z"),
  } satisfies PlaceRecord;
}

/** Minimal owner-side fixtures for the `owners` projection. */
type FakeOrg = { id: string; name: string };
type FakeHuman = { id: string; name: string | null };
type FakePage = {
  ownerType: "ORGANIZATION" | "HUMAN";
  ownerId: string;
  slug: string;
  displayName: string | null;
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
};

function buildPage(overrides: Partial<FakePage> & Pick<FakePage, "ownerType" | "ownerId">): FakePage {
  return {
    slug: "some-slug",
    displayName: null,
    visibility: "PUBLIC",
    ...overrides,
  };
}

type BuildDepsOptions = {
  placeRecord?: PlaceRecord | null;
  membership?: OrgMembership | null;
  orgs?: FakeOrg[];
  humans?: FakeHuman[];
  pages?: FakePage[];
  /** Force the owner-resolution path to blow up (swallow regression). */
  ownerLookupError?: Error;
  /** FR-007 community-listing count, or an Error to force its swallow. */
  communityListingCount?: number | Error;
  reportError?: GetPlaceForEditDeps["reportError"];
};

/** The bar `canManagePlace` enforces — see `db-authz-adapter.ts`. */
const PLACE_MANAGE_ROLES = ["OWNER", "ADMIN", "EDITOR"] as const;

function buildDeps(options: BuildDepsOptions = {}) {
  const placeValue = Object.prototype.hasOwnProperty.call(
    options,
    "placeRecord",
  )
    ? options.placeRecord
    : buildPlaceRecord();

  const placesRepo = {
    getById: vi.fn(async () => placeValue),
  };

  const membershipValue = Object.prototype.hasOwnProperty.call(
    options,
    "membership",
  )
    ? options.membership
    : ({
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "ADMIN",
      } satisfies OrgMembership);

  const authzRepo = {
    getOrgMemberships: vi.fn(async () =>
      membershipValue ? [membershipValue] : [],
    ),
  };

  /**
   * Faithful stand-in for `db-authz-adapter`'s `canManagePlace`, derived from
   * the SAME place/membership fixtures the repo fakes use: a direct human
   * owner of the place, or OWNER/ADMIN/EDITOR in an owning org. Hard-wiring
   * `allowed: true` here would make every gate assertion in this file
   * meaningless — the probe IS the gate now.
   */
  const authzPort = {
    canManagePlace: vi.fn(async () => {
      if (!placeValue) return { allowed: false };
      if (placeValue.humanIdsWithAccess.includes(DEFAULT_ACTOR_ID)) {
        return { allowed: true };
      }
      const allowed =
        membershipValue !== null &&
        membershipValue !== undefined &&
        placeValue.orgIdsWithAccess.includes(membershipValue.orgId) &&
        (PLACE_MANAGE_ROLES as readonly string[]).includes(
          membershipValue.role,
        );
      return { allowed };
    }),
  };

  // Default owner fixtures cover the ids the default place record uses, so
  // pre-existing tests keep resolving a non-empty `owners` array.
  const orgs = options.orgs ?? [{ id: DEFAULT_ORG_ID, name: "Default Org" }];
  const humans = options.humans ?? [
    { id: DEFAULT_ACTOR_ID, name: "Default Human" },
  ];
  const pages = options.pages ?? [];

  const organizationsRepo = {
    getByIds: vi.fn(async (ids: string[]) => {
      if (options.ownerLookupError) throw options.ownerLookupError;
      return orgs.filter((o) => ids.includes(o.id));
    }),
  };

  const humansRepo = {
    getByIds: vi.fn(async (ids: string[]) => {
      if (options.ownerLookupError) throw options.ownerLookupError;
      return humans.filter((h) => ids.includes(h.id));
    }),
  };

  const entityPagesRepo = {
    getByOwners: vi.fn(async (ownerType: string, ids: string[]) =>
      pages.filter((p) => p.ownerType === ownerType && ids.includes(p.ownerId)),
    ),
  };

  // FR-007: the count is a separate read with its own deliberate swallow, so
  // it gets its own knob rather than riding `ownerLookupError`.
  const eventsRepo = {
    countCommunityListingsAtPlace: vi.fn(async () => {
      const configured = options.communityListingCount;
      if (configured instanceof Error) throw configured;
      return configured ?? 0;
    }),
  };

  const repos = {
    places: placesRepo,
    authz: authzRepo,
    organizations: organizationsRepo,
    humans: humansRepo,
    entityPages: entityPagesRepo,
    events: eventsRepo,
  } as unknown as Repos;

  const deps: GetPlaceForEditDeps = {
    repos: repos as GetPlaceForEditDeps["repos"],
    authz: authzPort as unknown as GetPlaceForEditDeps["authz"],
    ...(options.reportError ? { reportError: options.reportError } : {}),
  };

  return {
    deps,
    mocks: {
      placesRepo,
      authzRepo,
      authzPort,
      organizationsRepo,
      humansRepo,
      entityPagesRepo,
      eventsRepo,
    },
  };
}

describe("getPlaceForEdit", () => {
  it("returns a place owned by the requesting human", async () => {
    const place = buildPlaceRecord({ humanIdsWithAccess: [DEFAULT_ACTOR_ID] });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await getPlaceForEdit(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.place.placeId).toBe(DEFAULT_PLACE_ID);
    expect(result.place.name).toBe("Test Place");
    expect(result.place.verificationStatus).toBe("UNVERIFIED");
    expect(mocks.placesRepo.getById).toHaveBeenCalledWith(DEFAULT_PLACE_ID);
    // No org membership check needed — direct human owner
    expect(mocks.authzRepo.getOrgMemberships).not.toHaveBeenCalled();
  });

  it("returns a place owned by an org the actor belongs to", async () => {
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const membership: OrgMembership = {
      orgId: DEFAULT_ORG_ID,
      humanId: DEFAULT_ACTOR_ID,
      role: "ADMIN",
    };
    const { deps, mocks } = buildDeps({ placeRecord: place, membership });

    const result = await getPlaceForEdit(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.place.placeId).toBe(DEFAULT_PLACE_ID);
    expect(mocks.authzRepo.getOrgMemberships).toHaveBeenCalledWith({
      orgIds: [DEFAULT_ORG_ID],
      humanId: DEFAULT_ACTOR_ID,
    });
  });

  it("throws not_found when place does not exist", async () => {
    const { deps } = buildDeps({ placeRecord: null });

    await expect(
      getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("throws forbidden when actor has no ownership", async () => {
    const otherHumanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const place = buildPlaceRecord({
      humanIdsWithAccess: [otherHumanId],
      orgIdsWithAccess: [],
    });
    const { deps } = buildDeps({ placeRecord: place, membership: null });

    await expect(
      getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws forbidden when actor is not a member of the owning org", async () => {
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const { deps } = buildDeps({ placeRecord: place, membership: null });

    await expect(
      getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The gate is `canManagePlace`, not "has a membership"
  // ───────────────────────────────────────────────────────────────────────────

  it("consults canManagePlace with the resolved place id", async () => {
    const { deps, mocks } = buildDeps();

    await getPlaceForEdit(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(mocks.authzPort.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: DEFAULT_ACTOR_ID,
      placeId: DEFAULT_PLACE_ID,
    });
  });

  it("refuses an owning org's SCANNER — membership alone is no longer the bar", async () => {
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const { deps } = buildDeps({
      placeRecord: place,
      membership: {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "SCANNER",
      },
    });

    await expect(
      getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      }),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "place" },
    });
  });

  it("allows an owning org's EDITOR", async () => {
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const { deps } = buildDeps({
      placeRecord: place,
      membership: {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "EDITOR",
      },
    });

    const result = await getPlaceForEdit(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.place.placeId).toBe(DEFAULT_PLACE_ID);
    // ...but an EDITOR still may not flip the switches. Read and write are
    // different tiers on purpose; this is the gap the field exists to show.
    expect(result.place.viewerCanManageSwitches).toBe(false);
  });

  it("does not project the address when the gate refuses", async () => {
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
      formattedAddress: "7 Private Lane",
      lat: 36.1627,
      lng: -86.7816,
    });
    const { deps, mocks } = buildDeps({
      placeRecord: place,
      membership: {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "VIEWER",
      },
    });

    await expect(
      getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    // Nothing downstream of the gate ran — no owner resolution, no counts.
    expect(mocks.organizationsRepo.getByIds).not.toHaveBeenCalled();
    expect(mocks.eventsRepo.countCommunityListingsAtPlace).not.toHaveBeenCalled();
  });

  it("returns all editable fields including address details", async () => {
    const place = buildPlaceRecord({
      name: "My Venue",
      addressLine1: "42 Park Ave",
      addressLine2: "Suite 100",
      city: "New York",
      region: "NY",
      postalCode: "10001",
      countryCode: "US",
      capacity: 500,
      lat: 40.7128,
      lng: -74.006,
    });
    const { deps } = buildDeps({ placeRecord: place });

    const result = await getPlaceForEdit(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.place).toMatchObject({
      name: "My Venue",
      addressLine1: "42 Park Ave",
      addressLine2: "Suite 100",
      city: "New York",
      region: "NY",
      postalCode: "10001",
      countryCode: "US",
      capacity: 500,
      lat: 40.7128,
      lng: -74.006,
    });
  });

  it("rejects invalid input (missing placeId)", async () => {
    const { deps } = buildDeps();

    await expect(
      getPlaceForEdit(deps, { actorHumanId: DEFAULT_ACTOR_ID }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // owners projection
  // ───────────────────────────────────────────────────────────────────────────

  describe("owners", () => {
    it("is omitted, and costs zero round-trips, when includeOwners is not requested", async () => {
      const place = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      });
      const { deps, mocks } = buildDeps({ placeRecord: place });

      // `includeOwners` omitted entirely — the schema default applies.
      const omitted = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
      });
      // ...and explicitly false.
      const explicit = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: false,
      });

      // `undefined`, NOT `[]` — "not asked for" must stay distinguishable from
      // "asked for and nothing resolved" (which is always an anomaly).
      expect(omitted.place.owners).toBeUndefined();
      expect(explicit.place.owners).toBeUndefined();
      expect("owners" in omitted.place).toBe(false);
      // The rest of the payload is unchanged for these callers.
      expect(omitted.place.access).toEqual({
        orgIds: [DEFAULT_ORG_ID],
        humanIds: [DEFAULT_ACTOR_ID],
      });
      // Zero owner-resolution round-trips across BOTH calls.
      expect(mocks.organizationsRepo.getByIds).not.toHaveBeenCalled();
      expect(mocks.humansRepo.getByIds).not.toHaveBeenCalled();
      expect(mocks.entityPagesRepo.getByOwners).not.toHaveBeenCalled();
    });

    it("resolves an org owner with its name and public page slug", async () => {
      const place = buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      });
      const { deps, mocks } = buildDeps({
        placeRecord: place,
        orgs: [{ id: DEFAULT_ORG_ID, name: "Fallback Org Name" }],
        pages: [
          buildPage({
            ownerType: "ORGANIZATION",
            ownerId: DEFAULT_ORG_ID,
            slug: "cool-org",
            displayName: "Cool Org",
            visibility: "PUBLIC",
          }),
        ],
      });

      const result = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: true,
      });

      expect(result.place.owners).toEqual([
        {
          kind: "ORGANIZATION",
          id: DEFAULT_ORG_ID,
          name: "Cool Org",
          pageSlug: "cool-org",
        },
      ]);
      // `access` is untouched — other callers depend on it.
      expect(result.place.access).toEqual({
        orgIds: [DEFAULT_ORG_ID],
        humanIds: [],
      });
      // No human-side round-trips when there are no human owners.
      expect(mocks.humansRepo.getByIds).not.toHaveBeenCalled();
      expect(mocks.organizationsRepo.getByIds).toHaveBeenCalledTimes(1);
      expect(mocks.entityPagesRepo.getByOwners).toHaveBeenCalledTimes(1);
    });

    it("resolves a human owner", async () => {
      const place = buildPlaceRecord({
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
        orgIdsWithAccess: [],
      });
      const { deps } = buildDeps({
        placeRecord: place,
        humans: [{ id: DEFAULT_ACTOR_ID, name: "Ada Lovelace" }],
        pages: [
          buildPage({
            ownerType: "HUMAN",
            ownerId: DEFAULT_ACTOR_ID,
            slug: "ada",
            visibility: "PUBLIC",
          }),
        ],
      });

      const result = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: true,
      });

      expect(result.place.owners).toEqual([
        {
          kind: "HUMAN",
          id: DEFAULT_ACTOR_ID,
          // Page has no displayName → falls back to Human.name.
          name: "Ada Lovelace",
          pageSlug: "ada",
        },
      ]);
    });

    it.each([
      ["no entity page at all", undefined],
      [
        "an UNLISTED page",
        buildPage({
          ownerType: "ORGANIZATION",
          ownerId: DEFAULT_ORG_ID,
          slug: "hidden-org",
          visibility: "UNLISTED",
        }),
      ],
      [
        "a PRIVATE page",
        buildPage({
          ownerType: "ORGANIZATION",
          ownerId: DEFAULT_ORG_ID,
          slug: "private-org",
          visibility: "PRIVATE",
        }),
      ],
      [
        "a PUBLIC but slugless page",
        buildPage({
          ownerType: "ORGANIZATION",
          ownerId: DEFAULT_ORG_ID,
          slug: "   ",
          visibility: "PUBLIC",
        }),
      ],
    ])(
      "still names an owner with %s, but returns pageSlug: null",
      async (_label, page) => {
        const place = buildPlaceRecord({
          humanIdsWithAccess: [],
          orgIdsWithAccess: [DEFAULT_ORG_ID],
        });
        const { deps } = buildDeps({
          placeRecord: place,
          orgs: [{ id: DEFAULT_ORG_ID, name: "Unlinkable Org" }],
          pages: page ? [page] : [],
        });

        const result = await getPlaceForEdit(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          includeOwners: true,
        });

        expect(result.place.owners).toEqual([
          {
            kind: "ORGANIZATION",
            id: DEFAULT_ORG_ID,
            name: "Unlinkable Org",
            pageSlug: null,
          },
        ]);
      },
    );

    it("orders orgs before humans, each sorted case-insensitively by name", async () => {
      const orgA = "44444444-4444-4444-8444-444444444444";
      const orgB = "55555555-5555-4555-8555-555555555555";
      const humanA = "66666666-6666-4666-8666-666666666666";
      const humanB = "77777777-7777-4777-8777-777777777777";

      const place = buildPlaceRecord({
        // Deliberately out of display order in the raw access arrays.
        orgIdsWithAccess: [orgB, orgA],
        humanIdsWithAccess: [humanB, humanA, DEFAULT_ACTOR_ID],
      });
      const { deps } = buildDeps({
        placeRecord: place,
        orgs: [
          { id: orgB, name: "Zeta Collective" },
          // Lowercase initial: a raw UTF-16 compare would file this AFTER
          // "Zeta Collective", which reads as unsorted to a human.
          { id: orgA, name: "alpha presents" },
        ],
        humans: [
          { id: humanB, name: "Zoe" },
          { id: humanA, name: "bea" },
          { id: DEFAULT_ACTOR_ID, name: "Ari" },
        ],
        pages: [],
      });

      const result = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: true,
      });

      expect(result.place.owners?.map((o) => [o.kind, o.name] as const)).toEqual(
        [
          ["ORGANIZATION", "alpha presents"],
          ["ORGANIZATION", "Zeta Collective"],
          ["HUMAN", "Ari"],
          ["HUMAN", "bea"],
          ["HUMAN", "Zoe"],
        ],
      );
    });

    it("skips an owner id whose row no longer exists", async () => {
      const deletedOrgId = "88888888-8888-4888-8888-888888888888";
      const place = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID, deletedOrgId],
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      });
      const reportError = vi.fn();
      const { deps } = buildDeps({
        placeRecord: place,
        // deletedOrgId intentionally absent from the org fixtures.
        orgs: [{ id: DEFAULT_ORG_ID, name: "Surviving Org" }],
        humans: [{ id: DEFAULT_ACTOR_ID, name: "Owner Human" }],
        reportError,
      });

      const result = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: true,
      });

      expect(result.place.owners?.map((o) => o.id)).toEqual([
        DEFAULT_ORG_ID,
        DEFAULT_ACTOR_ID,
      ]);
      // The raw id survives in `access` even though it has no display row.
      expect(result.place.access.orgIds).toContain(deletedOrgId);
      // A deletion is the EXPECTED cause here, so it is not an anomaly report.
      expect(reportError).not.toHaveBeenCalled();
    });

    it.each([
      ["a null Human.name", null],
      ["a whitespace-only Human.name", "   "],
    ])(
      "skips and reports a human owner with %s and no page displayName",
      async (_label, humanName) => {
        const place = buildPlaceRecord({
          orgIdsWithAccess: [],
          humanIdsWithAccess: [DEFAULT_ACTOR_ID],
        });
        const reportError = vi.fn();
        const loggerError = vi.fn();
        const { deps } = buildDeps({
          placeRecord: place,
          humans: [{ id: DEFAULT_ACTOR_ID, name: humanName }],
          pages: [
            buildPage({
              ownerType: "HUMAN",
              ownerId: DEFAULT_ACTOR_ID,
              slug: "someone",
              // Whitespace-only displayName must not count as a name either.
              displayName: "   ",
              visibility: "PUBLIC",
            }),
          ],
          reportError,
        });
        deps.logger = {
          info: vi.fn(),
          warn: vi.fn(),
          error: loggerError,
          debug: vi.fn(),
        } as unknown as GetPlaceForEditDeps["logger"];

        const result = await getPlaceForEdit(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          includeOwners: true,
        });

        // The row is skipped rather than labelled (display copy lives in the
        // UI), but under the ownership gate an empty list is an anomaly — so
        // it must be visible in Sentry, not silent.
        expect(result.place.owners).toEqual([]);
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "place_edit_owner_unnameable" }),
          expect.objectContaining({
            tags: expect.objectContaining({ useCase: "getPlaceForEdit" }),
            extra: expect.objectContaining({
              placeId: DEFAULT_PLACE_ID,
              kind: "HUMAN",
              ownerId: DEFAULT_ACTOR_ID,
            }),
          }),
        );
        expect(loggerError).toHaveBeenCalledTimes(1);
      },
    );

    it("skips and reports an org owner whose name is whitespace-only", async () => {
      const place = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        humanIdsWithAccess: [],
      });
      const reportError = vi.fn();
      const { deps } = buildDeps({
        placeRecord: place,
        orgs: [{ id: DEFAULT_ORG_ID, name: "   " }],
        reportError,
      });

      const result = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: true,
      });

      expect(result.place.owners).toEqual([]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          extra: expect.objectContaining({
            kind: "ORGANIZATION",
            ownerId: DEFAULT_ORG_ID,
          }),
        }),
      );
    });

    it("does not let a throwing reporter break the unnameable-owner skip", async () => {
      const place = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      });
      const reportError = vi.fn(() => {
        throw new Error("sentry is down");
      });
      const { deps } = buildDeps({
        placeRecord: place,
        // The org is nameless; the human is fine and must still come back.
        orgs: [{ id: DEFAULT_ORG_ID, name: "   " }],
        humans: [{ id: DEFAULT_ACTOR_ID, name: "Still Here" }],
        reportError,
      });

      const result = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: true,
      });

      // One bad row + a throwing reporter must not degrade the whole list.
      expect(result.place.owners).toEqual([
        {
          kind: "HUMAN",
          id: DEFAULT_ACTOR_ID,
          name: "Still Here",
          pageSlug: null,
        },
      ]);
    });

    it("degrades to owners: [] and reports when owner resolution throws", async () => {
      const boom = new Error("owner lookup exploded");
      const reportError = vi.fn();
      const loggerError = vi.fn();
      const place = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      });
      const { deps } = buildDeps({
        placeRecord: place,
        ownerLookupError: boom,
        reportError,
      });
      deps.logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: loggerError,
        debug: vi.fn(),
      } as unknown as GetPlaceForEditDeps["logger"];

      const result = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: true,
      });

      // The edit payload still resolves — the form does not depend on owners.
      expect(result.place.placeId).toBe(DEFAULT_PLACE_ID);
      expect(result.place.owners).toEqual([]);
      // Everything else in the payload is intact, `access` included: the UI
      // can still fall back to the raw ids.
      expect(result.place.access).toEqual({
        orgIds: [DEFAULT_ORG_ID],
        humanIds: [DEFAULT_ACTOR_ID],
      });
      expect(result.place.name).toBe("Test Place");
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: expect.objectContaining({ useCase: "getPlaceForEdit" }),
          extra: expect.objectContaining({ placeId: DEFAULT_PLACE_ID }),
        }),
      );
      // Logged at error (warn is not captured by Sentry).
      expect(loggerError).toHaveBeenCalledTimes(1);
    });

    it("is unaffected by a reporter AND a logger that themselves throw", async () => {
      const boom = new Error("owner lookup exploded");
      const reportError = vi.fn(() => {
        throw new Error("sentry is down");
      });
      const loggerError = vi.fn(() => {
        throw new Error("log transport is down");
      });
      const place = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      });
      const { deps } = buildDeps({
        placeRecord: place,
        ownerLookupError: boom,
        reportError,
      });
      deps.logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: loggerError,
        debug: vi.fn(),
      } as unknown as GetPlaceForEditDeps["logger"];

      const result = await getPlaceForEdit(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        includeOwners: true,
      });

      expect(result.place.owners).toEqual([]);
      expect(result.place.name).toBe("Test Place");
      expect(loggerError).toHaveBeenCalledTimes(1);
      // The logger threw FIRST, so the reporter never ran — the point is that
      // neither can turn a degraded read into a failed one.
      expect(reportError).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-007 — show the venue what it is being asked to accept
// (community-listings-at-claimed-venues).
// ─────────────────────────────────────────────────────────────────────────────

describe("getPlaceForEdit — community listings (FR-001 read, FR-007 count)", () => {
  it("exposes acceptsCommunityListings so the toggle and the booking toggle share one cache entry", async () => {
    const { deps } = buildDeps({
      placeRecord: buildPlaceRecord({ acceptsCommunityListings: true }),
    });

    const result = await getPlaceForEdit(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.place.acceptsCommunityListings).toBe(true);
  });

  it("counts the community listings already attached to the place", async () => {
    const { deps, mocks } = buildDeps({ communityListingCount: 3 });

    const result = await getPlaceForEdit(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.place.communityListingCount).toBe(3);
    expect(mocks.eventsRepo.countCommunityListingsAtPlace).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: DEFAULT_PLACE_ID }),
    );
  });

  it("a failed count degrades to 0 and REPORTS — it never takes the editor down", async () => {
    // Deliberate swallow per the repo's error convention: the number is
    // decorative relative to the edit form, but the failure must reach Sentry.
    const reportError = vi.fn();
    const { deps } = buildDeps({
      communityListingCount: new Error("db is down"),
      reportError,
    });

    const result = await getPlaceForEdit(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });

    expect(result.place.communityListingCount).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "countCommunityListings" }),
      }),
    );
  });

  it("is unaffected by a reporter AND a logger that themselves throw", async () => {
    // The swallow guards BOTH, the same way resolveOwnersSafe does — a
    // throwing logger is as capable of failing the read as a throwing reporter.
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const loggerError = vi.fn(() => {
      throw new Error("log transport is down");
    });
    const { deps } = buildDeps({
      communityListingCount: new Error("db is down"),
      reportError,
    });

    const result = await getPlaceForEdit(
      { ...deps, logger: { error: loggerError, info: vi.fn() } as never },
      { placeId: DEFAULT_PLACE_ID, actorHumanId: DEFAULT_ACTOR_ID },
    );

    expect(result.place.communityListingCount).toBe(0);
  });
});
