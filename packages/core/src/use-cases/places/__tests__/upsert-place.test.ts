import { describe, expect, it, vi } from "vitest";

import { upsertPlace } from "../upsert-place";
import type { UpsertPlaceDeps, UpsertPlaceInput } from "../upsert-place";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { OrgMembership } from "@th/ports/repos/authz";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PLACE_ID = "33333333-3333-4333-8333-333333333333";

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: overrides.id ?? DEFAULT_PLACE_ID,
    name: overrides.name ?? "Test Place",
    formattedAddress: overrides.formattedAddress ?? "123 Main St",
    addressLine1: overrides.addressLine1 ?? "123 Main St",
    addressLine2: overrides.addressLine2 ?? null,
    city: overrides.city ?? "City",
    region: overrides.region ?? "ST",
    postalCode: overrides.postalCode ?? "12345",
    countryCode: overrides.countryCode ?? "US",
    addressHash:
      overrides.addressHash ??
      (overrides.formattedAddress ?? "123 Main St").toLowerCase(),
    admissionTaxRateBps: overrides.admissionTaxRateBps ?? null,
    taxRateSource: overrides.taxRateSource ?? null,
    taxRateFetchedAt: overrides.taxRateFetchedAt ?? null,
    capacity: overrides.capacity ?? null,
    lat: overrides.lat ?? null,
    lng: overrides.lng ?? null,
    status: overrides.status ?? "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "UNVERIFIED",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? [],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [DEFAULT_ACTOR_ID],
    defaultPrimaryPayoutTermsId: overrides.defaultPrimaryPayoutTermsId ?? null,
    defaultResalePayoutTermsId: overrides.defaultResalePayoutTermsId ?? null,
    locationMode: overrides.locationMode ?? "EXACT",
    locationRadiusMeters: overrides.locationRadiusMeters ?? null,
    locationLabel: overrides.locationLabel ?? null,
    createdAt: overrides.createdAt ?? BASE_DATE,
    updatedAt: overrides.updatedAt ?? BASE_DATE,
  } satisfies PlaceRecord;
}

type FakeTaxRateLookup = {
  lookupByPostalCode: ReturnType<typeof vi.fn>;
};

type BuildDepsOptions = {
  existingPlace?: PlaceRecord | null;
  placeResult?: PlaceRecord;
  humanRecord?: HumanRecord | null;
  membership?: OrgMembership | null;
  taxRateLookup?: FakeTaxRateLookup | null;
  timezoneLookup?: ((lat: number, lng: number) => string | null) | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const placeResult = options.placeResult ?? buildPlaceRecord();
  let lastUpsert: PlaceRecord = placeResult;
  const placesRepo = {
    getById: vi.fn(async () =>
      Object.prototype.hasOwnProperty.call(options, "existingPlace")
        ? (options.existingPlace ?? null)
        : null,
    ),
    // Mirror the adapter: persist the input's address fields and derive
    // addressHash from the formatted address (lowercased) so an address change
    // produces a different hash than the existing place.
    upsert: vi.fn(
      async (input: {
        address: {
          formatted: string;
          postalCode?: string | null;
          countryCode: string;
        };
      }) => {
        lastUpsert = buildPlaceRecord({
          ...placeResult,
          formattedAddress: input.address.formatted,
          addressHash: input.address.formatted.trim().toLowerCase(),
          postalCode: input.address.postalCode ?? null,
          countryCode: input.address.countryCode,
        });
        return lastUpsert;
      },
    ),
    updateTaxRate: vi.fn(async () => undefined),
    updateTimezone: vi.fn(async () => undefined),
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
    // ── TRIPWIRES, not contract ──────────────────────────────────────────
    // `PlacesRepo` no longer declares any of these: `Place.slug` is deprecated
    // and `upsertPlace` mints none. They are kept here, WORKING (each returns
    // what the real adapter used to), so that reintroducing the mint would
    // succeed at runtime and be caught by the explicit assertion below rather
    // than by an incidental TypeError. Deleting them would turn that gate into
    // "the fake happens to lack the method", which is not a gate.
    getSlugContext: vi.fn(async () => ({
      placeId: placeResult.id,
      name: placeResult.name,
      countryCode: placeResult.countryCode,
      region: placeResult.region,
      city: placeResult.city,
    })),
    assignSlug: vi.fn(async () => ({
      ...buildPlaceRecord({
        ...placeResult,
        formattedAddress: lastUpsert.formattedAddress,
        addressHash: lastUpsert.addressHash,
        postalCode: lastUpsert.postalCode,
        countryCode: lastUpsert.countryCode,
      }),
      // The multi-segment shape the removed `generatePlaceSlug` produced.
      // Present so a reverted mint reaches `recordSlugHistory` and the audit
      // log too, instead of stopping at a falsy `finalRecord.slug`.
      slug: `us/st/test-place--${(placeResult.id ?? DEFAULT_PLACE_ID).replace(/-/g, "").slice(0, 10)}`,
    })),
    recordSlugHistory: vi.fn(async () => undefined),
    getBySlug: vi.fn(async () => null),
    resolveBySlug: vi.fn(async () => null),
  };

  const defaultHuman: HumanRecord = {
    id: DEFAULT_ACTOR_ID,
    name: null,
    status: "ACTIVE",
    roles: ["USER"],
    locale: null,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    trustTier: "NEW",
    trustBadgeLabel: null,
    trustBadgeIcon: null,
    createdAt: new Date(),
  };

  const humansRepo = {
    getById: vi.fn(async () =>
      Object.prototype.hasOwnProperty.call(options, "humanRecord")
        ? (options.humanRecord ?? null)
        : defaultHuman,
    ),
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

  const entityPagesRepo = {
    upsert: vi.fn(
      async (input: {
        ownerType: string;
        ownerId: string;
        slug: string;
        displayName: string;
      }) => ({
        id: "page-1",
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        slug: input.slug,
        displayName: input.displayName,
        bio: null,
        avatarUrl: null,
        bannerUrl: null,
        visibility: "PUBLIC",
      }),
    ),
  };

  const spacesFake = createFakeSpacesRepo();
  const calendarsFake = createFakeCalendarsRepo({ spaces: spacesFake });

  // Place-address-withholding D1: an UPDATE takes the place-location lock
  // and may re-project the venue's events (covered in
  // `upsert-place-event-location-cascade.test.ts`).
  const eventsRepo = {
    lockLocationsAtPlace: vi.fn(async () => undefined),
    reprojectLocationForPlace: vi.fn(async () => [] as string[]),
    followPlaceAddress: vi.fn(async () => ({
      followedIds: [] as string[],
      skippedIds: [] as string[],
    })),
  };

  const txRepos = {
    places: placesRepo,
    audit: auditRepo,
    entityPages: entityPagesRepo,
    spaces: spacesFake,
    calendars: calendarsFake,
    events: eventsRepo,
  } as unknown as TxRepos;

  const repos = {
    places: placesRepo,
    humans: humansRepo,
    authz: authzRepo,
    audit: auditRepo,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const idempotency = createFakeIdempotencyPort();
  const clock = { now: vi.fn(() => BASE_DATE) };
  const logger = createTestLogger();

  const taxRateLookup = Object.prototype.hasOwnProperty.call(
    options,
    "taxRateLookup",
  )
    ? options.taxRateLookup
    : ({
        lookupByPostalCode: vi.fn(async () => ({
          rateBps: 875,
          source: "ziptax",
        })),
      } satisfies FakeTaxRateLookup);

  const timezoneLookup = Object.prototype.hasOwnProperty.call(
    options,
    "timezoneLookup",
  )
    ? options.timezoneLookup
    : vi.fn(() => "America/Los_Angeles");
  const reportError = vi.fn();

  const deps: UpsertPlaceDeps = {
    repos,
    idempotency,
    clock,
    logger,
    taxRateLookup: taxRateLookup ?? null,
    timezoneLookup: timezoneLookup ?? null,
    reportError,
  };

  return {
    deps,
    mocks: {
      placesRepo,
      humansRepo,
      authzRepo,
      auditRepo,
      entityPagesRepo,
      repos,
      idempotency,
      taxRateLookup,
      timezoneLookup,
      reportError,
      spacesFake,
      calendarsFake,
    },
  };
}

function makeInput(
  overrides: Partial<UpsertPlaceInput> = {},
): UpsertPlaceInput {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    owner: overrides.owner ?? { kind: "human", humanId: DEFAULT_ACTOR_ID },
    name: overrides.name ?? "My Venue",
    address: overrides.address ?? {
      formatted: "123 Main St, City, ST",
      line1: "123 Main St",
      city: "City",
      region: "ST",
      postalCode: "12345",
      countryCode: "US",
      lat: 37.123,
      lng: -122.123,
    },
    capacity: overrides.capacity ?? 1000,
    clientKey: overrides.clientKey ?? "place-key-123456",
    placeId: overrides.placeId,
  } satisfies UpsertPlaceInput;
}

describe("upsertPlace", () => {
  it("creates a place for the actor human", async () => {
    const { deps, mocks } = buildDeps();

    const result = await upsertPlace(deps, makeInput());

    expect(result.placeId).toBe(DEFAULT_PLACE_ID);
    expect(mocks.placesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { kind: "human", humanId: DEFAULT_ACTOR_ID },
      }),
    );
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "place", action: "created" }),
    );
  });

  // ── Addressless places (place-editor spec, Part A "TBD" sentinel fix) ────
  //
  // `line1` used to be `.min(1)`, which made a place without a street address
  // UNSAVEABLE through this use case even though `Place.addrLine1` is nullable
  // and the repo-level upsert has always been called with `""` (the
  // review-flow stub-place path). The admin editor worked around it by sending
  // the literal string "TBD", which then persisted and rendered on the public
  // venue page. These pin the honest behaviour so nobody re-tightens it.
  describe("addressless places", () => {
    it("saves a place with no street address at all", async () => {
      const { deps, mocks } = buildDeps();

      await upsertPlace(
        deps,
        makeInput({
          address: {
            formatted: "Nashville, TN, US",
            city: "Nashville",
            region: "TN",
            countryCode: "US",
          },
        }),
      );

      expect(mocks.placesRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          address: expect.objectContaining({
            // Normalised to "", never a sentinel — every downstream read is a
            // `filter(Boolean)` join or an `addressLine1 && …` guard.
            line1: "",
            city: "Nashville",
          }),
        }),
      );
    });

    it("accepts an explicitly empty line1 without rejecting the save", async () => {
      const { deps, mocks } = buildDeps();

      await upsertPlace(
        deps,
        makeInput({
          address: {
            formatted: "Nashville, TN, US",
            line1: "   ",
            city: "Nashville",
            countryCode: "US",
          },
        }),
      );

      expect(mocks.placesRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          address: expect.objectContaining({ line1: "" }),
        }),
      );
    });

    it("still requires a non-empty formatted address", async () => {
      const { deps } = buildDeps();

      // `formatted` stays `.min(1)`: an address may have no STREET, but it
      // must still say something, and `addressHash` is derived from it.
      await expect(
        upsertPlace(
          deps,
          makeInput({
            address: {
              formatted: "",
              city: "Nashville",
              countryCode: "US",
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  it("requires the actor to match the human owner", async () => {
    const { deps } = buildDeps();

    await expect(
      upsertPlace(
        deps,
        makeInput({
          owner: {
            kind: "human",
            humanId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("requires membership for org-owned places", async () => {
    const { deps } = buildDeps({ membership: null });

    await expect(
      upsertPlace(
        deps,
        makeInput({ owner: { kind: "org", orgId: DEFAULT_ORG_ID } }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("updates an existing place when actor owner matches", async () => {
    const existing = buildPlaceRecord({ orgIdsWithAccess: [DEFAULT_ORG_ID] });
    const { deps, mocks } = buildDeps({ existingPlace: existing });

    await upsertPlace(
      deps,
      makeInput({
        owner: { kind: "org", orgId: DEFAULT_ORG_ID },
        placeId: DEFAULT_PLACE_ID,
      }),
    );

    expect(mocks.placesRepo.getById).toHaveBeenCalledWith(DEFAULT_PLACE_ID);
    expect(mocks.placesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: DEFAULT_PLACE_ID }),
    );
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "updated",
        entityId: DEFAULT_PLACE_ID,
      }),
    );
  });

  it("replays identical payloads via idempotency", async () => {
    const { deps, mocks } = buildDeps();

    const input = makeInput();
    const first = await upsertPlace(deps, input);
    const second = await upsertPlace(deps, input);

    expect(first).toEqual(second);
    expect(mocks.placesRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("auto-creates an EntityPage for a new place", async () => {
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, makeInput({ name: "The Grand Ballroom" }));

    expect(mocks.entityPagesRepo.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.entityPagesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "PLACE",
        ownerId: DEFAULT_PLACE_ID,
        slug: expect.stringContaining("the-grand-ballroom"),
        displayName: "The Grand Ballroom",
      }),
    );
  });

  // REGRESSION PIN for the `buildPageSlug` extraction out of this file into
  // `_shared/page-slug.ts`. The literal is hardcoded ON PURPOSE — computing it
  // by calling `buildPageSlug` would make this test agree with whatever the
  // helper does, including a change that silently re-slugs every existing
  // venue's public URL. `33333333-3333-4333-8333-333333333333` → the first 8
  // hex chars with dashes stripped are `33333333`.
  it("mints the EXACT page slug it did before buildPageSlug moved — {name}-{id8}, flat", async () => {
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, makeInput({ name: "The Grand Ballroom" }));

    const [pageInput] = mocks.entityPagesRepo.upsert.mock.calls[0] as [
      { slug: string },
    ];
    expect(pageInput.slug).toBe("the-grand-ballroom-33333333");
    // Single URL segment — `/places/[slug]` is not a catch-all.
    expect(pageInput.slug).not.toContain("/");
  });

  // ── STEP-2 GATE: `Place.slug` is never minted ────────────────────────────
  // A place carries ONE addressable slug, its `EntityPage.slug` (asserted
  // above). `Place.slug` was a second, multi-segment DIRECTORY key
  // (`us/tn/name--shortid`) that no route ever resolved, because `/places/
  // [slug]` and `/p/[slug]` are single non-catch-all segments. It is
  // deprecated and the column is being dropped.
  //
  // The fake's `getSlugContext` / `assignSlug` / `recordSlugHistory` are live
  // and would work if called — see the tripwire note in `buildDeps` — so
  // restoring the mint makes THIS assertion fail, not some unrelated crash.
  it("mints NO Place.slug — on create or on a name/address change", async () => {
    const created = buildDeps();
    await upsertPlace(created.deps, makeInput({ name: "The Grand Ballroom" }));

    expect(created.mocks.placesRepo.getSlugContext).not.toHaveBeenCalled();
    expect(created.mocks.placesRepo.assignSlug).not.toHaveBeenCalled();
    expect(created.mocks.placesRepo.recordSlugHistory).not.toHaveBeenCalled();

    // The rename+move case, which is what used to REgenerate the slug.
    const existing = buildPlaceRecord({
      orgIdsWithAccess: [DEFAULT_ORG_ID],
      name: "Old Name",
      city: "Old City",
      formattedAddress: "1 Old Rd, City, ST",
      addressHash: "1 old rd, city, st",
    });
    const updated = buildDeps({ existingPlace: existing });
    await upsertPlace(
      updated.deps,
      makeInput({
        owner: { kind: "org", orgId: DEFAULT_ORG_ID },
        placeId: DEFAULT_PLACE_ID,
        name: "Brand New Name",
        address: {
          formatted: "999 New Ave, Other City, ST",
          line1: "999 New Ave",
          city: "Other City",
          region: "ST",
          postalCode: "54321",
          countryCode: "US",
        },
      }),
    );

    expect(updated.mocks.placesRepo.getSlugContext).not.toHaveBeenCalled();
    expect(updated.mocks.placesRepo.assignSlug).not.toHaveBeenCalled();
    expect(updated.mocks.placesRepo.recordSlugHistory).not.toHaveBeenCalled();

    // ...and no audit entry claims one was assigned.
    const actions = updated.mocks.auditRepo.log.mock.calls.map(
      (call) => (call[0] as { action: string }).action,
    );
    expect(actions).not.toContain("place.slug_assigned");
    expect(actions).not.toContain("place.slug_updated");
  });

  it("does not auto-create an EntityPage when updating an existing place", async () => {
    const existing = buildPlaceRecord({ orgIdsWithAccess: [DEFAULT_ORG_ID] });
    const { deps, mocks } = buildDeps({ existingPlace: existing });

    await upsertPlace(
      deps,
      makeInput({
        owner: { kind: "org", orgId: DEFAULT_ORG_ID },
        placeId: DEFAULT_PLACE_ID,
      }),
    );

    expect(mocks.entityPagesRepo.upsert).not.toHaveBeenCalled();
  });

  describe("admission tax-rate lookup", () => {
    it("looks up and caches the tax rate when creating a place", async () => {
      const { deps, mocks } = buildDeps();

      await upsertPlace(deps, makeInput());

      expect(mocks.taxRateLookup?.lookupByPostalCode).toHaveBeenCalledWith({
        postalCode: "12345",
        countryCode: "US",
      });
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith({
        id: DEFAULT_PLACE_ID,
        admissionTaxRateBps: 875,
        taxRateSource: "ziptax",
        taxRateFetchedAt: BASE_DATE,
      });
    });

    it("does NOT look up the tax rate when the address is unchanged", async () => {
      // Existing place whose addressHash matches the input's formatted address
      // (lowercased) so the use case detects no change.
      const existing = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "123 Main St, City, ST",
        addressHash: "123 main st, city, st",
      });
      const { deps, mocks } = buildDeps({ existingPlace: existing });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "123 Main St, City, ST",
            line1: "123 Main St",
            city: "City",
            region: "ST",
            postalCode: "12345",
            countryCode: "US",
          },
        }),
      );

      expect(mocks.taxRateLookup?.lookupByPostalCode).not.toHaveBeenCalled();
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
    });

    it("looks up the tax rate when the address changes", async () => {
      const existing = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "1 Old Rd, City, ST",
        addressHash: "1 old rd, city, st",
      });
      const { deps, mocks } = buildDeps({ existingPlace: existing });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "999 New Ave, City, ST",
            line1: "999 New Ave",
            city: "City",
            region: "ST",
            postalCode: "54321",
            countryCode: "US",
          },
        }),
      );

      expect(mocks.taxRateLookup?.lookupByPostalCode).toHaveBeenCalledWith({
        postalCode: "54321",
        countryCode: "US",
      });
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledTimes(1);
    });

    it("still saves the place when the tax lookup throws", async () => {
      const taxRateLookup = {
        lookupByPostalCode: vi.fn(async () => {
          throw new Error("ziptax 500");
        }),
      };
      const { deps, mocks } = buildDeps({ taxRateLookup });

      const result = await upsertPlace(deps, makeInput());

      // Place is persisted...
      expect(result.placeId).toBe(DEFAULT_PLACE_ID);
      expect(mocks.placesRepo.upsert).toHaveBeenCalledTimes(1);
      // ...but no rate is cached (left null → checkout falls back to zero tax).
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
    });

    it("skips the lookup when no tax provider is configured", async () => {
      const { deps, mocks } = buildDeps({ taxRateLookup: null });

      const result = await upsertPlace(deps, makeInput());

      expect(result.placeId).toBe(DEFAULT_PLACE_ID);
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
    });

    it("calls the provider BEFORE the transaction opens, and writes the rate inside it", async () => {
      // The provider is a live HTTP call (ZipTax, 5s timeout). Inside the tx
      // it would hold the EXCLUSIVE place-location lock and a pooled
      // connection across the round trip.
      const order: string[] = [];
      const taxRateLookup = {
        lookupByPostalCode: vi.fn(async () => {
          order.push("lookup");
          return { rateBps: 925, source: "ziptax" };
        }),
      };
      const existing = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "1 Old Rd, City, ST",
        addressHash: "1 old rd, city, st",
      });
      const { deps, mocks } = buildDeps({
        existingPlace: existing,
        taxRateLookup,
      });
      const innerTx = mocks.repos.tx as unknown as ReturnType<typeof vi.fn>;
      const runTx = innerTx.getMockImplementation()!;
      innerTx.mockImplementation(async (fn: (tx: TxRepos) => Promise<unknown>) => {
        order.push("tx:begin");
        const out = await runTx(fn);
        order.push("tx:end");
        return out;
      });
      mocks.placesRepo.updateTaxRate.mockImplementation(async () => {
        order.push("updateTaxRate");
      });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "999 New Ave, City, ST",
            line1: "999 New Ave",
            city: "City",
            region: "ST",
            postalCode: "54321",
            countryCode: "US",
          },
        }),
      );

      expect(order).toEqual(["lookup", "tx:begin", "updateTaxRate", "tx:end"]);
      expect(taxRateLookup.lookupByPostalCode).toHaveBeenCalledWith({
        postalCode: "54321",
        countryCode: "US",
      });
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith({
        id: DEFAULT_PLACE_ID,
        admissionTaxRateBps: 925,
        taxRateSource: "ziptax",
        taxRateFetchedAt: BASE_DATE,
      });
    });

    it("does NOT write a rate looked up for a different postal code than the row written — reports the drift instead", async () => {
      // Defensive guard: if the adapter ever normalises the address so the
      // written postal code/country differ from what core looked up, the
      // rate belongs to another jurisdiction and must not be cached.
      const { deps, mocks } = buildDeps();
      mocks.placesRepo.upsert.mockImplementationOnce(async () =>
        buildPlaceRecord({
          formattedAddress: "123 Main St, City, ST",
          addressHash: "123 main st, city, st",
          postalCode: "99999",
          countryCode: "US",
        }),
      );

      const result = await upsertPlace(deps, makeInput());

      expect(result.placeId).toBe(DEFAULT_PLACE_ID);
      expect(mocks.taxRateLookup?.lookupByPostalCode).toHaveBeenCalledWith({
        postalCode: "12345",
        countryCode: "US",
      });
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "upsertPlace", stage: "tax_rate_address_mismatch" },
        }),
      );
    });

    it("still saves when the address-mismatch reporter THROWS (guarded swallow)", async () => {
      const { deps, mocks } = buildDeps();
      mocks.reportError.mockImplementation(() => {
        throw new Error("sentry down");
      });
      mocks.placesRepo.upsert.mockImplementationOnce(async () =>
        buildPlaceRecord({
          formattedAddress: "123 Main St, City, ST",
          addressHash: "123 main st, city, st",
          postalCode: "99999",
          countryCode: "US",
        }),
      );

      await expect(upsertPlace(deps, makeInput())).resolves.toMatchObject({
        placeId: DEFAULT_PLACE_ID,
      });
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "upsertPlace", stage: "tax_rate_address_mismatch" },
        }),
      );
    });

    it("reports a throwing provider and still saves without a rate", async () => {
      const taxRateLookup = {
        lookupByPostalCode: vi.fn(async () => {
          throw new Error("ziptax 500");
        }),
      };
      const { deps, mocks } = buildDeps({ taxRateLookup });

      const result = await upsertPlace(deps, makeInput());

      expect(result.placeId).toBe(DEFAULT_PLACE_ID);
      expect(mocks.repos.tx).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "ziptax 500" }),
        expect.objectContaining({
          tags: { useCase: "lookupAdmissionTaxRate" },
        }),
      );
    });

    it("does not spend a lookup on a request the owner check rejects", async () => {
      const { deps, mocks } = buildDeps({ membership: null });

      await expect(
        upsertPlace(
          deps,
          makeInput({ owner: { kind: "org", orgId: DEFAULT_ORG_ID } }),
        ),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

      expect(mocks.taxRateLookup?.lookupByPostalCode).not.toHaveBeenCalled();
    });
  });

  // Owner ruling 2026-10-03: a venue that MOVES and gets no rate for its new
  // address has its old rate CLEARED (a NULL cache is a miss that event save /
  // checkout retry), never kept beside the new postcode.
  describe("admission tax-rate cache on an address change", () => {
    const OLD_RATE = {
      admissionTaxRateBps: 950,
      taxRateSource: "ziptax",
      taxRateFetchedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const NEW_ADDRESS = {
      formatted: "999 New Ave, City, ST",
      line1: "999 New Ave",
      city: "City",
      region: "ST",
      postalCode: "54321",
      countryCode: "US",
    };
    const CLEARED = {
      id: DEFAULT_PLACE_ID,
      admissionTaxRateBps: null,
      taxRateSource: null,
      taxRateFetchedAt: null,
    };

    function movedVenue(taxRateLookup?: FakeTaxRateLookup | null) {
      const existing = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "1 Old Rd, City, ST",
        addressHash: "1 old rd, city, st",
        postalCode: "12345",
        ...OLD_RATE,
      });
      return buildDeps({
        existingPlace: existing,
        ...(taxRateLookup !== undefined ? { taxRateLookup } : {}),
      });
    }

    // `upsertPlace` logs through `deps.logger.child({ useCase })`.
    const scopedInfo = (deps: UpsertPlaceDeps) =>
      (
        (deps.logger!.child as ReturnType<typeof vi.fn>).mock.results[0]!
          .value as { info: ReturnType<typeof vi.fn> }
      ).info;

    // `getById` answers `preTx` until the transaction opens and `underLock`
    // inside it — keyed on tx entry, not on call order, so an extra read
    // before the tx cannot shift which record the lock-time re-read sees.
    function readsUnderLock(
      mocks: ReturnType<typeof buildDeps>["mocks"],
      preTx: PlaceRecord,
      underLock: PlaceRecord,
    ) {
      let inTx = false;
      const innerTx = mocks.repos.tx as unknown as ReturnType<typeof vi.fn>;
      const runTx = innerTx.getMockImplementation()!;
      innerTx.mockImplementation(
        async (fn: (tx: TxRepos) => Promise<unknown>) => {
          inTx = true;
          try {
            return await runTx(fn);
          } finally {
            inTx = false;
          }
        },
      );
      mocks.placesRepo.getById.mockImplementation(async () =>
        inTx ? underLock : preTx,
      );
    }

    const moveInput = () =>
      makeInput({
        owner: { kind: "org", orgId: DEFAULT_ORG_ID },
        placeId: DEFAULT_PLACE_ID,
        address: NEW_ADDRESS,
      });

    it("clears the old rate when the new address's lookup misses", async () => {
      const { deps, mocks } = movedVenue({
        lookupByPostalCode: vi.fn(async () => null),
      });

      await upsertPlace(deps, moveInput());

      expect(mocks.taxRateLookup?.lookupByPostalCode).toHaveBeenCalledWith({
        postalCode: "54321",
        countryCode: "US",
      });
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith(CLEARED);
      expect(scopedInfo(deps)).toHaveBeenCalledWith(
        "tax_rate_cleared_on_address_change",
        expect.objectContaining({
          placeId: DEFAULT_PLACE_ID,
          previousRateBps: 950,
          previousPostalCode: "12345",
          postalCode: "54321",
        }),
      );
    });

    it("clears the old rate when the provider throws", async () => {
      const { deps, mocks } = movedVenue({
        lookupByPostalCode: vi.fn(async () => {
          throw new Error("ziptax 500");
        }),
      });

      const result = await upsertPlace(deps, moveInput());

      expect(result.placeId).toBe(DEFAULT_PLACE_ID);
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith(CLEARED);
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "ziptax 500" }),
        expect.objectContaining({
          tags: { useCase: "lookupAdmissionTaxRate" },
        }),
      );
    });

    it("clears the old rate when no tax provider is configured", async () => {
      const { deps, mocks } = movedVenue(null);

      await upsertPlace(deps, moveInput());

      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith(CLEARED);
    });

    it("clears the old rate when the address-mismatch guard drops the looked-up rate", async () => {
      const { deps, mocks } = movedVenue();
      mocks.placesRepo.upsert.mockImplementationOnce(async () =>
        buildPlaceRecord({
          formattedAddress: NEW_ADDRESS.formatted,
          addressHash: NEW_ADDRESS.formatted.toLowerCase(),
          postalCode: "99999",
          countryCode: "US",
          ...OLD_RATE,
        }),
      );

      await upsertPlace(deps, moveInput());

      // The 54321 rate was looked up but not written (drift reported)...
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "upsertPlace", stage: "tax_rate_address_mismatch" },
        }),
      );
      // ...and the old 12345 rate is cleared, not left beside 99999.
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith(CLEARED);
    });

    it("writes the new rate (and does not clear) when the lookup succeeds", async () => {
      const { deps, mocks } = movedVenue();

      await upsertPlace(deps, moveInput());

      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith({
        id: DEFAULT_PLACE_ID,
        admissionTaxRateBps: 875,
        taxRateSource: "ziptax",
        taxRateFetchedAt: BASE_DATE,
      });
      expect(scopedInfo(deps)).not.toHaveBeenCalledWith(
        "tax_rate_cleared_on_address_change",
        expect.anything(),
      );
    });

    it("keeps the old rate untouched when the address is unchanged", async () => {
      const existing = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "123 Main St, City, ST",
        addressHash: "123 main st, city, st",
        ...OLD_RATE,
      });
      const { deps, mocks } = buildDeps({
        existingPlace: existing,
        taxRateLookup: { lookupByPostalCode: vi.fn(async () => null) },
      });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "123 Main St, City, ST",
            line1: "123 Main St",
            city: "City",
            region: "ST",
            postalCode: "12345",
            countryCode: "US",
          },
        }),
      );

      expect(mocks.taxRateLookup?.lookupByPostalCode).not.toHaveBeenCalled();
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
    });

    it("clears when a concurrent edit moved the venue between the pre-tx read and the lock", async () => {
      // existingPlace (pre-tx) says 123 Main St, so this save — which also
      // writes 123 Main St — attempts no lookup. But under the lock the row
      // reads as 1 Old Rd with ITS rate: writing 123 Main St back is a move,
      // and that rate must not survive beside it.
      const preTx = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "123 Main St, City, ST",
        addressHash: "123 main st, city, st",
      });
      const underLock = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "1 Old Rd, City, ST",
        addressHash: "1 old rd, city, st",
        postalCode: "54321",
        ...OLD_RATE,
      });
      const { deps, mocks } = buildDeps({ existingPlace: preTx });
      readsUnderLock(mocks, preTx, underLock);

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
        }),
      );

      expect(mocks.taxRateLookup?.lookupByPostalCode).not.toHaveBeenCalled();
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith(CLEARED);
    });

    it("keeps a rate a concurrent edit already cached for the SAME postcode this save writes, when this save's lookup misses", async () => {
      // Pre-tx the row was at 1 Old Rd / 12345, so this save looks up 54321
      // (and misses). Under the lock a concurrent edit has already moved it
      // to 999 New Ave / 54321 and cached 54321's rate: that rate is for the
      // jurisdiction this save writes, so it stays.
      const preTx = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "1 Old Rd, City, ST",
        addressHash: "1 old rd, city, st",
        postalCode: "12345",
        ...OLD_RATE,
      });
      const underLock = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: NEW_ADDRESS.formatted,
        addressHash: NEW_ADDRESS.formatted.toLowerCase(),
        postalCode: "54321",
        admissionTaxRateBps: 700,
        taxRateSource: "ziptax",
        taxRateFetchedAt: BASE_DATE,
      });
      const { deps, mocks } = buildDeps({
        existingPlace: preTx,
        taxRateLookup: { lookupByPostalCode: vi.fn(async () => null) },
      });
      readsUnderLock(mocks, preTx, underLock);

      await upsertPlace(deps, moveInput());

      expect(mocks.taxRateLookup?.lookupByPostalCode).toHaveBeenCalledWith({
        postalCode: "54321",
        countryCode: "US",
      });
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
    });

    it("clears the old rate when the venue moves to an address with NO postcode", async () => {
      const { deps, mocks } = movedVenue();
      // Spread, not an override: `buildPlaceRecord` maps a null postcode
      // back to its "12345" default.
      mocks.placesRepo.upsert.mockImplementationOnce(async () => ({
        ...buildPlaceRecord({
          formattedAddress: "Somewhere, City, ST",
          addressHash: "somewhere, city, st",
          ...OLD_RATE,
        }),
        postalCode: null,
      }));

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "Somewhere, City, ST",
            line1: "",
            city: "City",
            region: "ST",
            countryCode: "US",
          },
        }),
      );

      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith(CLEARED);
    });

    it("keeps the rate on a street-text-only edit with the same postcode, even when that save's lookup throws", async () => {
      const { deps, mocks } = movedVenue({
        lookupByPostalCode: vi.fn(async () => {
          throw new Error("ziptax 500");
        }),
      });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "1 Old Road, City, ST",
            line1: "1 Old Road",
            city: "City",
            region: "ST",
            postalCode: "12345",
            countryCode: "US",
          },
        }),
      );

      // The text changed, so a lookup was attempted (and its throw reported)...
      expect(mocks.taxRateLookup?.lookupByPostalCode).toHaveBeenCalledWith({
        postalCode: "12345",
        countryCode: "US",
      });
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "ziptax 500" }),
        expect.objectContaining({
          tags: { useCase: "lookupAdmissionTaxRate" },
        }),
      );
      // ...but 12345's rate is still 12345's rate: nothing is written.
      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
    });

    it("looks up on a postcode change under identical address text, and clears on a miss", async () => {
      const existing = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "123 Main St, City, ST",
        addressHash: "123 main st, city, st",
        postalCode: "12345",
        ...OLD_RATE,
      });
      const { deps, mocks } = buildDeps({
        existingPlace: existing,
        taxRateLookup: { lookupByPostalCode: vi.fn(async () => null) },
      });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "123 Main St, City, ST",
            line1: "123 Main St",
            city: "City",
            region: "ST",
            postalCode: "54321",
            countryCode: "US",
          },
        }),
      );

      expect(mocks.taxRateLookup?.lookupByPostalCode).toHaveBeenCalledWith({
        postalCode: "54321",
        countryCode: "US",
      });
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTaxRate).toHaveBeenCalledWith(CLEARED);
    });

    it("writes nothing to the rate on CREATE when the lookup misses", async () => {
      const { deps, mocks } = buildDeps({
        taxRateLookup: { lookupByPostalCode: vi.fn(async () => null) },
      });

      await upsertPlace(deps, makeInput());

      expect(mocks.placesRepo.updateTaxRate).not.toHaveBeenCalled();
    });
  });

  describe("timezone derivation (venue-hierarchy FR-004)", () => {
    it("derives and persists the timezone from lat/lng on create", async () => {
      const { deps, mocks } = buildDeps();

      await upsertPlace(deps, makeInput());

      expect(mocks.timezoneLookup).toHaveBeenCalledWith(37.123, -122.123);
      expect(mocks.placesRepo.updateTimezone).toHaveBeenCalledWith({
        id: DEFAULT_PLACE_ID,
        timezone: "America/Los_Angeles",
      });
    });

    it("recomputes the timezone when the address changes", async () => {
      const existing = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "1 Old Rd, City, ST",
        addressHash: "1 old rd, city, st",
      });
      const { deps, mocks } = buildDeps({ existingPlace: existing });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "999 New Ave, City, ST",
            line1: "999 New Ave",
            city: "City",
            region: "ST",
            postalCode: "54321",
            countryCode: "US",
            lat: 36.16,
            lng: -86.78,
          },
        }),
      );

      expect(mocks.timezoneLookup).toHaveBeenCalledWith(36.16, -86.78);
      expect(mocks.placesRepo.updateTimezone).toHaveBeenCalledTimes(1);
    });

    it("does NOT recompute when the address is unchanged", async () => {
      const existing = buildPlaceRecord({
        orgIdsWithAccess: [DEFAULT_ORG_ID],
        formattedAddress: "123 Main St, City, ST",
        addressHash: "123 main st, city, st",
      });
      const { deps, mocks } = buildDeps({ existingPlace: existing });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
          address: {
            formatted: "123 Main St, City, ST",
            line1: "123 Main St",
            city: "City",
            region: "ST",
            postalCode: "12345",
            countryCode: "US",
            lat: 37.123,
            lng: -122.123,
          },
        }),
      );

      expect(mocks.timezoneLookup).not.toHaveBeenCalled();
      expect(mocks.placesRepo.updateTimezone).not.toHaveBeenCalled();
    });

    it("keeps the existing value when the lookup returns null", async () => {
      const { deps, mocks } = buildDeps({ timezoneLookup: () => null });

      const result = await upsertPlace(deps, makeInput());

      expect(result.placeId).toBe(DEFAULT_PLACE_ID);
      // Never null out a previously-derived timezone on an unknown lookup.
      expect(mocks.placesRepo.updateTimezone).not.toHaveBeenCalled();
      expect(mocks.reportError).not.toHaveBeenCalled();
    });

    it("skips the lookup when coordinates are absent", async () => {
      const { deps, mocks } = buildDeps();

      await upsertPlace(
        deps,
        makeInput({
          address: {
            formatted: "123 Main St, City, ST",
            line1: "123 Main St",
            city: "City",
            region: "ST",
            postalCode: "12345",
            countryCode: "US",
          },
        }),
      );

      expect(mocks.timezoneLookup).not.toHaveBeenCalled();
      expect(mocks.placesRepo.updateTimezone).not.toHaveBeenCalled();
    });

    it("reports and still saves when the lookup throws", async () => {
      const boom = new Error("tz boundary data corrupt");
      const { deps, mocks } = buildDeps({
        timezoneLookup: () => {
          throw boom;
        },
      });

      const result = await upsertPlace(deps, makeInput());

      // The save is untouched by the lookup failure...
      expect(result.placeId).toBe(DEFAULT_PLACE_ID);
      expect(mocks.placesRepo.upsert).toHaveBeenCalledTimes(1);
      expect(mocks.placesRepo.updateTimezone).not.toHaveBeenCalled();
      // ...and the swallow is REPORTED, not just logged (Sentry convention).
      expect(mocks.reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: expect.objectContaining({ useCase: "upsertPlace" }),
        }),
      );
    });

    it("still saves when BOTH the lookup AND the reporter throw (guarded swallow)", async () => {
      // Pins the try/catch around `deps.reportError?.(...)` inside the tx: a
      // throwing reporter must never escape the swallow branch, abort the
      // transaction, and fail the place save (repo Sentry convention).
      const { deps, mocks } = buildDeps({
        timezoneLookup: () => {
          throw new Error("tz boundary data corrupt");
        },
      });
      mocks.reportError.mockImplementation(() => {
        throw new Error("sentry transport down");
      });

      const result = await upsertPlace(deps, makeInput());

      expect(result.placeId).toBe(DEFAULT_PLACE_ID);
      expect(mocks.placesRepo.upsert).toHaveBeenCalledTimes(1);
      expect(mocks.reportError).toHaveBeenCalled();
    });
  });

  describe("default space + calendar minting (venue-hierarchy FR-001/FR-002)", () => {
    it("mints Main Space + default Main Calendar joined via CalendarSpace on create", async () => {
      const { deps, mocks } = buildDeps();

      await upsertPlace(deps, makeInput());

      const spaces = [...mocks.spacesFake.rows.values()];
      expect(spaces).toHaveLength(1);
      expect(spaces[0]).toMatchObject({
        placeId: DEFAULT_PLACE_ID,
        name: "Main Space",
        sortOrder: 0,
        status: "ACTIVE",
      });

      const calendars = [...mocks.calendarsFake.calendars.values()];
      expect(calendars).toHaveLength(1);
      expect(calendars[0]).toMatchObject({
        placeId: DEFAULT_PLACE_ID,
        name: "Main Calendar",
        slug: "main",
        isDefault: true,
      });

      // The join: default calendar schedules into the default space.
      expect(mocks.calendarsFake.joins.get(calendars[0]!.id)).toEqual([
        spaces[0]!.id,
      ]);
      expect(mocks.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "place",
          action: "place.defaults_minted",
        }),
      );
      expect(mocks.reportError).not.toHaveBeenCalled();
    });

    it("does NOT mint on update of an existing place", async () => {
      const existing = buildPlaceRecord({ orgIdsWithAccess: [DEFAULT_ORG_ID] });
      const { deps, mocks } = buildDeps({ existingPlace: existing });

      await upsertPlace(
        deps,
        makeInput({
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
          placeId: DEFAULT_PLACE_ID,
        }),
      );

      expect(mocks.spacesFake.rows.size).toBe(0);
      expect(mocks.calendarsFake.calendars.size).toBe(0);
    });

    it("a FAILING mint aborts the whole place save (atomic with the place row)", async () => {
      // The staging-era skip-and-report path is gone: the repos are required,
      // so the mint runs unconditionally inside the tx — a mint failure now
      // rolls the place save back rather than leaving a space-less place.
      const { deps, mocks } = buildDeps();
      vi.spyOn(mocks.spacesFake, "create").mockRejectedValueOnce(
        new Error("spaces table on fire"),
      );

      // Non-domain errors surface via asKnownError as dependency_failed with
      // the original failure on `cause` — the save FAILED, it did not commit
      // a space-less place.
      await expect(upsertPlace(deps, makeInput())).rejects.toMatchObject({
        code: "dependency_failed",
        cause: expect.objectContaining({ message: "spaces table on fire" }),
      });
      expect(mocks.auditRepo.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "place.defaults_minted" }),
      );
      // edf7c13aa: a failed save FREES the key (owner-checked release), so
      // the same-key retry proceeds at once instead of waiting out the TTL.
      const idemKey = `place:human:${DEFAULT_ACTOR_ID}:new:place-key-123456`;
      const ownerToken = vi.mocked(mocks.idempotency.begin).mock.calls[0]![2];
      expect(ownerToken).toEqual(expect.any(String));
      expect(mocks.idempotency.release).toHaveBeenCalledWith(
        idemKey,
        ownerToken,
      );
    });
  });
});

// ── Address privacy: what a BRAND-NEW place gets ────────────────────────────
//
// New places default to WITHHELD (place-address-withholding, item 5). The
// asymmetry is the whole argument: a public venue defaulted to hidden loses
// some discovery until its operator — who is running a business and does open
// the settings page — switches it on; a house defaulted to public publishes
// somebody's home address, and the person listing their living room is the
// LEAST likely of all users to visit a settings page first. Privacy controls
// inherit whatever the default is, so the default is the one whose failure
// mode is an inconvenience.
describe("upsertPlace — address privacy", () => {
  it("creates a NEW place EXACT when nobody says otherwise", async () => {
    // RULED 2026-09-17: a venue shows its address unless it asks not to.
    // Nearly every place is a public business whose address is the most
    // useful thing about it; defaulting those to hidden ships a broken
    // directory. The house is protected by an explicit choice AT CREATION,
    // not by a default that makes every ordinary venue wrong.
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, makeInput());

    expect(mocks.placesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        locationMode: "EXACT",
        locationRadiusMeters: null,
      }),
    );
  });

  it("honours an explicit withheld on create — the hide choice is what protects a home", async () => {
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, {
      ...makeInput(),
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
    });

    expect(mocks.placesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        locationMode: "OBSCURED",
        // null = FULLY HIDDEN, the strictest of the three states.
        locationRadiusMeters: null,
      }),
    );
  });

  it("honours an explicit circle radius on create — snapped UP to the radius ladder", async () => {
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, {
      ...makeInput(),
      locationMode: "OBSCURED",
      // Off-ladder: stored as the next rung, never as a new circle.
      locationRadiusMeters: 1200,
      locationLabel: "East Nashville",
    });

    expect(mocks.placesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        locationMode: "OBSCURED",
        locationRadiusMeters: 2000,
        locationLabel: "East Nashville",
      }),
    );
  });

  it("does NOT touch an EXISTING place's privacy when the caller omits it", async () => {
    // The `omitted = preserve` contract. Without it, a FINANCE member editing
    // a payout term would silently un-withhold (or hide) a venue.
    const existing = buildPlaceRecord({ locationMode: "OBSCURED" });
    const { deps, mocks } = buildDeps({ existingPlace: existing });

    await upsertPlace(deps, makeInput({ placeId: DEFAULT_PLACE_ID }));

    const call = mocks.placesRepo.upsert.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(call).not.toHaveProperty("locationMode");
    expect(call).not.toHaveProperty("locationRadiusMeters");
    expect(call).not.toHaveProperty("locationLabel");
  });

  it("rejects an out-of-range radius at the boundary", async () => {
    const { deps } = buildDeps();

    await expect(
      upsertPlace(deps, { ...makeInput(), locationRadiusMeters: 12 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      upsertPlace(deps, {
        ...makeInput({ clientKey: "place-key-654321" }),
        locationRadiusMeters: 999_999,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ── Performer-review switch at creation (venue-track-record-and-review-switch
// R3 / FR-006). The person who withheld their address is the person listing a
// home; the switch they would otherwise have to go and find is set by the
// choice they already made.
describe("upsertPlace — Place.communityReviewsEnabled default (R3)", () => {
  function writtenSwitch(mocks: ReturnType<typeof buildDeps>["mocks"]) {
    return mocks.placesRepo.upsert.mock.calls[0]![0] as Record<string, unknown>;
  }

  it("creates an OBSCURED place with performer reviews OFF", async () => {
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, {
      ...makeInput(),
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
    });

    expect(writtenSwitch(mocks)).toMatchObject({
      locationMode: "OBSCURED",
      communityReviewsEnabled: false,
    });
  });

  it("creates an EXACT place with performer reviews ON", async () => {
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, { ...makeInput(), locationMode: "EXACT" });

    expect(writtenSwitch(mocks)).toMatchObject({
      locationMode: "EXACT",
      communityReviewsEnabled: true,
    });
  });

  it("follows the resolved location default (EXACT) when nobody says either", async () => {
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, makeInput());

    expect(writtenSwitch(mocks)).toMatchObject({
      locationMode: "EXACT",
      communityReviewsEnabled: true,
    });
  });

  it("honours an explicit ON for an OBSCURED place — the input wins over the default", async () => {
    const { deps, mocks } = buildDeps();

    await upsertPlace(deps, {
      ...makeInput(),
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      communityReviewsEnabled: true,
    });

    expect(writtenSwitch(mocks)).toMatchObject({
      locationMode: "OBSCURED",
      communityReviewsEnabled: true,
    });
  });

  it("does NOT touch an EXISTING place's switch when the caller omits it", async () => {
    const existing = buildPlaceRecord({
      locationMode: "OBSCURED",
      communityReviewsEnabled: false,
    });
    const { deps, mocks } = buildDeps({ existingPlace: existing });

    await upsertPlace(deps, makeInput({ placeId: DEFAULT_PLACE_ID }));

    expect(writtenSwitch(mocks)).not.toHaveProperty("communityReviewsEnabled");
  });

  // ── UPDATE never carries the switch (FR-005). This use case admits EDITOR;
  // the switch sits at the OWNER/ADMIN bar and audits as
  // `place.community_reviews_*`. So on an existing place the field is
  // REJECTED outright — for everyone, owner included — before any read or
  // write, and the only writer is `setPlaceCommunityReviewsEnabled`.

  it("an org EDITOR cannot reopen a closed place's performer reviews through upsertPlace", async () => {
    const existing = buildPlaceRecord({
      locationMode: "OBSCURED",
      communityReviewsEnabled: false,
      humanIdsWithAccess: [],
      orgIdsWithAccess: [DEFAULT_ORG_ID],
    });
    const { deps, mocks } = buildDeps({
      existingPlace: existing,
      membership: { orgId: DEFAULT_ORG_ID, humanId: DEFAULT_ACTOR_ID, role: "EDITOR" },
    });

    await expect(
      upsertPlace(deps, {
        ...makeInput({
          placeId: DEFAULT_PLACE_ID,
          owner: { kind: "org", orgId: DEFAULT_ORG_ID },
        }),
        communityReviewsEnabled: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { field: "communityReviewsEnabled", useCase: "setPlaceCommunityReviewsEnabled" },
    });

    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
    // Refused before the read, not after it.
    expect(mocks.placesRepo.getById).not.toHaveBeenCalled();
  });

  it("even the direct OWNER is refused on UPDATE — the dedicated use case is the only writer", async () => {
    const existing = buildPlaceRecord({ communityReviewsEnabled: true });
    const { deps, mocks } = buildDeps({ existingPlace: existing });

    await expect(
      upsertPlace(deps, {
        ...makeInput({ placeId: DEFAULT_PLACE_ID }),
        communityReviewsEnabled: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.auditRepo.log).not.toHaveBeenCalled();
  });

  it("an explicit value on UPDATE is refused even when it equals the stored one", async () => {
    // No "harmless no-op" exception: the rule is about who may carry the
    // field, not about whether this particular write would change anything.
    const existing = buildPlaceRecord({ communityReviewsEnabled: false });
    const { deps, mocks } = buildDeps({ existingPlace: existing });

    await expect(
      upsertPlace(deps, {
        ...makeInput({ placeId: DEFAULT_PLACE_ID }),
        communityReviewsEnabled: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("a replay of the same clientKey with a DIFFERENT switch value conflicts, never silently ignores", async () => {
    const { deps } = buildDeps();
    const input = { ...makeInput(), locationMode: "OBSCURED" as const };

    await upsertPlace(deps, input);

    await expect(
      upsertPlace(deps, { ...input, communityReviewsEnabled: true }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });
});
