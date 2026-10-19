import { describe, expect, it, vi } from "vitest";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import {
  createCommunityListing,
  type CreateCommunityListingDeps,
} from "../create-community-listing";
import type { CreateCommunityListingInput as RepoCreateInput } from "@th/ports/repos/events";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { ok } from "@th/ports/search/types";
import {
  ADMIN_ID,
  CATEGORY_ID,
  MODERATOR_ID,
  NOW,
  USER_ID,
  makeClock,
  makeContentFilter,
  makeStaffAuthz,
  makeValidBody,
  makeXssCtaBody,
} from "./helpers";

const VALID_INPUT = {
  actorHumanId: MODERATOR_ID,
  title: "Weekly Open Mic",
  startsAt: new Date("2026-08-01T20:00:00.000Z"),
  endsAt: new Date("2026-08-01T23:00:00.000Z"),
  timezone: "America/Chicago",
  addressText: "123 Main St, Austin, TX",
  countryCode: "us",
  region: "TX",
  locality: "Austin",
  postalCode: "78701",
  lat: 30.27,
  lng: -97.74,
};

const CREATED_EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * Search fake mirroring the `MultiSearchPort` shape used in
 * build-search-index.test — captures the documents `reindexAfterMutation`
 * ultimately upserts so the trigger can be asserted end-to-end.
 */
function makeSearchFake() {
  const upsertDocuments = vi.fn(async ({ documents }) => {
    return ok({ indexed: documents.length });
  });
  const search = {
    ensureIndexes: vi.fn(async () => ok(undefined)),
    upsertDocuments,
    deleteDocuments: vi.fn(async () => ok(undefined)),
    getStats: vi.fn(async () => ok({} as never)),
    autocomplete: vi.fn(async () => ok({} as never)),
  } as unknown as MultiSearchPort;
  return { search, upsertDocuments };
}

/**
 * Read-side repos that `reindexAfterMutation → buildSearchIndex` touches for a
 * single-event incremental index (getById returns the freshly created,
 * PUBLISHED listing so a document actually reaches `upsertDocuments`).
 */
/**
 * The mutation's `repos.tx` fake hands its callback the WRITE-side repos. The
 * search index write fence opens a `repos.tx` of its own and reads through
 * it, so the object it gets must carry the read side (and the fence's locks)
 * too.
 */
function fenceAwareTxRepos<T extends object>(
  txRepos: T,
  readRepos: object,
): T {
  // One level deep, per repo: both sides can define `events` / `images`.
  const merged: Record<string, unknown> = { ...readRepos };
  for (const [key, repo] of Object.entries(txRepos)) {
    const read = (readRepos as Record<string, unknown>)[key];
    merged[key] =
      read && typeof read === "object" && repo && typeof repo === "object"
        ? { ...read, ...repo }
        : repo;
  }
  return withSearchIndexFence(merged) as T;
}

function makeSearchReadRepos() {
  return {
    events: {
      getById: vi.fn(async (id: string) => ({
        id,
        slug: "event/us/austin/weekly-open-mic",
        title: "Weekly Open Mic",
        status: "PUBLISHED" as const,
        orgId: null,
        categoryId: null,
        admissionTaxRateBps: 0,
        addressText: "123 Main St, Austin, TX",
        lat: 30.27,
        lng: -97.74,
        locality: "Austin",
        region: "TX",
        locationMode: "EXACT" as const,
        locationRadiusMeters: null,
      })),
      getPopularityStats: vi.fn(async () => []),
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => []),
    },
    feePolicies: {
      resolveEffective: vi.fn(async () => null),
    },
    images: {
      getPrimaryImageRefs: vi.fn(
        async () => new Map<string, { publicUrl: string; key: string }>(),
      ),
    },
  };
}

function buildDeps(
  overrides: {
    rolesByHuman?: Record<string, string[]>;
    blockedTexts?: string[];
    category?: { id: string; active: boolean } | null;
    search?: MultiSearchPort;
  } = {},
) {
  const rolesByHuman = overrides.rolesByHuman ?? {
    [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
    [ADMIN_ID]: ["ADMIN"],
  };

  const createCommunityListingMock = vi.fn(async (input: RepoCreateInput) => ({
    id: CREATED_EVENT_ID,
    orgId: null,
    humanId: null,
    title: input.title,
    status: input.status,
    attendanceMode: input.attendanceMode,
    stewardship: input.stewardship,
    visibility: "PUBLIC",
    gateType: "NONE",
    timezone: input.timezone,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    slug: input.slug,
    shortId: input.shortId,
    publishedAt: input.publishedAt,
  }));

  const categories = {
    getById: vi.fn(async () =>
      "category" in overrides
        ? overrides.category
        : { id: CATEGORY_ID, active: true },
    ),
  };

  const audit = { log: vi.fn() };

  const txRepos = {
    events: { createCommunityListing: createCommunityListingMock },
    categories,
    audit,
  };

  // The outer (non-tx) repos also expose the read-side methods
  // `reindexAfterMutation` uses on the incremental-index path.
  const searchReadRepos = makeSearchReadRepos();

  const deps: CreateCommunityListingDeps = {
    repos: withSearchIndexFence(
      {
        tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(fenceAwareTxRepos(txRepos, searchReadRepos)),
        ),
        ...searchReadRepos,
      } as unknown as CreateCommunityListingDeps["repos"],
    ),
    authz: makeStaffAuthz(rolesByHuman),
    clock: makeClock(),
    contentFilter: makeContentFilter(overrides.blockedTexts),
    search: overrides.search,
  };

  return { deps, createCommunityListingMock, audit, categories, searchReadRepos };
}

describe("createCommunityListing", () => {
  it("creates an ownerless PUBLISHED RSVP+COMMUNITY row with slug + geohash and audits the creator", async () => {
    const { deps, createCommunityListingMock, audit } = buildDeps();

    const result = await createCommunityListing(deps, VALID_INPUT);

    expect(createCommunityListingMock).toHaveBeenCalledTimes(1);
    const repoInput = createCommunityListingMock.mock.calls[0]![0];
    expect(repoInput).toMatchObject({
      attendanceMode: "RSVP",
      stewardship: "COMMUNITY",
      status: "PUBLISHED",
      publishedAt: NOW,
      countryCode: "US",
      lat: 30.27,
      lng: -97.74,
      heroImageId: null,
    });
    // geohash6 derived server-side from the pin (Austin ≈ 9v6k...).
    expect(repoInput.geohash6).toHaveLength(6);
    // Ownerless host segment falls back to "event".
    expect(repoInput.slug.startsWith("event/us/")).toBe(true);
    expect(repoInput.shortId).toBeTruthy();

    expect(result.event.stewardship).toBe("COMMUNITY");
    expect(result.event.attendanceMode).toBe("RSVP");
    expect(result.event.status).toBe("PUBLISHED");

    // Creator attribution lives ONLY in the audit trail.
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "community_listing.created",
        data: expect.objectContaining({ actorHumanId: MODERATOR_ID }),
        at: NOW,
      }),
    );
  });

  it("persists the NORMALIZED body via createCommunityListing (content in the repo input)", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    await createCommunityListing(deps, {
      ...VALID_INPUT,
      content: makeValidBody(),
    });

    const repoInput = createCommunityListingMock.mock.calls[0]![0];
    expect(repoInput.content).toBeTruthy();
    // Normalization applies schema defaults (e.g. section style).
    expect(
      (repoInput.content as { sections: Array<{ style?: unknown }> })
        .sections[0]!.style,
    ).toBeDefined();
  });

  it("allows a platform ADMIN as well as a moderator", async () => {
    const { deps } = buildDeps();

    await expect(
      createCommunityListing(deps, { ...VALID_INPUT, actorHumanId: ADMIN_ID }),
    ).resolves.toBeTruthy();
  });

  it("rejects non-moderators with STAFF_ONLY and never writes", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    await expect(
      createCommunityListing(deps, { ...VALID_INPUT, actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(createCommunityListingMock).not.toHaveBeenCalled();
  });

  it("rejects endsAt <= startsAt", async () => {
    const { deps } = buildDeps();

    await expect(
      createCommunityListing(deps, {
        ...VALID_INPUT,
        endsAt: new Date("2026-08-01T19:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a body with a javascript: cta href", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    await expect(
      createCommunityListing(deps, {
        ...VALID_INPUT,
        content: makeXssCtaBody(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(createCommunityListingMock).not.toHaveBeenCalled();
  });

  it("rejects filter-blocked title text", async () => {
    const { deps, createCommunityListingMock } = buildDeps({
      blockedTexts: ["slurword"],
    });

    await expect(
      createCommunityListing(deps, {
        ...VALID_INPUT,
        title: "Totally slurword night",
      }),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    expect(createCommunityListingMock).not.toHaveBeenCalled();
  });

  // Geographic fields are EXEMPT from the content filter (reversing the
  // original NFR-001 "ALL free text" reading). Place names are given, not
  // authored: "1200 Dickerson Pike" is a real Nashville thoroughfare that the
  // profanity matcher rejected, and it took 3 of 18 genuine open-mic listings
  // down with it.
  //
  // The blocked tokens are spelled to MATCH the fixture's casing on purpose:
  // makeContentFilter does a case-sensitive `includes`, so lowercase "dick"
  // would never hit "Dickerson" and the reject half of this test would be
  // inert. As written, re-adding the geo fields to the filtered set fails this
  // test twice — once on the throw, once on the never-asked loop.
  it("does NOT content-filter addressText / region / locality", async () => {
    const { deps, createCommunityListingMock } = buildDeps({
      blockedTexts: ["Dickerson", "Penistone"],
    });

    const result = await createCommunityListing(deps, {
      ...VALID_INPUT,
      addressText: "1200 Dickerson Pike, Nashville, TN",
      region: "TN",
      locality: "Penistone",
    });

    expect(result.event.stewardship).toBe("COMMUNITY");
    expect(createCommunityListingMock).toHaveBeenCalledTimes(1);
    expect(createCommunityListingMock.mock.calls[0]![0]).toMatchObject({
      addressText: "1200 Dickerson Pike, Nashville, TN",
      locality: "Penistone",
    });

    // ...and the filter was never even asked about the address.
    for (const call of deps.contentFilter.hasBlockedContent.mock.calls) {
      expect(call[0]!.text).not.toContain("Dickerson");
      expect(call[0]!.text).not.toContain("Penistone");
    }
  });

  it("still rejects filter-blocked title text with blocked_content and the matched term", async () => {
    const { deps, createCommunityListingMock } = buildDeps();
    deps.contentFilter = {
      hasBlockedContent: vi.fn(async () => true),
      findBlocked: vi.fn(async () => ({
        blocked: true,
        matches: ["slurword"],
      })),
    };

    await expect(
      createCommunityListing(deps, {
        ...VALID_INPUT,
        title: "Totally slurword night",
      }),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: {
        reason: "blocked_content",
        fields: ["title"],
        term: "slurword",
      },
    });
    expect(createCommunityListingMock).not.toHaveBeenCalled();
  });

  it("requires countryCode (slug generation depends on it)", async () => {
    const { deps } = buildDeps();
    const { countryCode: _omitted, ...withoutCountry } = VALID_INPUT;

    await expect(
      createCommunityListing(deps, withoutCountry),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an inactive category", async () => {
    const { deps } = buildDeps({
      category: { id: CATEGORY_ID, active: false },
    });

    await expect(
      createCommunityListing(deps, {
        ...VALID_INPUT,
        categoryId: CATEGORY_ID,
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_INACTIVE" });
  });

  it("rejects a missing category", async () => {
    const { deps } = buildDeps({ category: null });

    await expect(
      createCommunityListing(deps, {
        ...VALID_INPUT,
        categoryId: CATEGORY_ID,
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
  });

  it("triggers an incremental search index for the new event when a search port is provided", async () => {
    const { search, upsertDocuments } = makeSearchFake();
    const { deps, searchReadRepos } = buildDeps({ search });

    await createCommunityListing(deps, VALID_INPUT);

    // reindexAfterMutation is fire-and-forget (voided, not awaited), so flush
    // the microtask chain until the index upsert lands.
    await vi.waitFor(() => expect(upsertDocuments).toHaveBeenCalled());

    // The reindex resolved the freshly created listing by id...
    expect(searchReadRepos.events.getById).toHaveBeenCalledWith(
      CREATED_EVENT_ID,
    );
    // ...and upserted a search document keyed to that event id.
    const upsertedDocs = upsertDocuments.mock.calls.flatMap(
      ([call]) => call.documents,
    );
    expect(
      upsertedDocs.some(
        (doc: { id: string; eventId?: string }) =>
          doc.id === `event_${CREATED_EVENT_ID}` &&
          doc.eventId === CREATED_EVENT_ID,
      ),
    ).toBe(true);
  });

  it("succeeds and never throws when no search port is provided (indexing skipped)", async () => {
    const { deps } = buildDeps();

    // No search dep → reindexAfterMutation no-ops. Creation still resolves.
    const result = await createCommunityListing(deps, VALID_INPUT);
    expect(result.event.id).toBe(CREATED_EVENT_ID);

    // Give any stray microtask a tick to surface an unexpected rejection.
    await Promise.resolve();
    expect(result.event.status).toBe("PUBLISHED");
  });
});
