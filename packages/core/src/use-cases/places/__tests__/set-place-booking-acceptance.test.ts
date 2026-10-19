import { describe, expect, it, vi } from "vitest";

import { setPlaceBookingAcceptance } from "../set-place-booking-acceptance";
import type { SetPlaceBookingAcceptanceDeps } from "../set-place-booking-acceptance";
import type { PlaceFlag, PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_ORG_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-06-05T12:00:00.000Z");

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
    verificationStatus: overrides.verificationStatus ?? "VERIFIED",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? [],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [DEFAULT_ACTOR_ID],
    phone: overrides.phone ?? null,
    website: overrides.website ?? null,
    listedInDirectory: overrides.listedInDirectory ?? false,
    acceptsBookingRequests: overrides.acceptsBookingRequests ?? false,
    defaultPrimaryPayoutTermsId: overrides.defaultPrimaryPayoutTermsId ?? null,
    defaultResalePayoutTermsId: overrides.defaultResalePayoutTermsId ?? null,
    createdAt: overrides.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-01T00:00:00.000Z"),
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
};

function buildDeps(options: BuildDepsOptions = {}) {
  const placesRepo = {
    getById: vi.fn(async () =>
      Object.prototype.hasOwnProperty.call(options, "placeRecord")
        ? options.placeRecord
        : buildPlaceRecord(),
    ),
    // Whole-row rebuild: must never be called by a switch flip.
    upsert: vi.fn(),
    // Stateful like the adapter's compare-and-set: `changed` only when the
    // stored row held the opposite value.
    setFlag: vi.fn(
      async (input: { placeId: string; flag: PlaceFlag; value: boolean }) => {
        const row = Object.prototype.hasOwnProperty.call(options, "placeRecord")
          ? options.placeRecord
          : buildPlaceRecord();
        return { changed: !!row && row[input.flag] !== input.value };
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

  const auditRepo = {
    log: vi.fn(async () => {}),
  };

  const txRepos = {
    places: placesRepo,
    authz: authzRepo,
    audit: auditRepo,
  };
  const tx = vi.fn(async (fn: (r: typeof txRepos) => Promise<unknown>) =>
    fn(txRepos),
  );
  // Outside the transaction the writers throw, so a write or audit that
  // escapes the tx callback fails the test instead of passing silently.
  const outsideTx = () => {
    throw new Error("written outside repos.tx");
  };
  const repos = {
    ...txRepos,
    places: { ...placesRepo, setFlag: vi.fn(outsideTx) },
    audit: { log: vi.fn(outsideTx) },
    tx,
  } as unknown as Repos;

  const deps: SetPlaceBookingAcceptanceDeps = {
    repos: repos as SetPlaceBookingAcceptanceDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks: { placesRepo, authzRepo, auditRepo, tx } };
}

describe("setPlaceBookingAcceptance", () => {
  it("enables booking acceptance on a verified place owned by the actor", async () => {
    const place = buildPlaceRecord({
      verificationStatus: "VERIFIED",
      acceptsBookingRequests: false,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(result).toEqual({
      placeId: DEFAULT_PLACE_ID,
      acceptsBookingRequests: true,
    });
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      flag: "acceptsBookingRequests",
      value: true,
    });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place",
        action: "place.booking_acceptance_enabled",
        data: expect.objectContaining({ previous: false, next: true }),
      }),
    );
  });

  it("rejects enabling on an unverified place with place_not_verified", async () => {
    const place = buildPlaceRecord({
      verificationStatus: "UNVERIFIED",
      acceptsBookingRequests: false,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    await expect(
      setPlaceBookingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_VERIFIED" });

    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("rejects a non-owner with forbidden", async () => {
    const otherHumanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const place = buildPlaceRecord({
      humanIdsWithAccess: [otherHumanId],
      orgIdsWithAccess: [],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place, membership: null });

    await expect(
      setPlaceBookingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
  });

  it("throws not_found when the place does not exist", async () => {
    const { deps } = buildDeps({ placeRecord: null });

    await expect(
      setPlaceBookingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("is idempotent: the CAS changes nothing when already enabled, but still audits", async () => {
    const place = buildPlaceRecord({
      verificationStatus: "VERIFIED",
      acceptsBookingRequests: true,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(result).toEqual({
      placeId: DEFAULT_PLACE_ID,
      acceptsBookingRequests: true,
    });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.booking_acceptance_enabled",
        data: expect.objectContaining({ previous: true, next: true }),
      }),
    );
  });

  it("disables booking acceptance (no verification gate on disable)", async () => {
    const place = buildPlaceRecord({
      verificationStatus: "UNVERIFIED",
      acceptsBookingRequests: true,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: false,
    });

    expect(result).toEqual({
      placeId: DEFAULT_PLACE_ID,
      acceptsBookingRequests: false,
    });
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      flag: "acceptsBookingRequests",
      value: false,
    });
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.booking_acceptance_disabled",
        data: expect.objectContaining({ previous: true, next: false }),
      }),
    );
  });

  it("allows an org member to toggle a place owned by their org", async () => {
    const place = buildPlaceRecord({
      verificationStatus: "VERIFIED",
      acceptsBookingRequests: false,
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const membership: OrgMembership = {
      orgId: DEFAULT_ORG_ID,
      humanId: DEFAULT_ACTOR_ID,
      role: "ADMIN",
    };
    const { deps, mocks } = buildDeps({ placeRecord: place, membership });

    const result = await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(result.acceptsBookingRequests).toBe(true);
    expect(mocks.authzRepo.getOrgMemberships).toHaveBeenCalledWith({
      orgIds: [DEFAULT_ORG_ID],
      humanId: DEFAULT_ACTOR_ID,
    });
  });

  // ── The org-role bar on the toggle ───────────────────────────────────────
  // Opening the venue to inbound booking requests commits the business to
  // answering them, so the bar is ORG_ADMIN_ROLES — not "any membership",
  // which let a door scanner flip it. Kept byte-identical in behaviour to
  // `setPlaceCommunityListingAcceptance`: the owner meets both switches on one
  // page. The EDITOR case is the deliberate policy line — loosening it must be
  // a conscious edit to this test, not a silent drift.

  const ORG_OWNED_PLACE = () =>
    buildPlaceRecord({
      verificationStatus: "VERIFIED",
      acceptsBookingRequests: false,
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });

  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`an org ${role} of an owning org may open the venue to requests`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: ORG_OWNED_PLACE(),
        membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role },
      });

      const result = await setPlaceBookingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      });

      expect(result.acceptsBookingRequests).toBe(true);
      expect(mocks.placesRepo.setFlag).toHaveBeenCalled();
    });
  }

  for (const role of ["EDITOR", "SCANNER", "VIEWER", "FINANCE"] as const) {
    it(`an org ${role} is refused — membership alone is not authority`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: ORG_OWNED_PLACE(),
        membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role },
      });

      await expect(
        setPlaceBookingAcceptance(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          accepts: true,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it(`an org ${role} cannot close the venue to requests either`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: buildPlaceRecord({
          verificationStatus: "VERIFIED",
          acceptsBookingRequests: true,
          humanIdsWithAccess: [],
          orgIdsWithAccess: [DEFAULT_ORG_ID],
        }),
        membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role },
      });

      await expect(
        setPlaceBookingAcceptance(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          accepts: false,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
    });
  }

  // ── Multi-org actors: the answer must not depend on row order ────────────
  // A place can be owned by more than one org. These pin `some` over the WHOLE
  // list: a `memberships[0]`-shaped check passes the first of these and fails
  // the second purely on the order the rows come back.

  it("a SCANNER in one owning org but OWNER in another may open the venue", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: false,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID, SECOND_ORG_ID],
      }),
      memberships: [
        { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "SCANNER" },
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "OWNER" },
      ],
    });

    const result = await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(result.acceptsBookingRequests).toBe(true);
    expect(mocks.placesRepo.setFlag).toHaveBeenCalled();
  });

  it("two non-qualifying memberships across two owning orgs are still refused", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: false,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID, SECOND_ORG_ID],
      }),
      memberships: [
        { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "SCANNER" },
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "EDITOR" },
      ],
    });

    await expect(
      setPlaceBookingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("an OWNER role in an org that does NOT own this place grants nothing", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: false,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
      memberships: [
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "OWNER" },
      ],
    });

    await expect(
      setPlaceBookingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
  });

  it("a direct human owner needs no org role at all", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: false,
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
      membership: {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "SCANNER",
      },
    });

    const result = await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(result.acceptsBookingRequests).toBe(true);
    expect(mocks.authzRepo.getOrgMemberships).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Availability-onboarding FR-003 trigger (docs/specs/2026-08-31)
// ─────────────────────────────────────────────────────────────────────────────

describe("setPlaceBookingAcceptance — availability-setup nudge trigger", () => {
  const enableInput = {
    placeId: DEFAULT_PLACE_ID,
    actorHumanId: DEFAULT_ACTOR_ID,
    accepts: true,
  };

  it("calls the hook on a real OFF→ON transition", async () => {
    const place = buildPlaceRecord({ acceptsBookingRequests: false });
    const { deps } = buildDeps({ placeRecord: place });
    const hook = vi.fn(async () => undefined);
    deps.notifyAvailabilitySetupNeeded = hook;

    await setPlaceBookingAcceptance(deps, enableInput);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
    });
  });

  it("does NOT call the hook on an idempotent ON→ON re-toggle", async () => {
    const place = buildPlaceRecord({ acceptsBookingRequests: true });
    const { deps } = buildDeps({ placeRecord: place });
    const hook = vi.fn(async () => undefined);
    deps.notifyAvailabilitySetupNeeded = hook;

    await setPlaceBookingAcceptance(deps, enableInput);

    expect(hook).not.toHaveBeenCalled();
  });

  it("does NOT call the hook when the read said OFF but the CAS changed nothing", async () => {
    // A concurrent request already turned it on: no real transition here.
    const place = buildPlaceRecord({ acceptsBookingRequests: false });
    const { deps, mocks } = buildDeps({ placeRecord: place });
    mocks.placesRepo.setFlag.mockResolvedValueOnce({ changed: false });
    const hook = vi.fn(async () => undefined);
    deps.notifyAvailabilitySetupNeeded = hook;

    await setPlaceBookingAcceptance(deps, enableInput);

    expect(hook).not.toHaveBeenCalled();
  });

  it("does NOT call the hook when disabling", async () => {
    const place = buildPlaceRecord({ acceptsBookingRequests: true });
    const { deps } = buildDeps({ placeRecord: place });
    const hook = vi.fn(async () => undefined);
    deps.notifyAvailabilitySetupNeeded = hook;

    await setPlaceBookingAcceptance(deps, {
      ...enableInput,
      accepts: false,
    });

    expect(hook).not.toHaveBeenCalled();
  });

  it("a throwing hook never fails the committed toggle (swallow + report)", async () => {
    const place = buildPlaceRecord({ acceptsBookingRequests: false });
    const { deps, mocks } = buildDeps({ placeRecord: place });
    deps.notifyAvailabilitySetupNeeded = vi.fn(async () => {
      throw new Error("notify down");
    });
    const reportError = vi.fn();
    deps.reportError = reportError;

    const result = await setPlaceBookingAcceptance(deps, enableInput);

    expect(result.acceptsBookingRequests).toBe(true);
    expect(mocks.placesRepo.setFlag).toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("even a throwing REPORTER cannot fail the toggle", async () => {
    const place = buildPlaceRecord({ acceptsBookingRequests: false });
    const { deps } = buildDeps({ placeRecord: place });
    deps.notifyAvailabilitySetupNeeded = vi.fn(async () => {
      throw new Error("notify down");
    });
    deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    await expect(
      setPlaceBookingAcceptance(deps, enableInput),
    ).resolves.toMatchObject({ acceptsBookingRequests: true });
  });
});

describe("setPlaceBookingAcceptance — one-column write (no whole-row rebuild)", () => {
  it("writes ONLY acceptsBookingRequests and never calls upsert: setFlag gets exactly {placeId, flag, value}", async () => {
    const place = {
      ...buildPlaceRecord({ acceptsBookingRequests: false }),
      addressLine1: null,
      countryCode: null,
    };
    const { deps, mocks } = buildDeps({ placeRecord: place });

    await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledTimes(1);
    const [args] = mocks.placesRepo.setFlag.mock.calls[0]!;
    expect(args).toEqual({
      placeId: DEFAULT_PLACE_ID,
      flag: "acceptsBookingRequests",
      value: true,
    });
  });

  it("writes and audits in ONE transaction", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({ acceptsBookingRequests: false }),
    });

    // Record whether each write ran INSIDE the tx callback.
    let inTx = false;
    const runTx = mocks.tx.getMockImplementation()!;
    mocks.tx.mockImplementation(async (cb) => {
      inTx = true;
      try {
        return await runTx(cb);
      } finally {
        inTx = false;
      }
    });
    const seen: Array<[string, boolean]> = [];
    mocks.placesRepo.setFlag.mockImplementationOnce(async () => {
      seen.push(["setFlag", inTx]);
      return { changed: true };
    });
    mocks.auditRepo.log.mockImplementationOnce(async () => {
      seen.push(["audit", inTx]);
    });

    await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: true,
    });

    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      ["setFlag", true],
      ["audit", true],
    ]);
  });

  it("throws PLACE_NOT_FOUND when the row is gone by the write (no audit)", async () => {
    const place = buildPlaceRecord({ acceptsBookingRequests: true });
    const { deps, mocks } = buildDeps({ placeRecord: place });
    // Deleted or merged between the read and the transaction.
    mocks.placesRepo.getById
      .mockResolvedValueOnce(place)
      .mockResolvedValueOnce(null);
    mocks.placesRepo.setFlag.mockResolvedValueOnce({ changed: false });

    await expect(
      setPlaceBookingAcceptance(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        accepts: false,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(mocks.placesRepo.getById).toHaveBeenCalledTimes(2);
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("audit previous comes from the WRITE, not a stale read", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({ acceptsBookingRequests: true }),
    });
    // Read says ON; a concurrent request already turned it OFF.
    mocks.placesRepo.setFlag.mockResolvedValueOnce({ changed: false });

    await setPlaceBookingAcceptance(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      accepts: false,
    });

    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ previous: false, next: false }),
      }),
    );
  });
});
