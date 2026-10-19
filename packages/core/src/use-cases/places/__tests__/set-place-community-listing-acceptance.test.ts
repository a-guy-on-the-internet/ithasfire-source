import { describe, expect, it, vi } from "vitest";

import { setPlaceCommunityListingAcceptance } from "../set-place-community-listing-acceptance";
import type { SetPlaceCommunityListingAcceptanceDeps } from "../set-place-community-listing-acceptance";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// community-listings-at-claimed-venues FR-001 (the write half).
//
// Deliberately a near-copy of set-place-booking-acceptance.test.ts: the two
// toggles sit next to each other on the same admin page, so their behaviour is
// pinned the same way. Where they DIFFER is called out in the test names.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
const STRANGER_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_ORG_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-12T12:00:00.000Z");

/**
 * The write, its audit row and its search reindex mark share one
 * `repos.tx`; this fake runs the callback against the same repos.
 */
function withTx<T extends object>(repos: T): T {
  return Object.assign(repos, {
    tx: vi.fn(async (fn: (tx: T) => Promise<unknown>) => fn(repos)),
  });
}

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: DEFAULT_PLACE_ID,
    name: "Test Place",
    slug: "test-place",
    formattedAddress: "123 Main St",
    addressLine1: "123 Main St",
    addressLine2: null,
    city: "City",
    region: "ST",
    postalCode: "12345",
    countryCode: "US",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: null,
    capacity: null,
    lat: null,
    lng: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    phone: null,
    website: null,
    listedInDirectory: false,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    attendeeReviewsPublic: false,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } satisfies PlaceRecord;
}

type BuildDepsOptions = {
  placeRecord?: PlaceRecord | null;
  membership?: OrgMembership | null;
  /**
   * Multi-org actor. `membership` (singular) can only ever express ONE row,
   * which is exactly what let a `memberships[0]`-style bug hide: an actor who
   * is SCANNER in one owning org and OWNER in another must be ALLOWED, and the
   * answer must not depend on row order.
   */
  memberships?: OrgMembership[];
  /**
   * The row a concurrent writer leaves behind between the use case's read
   * and its compare-and-set (applied as the CAS runs); `null` deletes it.
   */
  rowAtWrite?: Partial<PlaceRecord> | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  // Stateful, like the table: the compare-and-set below writes into `row`,
  // and a re-read sees what it wrote.
  let row: PlaceRecord | null = Object.prototype.hasOwnProperty.call(
    options,
    "placeRecord",
  )
    ? (options.placeRecord ?? null)
    : buildPlaceRecord();
  const placesRepo = {
    getById: vi.fn(async () => (row ? { ...row } : null)),
    // A tripwire: the whole-row rebuild this use case used to do.
    upsert: vi.fn(),
    // Mirrors the adapter's `updateMany` where-clause.
    setCommunityListingAcceptance: vi.fn(
      async (input: {
        placeId: string;
        accepts: boolean;
        requireVerified?: boolean;
      }) => {
        if (Object.prototype.hasOwnProperty.call(options, "rowAtWrite")) {
          row =
            options.rowAtWrite === null || !row
              ? null
              : { ...row, ...options.rowAtWrite };
        }
        if (
          !row ||
          row.id !== input.placeId ||
          row.acceptsCommunityListings !== !input.accepts ||
          (input.requireVerified && row.verificationStatus !== "VERIFIED")
        ) {
          return { changed: false };
        }
        row = { ...row, acceptsCommunityListings: input.accepts };
        return { changed: true };
      },
    ),
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

  const membershipList: OrgMembership[] = Object.prototype.hasOwnProperty.call(
    options,
    "memberships",
  )
    ? (options.memberships ?? [])
    : membershipValue
      ? [membershipValue]
      : [];

  const authzRepo = {
    // Mirrors the real adapter's `where: { humanId, orgId: { in: orgIds } }`
    // (`packages/adapters/src/db/prisma/authz.ts`), so the mock can never be
    // more permissive than production: a membership belonging to some OTHER
    // org — or to some other human — satisfies nothing.
    getOrgMemberships: vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        membershipList.filter(
          (m) => orgIds.includes(m.orgId) && m.humanId === humanId,
        ),
    ),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const repos = withTx({
    places: placesRepo,
    authz: authzRepo,
    audit: auditRepo,
    // The flip enumerates (and marks) its community listings in its tx.
    events: { listPublishedByPlace: vi.fn(async () => ({ items: [] })) },
  }) as unknown as Repos;

  const deps: SetPlaceCommunityListingAcceptanceDeps = {
    repos: repos as SetPlaceCommunityListingAcceptanceDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks: { placesRepo, authzRepo, auditRepo } };
}

describe("setPlaceCommunityListingAcceptance", () => {
  it("enables consent on a verified place owned by the actor", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({ humanIdsWithAccess: [DEFAULT_ACTOR_ID] }),
    });

    const result = await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(result).toEqual({
      placeId: DEFAULT_PLACE_ID,
      acceptsCommunityListings: true,
    });
    expect(
      mocks.placesRepo.setCommunityListingAcceptance,
    ).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      accepts: true,
      requireVerified: true,
    });
  });

  it("writes ONLY the flag — never the whole row, so a NULL street line, country, phone or website stays as it is", async () => {
    // The whole-row upsert this replaced rebuilt name/address/pin/phone/
    // website from the read: it undid a moderator's concurrent edit and wrote
    // a NULL `addrLine1` / `country` back as "".
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        addressLine1: null,
        countryCode: null,
        phone: null,
        website: "https://venue.example",
        websiteSource: "TRUSTED_IMPORT",
      }),
    });

    await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(
      mocks.placesRepo.setCommunityListingAcceptance,
    ).toHaveBeenCalledTimes(1);
    const after = await deps.repos.places.getById(DEFAULT_PLACE_ID);
    expect(after).toMatchObject({
      acceptsCommunityListings: true,
      addressLine1: null,
      countryCode: null,
      phone: null,
      website: "https://venue.example",
      websiteSource: "TRUSTED_IMPORT",
    });
  });

  it("a moderator's name/address edit landing between the read and the write survives the flip", async () => {
    const { deps } = buildDeps({
      rowAtWrite: { name: "Renamed By Moderator", addressLine1: "9 New St" },
    });

    await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(await deps.repos.places.getById(DEFAULT_PLACE_ID)).toMatchObject({
      name: "Renamed By Moderator",
      addressLine1: "9 New St",
      acceptsCommunityListings: true,
    });
  });

  it("an enable racing a loss of verification is refused PLACE_NOT_VERIFIED — the CAS requires VERIFIED at write time", async () => {
    const { deps, mocks } = buildDeps({
      rowAtWrite: { verificationStatus: "UNVERIFIED" },
    });

    await expect(
      setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_VERIFIED" });
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    expect(
      (await deps.repos.places.getById(DEFAULT_PLACE_ID))
        ?.acceptsCommunityListings,
    ).toBe(false);
  });

  it("a flip that finds the row already at the target (a racing twin) succeeds, audits previous = next, and marks nothing", async () => {
    const { deps, mocks } = buildDeps({
      rowAtWrite: { acceptsCommunityListings: true },
    });
    const listPublishedByPlace = (deps.repos.events as unknown as {
      listPublishedByPlace: ReturnType<typeof vi.fn>;
    }).listPublishedByPlace;

    await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { previous: true, next: true, actorHumanId: DEFAULT_ACTOR_ID },
      }),
    );
    expect(listPublishedByPlace).not.toHaveBeenCalled();
  });

  it("PLACE_NOT_FOUND when the row is removed between the read and the write — never a success", async () => {
    const { deps, mocks } = buildDeps({ rowAtWrite: null });

    await expect(
      setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("disabling is allowed and writes false", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({ acceptsCommunityListings: true }),
    });

    const result = await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: false,
    });

    expect(result.acceptsCommunityListings).toBe(false);
    expect(
      mocks.placesRepo.setCommunityListingAcceptance,
    ).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      accepts: false,
      requireVerified: false,
    });
  });

  it("is idempotent: no write when already in the desired state, but still audits", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({ acceptsCommunityListings: true }),
    });

    await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.community_listing_acceptance_enabled",
        data: { previous: true, next: true, actorHumanId: DEFAULT_ACTOR_ID },
      }),
    );
  });

  it("audits the transition with previous and next", async () => {
    const { deps, mocks } = buildDeps();

    await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(mocks.auditRepo.log).toHaveBeenCalledWith({
      entity: "place",
      entityId: DEFAULT_PLACE_ID,
      action: "place.community_listing_acceptance_enabled",
      data: { previous: false, next: true, actorHumanId: DEFAULT_ACTOR_ID },
      at: NOW,
    });
  });

  it("audits a disable under its own action name", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({ acceptsCommunityListings: true }),
    });

    await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: false,
    });

    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.community_listing_acceptance_disabled",
        data: { previous: true, next: false, actorHumanId: DEFAULT_ACTOR_ID },
      }),
    );
  });

  // ── Authorization ────────────────────────────────────────────────────────

  it("PLACE_NOT_FOUND when the place row is gone", async () => {
    const { deps } = buildDeps({ placeRecord: null });
    await expect(
      setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("NOT_RESOURCE_OWNER for a stranger — and nothing is written", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
        orgIdsWithAccess: [],
      }),
    });

    await expect(
      setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: STRANGER_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("a member of an OWNING ORG may flip it", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
    });

    await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(mocks.authzRepo.getOrgMemberships).toHaveBeenCalledWith({
      orgIds: [DEFAULT_ORG_ID],
      humanId: DEFAULT_ACTOR_ID,
    });
    expect(mocks.placesRepo.setCommunityListingAcceptance).toHaveBeenCalled();
  });

  it("a NON-member of the owning org is refused", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
      membership: null,
    });

    await expect(
      setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: STRANGER_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
  });

  // ── The org-role bar on the toggle ───────────────────────────────────────
  // Granting consent retroactively confirms every ownerless COMMUNITY listing
  // at the place, and confirmed nights BLOCK the venue's own booking
  // availability. That is a decision for whoever runs the business, so the bar
  // is ORG_ADMIN_ROLES — not "any membership", which let a door scanner do it.
  // The EDITOR case is the deliberate policy line: loosening it must be a
  // conscious edit to this test, not a silent drift.

  const ORG_OWNED_PLACE = () =>
    buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });

  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`an org ${role} of an owning org may grant consent`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: ORG_OWNED_PLACE(),
        membership: {
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_ACTOR_ID,
          role,
        },
      });

      const result = await setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      });

      expect(result.acceptsCommunityListings).toBe(true);
      expect(mocks.placesRepo.setCommunityListingAcceptance).toHaveBeenCalled();
    });
  }

  for (const role of ["EDITOR", "SCANNER", "VIEWER", "FINANCE"] as const) {
    it(`an org ${role} is refused — membership alone is not consent`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: ORG_OWNED_PLACE(),
        membership: {
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_ACTOR_ID,
          role,
        },
      });

      await expect(
        setPlaceCommunityListingAcceptance(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          accepts: true,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it(`an org ${role} cannot RETRACT consent either`, async () => {
      // The bar is symmetric on purpose: a non-admin flipping the switch off
      // would un-confirm every listing the venue had already stood behind.
      const { deps, mocks } = buildDeps({
        placeRecord: buildPlaceRecord({
          humanIdsWithAccess: [],
          orgIdsWithAccess: [DEFAULT_ORG_ID],
          acceptsCommunityListings: true,
        }),
        membership: {
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_ACTOR_ID,
          role,
        },
      });

      await expect(
        setPlaceCommunityListingAcceptance(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          accepts: false,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
    });
  }

  // ── Multi-org actors: the answer must not depend on row order ────────────
  // A place can be owned by more than one org. These two pin `some` over the
  // WHOLE list: a `memberships[0]`-shaped check passes the first of these and
  // fails the second (or vice versa) purely on the order the rows come back.

  it("a SCANNER in one owning org but OWNER in another may grant consent", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID, SECOND_ORG_ID],
      }),
      memberships: [
        { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "SCANNER" },
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "OWNER" },
      ],
    });

    const result = await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(result.acceptsCommunityListings).toBe(true);
    expect(mocks.placesRepo.setCommunityListingAcceptance).toHaveBeenCalled();
  });

  it("two non-qualifying memberships across two owning orgs are still refused", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID, SECOND_ORG_ID],
      }),
      memberships: [
        { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "SCANNER" },
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "EDITOR" },
      ],
    });

    await expect(
      setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("an OWNER role in an org that does NOT own this place grants nothing", async () => {
    // The role filter must not be allowed to paper over a missing org scope.
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
      memberships: [
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "OWNER" },
      ],
    });

    await expect(
      setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
  });

  it("a direct human owner needs no org role at all", async () => {
    // The human-ownership path is untouched by the role bar: a verified owner
    // with a non-admin membership in some unrelated org still qualifies.
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
      membership: {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "SCANNER",
      },
    });

    const result = await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(result.acceptsCommunityListings).toBe(true);
    expect(mocks.authzRepo.getOrgMemberships).not.toHaveBeenCalled();
  });

  // ── The verification gate, and its deliberate asymmetry ──────────────────

  it("ENABLING on an unverified place is refused with PLACE_NOT_VERIFIED", async () => {
    // A consent is only meaningful from a verified owner: an unverified place
    // has at most a provisional claimant, and the flag would let an ownerless
    // listing speak for the venue publicly. Same gate as the booking toggle.
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({ verificationStatus: "PENDING" }),
    });

    await expect(
      setPlaceCommunityListingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_VERIFIED" });
    expect(mocks.placesRepo.setCommunityListingAcceptance).not.toHaveBeenCalled();
  });

  it("DISABLING is never gated on verification — retracting consent must always work", async () => {
    // The asymmetry is the point: a place that has since lost its verification
    // (a revoked claim, a dispute) must still be able to switch consent off.
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        verificationStatus: "UNVERIFIED",
        acceptsCommunityListings: true,
      }),
    });

    const result = await setPlaceCommunityListingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: false,
    });

    expect(result.acceptsCommunityListings).toBe(false);
    expect(
      mocks.placesRepo.setCommunityListingAcceptance,
    ).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      accepts: false,
      requireVerified: false,
    });
  });
});
