import { describe, expect, it, vi } from "vitest";

import { bulkImportPlaces } from "../bulk-import-places";
import type { BulkImportPlacesDeps } from "../bulk-import-places";
import { buildPageSlug } from "../_shared/page-slug";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const BASE_ADDRESS = {
  formatted: "123 Main St, Austin, TX 78701, US",
  line1: "123 Main St",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  countryCode: "US",
};

const VALID_PLACE = {
  name: "The Grand Ballroom",
  address: BASE_ADDRESS,
  owner: { kind: "human" as const, humanId: ACTOR_ID },
  capacity: 500,
  listedInDirectory: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    allowed?: boolean;
    created?: number;
    /**
     * Rows `entityPages.bulkCreate` reports as inserted. `undefined` means
     * "however many were asked for" — the honest default. Set it lower to
     * simulate a unique collision that `skipDuplicates` swallowed.
     */
    pagesCreated?: number;
  } = {},
): BulkImportPlacesDeps {
  const allowed = overrides.allowed ?? true;
  const created = overrides.created ?? 1;

  const places = {
    bulkCreate: vi.fn(async () => ({ created })),
  };

  const entityPages = {
    bulkCreate: vi.fn(async (rows: unknown[]) => ({
      created: overrides.pagesCreated ?? rows.length,
    })),
  };

  const audit = { log: vi.fn(async () => undefined) };

  // The tx repos and the outer repos bag are the SAME objects, spread rather
  // than a bare `{ tx } as unknown as Repos`. A bag with no non-transactional
  // surface makes any post-commit `deps.repos.<x>` read `undefined`, which the
  // use case's own error handling then eats — a green test over dead code.
  // That failure mode has landed in this repo four times.
  const txRepos = { places, entityPages, audit };
  const tx = vi.fn(async (fn: (repos: unknown) => Promise<unknown>) =>
    fn(txRepos),
  );

  return {
    repos: {
      ...txRepos,
      tx,
    } as unknown as BulkImportPlacesDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as BulkImportPlacesDeps["authz"],
  };
}

function entityPagesBulkCreate(deps: BulkImportPlacesDeps) {
  return (
    deps.repos as unknown as {
      entityPages: { bulkCreate: ReturnType<typeof vi.fn> };
    }
  ).entityPages.bulkCreate;
}

function placesBulkCreate(deps: BulkImportPlacesDeps) {
  return (
    deps.repos as unknown as {
      places: { bulkCreate: ReturnType<typeof vi.fn> };
    }
  ).places.bulkCreate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("bulkImportPlaces", () => {
  it("returns { total: 2, created: 2 } and emits a single audit log for an ADMIN actor with 2 places (human + org owner)", async () => {
    const deps = buildDeps({ created: 2 });

    const result = await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [
        VALID_PLACE,
        {
          ...VALID_PLACE,
          name: "Second Venue",
          owner: { kind: "org" as const, orgId: ORG_ID },
        },
      ],
    });

    expect(result.total).toBe(2);
    expect(result.created).toBe(2);

    const auditLog = (
      deps.repos as unknown as { audit: { log: ReturnType<typeof vi.fn> } }
    ).audit.log;
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.bulkImportPlaces" }),
    );
  });

  it("throws { code: 'forbidden' } when actor does not have ADMIN role", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      bulkImportPlaces(deps, {
        actorHumanId: ACTOR_ID,
        places: [VALID_PLACE],
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws { code: 'invalid_input' } for an empty places array", async () => {
    const deps = buildDeps();

    await expect(
      bulkImportPlaces(deps, {
        actorHumanId: ACTOR_ID,
        places: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws { code: 'invalid_input' } when places array exceeds 500", async () => {
    const deps = buildDeps();

    await expect(
      bulkImportPlaces(deps, {
        actorHumanId: ACTOR_ID,
        places: Array.from({ length: 501 }, (_, i) => ({
          ...VALID_PLACE,
          name: `Venue ${i + 1}`,
        })),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("uppercases countryCode 'us' to 'US' in the payload passed to bulkCreate", async () => {
    const deps = buildDeps();

    await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [
        { ...VALID_PLACE, address: { ...BASE_ADDRESS, countryCode: "us" } },
      ],
    });

    const bulkCreate = (
      deps.repos as unknown as {
        places: { bulkCreate: ReturnType<typeof vi.fn> };
      }
    ).places.bulkCreate;
    expect(bulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          address: expect.objectContaining({ countryCode: "US" }),
        }),
      ]),
    );
  });

  // ── Addressless places (the "TBD" sentinel fix) ──────────────────────────
  //
  // `line1` used to be `min(1)` here, which is what pushed the platform CSV
  // importer into sending the literal string "TBD" for rows with no street
  // address. That sentinel persisted to `Place.addrLine1` and rendered on the
  // venue's public page. `Place.addrLine1` is nullable and plenty of real
  // venues (parks, DIY spaces, house shows) have no street, so an absent
  // `line1` is now a first-class input.
  it("accepts a place with no line1 and normalises it to the empty string for the repo", async () => {
    const deps = buildDeps();

    const { line1: _line1, ...addressWithoutStreet } = BASE_ADDRESS;

    await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [
        {
          ...VALID_PLACE,
          address: { ...addressWithoutStreet, formatted: "Austin, TX, US" },
        },
      ],
    });

    const bulkCreate = (
      deps.repos as unknown as {
        places: { bulkCreate: ReturnType<typeof vi.fn> };
      }
    ).places.bulkCreate;

    const [rows] = bulkCreate.mock.calls[0] as [
      { address: Record<string, unknown> }[],
    ];
    // `""`, not null/undefined: the same normalisation as upsertPlace; every
    // existing addressless caller already writes the empty string.
    expect(rows[0]!.address.line1).toBe("");
    expect(rows[0]!.address.formatted).toBe("Austin, TX, US");
    expect(JSON.stringify(rows)).not.toContain("TBD");
  });

  it("still rejects an address with no `formatted` — `Place.address` is NOT NULL", async () => {
    const deps = buildDeps();

    await expect(
      bulkImportPlaces(deps, {
        actorHumanId: ACTOR_ID,
        places: [
          { ...VALID_PLACE, address: { ...BASE_ADDRESS, formatted: "" } },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ── Unowned imports (the "scraped venue is unclaimable" fix) ─────────────
  //
  // `owner` used to be REQUIRED here, and the platform CSV importer satisfied
  // it by naming the importing staff human. That wrote a VERIFIED
  // `PlaceOwnership` row for every scraped venue, so
  // `getPlaceClaimEligibility` returned `already_claimed` /
  // `verified_owner_exists` and the venue's real operator was permanently
  // routed to the dispute path instead of the claim path.
  it("accepts a place with NO owner and passes owner: undefined to bulkCreate (never defaults to the actor)", async () => {
    const deps = buildDeps();

    const { owner: _owner, ...unownedPlace } = VALID_PLACE;

    await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [unownedPlace],
    });

    const bulkCreate = (
      deps.repos as unknown as {
        places: { bulkCreate: ReturnType<typeof vi.fn> };
      }
    ).places.bulkCreate;

    const [rows] = bulkCreate.mock.calls[0] as [
      { owner?: unknown; name: string }[],
    ];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBeUndefined();
    // The actor must not leak in as an implicit owner anywhere on the row.
    expect(JSON.stringify(rows[0])).not.toContain(ACTOR_ID);
  });

  it("passes a mixed batch through with per-row owners preserved (owned + unowned)", async () => {
    const deps = buildDeps({ created: 2 });

    const { owner: _owner, ...unownedPlace } = VALID_PLACE;

    await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [
        {
          ...VALID_PLACE,
          name: "Owned Venue",
          owner: { kind: "org" as const, orgId: ORG_ID },
        },
        { ...unownedPlace, name: "Scraped Venue" },
      ],
    });

    const bulkCreate = (
      deps.repos as unknown as {
        places: { bulkCreate: ReturnType<typeof vi.fn> };
      }
    ).places.bulkCreate;

    const [rows] = bulkCreate.mock.calls[0] as [
      { owner?: unknown; name: string }[],
    ];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("Owned Venue");
    expect(rows[0]!.owner).toEqual({ kind: "org", orgId: ORG_ID });
    expect(rows[1]!.name).toBe("Scraped Venue");
    expect(rows[1]!.owner).toBeUndefined();
  });

  // ── websiteSource provenance (FR-010 fast-track) ────────────────────────
  it("omits websiteSource when the row does not set it, so the adapter's fail-safe UNKNOWN applies", async () => {
    const deps = buildDeps();

    await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [VALID_PLACE],
    });

    const bulkCreate = (
      deps.repos as unknown as {
        places: { bulkCreate: ReturnType<typeof vi.fn> };
      }
    ).places.bulkCreate;

    const [rows] = bulkCreate.mock.calls[0] as [
      { websiteSource?: unknown }[],
    ];
    expect(rows[0]!.websiteSource).toBeUndefined();
    // The use case must never invent trust for a caller that didn't ask.
    expect(JSON.stringify(rows[0])).not.toContain("TRUSTED_IMPORT");
  });

  it("round-trips an explicit websiteSource through to bulkCreate", async () => {
    const deps = buildDeps({ created: 3 });

    await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [
        { ...VALID_PLACE, name: "Curated Feed", websiteSource: "TRUSTED_IMPORT" },
        { ...VALID_PLACE, name: "Review Stub", websiteSource: "USER_STUB" },
        { ...VALID_PLACE, name: "Explicit Unknown", websiteSource: "UNKNOWN" },
      ],
    });

    const bulkCreate = (
      deps.repos as unknown as {
        places: { bulkCreate: ReturnType<typeof vi.fn> };
      }
    ).places.bulkCreate;

    const [rows] = bulkCreate.mock.calls[0] as [{ websiteSource?: string }[]];
    expect(rows.map((r) => r.websiteSource)).toEqual([
      "TRUSTED_IMPORT",
      "USER_STUB",
      "UNKNOWN",
    ]);
  });

  it("rejects a websiteSource outside the PlaceWebsiteSource enum", async () => {
    const deps = buildDeps();

    await expect(
      bulkImportPlaces(deps, {
        actorHumanId: ACTOR_ID,
        places: [{ ...VALID_PLACE, websiteSource: "TOTALLY_TRUSTED" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ── Audit trail ─────────────────────────────────────────────────────────
  it("records the generated place ids in the audit row, not just a count", async () => {
    const deps = buildDeps({ created: 2 });

    await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [VALID_PLACE, { ...VALID_PLACE, name: "Second Venue" }],
    });

    const bulkCreate = (
      deps.repos as unknown as {
        places: { bulkCreate: ReturnType<typeof vi.fn> };
      }
    ).places.bulkCreate;
    const [rows] = bulkCreate.mock.calls[0] as [{ id: string }[]];

    const auditLog = (
      deps.repos as unknown as { audit: { log: ReturnType<typeof vi.fn> } }
    ).audit.log;
    const auditArg = auditLog.mock.calls[0]![0] as {
      data: { placeIds: string[]; count: number };
    };
    // The ids in the audit row are the ids actually written.
    expect(auditArg.data.placeIds).toEqual(rows.map((r) => r.id));
    expect(auditArg.data.placeIds).toHaveLength(2);
    expect(auditArg.data.count).toBe(2);
  });

  // ── Public page per imported venue ──────────────────────────────────────
  //
  // `/places/[slug]` and `/p/[slug]` resolve `EntityPage.slug`. The import
  // path used to write Place rows and nothing else, so every bulk-imported
  // venue had NO EntityPage and therefore no public page at all — reachable
  // only via the `/places/id/[placeId]` fallback nothing links to.
  describe("EntityPage minting", () => {
    it("mints exactly one EntityPage per imported place, in the same transaction", async () => {
      const deps = buildDeps({ created: 3 });

      await bulkImportPlaces(deps, {
        actorHumanId: ACTOR_ID,
        places: [
          { ...VALID_PLACE, name: "Venue One" },
          { ...VALID_PLACE, name: "Venue Two" },
          { ...VALID_PLACE, name: "Venue Three" },
        ],
      });

      const pageCreate = entityPagesBulkCreate(deps);
      expect(pageCreate).toHaveBeenCalledTimes(1);

      const [pageRows] = pageCreate.mock.calls[0] as [
        { ownerType: string; ownerId: string; displayName: string }[],
      ];
      const [placeRows] = placesBulkCreate(deps).mock.calls[0] as [
        { id: string; name: string }[],
      ];

      // EVERY place, not just "a page exists".
      expect(pageRows).toHaveLength(3);
      expect(pageRows.map((r) => r.ownerId)).toEqual(
        placeRows.map((r) => r.id),
      );
      expect(pageRows.every((r) => r.ownerType === "PLACE")).toBe(true);
      expect(pageRows.map((r) => r.displayName)).toEqual([
        "Venue One",
        "Venue Two",
        "Venue Three",
      ]);

      // Both writes go through the SAME tx callback — one call to repos.tx.
      const txFn = (deps.repos as unknown as { tx: ReturnType<typeof vi.fn> })
        .tx;
      expect(txFn).toHaveBeenCalledTimes(1);
    });

    it("gives every page the FLAT buildPageSlug form", async () => {
      const deps = buildDeps({ created: 1 });

      await bulkImportPlaces(deps, {
        actorHumanId: ACTOR_ID,
        places: [{ ...VALID_PLACE, name: "Backstage Nashville" }],
      });

      const [placeRows] = placesBulkCreate(deps).mock.calls[0] as [
        { id: string; name: string }[],
      ];
      const placeId = placeRows[0]!.id;

      const [pageRows] = entityPagesBulkCreate(deps).mock.calls[0] as [
        { slug: string }[],
      ];
      const pageSlug = pageRows[0]!.slug;

      expect(pageSlug).toBe(buildPageSlug("Backstage Nashville", placeId));

      // The whole point: a route with a single non-catch-all segment can
      // never match a value containing "/". (The since-deprecated `Place.slug`
      // was multi-segment and did contain one, which is why it routed
      // nowhere — `bulkCreate` never wrote it and nothing mints it now.)
      expect(pageSlug).not.toContain("/");
    });

    it("leaves bio null — a scraped row carries no bio to import", async () => {
      const deps = buildDeps();

      await bulkImportPlaces(deps, {
        actorHumanId: ACTOR_ID,
        places: [VALID_PLACE],
      });

      const [pageRows] = entityPagesBulkCreate(deps).mock.calls[0] as [
        { bio: string | null }[],
      ];
      expect(pageRows[0]!.bio).toBeNull();
    });

    it("throws INTERNAL (rolling the import back) when the repo inserts fewer pages than asked for", async () => {
      // `bulkCreate` uses `skipDuplicates`, so a unique collision comes back as
      // a short count rather than a throw. Letting that pass would ship the
      // exact defect this block fixes: a venue in the directory with no page.
      const deps = buildDeps({ created: 2, pagesCreated: 1 });

      await expect(
        bulkImportPlaces(deps, {
          actorHumanId: ACTOR_ID,
          places: [
            { ...VALID_PLACE, name: "Venue One" },
            { ...VALID_PLACE, name: "Venue Two" },
          ],
        }),
      ).rejects.toMatchObject({ code: "INTERNAL" });

      // And the audit row is never written — the throw happens inside the tx,
      // before it.
      const auditLog = (
        deps.repos as unknown as { audit: { log: ReturnType<typeof vi.fn> } }
      ).audit.log;
      expect(auditLog).not.toHaveBeenCalled();
    });
  });

  it("passes geo: { lat: 0, lng: 0 } to bulkCreate when address.lat and address.lng are 0 (regression: falsy-zero guard)", async () => {
    const deps = buildDeps();

    await bulkImportPlaces(deps, {
      actorHumanId: ACTOR_ID,
      places: [
        { ...VALID_PLACE, address: { ...BASE_ADDRESS, lat: 0, lng: 0 } },
      ],
    });

    const bulkCreate = (
      deps.repos as unknown as {
        places: { bulkCreate: ReturnType<typeof vi.fn> };
      }
    ).places.bulkCreate;
    expect(bulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ geo: { lat: 0, lng: 0 } }),
      ]),
    );
  });
});
