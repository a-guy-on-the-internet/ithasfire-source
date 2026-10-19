import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import { ok } from "@th/ports/search/types";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { buildSearchIndex as buildSearchIndexFenced } from "../build-search-index";

/** The fixtures below predate the index-write fence; give them its surface. */
const buildSearchIndex: typeof buildSearchIndexFenced = (deps, input) =>
  buildSearchIndexFenced(
    { ...deps, repos: withSearchIndexFence(deps.repos) },
    input,
  );

/**
 * The stored all-in buyer total under a jurisdictional taxable base.
 *
 * The card badge renders `lowestBuyerTotalCents` as the price. In Tennessee the
 * admission tax applies to the buyer's platform and processing fees too, so a
 * total computed on the face-only base understates the charge by a few percent —
 * and the mapper's `[face, 2×face]` freshness guard cannot see that (it is the
 * same blind spot `buyerTotalForIndex` exists to close on the tax side).
 *
 * The fixture is the charge fixture: $25 face, 50¢ flat platform fee, Stripe
 * 2.9% + 30¢, PASS_THROUGH, 9.75% — which `create-checkout.test.ts` pins at
 * 2925¢ charged (2909¢ on the old face-only base). Situs comes from a PLACE row
 * here, so this also exercises the batched place read.
 */

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const PLACE_ID = "00000000-0000-4000-8000-00000000a001";
const EVENT_A = "00000000-0000-4000-8000-0000000000e1";
const EVENT_B = "00000000-0000-4000-8000-0000000000e2";
const TT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_ID = "00000000-0000-4000-8000-00000000c001";

const FACE_CENTS = 2500;
const TN_CHARGE_CENTS = 2925;
const FACE_CHARGE_CENTS = 2909;

const AGREEMENT = {
  id: "agreement-1",
  kind: "PRIMARY",
  status: "ACTIVE",
  feeMode: "PASS_THROUGH",
  feePolicyId: "policy-1",
  version: 1,
};
const AGREEMENT_LINE = {
  id: "line-1",
  payoutTermsId: "agreement-1",
  payeeId: "payee-1",
  percent: 100,
  floorCents: 0,
  capPercent: null,
  priority: 0,
  rounding: "FLOOR",
};

const feePolicy = {
  id: "policy-1",
  version: 1,
  status: "ACTIVE",
  feeMode: "PASS_THROUGH",
  buyerFeePct: 0,
  maxFeeCents: null,
  minFeeCents: 0,
  maxPlatformFeeCents: null,
  platformFixedCents: 50,
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0,
  payoutFixedCents: 0,
  monthlyPayoutCents: 0,
};

function event(id: string) {
  return {
    id,
    slug: `show-${id}`,
    title: "Show",
    status: "PUBLISHED" as const,
    orgId: ORG_ID,
    humanId: null,
    categoryId: null,
    addressText: "1 Main St",
    lat: 36.16,
    lng: -86.78,
    locality: "Nashville",
    region: "TN",
    locationMode: "EXACT" as const,
    locationRadiusMeters: null,
    startsAt: new Date("2026-08-01T02:00:00.000Z"),
    endsAt: null,
    visibility: "PUBLIC" as const,
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
    admissionTaxRateBps: 975,
    // The situs lives on the PLACE, not the event.
    placeId: PLACE_ID,
    savedLocationId: null,
    postalCode: null,
    countryCode: null,
  };
}

function ticketType(id: string, eventId: string) {
  return {
    id,
    eventId,
    name: "General",
    description: null,
    priceCents: FACE_CENTS,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status: "ACTIVE",
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
  };
}

async function indexNashville(options: {
  region: string | null;
  placesError?: Error;
  eventIds?: string[];
}) {
  const eventIds = options.eventIds ?? [EVENT_A];
  const placeFor = (id: string) =>
    options.placesError
      ? Promise.reject(options.placesError)
      : Promise.resolve({
          id,
          orgIdsWithAccess: [],
          humanIdsWithAccess: [],
          countryCode: "US",
          region: options.region,
          postalCode: "37203",
        });
  const getPlaceById = vi.fn(placeFor);
  // The listing loader pre-warms its venue reader with ONE batch read.
  const getPlacesByIds = vi.fn(
    async (ids: readonly string[]) =>
      new Map(
        await Promise.all(
          ids.map(async (id) => [id, await placeFor(id)] as const),
        ),
      ),
  );
  const byId = new Map(eventIds.map((id) => [id, event(id)]));
  const reportError = vi.fn();
  const repos = {
    events: {
      getById: vi.fn(async (id: string) => byId.get(id) ?? null),
      getPopularityStats: vi.fn(async () => []),
      listTicketTypesForEventIds: vi.fn(async (ids: string[]) =>
        ids.flatMap((id) => [ticketType(id === EVENT_A ? TT_A : TT_B, id)]),
      ),
    },
    places: { getById: getPlaceById, getByIds: getPlacesByIds },
    savedLocations: {
      getById: vi.fn(async () => null),
      getByIds: vi.fn(async () => new Map()),
    },
    // The batch reads `loadListingBuyerTotalsByEventId` makes: every event on
    // the same pinned PRIMARY terms + policy.
    payoutTerms: {
      listByEventIds: vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, [AGREEMENT]] as const)),
      ),
      listLinesByTermsIds: vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, [AGREEMENT_LINE]] as const)),
      ),
    },
    feePolicies: {
      getByIds: vi.fn(async (ids: readonly string[]) =>
        new Map(ids.includes("policy-1") ? [["policy-1", feePolicy] as const] : []),
      ),
      resolveEffectiveForScopes: vi.fn(async () => new Map()),
      resolveEffective: vi.fn(async () => null),
    },
    images: { getPrimaryImageRefs: vi.fn(async () => new Map()) },
    imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
    categories: { getById: vi.fn(async () => null) },
  } as unknown as Repos;

  const captured: Array<Record<string, unknown>> = [];
  await buildSearchIndex(
    {
      clock: testClock,
      repos,
      reportError,
      search: {
        ensureIndexes: vi.fn(async () => ok(undefined)),
        upsertDocuments: vi.fn(async ({ documents }) => {
          captured.push(...documents);
          return ok({ indexed: documents.length });
        }),
        deleteDocuments: vi.fn(async () => ok(undefined)),
      } as never,
    },
    { eventIds },
  );

  const docs = new Map(
    captured
      .filter((d) => d.type === "event")
      .map((d) => [
        d.eventId as string,
        d as { lowestBuyerTotalCents: number | null },
      ]),
  );
  return { docs, getPlaceById, getPlacesByIds, reportError };
}

describe("buildSearchIndex — stored buyer total under the taxable base", () => {
  it("US/TN stores the CHARGE (2925), not the face-only 2909", async () => {
    const { docs } = await indexNashville({ region: "TN" });
    expect(docs.get(EVENT_A)?.lowestBuyerTotalCents).toBe(TN_CHARGE_CENTS);
  });

  it("US/FL stores exactly what HEAD stored", async () => {
    const { docs } = await indexNashville({ region: "FL" });
    expect(docs.get(EVENT_A)?.lowestBuyerTotalCents).toBe(FACE_CHARGE_CENTS);
  });

  it("reads the venue ONCE for the batch, not once per event", async () => {
    const { docs, getPlaceById, getPlacesByIds } = await indexNashville({
      region: "TN",
      eventIds: [EVENT_A, EVENT_B],
    });
    expect(docs.get(EVENT_A)?.lowestBuyerTotalCents).toBe(TN_CHARGE_CENTS);
    expect(docs.get(EVENT_B)?.lowestBuyerTotalCents).toBe(TN_CHARGE_CENTS);
    // Venue confirmation reads the ONE distinct place once; the tax situs
    // reader is pre-warmed by ONE batch read. Two events must not double it.
    expect(getPlaceById).toHaveBeenCalledTimes(1);
    expect(getPlacesByIds).toHaveBeenCalledTimes(1);
    expect(getPlacesByIds.mock.calls[0]?.[0]).toEqual([PLACE_ID]);
  });

  it("an unreadable venue ships the doc with NO buyer total, and reports", async () => {
    const { docs, reportError } = await indexNashville({
      region: "TN",
      placesError: new Error("db down"),
    });
    // The doc still ships (the reindex's existing posture)…
    expect(docs.get(EVENT_A)).toBeDefined();
    // …but with no all-in price, rather than one built on a guessed base.
    expect(docs.get(EVENT_A)?.lowestBuyerTotalCents ?? null).toBeNull();
    expect(
      reportError.mock.calls.filter(
        ([, context]) =>
          (context as { tags?: Record<string, string> } | undefined)?.tags
            ?.step === "resolveEventTaxSitus",
      ),
    ).toHaveLength(1);
  });
});
