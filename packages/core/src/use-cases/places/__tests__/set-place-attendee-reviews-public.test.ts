import { describe, expect, it, vi } from "vitest";

import { setPlaceAttendeeReviewsPublic } from "../set-place-attendee-reviews-public";
import type { SetPlaceAttendeeReviewsPublicDeps } from "../set-place-attendee-reviews-public";
import type { PlaceFlag, PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_ORG_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-07-24T12:00:00.000Z");

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
    addressHash: overrides.addressHash ?? null,
    admissionTaxRateBps: overrides.admissionTaxRateBps ?? null,
    taxRateSource: overrides.taxRateSource ?? null,
    taxRateFetchedAt: overrides.taxRateFetchedAt ?? null,
    websiteSource: overrides.websiteSource ?? "UNKNOWN",
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
    attendeeReviewsPublic: overrides.attendeeReviewsPublic ?? false,
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
   * is SCANNER in one owning org and OWNER in another must be ALLOWED, and
   * the answer must not depend on row order.
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

  const auditRepo = { log: vi.fn(async () => {}) };

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

  const deps: SetPlaceAttendeeReviewsPublicDeps = {
    repos: repos as SetPlaceAttendeeReviewsPublicDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks: { placesRepo, authzRepo, auditRepo, tx } };
}

describe("setPlaceAttendeeReviewsPublic", () => {
  it("publishes the attendee aggregate on a place owned by the actor", async () => {
    const place = buildPlaceRecord({
      attendeeReviewsPublic: false,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceAttendeeReviewsPublic(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      isPublic: true,
    });

    expect(result).toEqual({
      placeId: DEFAULT_PLACE_ID,
      attendeeReviewsPublic: true,
    });
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      flag: "attendeeReviewsPublic",
      value: true,
    });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place",
        action: "place.attendee_reviews_published",
        data: expect.objectContaining({ previous: false, next: true }),
      }),
    );
  });

  it("publishes with NO verification gate (unverified place still allowed)", async () => {
    const place = buildPlaceRecord({
      verificationStatus: "UNVERIFIED",
      attendeeReviewsPublic: false,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceAttendeeReviewsPublic(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      isPublic: true,
    });

    expect(result.attendeeReviewsPublic).toBe(true);
    expect(mocks.placesRepo.setFlag).toHaveBeenCalled();
  });

  it("rejects a non-owner with NOT_RESOURCE_OWNER", async () => {
    const otherHumanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const place = buildPlaceRecord({
      humanIdsWithAccess: [otherHumanId],
      orgIdsWithAccess: [],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place, membership: null });

    await expect(
      setPlaceAttendeeReviewsPublic(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        isPublic: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("throws PLACE_NOT_FOUND when the place does not exist", async () => {
    const { deps } = buildDeps({ placeRecord: null });

    await expect(
      setPlaceAttendeeReviewsPublic(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        isPublic: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("is idempotent: the CAS changes nothing when already published, but still audits", async () => {
    const place = buildPlaceRecord({
      attendeeReviewsPublic: true,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceAttendeeReviewsPublic(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      isPublic: true,
    });

    expect(result.attendeeReviewsPublic).toBe(true);
    // The CAS still runs (the read may be stale); the fake reports no change.
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      flag: "attendeeReviewsPublic",
      value: true,
    });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.attendee_reviews_published",
        data: expect.objectContaining({ previous: true, next: true }),
      }),
    );
  });

  it("unpublishes (isPublic false) and audits the disable", async () => {
    const place = buildPlaceRecord({
      attendeeReviewsPublic: true,
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps, mocks } = buildDeps({ placeRecord: place });

    const result = await setPlaceAttendeeReviewsPublic(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      isPublic: false,
    });

    expect(result.attendeeReviewsPublic).toBe(false);
    expect(mocks.placesRepo.setFlag).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      flag: "attendeeReviewsPublic",
      value: false,
    });
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.attendee_reviews_unpublished",
        data: expect.objectContaining({ previous: true, next: false }),
      }),
    );
  });

  it("allows an org member to toggle a place owned by their org", async () => {
    const place = buildPlaceRecord({
      attendeeReviewsPublic: false,
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const membership: OrgMembership = {
      orgId: DEFAULT_ORG_ID,
      humanId: DEFAULT_ACTOR_ID,
      role: "ADMIN",
    };
    const { deps, mocks } = buildDeps({ placeRecord: place, membership });

    const result = await setPlaceAttendeeReviewsPublic(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      isPublic: true,
    });

    expect(result.attendeeReviewsPublic).toBe(true);
    expect(mocks.authzRepo.getOrgMemberships).toHaveBeenCalledWith({
      orgIds: [DEFAULT_ORG_ID],
      humanId: DEFAULT_ACTOR_ID,
    });
  });

  // ── The org-role bar on this toggle ──────────────────────────────────────
  // ORG_ADMIN_ROLES, the same bar as the two consent switches — FR-004 asks
  // for exactly that ("mirror set-place-booking-acceptance ownership check").
  // EDITOR is refused: publishing the attendee aggregate speaks for the venue,
  // and the spec calls this control owner-only. Loosening it must be a
  // conscious edit to these tests, not a silent drift.

  const ORG_OWNED_PLACE = () =>
    buildPlaceRecord({
      attendeeReviewsPublic: false,
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });

  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`an org ${role} of an owning org may publish the aggregate`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: ORG_OWNED_PLACE(),
        membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role },
      });

      const result = await setPlaceAttendeeReviewsPublic(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        isPublic: true,
      });

      expect(result.attendeeReviewsPublic).toBe(true);
      expect(mocks.placesRepo.setFlag).toHaveBeenCalled();
    });
  }

  for (const role of ["EDITOR", "SCANNER", "VIEWER", "FINANCE"] as const) {
    it(`an org ${role} is refused — membership alone is not ownership`, async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: ORG_OWNED_PLACE(),
        membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role },
      });

      await expect(
        setPlaceAttendeeReviewsPublic(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          isPublic: true,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it(`an org ${role} cannot HIDE the aggregate either`, async () => {
      // Symmetric on purpose: un-publishing erases the venue's public rating,
      // which is as much of an edit as publishing it.
      const { deps, mocks } = buildDeps({
        placeRecord: buildPlaceRecord({
          attendeeReviewsPublic: true,
          humanIdsWithAccess: [],
          orgIdsWithAccess: [DEFAULT_ORG_ID],
        }),
        membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role },
      });

      await expect(
        setPlaceAttendeeReviewsPublic(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          isPublic: false,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
    });
  }

  // ── Multi-org actors: the answer must not depend on row order ────────────

  it("a SCANNER in one owning org but OWNER in another may publish", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        attendeeReviewsPublic: false,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID, SECOND_ORG_ID],
      }),
      memberships: [
        { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "SCANNER" },
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "OWNER" },
      ],
    });

    const result = await setPlaceAttendeeReviewsPublic(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      isPublic: true,
    });

    expect(result.attendeeReviewsPublic).toBe(true);
    expect(mocks.placesRepo.setFlag).toHaveBeenCalled();
  });

  it("two non-qualifying memberships across two owning orgs are still refused", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        attendeeReviewsPublic: false,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID, SECOND_ORG_ID],
      }),
      memberships: [
        { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "SCANNER" },
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "EDITOR" },
      ],
    });

    await expect(
      setPlaceAttendeeReviewsPublic(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        isPublic: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("an OWNER role in an org that does NOT own this place grants nothing", async () => {
    // The role filter must not be allowed to paper over a missing org scope.
    const { deps, mocks } = buildDeps({
      placeRecord: ORG_OWNED_PLACE(),
      memberships: [
        { orgId: SECOND_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "OWNER" },
      ],
    });

    await expect(
      setPlaceAttendeeReviewsPublic(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        isPublic: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.placesRepo.setFlag).not.toHaveBeenCalled();
  });

  it("a direct human owner needs no org role at all", async () => {
    const { deps, mocks } = buildDeps({
      placeRecord: buildPlaceRecord({
        attendeeReviewsPublic: false,
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
      membership: {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "SCANNER",
      },
    });

    const result = await setPlaceAttendeeReviewsPublic(deps, {
      placeId: DEFAULT_PLACE_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      isPublic: true,
    });

    expect(result.attendeeReviewsPublic).toBe(true);
    expect(mocks.authzRepo.getOrgMemberships).not.toHaveBeenCalled();
  });

  describe("one-column write (no whole-row rebuild)", () => {
    it("writes ONLY attendeeReviewsPublic and never calls upsert: setFlag gets exactly {placeId, flag, value}", async () => {
      const place = buildPlaceRecord({
        attendeeReviewsPublic: false,
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      });
      // The fixture's `??` defaults would turn null into a value, so null the
      // address columns on the built record itself.
      const nullAddress = { ...place, addressLine1: null, countryCode: null };
      const { deps, mocks } = buildDeps({ placeRecord: nullAddress });

      await setPlaceAttendeeReviewsPublic(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        isPublic: true,
      });

      expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
      expect(mocks.placesRepo.setFlag).toHaveBeenCalledTimes(1);
      const [args] = mocks.placesRepo.setFlag.mock.calls[0]!;
      // Exactly these keys: nothing else from the read rides along.
      expect(args).toEqual({
        placeId: DEFAULT_PLACE_ID,
        flag: "attendeeReviewsPublic",
        value: true,
      });
    });

    it("writes and audits in ONE transaction", async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: buildPlaceRecord({ attendeeReviewsPublic: false }),
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

      await setPlaceAttendeeReviewsPublic(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        isPublic: true,
      });

      expect(mocks.tx).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([
        ["setFlag", true],
        ["audit", true],
      ]);
    });

    it("throws PLACE_NOT_FOUND when the row is gone by the write (no audit)", async () => {
      const place = buildPlaceRecord({ attendeeReviewsPublic: false });
      const { deps, mocks } = buildDeps({ placeRecord: place });
      // Deleted or merged between the read and the transaction.
      mocks.placesRepo.getById
        .mockResolvedValueOnce(place)
        .mockResolvedValueOnce(null);
      mocks.placesRepo.setFlag.mockResolvedValueOnce({ changed: false });

      await expect(
        setPlaceAttendeeReviewsPublic(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          isPublic: true,
        }),
      ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
      expect(mocks.placesRepo.getById).toHaveBeenCalledTimes(2);
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    });

    it("audit previous comes from the WRITE, not a stale read", async () => {
      // The read says false, but a concurrent request already published it:
      // the CAS reports no change, so the audit must not claim false → true.
      const { deps, mocks } = buildDeps({
        placeRecord: buildPlaceRecord({ attendeeReviewsPublic: false }),
      });
      mocks.placesRepo.setFlag.mockResolvedValueOnce({ changed: false });

      await setPlaceAttendeeReviewsPublic(deps, {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        isPublic: true,
      });

      expect(mocks.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ previous: true, next: true }),
        }),
      );
    });

    it("a failed audit fails the toggle (it runs inside the write's transaction)", async () => {
      const { deps, mocks } = buildDeps({
        placeRecord: buildPlaceRecord({ attendeeReviewsPublic: false }),
      });
      mocks.auditRepo.log.mockRejectedValueOnce(new Error("audit down"));

      await expect(
        setPlaceAttendeeReviewsPublic(deps, {
          placeId: DEFAULT_PLACE_ID,
          actorHumanId: DEFAULT_ACTOR_ID,
          isPublic: true,
        }),
      ).rejects.toThrow("audit down");
    });
  });
});
