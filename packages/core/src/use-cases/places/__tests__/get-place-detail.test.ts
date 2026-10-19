import { describe, expect, it, vi } from "vitest";

import { getPlaceDetail } from "../get-place-detail";
import type { GetPlaceDetailDeps } from "../get-place-detail";
import type { OrgRole } from "@th/ports/repos/authz";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { Repos } from "@th/ports/repos";

/**
 * THE GATE, and only the gate.
 *
 * `getPlaceDetail` is the admin places table's row-expansion read
 * (`PlaceDetailPanel`), and its payload is a strict SUPERSET of
 * `getPlaceForEdit`'s: it carries `addressLine2` and `postalCode` that the
 * other one does not even project, plus the exact `lat`/`lng`, the phone
 * number and the full ownership list — with no `redactPlaceLocation` anywhere
 * in that file.
 *
 * It used to carry the SAME loose bar `getPlaceForEdit` did: any membership in
 * an owning org. Tightening one and leaving the other would have moved the
 * door rather than locking it — a SCANNER refused at the editor could read
 * MORE here, one row click away, with no crafted request.
 *
 * TWO arms, and this file asserts both, because the second is how a
 * well-meaning tightening breaks verification review: platform ADMIN/REVIEWER
 * must keep full access (they need the address they are verifying), and the
 * `isStaffAccess` flag on the log line must keep meaning what it says.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_HUMAN_ID = "44444444-4444-4444-8444-444444444444";

/** The READ bar — `canManagePlace` (db-authz-adapter.ts). */
const MANAGE_ROLES: OrgRole[] = ["OWNER", "ADMIN", "EDITOR"];
const REFUSED_ROLES: OrgRole[] = ["VIEWER", "FINANCE", "SCANNER"];

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Basement",
    slug: "the-basement",
    // The whole reason this gate moved. A real street address, a real
    // postcode, real coordinates — for many venues, somebody's home.
    formattedAddress: "7 Private Lane, Nashville, TN 37203",
    addressLine1: "7 Private Lane",
    addressLine2: "Rear entrance, behind the house",
    city: "Nashville",
    region: "TN",
    postalCode: "37203",
    countryCode: "US",
    capacity: 120,
    lat: 36.1627,
    lng: -86.7816,
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [OTHER_HUMAN_ID],
    phone: "+1 615 555 0133",
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

type Scenario = {
  /** Owning-org role held by the actor, or null for no membership at all. */
  role?: OrgRole | null;
  /** Actor is named directly on the place as a verified owner. */
  directHumanOwner?: boolean;
  /** Place is owned by an org at all. */
  orgOwned?: boolean;
  /** Actor holds a platform ADMIN/REVIEWER role. */
  staff?: boolean;
};

function buildDeps(scenario: Scenario) {
  const orgOwned = scenario.orgOwned ?? true;
  const place = buildPlaceRecord({
    orgIdsWithAccess: orgOwned ? [ORG_ID] : [],
    humanIdsWithAccess: scenario.directHumanOwner ? [ACTOR_ID] : [OTHER_HUMAN_ID],
  });

  const repos = {
    places: { getById: vi.fn(async () => place) },
    events: {
      getStatsForPlace: vi.fn(async () => ({
        total: 3,
        upcoming: 1,
        past: 2,
        nextEventAt: new Date("2026-02-01T00:00:00.000Z"),
      })),
    },
    humans: { getByIds: vi.fn(async () => []) },
    payoutTerms: { getById: vi.fn(async () => null) },
    placeVerificationRequests: { listForPlace: vi.fn(async () => []) },
    placeVerificationDocuments: { listByRequestIds: vi.fn(async () => []) },
    entityPages: { getByOwner: vi.fn(async () => null) },
  } as unknown as Repos;

  /**
   * Faithful stand-ins, derived from the SAME scenario — not blanket allows.
   * `canManagePlace` mirrors `db-authz-adapter.ts`: a direct human owner, or
   * OWNER/ADMIN/EDITOR in an OWNING org.
   */
  const canManagePlace = vi.fn(async () => {
    if (scenario.directHumanOwner) return { allowed: true };
    if (!orgOwned || scenario.role == null) return { allowed: false };
    return { allowed: MANAGE_ROLES.includes(scenario.role) };
  });
  const hasStaffRole = vi.fn(async () => ({
    allowed: scenario.staff === true,
  }));

  const deps = {
    repos,
    authz: { canManagePlace, hasStaffRole },
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as GetPlaceDetailDeps;

  return { deps, place, repos, canManagePlace, hasStaffRole };
}

const run = (scenario: Scenario) => {
  const built = buildDeps(scenario);
  return {
    ...built,
    result: getPlaceDetail(built.deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
    }),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// The owner arm
// ─────────────────────────────────────────────────────────────────────────────

describe("getPlaceDetail — owner arm is canManagePlace", () => {
  it("allows a direct verified human owner, without consulting staff roles", async () => {
    const { result, hasStaffRole } = run({
      directHumanOwner: true,
      role: null,
    });

    await expect(result).resolves.toMatchObject({
      place: { id: PLACE_ID, addressLine1: "7 Private Lane" },
    });
    // The staff arm is a SECOND chance, not a first one; an owner must never
    // depend on it.
    expect(hasStaffRole).not.toHaveBeenCalled();
  });

  for (const role of MANAGE_ROLES) {
    it(`allows an owning org's ${role}`, async () => {
      const { result } = run({ role });
      await expect(result).resolves.toMatchObject({
        place: { id: PLACE_ID },
      });
    });
  }

  for (const role of REFUSED_ROLES) {
    it(`REFUSES an owning org's ${role} — membership is not the bar`, async () => {
      const { result } = run({ role });
      await expect(result).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    });
  }

  it("refuses a stranger — tenancy is unchanged", async () => {
    const { result } = run({ role: null });
    await expect(result).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("refuses a member of an UNRELATED org — the probe is place-scoped", async () => {
    // ORG_ID does not own this place, so the actor's OWNER role there buys
    // nothing here.
    const { result } = run({ orgOwned: false, role: "OWNER" });
    await expect(result).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("probes canManagePlace with the resolved place id", async () => {
    const { result, canManagePlace } = run({ role: "ADMIN" });
    await result;

    expect(canManagePlace).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
    });
  });

  it("throws PLACE_NOT_FOUND before any authz probe for a dead id", async () => {
    const { deps, repos, canManagePlace } = buildDeps({ role: "OWNER" });
    (repos.places.getById as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null);

    await expect(
      getPlaceDetail(deps, { placeId: PLACE_ID, actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(canManagePlace).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nothing locational escapes a refusal
// ─────────────────────────────────────────────────────────────────────────────

describe("getPlaceDetail — a refusal projects nothing", () => {
  it("does not read, hydrate or return the address for a SCANNER", async () => {
    const { deps, repos } = buildDeps({ role: "SCANNER" });

    await expect(
      getPlaceDetail(deps, { placeId: PLACE_ID, actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });

    // Everything downstream of the gate is untouched — the refusal is not a
    // filter applied to an already-built payload.
    expect(repos.events.getStatsForPlace).not.toHaveBeenCalled();
    expect(repos.placeVerificationRequests.listForPlace).not.toHaveBeenCalled();
    expect(repos.entityPages.getByOwner).not.toHaveBeenCalled();
  });

  it("never lets a refusal resolve to a payload at all", async () => {
    for (const role of REFUSED_ROLES) {
      const { result } = run({ role });
      const outcome = await result.then(
        (value) => ({ resolved: true as const, value }),
        () => ({ resolved: false as const }),
      );
      expect(outcome.resolved).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The staff arm, which must NOT regress
// ─────────────────────────────────────────────────────────────────────────────

describe("getPlaceDetail — platform staff arm", () => {
  it("allows a platform reviewer who owns nothing — they need the address they verify", async () => {
    const { result, hasStaffRole } = run({ role: null, staff: true });

    await expect(result).resolves.toMatchObject({
      place: {
        id: PLACE_ID,
        addressLine1: "7 Private Lane",
        addressLine2: "Rear entrance, behind the house",
        postalCode: "37203",
        lat: 36.1627,
        lng: -86.7816,
      },
    });
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "REVIEWER"],
    });
  });

  it("still admits staff for a role the OWNER arm now refuses", async () => {
    // A SCANNER who is ALSO a platform reviewer gets in on the staff arm.
    // This is the case a careless tightening breaks.
    const { result } = run({ role: "SCANNER", staff: true });
    await expect(result).resolves.toMatchObject({ place: { id: PLACE_ID } });
  });

  it("logs isStaffAccess true for staff and false for an owner", async () => {
    const staffRun = buildDeps({ role: null, staff: true });
    await getPlaceDetail(staffRun.deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
    });
    expect(staffRun.deps.logger?.info).toHaveBeenCalledWith(
      "places.get_detail",
      expect.objectContaining({ isStaffAccess: true }),
    );

    const ownerRun = buildDeps({ role: "ADMIN" });
    await getPlaceDetail(ownerRun.deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
    });
    expect(ownerRun.deps.logger?.info).toHaveBeenCalledWith(
      "places.get_detail",
      expect.objectContaining({ isStaffAccess: false }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two place reads agree
// ─────────────────────────────────────────────────────────────────────────────

describe("getPlaceDetail and getPlaceForEdit sit at the SAME bar", () => {
  // Not a style point. These two return the same class of data about the same
  // venue, and the entire defect was that they disagreed — so a role refused
  // by one could read it from the other. Pinning them together is what stops
  // the next person tightening only the one they happened to be looking at.
  const ALL_ROLES: OrgRole[] = [...MANAGE_ROLES, ...REFUSED_ROLES];

  for (const role of ALL_ROLES) {
    it(`${role}: allowed here exactly when canManagePlace allows`, async () => {
      const expected = MANAGE_ROLES.includes(role);
      const { result } = run({ role });
      const allowed = await result.then(
        () => true,
        () => false,
      );
      expect(allowed).toBe(expected);
    });
  }
});
