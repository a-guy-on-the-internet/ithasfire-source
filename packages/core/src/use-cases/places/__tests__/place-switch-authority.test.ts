import { describe, expect, it, vi } from "vitest";

import { getPlaceForEdit } from "../get-place-for-edit";
import type { GetPlaceForEditDeps } from "../get-place-for-edit";
import { setPlaceBookingAcceptance } from "../set-place-booking-acceptance";
import { setPlaceCommunityListingAcceptance } from "../set-place-community-listing-acceptance";
import { setPlaceAttendeeReviewsPublic } from "../set-place-attendee-reviews-public";
import { setPlaceCommunityReviewsEnabled } from "../set-place-community-reviews-enabled";
import type { OrgMembership, OrgRole } from "@th/ports/repos/authz";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { Repos } from "@th/ports/repos";

/**
 * THREE tiers, and this file pins all three against each other:
 *
 *   navigate this venue     → any org member          (`getPlaceTitle`)
 *   read/edit this page     → `canManagePlace`        (OWNER/ADMIN/EDITOR)
 *   flip the three switches → `ORG_ADMIN_ROLES`       (OWNER/ADMIN)
 *
 * The middle tier is the one that moved. This file used to assert that a
 * VIEWER could still LOAD the page — see the inverted block below for why that
 * assertion described the mechanism correctly and drew the wrong conclusion.
 *
 * The remaining gap is EDITOR: they open the page and cannot flip anything,
 * which is what `viewerCanManageSwitches` exists to show instead of making
 * them discover it through a 403 toast.
 *
 * All three are asserted together on purpose. Splitting them is how the
 * disabled state and the enforced rule drift apart.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_HUMAN_ID = "44444444-4444-4444-8444-444444444444";

/** Every org role, so a new one cannot be added without landing on a side. */
const ALLOWED_ROLES: OrgRole[] = ["OWNER", "ADMIN"];
const REFUSED_ROLES: OrgRole[] = ["EDITOR", "VIEWER", "FINANCE", "SCANNER"];

/** The READ gate — `canManagePlace` (db-authz-adapter.ts). */
const READ_ROLES: OrgRole[] = ["OWNER", "ADMIN", "EDITOR"];
const READ_REFUSED_ROLES: OrgRole[] = ["VIEWER", "FINANCE", "SCANNER"];

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
    id: PLACE_ID,
    name: "Test Place",
    slug: "test-place",
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
    status: "ACTIVE",
    // VERIFIED so the writes reach (or fail past) the ownership gate rather
    // than tripping PLACE_NOT_VERIFIED first.
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    phone: null,
    website: null,
    listedInDirectory: false,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    attendeeReviewsPublic: false,
    communityReviewsEnabled: true,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } satisfies PlaceRecord;
}

type Scenario = {
  /** Owning-org role held by the actor, or null for no membership at all. */
  role?: OrgRole | null;
  /** Actor is named directly on the place. */
  directHumanOwner?: boolean;
  /** Place is owned by an org at all. */
  orgOwned?: boolean;
};

function buildRepos(scenario: Scenario) {
  const orgOwned = scenario.orgOwned ?? true;
  const place = buildPlaceRecord({
    orgIdsWithAccess: orgOwned ? [ORG_ID] : [],
    humanIdsWithAccess: scenario.directHumanOwner
      ? [ACTOR_ID]
      : [OTHER_HUMAN_ID],
  });

  const memberships: OrgMembership[] =
    scenario.role == null
      ? []
      : [{ orgId: ORG_ID, humanId: ACTOR_ID, role: scenario.role }];

  const getOrgMemberships = vi.fn(async () => memberships);

  const repos = {
    places: {
      getById: vi.fn(async () => place),
      upsert: vi.fn(async () => place),
      setFlag: vi.fn(async () => ({ changed: true })),
      setCommunityListingAcceptance: vi.fn(async () => ({ changed: true })),
    },
    authz: { getOrgMemberships },
    audit: { log: vi.fn(async () => undefined) },
    organizations: { getByIds: vi.fn(async () => []) },
    humans: { getByIds: vi.fn(async () => []) },
    entityPages: { getByOwners: vi.fn(async () => []) },
    events: {
      countCommunityListingsAtPlace: vi.fn(async () => 0),
      // The community-listing flip enumerates (and marks) its listings.
      listPublishedByPlace: vi.fn(async () => ({ items: [] })),
    },
  } as unknown as Repos;
  withTx(repos);

  return { repos, getOrgMemberships };
}

/**
 * Faithful stand-in for `db-authz-adapter`'s `canManagePlace`, built from the
 * SAME scenario the repo fakes are: a direct human owner of the place, or
 * OWNER/ADMIN/EDITOR in an owning org. A blanket `allowed: true` would turn
 * every gate assertion below into a no-op.
 */
function buildAuthzPort(scenario: Scenario) {
  const orgOwned = scenario.orgOwned ?? true;
  const canManagePlace = vi.fn(async () => {
    if (scenario.directHumanOwner) return { allowed: true };
    if (!orgOwned || scenario.role == null) return { allowed: false };
    return { allowed: READ_ROLES.includes(scenario.role) };
  });
  return { canManagePlace };
}

function readDeps(scenario: Scenario) {
  const { repos, getOrgMemberships } = buildRepos(scenario);
  const authz = buildAuthzPort(scenario);
  return {
    deps: { repos, authz } as unknown as GetPlaceForEditDeps,
    getOrgMemberships,
    canManagePlace: authz.canManagePlace,
  };
}

function writeDeps(scenario: Scenario) {
  const { repos, getOrgMemberships } = buildRepos(scenario);
  return {
    deps: { repos, clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } },
    getOrgMemberships,
  };
}

async function readCapability(scenario: Scenario): Promise<boolean> {
  const { deps } = readDeps(scenario);
  const result = await getPlaceForEdit(deps, {
    placeId: PLACE_ID,
    actorHumanId: ACTOR_ID,
  });
  return result.place.viewerCanManageSwitches;
}

// ─────────────────────────────────────────────────────────────────────────────
// The capability
// ─────────────────────────────────────────────────────────────────────────────

describe("getPlaceForEdit → viewerCanManageSwitches", () => {
  it("is true for a direct human owner, without any membership lookup", async () => {
    const { deps, getOrgMemberships } = readDeps({
      directHumanOwner: true,
      role: null,
    });

    const result = await getPlaceForEdit(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
    });

    expect(result.place.viewerCanManageSwitches).toBe(true);
    expect(getOrgMemberships).not.toHaveBeenCalled();
  });

  for (const role of ALLOWED_ROLES) {
    it(`is true for an owning org's ${role}`, async () => {
      await expect(readCapability({ role })).resolves.toBe(true);
    });
  }

  // EDITOR is the ONLY role that reaches this field and is refused by it —
  // the whole remaining reason the field exists. VIEWER/FINANCE/SCANNER never
  // get far enough to read it; the gate block below pins that instead.
  it("is false for an owning org's EDITOR — they open the page, they cannot flip", async () => {
    await expect(readCapability({ role: "EDITOR" })).resolves.toBe(false);
  });

  it("issues exactly ONE membership lookup for the capability", async () => {
    const { deps, getOrgMemberships } = readDeps({ role: "EDITOR" });

    await getPlaceForEdit(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
    });

    expect(getOrgMemberships).toHaveBeenCalledTimes(1);
    expect(getOrgMemberships).toHaveBeenCalledWith({
      orgIds: [ORG_ID],
      humanId: ACTOR_ID,
    });
  });

  it("is false when the place is human-owned by someone else and has no orgs", async () => {
    // The read itself refuses here, so the capability is unreachable — pinned
    // via the write instead, below. This asserts the read still slams shut.
    const { deps } = readDeps({ orgOwned: false, role: null });

    await expect(
      getPlaceForEdit(deps, { placeId: PLACE_ID, actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The read gate: `canManagePlace`, one tier below the switches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INVERTED, on purpose, and kept rather than deleted.
 *
 * This block used to assert `loads the page for an owning org's VIEWER` (and
 * SCANNER, and FINANCE), added deliberately so nobody would "fix" the loose
 * gate back into line with the writes. The mechanism it described was right —
 * the read WAS looser than the writes, and that gap WAS load-bearing for the
 * disabled-switch UI. The conclusion it drew from it was wrong.
 *
 * What it missed is the PAYLOAD. `getPlaceForEdit` returns
 * `formattedAddress`, `postalCode`, `city`, `region`, the exact `lat`/`lng`
 * and the phone number. Seeing a venue's settings is not the same as being
 * allowed to see its address — and for a great many of these venues the
 * address is somebody's home. A door scanner has no business with it.
 *
 * The loose bar still exists; it just lives on `getPlaceTitle`
 * (id/name/status/verification), which is what the admin rail and the
 * `[placeId]` layout gate on, so navigation is untouched.
 */
describe("getPlaceForEdit is gated by canManagePlace", () => {
  for (const role of READ_ROLES) {
    it(`loads the page for an owning org's ${role}`, async () => {
      const { deps } = readDeps({ role });

      const result = await getPlaceForEdit(deps, {
        placeId: PLACE_ID,
        actorHumanId: ACTOR_ID,
      });

      expect(result.place.placeId).toBe(PLACE_ID);
    });
  }

  for (const role of READ_REFUSED_ROLES) {
    it(`REFUSES an owning org's ${role} — this assertion is the inversion`, async () => {
      const { deps } = readDeps({ role });

      await expect(
        getPlaceForEdit(deps, { placeId: PLACE_ID, actorHumanId: ACTOR_ID }),
      ).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "place" },
      });
    });
  }

  it("loads the page for a direct human owner", async () => {
    const { deps } = readDeps({ directHumanOwner: true, role: null });

    const result = await getPlaceForEdit(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
    });

    expect(result.place.placeId).toBe(PLACE_ID);
  });

  it("still refuses a stranger — tenancy is unchanged", async () => {
    const { deps } = readDeps({ role: null });

    await expect(
      getPlaceForEdit(deps, { placeId: PLACE_ID, actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("refuses a member of an UNRELATED org — the probe is place-scoped", async () => {
    // `orgOwned: false` means ORG_ID does not own this place, so the actor's
    // OWNER role there buys nothing here.
    const { deps } = readDeps({ orgOwned: false, role: "OWNER" });

    await expect(
      getPlaceForEdit(deps, { placeId: PLACE_ID, actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("refuses before reading anything downstream of the gate", async () => {
    const { deps } = readDeps({ role: "SCANNER" });

    await expect(
      getPlaceForEdit(deps, {
        placeId: PLACE_ID,
        actorHumanId: ACTOR_ID,
        includeOwners: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The four writes refuse exactly as before
// ─────────────────────────────────────────────────────────────────────────────

const WRITES = [
  {
    name: "setPlaceBookingAcceptance",
    run: (deps: unknown) =>
      setPlaceBookingAcceptance(
        deps as Parameters<typeof setPlaceBookingAcceptance>[0],
        { placeId: PLACE_ID, actorHumanId: ACTOR_ID, accepts: true },
      ),
  },
  {
    name: "setPlaceCommunityListingAcceptance",
    run: (deps: unknown) =>
      setPlaceCommunityListingAcceptance(
        deps as Parameters<typeof setPlaceCommunityListingAcceptance>[0],
        { placeId: PLACE_ID, actorHumanId: ACTOR_ID, accepts: true },
      ),
  },
  {
    name: "setPlaceAttendeeReviewsPublic",
    run: (deps: unknown) =>
      setPlaceAttendeeReviewsPublic(
        deps as Parameters<typeof setPlaceAttendeeReviewsPublic>[0],
        { placeId: PLACE_ID, actorHumanId: ACTOR_ID, isPublic: true },
      ),
  },
  {
    // The fourth switch (venue-track-record-and-review-switch FR-005). Flipped
    // to `false` because the fixture starts `true` and the write must reach
    // the ownership gate, not short-circuit as an idempotent no-op.
    name: "setPlaceCommunityReviewsEnabled",
    run: (deps: unknown) =>
      setPlaceCommunityReviewsEnabled(
        deps as Parameters<typeof setPlaceCommunityReviewsEnabled>[0],
        { placeId: PLACE_ID, actorHumanId: ACTOR_ID, enabled: false },
      ),
  },
] as const;

describe.each(WRITES)("$name ownership bar", ({ run }) => {
  it("allows a direct human owner without a membership lookup", async () => {
    const { deps, getOrgMemberships } = writeDeps({
      directHumanOwner: true,
      role: null,
    });

    await expect(run(deps)).resolves.toBeTruthy();
    expect(getOrgMemberships).not.toHaveBeenCalled();
  });

  for (const role of ALLOWED_ROLES) {
    it(`allows an owning org's ${role}`, async () => {
      const { deps } = writeDeps({ role });
      await expect(run(deps)).resolves.toBeTruthy();
    });
  }

  for (const role of REFUSED_ROLES) {
    it(`refuses an owning org's ${role} with NOT_RESOURCE_OWNER`, async () => {
      const { deps } = writeDeps({ role });
      await expect(run(deps)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "place" },
      });
    });
  }

  it("refuses a stranger with NOT_RESOURCE_OWNER", async () => {
    const { deps } = writeDeps({ role: null });
    await expect(run(deps)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "place" },
    });
  });

  it("refuses without a lookup when the place has no owning orgs", async () => {
    const { deps, getOrgMemberships } = writeDeps({
      orgOwned: false,
      role: null,
    });

    await expect(run(deps)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(getOrgMemberships).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two bars agree, role by role
// ─────────────────────────────────────────────────────────────────────────────

describe("capability and write agree", () => {
  for (const role of [...ALLOWED_ROLES, ...REFUSED_ROLES]) {
    it(`${role}: the read's capability predicts whether the write succeeds`, async () => {
      // A role the read now REFUSES outright can obviously not flip a switch
      // either, so a refused read reads as `false` here. That keeps the whole
      // role table in one place: every role still lands on a side, and the
      // prediction still has to hold for the roles that do reach the field.
      const capability = await readCapability({ role }).catch(() => false);

      const { deps } = writeDeps({ role });
      const wrote = await setPlaceBookingAcceptance(
        deps as Parameters<typeof setPlaceBookingAcceptance>[0],
        { placeId: PLACE_ID, actorHumanId: ACTOR_ID, accepts: true },
      ).then(
        () => true,
        () => false,
      );

      expect(capability).toBe(wrote);
    });
  }
});
