import { describe, expect, it, vi } from "vitest";

import { updatePlaceStatus } from "../update-place-status";
import type {
  UpdatePlaceStatusDeps,
  UpdatePlaceStatusInput,
} from "../update-place-status";

import type { PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos, TxRepos } from "@th/ports/repos";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
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
    capacity: overrides.capacity ?? 1000,
    lat: overrides.lat ?? 37.123,
    lng: overrides.lng ?? -122.123,
    status: overrides.status ?? "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "UNVERIFIED",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? [],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [DEFAULT_ACTOR_ID],
  } satisfies PlaceRecord;
}

type BuildDepsOptions = {
  existingPlace?: PlaceRecord | null;
  /** The row as read under the claim lock (defaults to `existingPlace`). */
  lockedPlace?: PlaceRecord | null;
  /** The row re-read after a lost CAS (defaults to `lockedPlace`). */
  afterLostCas?: PlaceRecord | null;
  casChanged?: boolean;
  membership?: OrgMembership | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const existingPlace = Object.prototype.hasOwnProperty.call(
    options,
    "existingPlace",
  )
    ? (options.existingPlace ?? null)
    : buildPlaceRecord();

  const lockedPlace = Object.prototype.hasOwnProperty.call(
    options,
    "lockedPlace",
  )
    ? (options.lockedPlace ?? null)
    : existingPlace;
  const afterLostCas = Object.prototype.hasOwnProperty.call(
    options,
    "afterLostCas",
  )
    ? (options.afterLostCas ?? null)
    : lockedPlace;

  // Call order across the place reads and the lock, so a test can show the
  // under-lock read follows the lock.
  const calls: string[] = [];
  let reads = 0;
  const placesRepo = {
    // 1st read: before the tx; 2nd: under the lock; 3rd: after a lost CAS.
    getById: vi.fn(async () => {
      reads += 1;
      calls.push(`getById#${reads}`);
      if (reads === 1) return existingPlace;
      if (reads === 2) return lockedPlace;
      return afterLostCas;
    }),
    lockPlaceForClaim: vi.fn(async () => {
      calls.push("lockPlaceForClaim");
    }),
    compareAndSetStatus: vi.fn(async () => {
      calls.push("compareAndSetStatus");
      return { changed: options.casChanged ?? true };
    }),
    setStatus: vi.fn(),
    upsert: vi.fn(async (input) => {
      if (!existingPlace) throw new Error("missing_place");
      return {
        ...existingPlace,
        status: input.status ?? existingPlace.status,
      } satisfies PlaceRecord;
    }),
    listAccessibleByHuman: vi.fn(async () => ({
      items: [],
      pageInfo: {
        total: 0,
        count: 0,
        limit: 20,
        offset: 0,
        hasNextPage: false,
        nextOffset: null,
      },
    })),
  };

  const membershipValue = Object.prototype.hasOwnProperty.call(
    options,
    "membership",
  )
    ? (options.membership ?? null)
    : ({
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role: "ADMIN",
      } satisfies OrgMembership);

  const authzRepo = {
    getOrgMembership: vi.fn(async () => membershipValue),
    getStaffRolesForHumanId: vi.fn(async () => []),
    getEventOrgId: vi.fn(),
    getPlaceAccessContext: vi.fn(),
    isPlaceVerifiedForOrg: vi.fn(),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const searchReindexPending = { mark: vi.fn(async () => undefined) };

  const txRepos = {
    places: placesRepo,
    authz: authzRepo,
    audit: auditRepo,
    searchReindexPending,
  } as unknown as TxRepos;

  const repos = {
    places: placesRepo,
    authz: authzRepo,
    audit: auditRepo,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const idempotency = createFakeIdempotencyPort();
  const clock = { now: vi.fn(() => BASE_DATE) };
  const logger = createTestLogger();

  const deps: UpdatePlaceStatusDeps = {
    repos,
    idempotency,
    clock,
    logger,
  };

  return {
    deps,
    calls,
    mocks: { placesRepo, authzRepo, auditRepo, searchReindexPending },
  };
}

function makeInput(
  overrides: Partial<UpdatePlaceStatusInput> = {},
): UpdatePlaceStatusInput {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    placeId: DEFAULT_PLACE_ID,
    status: "ARCHIVED",
    clientKey: "place-status-key-123456",
    ...overrides,
  } satisfies UpdatePlaceStatusInput;
}

describe("updatePlaceStatus", () => {
  it("updates place status when actor is a human owner", async () => {
    const { deps, mocks } = buildDeps({
      existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
    });

    const result = await updatePlaceStatus(
      deps,
      makeInput({ status: "ARCHIVED" }),
    );

    expect(result).toEqual({ placeId: DEFAULT_PLACE_ID, status: "ARCHIVED" });
    expect(mocks.placesRepo.compareAndSetStatus).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      from: "ACTIVE",
      to: "ARCHIVED",
    });
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "status_updated" }),
    );
  });

  it("requires org membership when the actor is not a direct human owner", async () => {
    const { deps } = buildDeps({
      existingPlace: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
      membership: null,
    });

    await expect(
      updatePlaceStatus(deps, makeInput({ status: "SUSPENDED" })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("is idempotent for identical payloads", async () => {
    const { deps, mocks } = buildDeps({
      existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
    });

    const input = makeInput({ status: "SUSPENDED" });
    const first = await updatePlaceStatus(deps, input);
    const second = await updatePlaceStatus(deps, input);

    expect(first).toEqual(second);
    expect(mocks.placesRepo.compareAndSetStatus).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when status is unchanged", async () => {
    const { deps, mocks } = buildDeps({
      existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
    });

    const result = await updatePlaceStatus(
      deps,
      makeInput({ status: "ACTIVE" }),
    );

    expect(result).toEqual({ placeId: DEFAULT_PLACE_ID, status: "ACTIVE" });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.placesRepo.compareAndSetStatus).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  // The status change used to rebuild the whole row through `places.upsert`
  // from a read: name/address/pin overwritten, NULL line1 → "", NULL
  // country → "US". Now one column moves, compare-and-set.
  describe("writes status only", () => {
    it("never calls upsert or setStatus; the CAS carries no other column", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
      });

      await updatePlaceStatus(deps, makeInput({ status: "SUSPENDED" }));

      expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
      expect(mocks.placesRepo.setStatus).not.toHaveBeenCalled();
      expect(mocks.placesRepo.compareAndSetStatus).toHaveBeenCalledTimes(1);
      const [arg] = mocks.placesRepo.compareAndSetStatus.mock
        .calls[0] as unknown as [Record<string, unknown>];
      expect(Object.keys(arg).sort()).toEqual(["from", "placeId", "to"]);
    });

    it("leaves a NULL country and street line alone (nothing writes them)", async () => {
      const place = {
        ...buildPlaceRecord({ status: "ACTIVE" }),
        countryCode: null,
        addressLine1: null,
        formattedAddress: null,
      } as unknown as PlaceRecord;
      const { deps, mocks } = buildDeps({ existingPlace: place });

      await updatePlaceStatus(deps, makeInput({ status: "ARCHIVED" }));

      expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
      expect(mocks.placesRepo.compareAndSetStatus).toHaveBeenCalledWith({
        placeId: DEFAULT_PLACE_ID,
        from: "ACTIVE",
        to: "ARCHIVED",
      });
    });

    it("marks the place for search reindex and audits the under-lock `from`", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
        lockedPlace: buildPlaceRecord({ status: "SUSPENDED" }),
      });

      await updatePlaceStatus(deps, makeInput({ status: "ARCHIVED" }));

      expect(mocks.placesRepo.compareAndSetStatus).toHaveBeenCalledWith({
        placeId: DEFAULT_PLACE_ID,
        from: "SUSPENDED",
        to: "ARCHIVED",
      });
      expect(mocks.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "status_updated",
          data: expect.objectContaining({ from: "SUSPENDED", to: "ARCHIVED" }),
        }),
      );
      expect(mocks.searchReindexPending.mark).toHaveBeenCalledTimes(1);
    });
  });

  describe("claim lock", () => {
    it("takes the lock before the read the CAS is based on", async () => {
      const { deps, calls } = buildDeps({
        existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
      });

      await updatePlaceStatus(deps, makeInput({ status: "ARCHIVED" }));

      expect(calls.slice(0, 4)).toEqual([
        "getById#1",
        "lockPlaceForClaim",
        "getById#2",
        "compareAndSetStatus",
      ]);
    });

    it("re-checks ownership under the lock (access revoked while waiting)", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
        lockedPlace: buildPlaceRecord({
          status: "ACTIVE",
          humanIdsWithAccess: [],
          orgIdsWithAccess: [],
        }),
      });

      await expect(
        updatePlaceStatus(deps, makeInput({ status: "ARCHIVED" })),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.placesRepo.compareAndSetStatus).not.toHaveBeenCalled();
    });

    it("is a no-op when the place reached the target while waiting", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
        lockedPlace: buildPlaceRecord({ status: "ARCHIVED" }),
      });

      const result = await updatePlaceStatus(
        deps,
        makeInput({ status: "ARCHIVED" }),
      );

      expect(result).toEqual({ placeId: DEFAULT_PLACE_ID, status: "ARCHIVED" });
      expect(mocks.placesRepo.compareAndSetStatus).not.toHaveBeenCalled();
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
    });
  });

  describe("lost compare-and-set", () => {
    it("CONFLICT when the status moved elsewhere; no audit, no mark", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
        casChanged: false,
        afterLostCas: buildPlaceRecord({ status: "SUSPENDED" }),
      });

      await expect(
        updatePlaceStatus(deps, makeInput({ status: "ARCHIVED" })),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        meta: expect.objectContaining({ reason: "place_status_changed" }),
      });
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
    });

    it("succeeds without an audit row when the row is already at the target", async () => {
      const { deps, mocks } = buildDeps({
        existingPlace: buildPlaceRecord({ status: "ACTIVE" }),
        casChanged: false,
        afterLostCas: buildPlaceRecord({ status: "ARCHIVED" }),
      });

      const result = await updatePlaceStatus(
        deps,
        makeInput({ status: "ARCHIVED" }),
      );

      expect(result).toEqual({ placeId: DEFAULT_PLACE_ID, status: "ARCHIVED" });
      expect(mocks.auditRepo.log).not.toHaveBeenCalled();
      expect(mocks.searchReindexPending.mark).not.toHaveBeenCalled();
    });
  });
});
