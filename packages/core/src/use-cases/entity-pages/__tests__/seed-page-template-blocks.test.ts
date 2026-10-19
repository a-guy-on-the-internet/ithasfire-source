import { describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";

import { getPageTemplate } from "../page-templates";
import { seedPageTemplateBlocks } from "../seed-page-template-blocks";
import type { SeedPageTemplateBlocksDeps } from "../seed-page-template-blocks";
import type {
  ApplyTemplateSeedInput,
  PageBlockRecord,
} from "@th/ports/repos/entity-pages";

const PAGE_ID = "page-1";

/**
 * A minimal in-memory EntityPages repo that models the adapter's
 * applyTemplateSeed contract: atomic per-marker guard (bare category =
 * revision 1, `"<category>@<N>"` = revision N) + additive append-by-kind at
 * the next orderIndex.
 */
function makeInMemoryRepo(opts?: {
  initialBlocks?: PageBlockRecord[];
  appliedCategories?: string[];
}) {
  let blocks: PageBlockRecord[] = [...(opts?.initialBlocks ?? [])];
  let applied: string[] = [...(opts?.appliedCategories ?? [])];
  let counter = 0;

  const repo = {
    getById: vi.fn(async () => ({
      id: PAGE_ID,
      templateAppliedCategories: applied,
    })),
    listBlocks: vi.fn(async () => [...blocks]),
    applyTemplateSeed: vi.fn(
      async ({
        category,
        appliedMarker,
        blocks: candidates,
      }: ApplyTemplateSeedInput) => {
        // Concurrency guard: no-op if the marker is already applied.
        const marker = appliedMarker ?? category;
        if (applied.includes(marker)) return [];

        const present = new Set(blocks.map((b) => b.kind));
        // Adapter contract for a PINNED candidate: present only when a
        // MAIN-section row carries the kind.
        const presentMain = new Set(
          blocks
            .filter((b) => (b.section ?? "main") === "main")
            .map((b) => b.kind),
        );
        // The partial unique index ("PageBlock_pinned_kind_per_page_key") is
        // SECTION-BLIND: a pinned candidate that passed the main-only check
        // but collides with a same-kind row in ANY section is refused, and
        // the transaction rolls back — nothing created, marker NOT recorded.
        const collision = candidates.find(
          (c) => c.pinned && !presentMain.has(c.kind) && present.has(c.kind),
        );
        if (collision) {
          throw fail("BLOCK_PINNED", {
            meta: { kind: collision.kind, attempted: "add_duplicate" },
          });
        }
        applied = [...applied, marker];
        let nextIndex = blocks.reduce(
          (max, b) => Math.max(max, b.orderIndex + 1),
          0,
        );
        const created: PageBlockRecord[] = [];
        for (const candidate of candidates) {
          const isPresent = candidate.pinned
            ? presentMain.has(candidate.kind)
            : present.has(candidate.kind);
          if (isPresent) continue;
          present.add(candidate.kind);
          presentMain.add(candidate.kind);
          const row: PageBlockRecord = {
            id: `seeded-${counter++}`,
            pageId: PAGE_ID,
            kind: candidate.kind,
            orderIndex: nextIndex++,
            data: candidate.data ?? {},
            visible: candidate.visible ?? true,
            // Seeds never set a section; the adapter fills the DB default.
            section: "main",
          };
          blocks.push(row);
          created.push(row);
        }
        return created;
      },
    ),
  };

  const deps: SeedPageTemplateBlocksDeps = {
    repos: { entityPages: repo as never },
  };

  return {
    deps,
    repo,
    getBlocks: () => blocks,
    getApplied: () => applied,
  };
}

function makeBlock(overrides: Partial<PageBlockRecord>): PageBlockRecord {
  return {
    id: "existing",
    pageId: PAGE_ID,
    kind: "about",
    orderIndex: 0,
    data: {},
    visible: true,
    ...overrides,
  };
}

describe("seedPageTemplateBlocks", () => {
  it("seeds the full musician template onto an empty page in template order", async () => {
    const { deps, getBlocks } = makeInMemoryRepo();

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "musician",
    });

    const expectedKinds = getPageTemplate("HUMAN", "musician").map(
      (s) => s.kind,
    );
    expect(created.map((b) => b.kind)).toEqual(expectedKinds);
    // Sequential orderIndex from 0.
    expect(created.map((b) => b.orderIndex)).toEqual(
      expectedKinds.map((_, i) => i),
    );
    expect(getBlocks()).toHaveLength(expectedKinds.length);
  });

  it("is idempotent: a second call for the same category is a no-op", async () => {
    const { deps, repo, getBlocks } = makeInMemoryRepo();

    await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "musician",
    });
    const countAfterFirst = getBlocks().length;

    const second = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "musician",
    });

    expect(second).toEqual([]);
    expect(getBlocks()).toHaveLength(countAfterFirst);
    // Pre-check short-circuits before touching applyTemplateSeed the 2nd time.
    expect(repo.applyTemplateSeed).toHaveBeenCalledTimes(1);
  });

  it("is additive: skips a manually-present kind and appends only the missing ones", async () => {
    const manual = makeBlock({
      id: "manual-about",
      kind: "about",
      orderIndex: 5,
      data: { heading: "My own about", content: "hand written" },
    });
    const { deps, getBlocks } = makeInMemoryRepo({ initialBlocks: [manual] });

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "generic",
    });

    // "about" already present → not re-added.
    expect(created.map((b) => b.kind)).not.toContain("about");
    expect(created.map((b) => b.kind)).toEqual([
      "links",
      "photos",
      "upcoming_events",
    ]);

    // Existing manual block is untouched (data, id, orderIndex preserved).
    const stillThere = getBlocks().find((b) => b.id === "manual-about");
    expect(stillThere).toEqual(manual);

    // New blocks append AFTER the existing max orderIndex (5) → 6, 7, 8.
    expect(created.map((b) => b.orderIndex)).toEqual([6, 7, 8]);
  });

  it("still records the category as applied when nothing new is added", async () => {
    // Pre-seed all generic kinds manually.
    const kinds = getPageTemplate("HUMAN", "generic").map((s) => s.kind);
    const initial = kinds.map((kind, i) =>
      makeBlock({ id: `m-${kind}`, kind, orderIndex: i }),
    );
    const { deps, getApplied, getBlocks } = makeInMemoryRepo({
      initialBlocks: initial,
    });

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "generic",
    });

    expect(created).toEqual([]);
    expect(getApplied()).toContain("generic");
    expect(getBlocks()).toHaveLength(kinds.length); // no dupes
  });

  it("generic -> musician transition only appends the missing music kinds", async () => {
    const { deps, getBlocks } = makeInMemoryRepo();

    await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "generic",
    });
    const genericKinds = getBlocks().map((b) => b.kind);

    const musicianCreated = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "musician",
    });

    // Universal kinds already present are skipped; only the musician-specific
    // kinds append, in template order (media-first reorder).
    expect(musicianCreated.map((b) => b.kind)).toEqual([
      "music",
      "tracks",
      "video",
      "press",
      "stats",
      "shows",
      "past_shows",
      "genre_tags",
      "rider",
      "booking_info",
    ]);
    // No duplicate universal kinds.
    const allKinds = getBlocks().map((b) => b.kind);
    for (const k of genericKinds) {
      expect(allKinds.filter((x) => x === k)).toHaveLength(1);
    }

    // FR-004: the stats block is seeded hidden (opt-in on the public page);
    // every other seeded block is visible by default.
    const statsBlock = getBlocks().find((b) => b.kind === "stats");
    expect(statsBlock?.visible).toBe(false);
    const showsBlock = getBlocks().find((b) => b.kind === "shows");
    expect(showsBlock?.visible).toBe(true);
  });

  it("generic -> performer transition appends only the performer-specific kinds", async () => {
    const { deps, getBlocks } = makeInMemoryRepo();

    await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "generic",
    });
    const genericKinds = getBlocks().map((b) => b.kind);

    const performerCreated = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "performer",
    });

    // The performer template is self-contained (repeats the universal kinds),
    // but the additive seed appends only what generic did not already place.
    expect(performerCreated.map((b) => b.kind)).toEqual([
      "music",
      "video",
      "genre_tags",
      "booking_info",
    ]);
    const allKinds = getBlocks().map((b) => b.kind);
    for (const k of genericKinds) {
      expect(allKinds.filter((x) => x === k)).toHaveLength(1);
    }
  });

  it("musician -> performer transition appends NOTHING (performer is a subset of musician)", async () => {
    const { deps, getBlocks, getApplied } = makeInMemoryRepo();

    await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "musician",
    });
    const countAfterMusician = getBlocks().length;

    // The default resolution for performer-mode humans is now "performer";
    // an existing musician-template page must gain zero new blocks when that
    // category is seeded on its next editor load.
    const performerCreated = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "HUMAN",
      category: "performer",
    });

    expect(performerCreated).toEqual([]);
    expect(getBlocks()).toHaveLength(countAfterMusician);
    // The category is still recorded as applied so it never re-runs.
    expect(getApplied()).toContain("performer");
  });

  it("org generic -> collective transition appends exactly team, mission, managed_places, past_events", async () => {
    const { deps, getBlocks } = makeInMemoryRepo();

    await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "ORGANIZATION",
      category: "generic",
    });
    expect(getBlocks().map((b) => b.kind)).toEqual([
      "about",
      "links",
      "upcoming_events",
    ]);

    const collectiveCreated = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "ORGANIZATION",
      category: "collective",
    });

    expect(collectiveCreated.map((b) => b.kind)).toEqual([
      "team",
      "mission",
      "managed_places",
      "past_events",
    ]);
    // No duplicated universal kinds.
    const allKinds = getBlocks().map((b) => b.kind);
    expect(new Set(allKinds).size).toBe(allKinds.length);
  });

  // ── Template revisions (one-shot additivity for newly-added kinds) ──────
  // tech_specs was added to PLACE:venue as `sinceRevision: 2` after the
  // original template shipped. Block deletion is a hard delete (no
  // tombstone), so additivity is one-shot per revision — never per editor
  // load — to keep owner deletions deleted.

  /** The original (revision-1) venue template kinds, i.e. everything except
   *  the revision-2 tech_specs. */
  const VENUE_REV1_KINDS = getPageTemplate("PLACE", "venue")
    .filter((s) => (s.sinceRevision ?? 1) <= 1)
    .map((s) => s.kind);

  it("revision bump: an already-applied venue page gains the newer kinds (tech_specs + track_record + rate_venue), appended at the end", async () => {
    const initial = VENUE_REV1_KINDS.map((kind, i) =>
      makeBlock({ id: `m-${kind}`, kind, orderIndex: i }),
    );
    const { deps, getBlocks, getApplied } = makeInMemoryRepo({
      initialBlocks: initial,
      // Bare category marker = revision 1 applied (every pre-existing page).
      appliedCategories: ["venue"],
    });

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "PLACE",
      category: "venue",
    });

    // A rev-1 page lags to the current revision (4), so it gains the rev-2
    // (tech_specs), rev-4 (track_record) and rev-3 (rate_venue) kinds, in
    // TEMPLATE order (not revision order).
    expect(created.map((b) => b.kind)).toEqual([
      "tech_specs",
      "track_record",
      "rate_venue",
    ]);
    // Appended after the existing max orderIndex.
    expect(created[0]!.orderIndex).toBe(VENUE_REV1_KINDS.length);
    // Existing blocks untouched, no duplicates.
    expect(getBlocks()).toHaveLength(VENUE_REV1_KINDS.length + 3);
    // The current-revision marker is recorded alongside the original one.
    expect(getApplied()).toEqual(["venue", "venue@4"]);
  });

  it("revision bump does NOT resurrect a base-template block the owner deleted", async () => {
    // Owner deleted `amenities` (hard delete — indistinguishable from never
    // having had it); the page is at applied revision 1.
    const initial = VENUE_REV1_KINDS.filter((k) => k !== "amenities").map(
      (kind, i) => makeBlock({ id: `m-${kind}`, kind, orderIndex: i }),
    );
    const { deps, getBlocks } = makeInMemoryRepo({
      initialBlocks: initial,
      appliedCategories: ["venue"],
    });

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "PLACE",
      category: "venue",
    });

    // Only the newer tagged kinds seed; amenities stays deleted.
    expect(created.map((b) => b.kind)).toEqual([
      "tech_specs",
      "track_record",
      "rate_venue",
    ]);
    expect(getBlocks().map((b) => b.kind)).not.toContain("amenities");
  });

  it("is a no-op when the current revision is already applied (deleted tech_specs stays deleted)", async () => {
    // Owner deleted tech_specs AFTER the current-revision seed ran.
    const initial = VENUE_REV1_KINDS.map((kind, i) =>
      makeBlock({ id: `m-${kind}`, kind, orderIndex: i }),
    );
    const { deps, repo, getBlocks } = makeInMemoryRepo({
      initialBlocks: initial,
      appliedCategories: ["venue", "venue@4"],
    });

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "PLACE",
      category: "venue",
    });

    expect(created).toEqual([]);
    expect(getBlocks().map((b) => b.kind)).not.toContain("tech_specs");
    // Pre-check short-circuits before any write.
    expect(repo.applyTemplateSeed).not.toHaveBeenCalled();
  });

  it("a never-seeded venue page gets the full template and records the current-revision marker", async () => {
    const { deps, getBlocks, getApplied } = makeInMemoryRepo();

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "PLACE",
      category: "venue",
    });

    const expectedKinds = getPageTemplate("PLACE", "venue").map((s) => s.kind);
    expect(created.map((b) => b.kind)).toEqual(expectedKinds);
    expect(getBlocks()).toHaveLength(expectedKinds.length);
    // `venue@4` alone covers revisions 1..4 (getAppliedTemplateRevision), so
    // a later load is a no-op without needing the bare marker too.
    expect(getApplied()).toEqual(["venue@4"]);
  });

  // ── venue-track-record-and-review-switch FR-011 / FR-012 (revision 4) ─────

  it("revision 3 → 4: a venue page that already has tech_specs + rate_venue gains EXACTLY track_record, appended, visible", async () => {
    const rev3Kinds = getPageTemplate("PLACE", "venue")
      .filter((s) => (s.sinceRevision ?? 1) <= 3)
      .map((s) => s.kind);
    const initial = rev3Kinds.map((kind, i) =>
      makeBlock({ id: `m-${kind}`, kind, orderIndex: i }),
    );
    const { deps, getBlocks, getApplied } = makeInMemoryRepo({
      initialBlocks: initial,
      appliedCategories: ["venue", "venue@3"],
    });

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "PLACE",
      category: "venue",
    });

    expect(created.map((b) => b.kind)).toEqual(["track_record"]);
    expect(created[0]!.visible).toBe(true);
    expect(created[0]!.orderIndex).toBe(rev3Kinds.length);
    expect(getBlocks()).toHaveLength(rev3Kinds.length + 1);
    expect(getApplied()).toEqual(["venue", "venue@3", "venue@4"]);
  });

  it("revision 3 → 4: a STRAY track_record under \"memberships\" never counts as present — the seed attempts the insert, the index REFUSES it as BLOCK_PINNED, and the marker is NOT recorded (surfaced by getMyPage's report on every load until the stray is hand-removed)", async () => {
    const rev3Kinds = getPageTemplate("PLACE", "venue")
      .filter((s) => (s.sinceRevision ?? 1) <= 3)
      .map((s) => s.kind);
    const initial = [
      ...rev3Kinds.map((kind, i) =>
        makeBlock({ id: `m-${kind}`, kind, orderIndex: i }),
      ),
      makeBlock({
        id: "stray",
        kind: "track_record",
        orderIndex: rev3Kinds.length,
        section: "memberships",
      }),
    ];
    const { deps, repo, getBlocks, getApplied } = makeInMemoryRepo({
      initialBlocks: initial,
      appliedCategories: ["venue", "venue@3"],
    });

    await expect(
      seedPageTemplateBlocks(deps, {
        pageId: PAGE_ID,
        ownerType: "PLACE",
        category: "venue",
      }),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "add_duplicate" },
    });
    // Never a quiet skip: the use case did NOT count the stray as present —
    // it sent track_record as a pinned candidate and the adapter tried it.
    const sent = repo.applyTemplateSeed.mock.calls[0]![0] as ApplyTemplateSeedInput;
    expect(sent.blocks).toEqual([
      expect.objectContaining({ kind: "track_record", pinned: true }),
    ]);
    // Rolled back: no main copy, no revision marker, so the next editor load
    // retries (and reports) again.
    expect(getBlocks().filter((b) => b.kind === "track_record")).toEqual([
      expect.objectContaining({ id: "stray", section: "memberships" }),
    ]);
    expect(getApplied()).toEqual(["venue", "venue@3"]);
    // A non-pinned kind is NOT flagged (the section-blind check stays).
    const fresh = makeInMemoryRepo();
    await seedPageTemplateBlocks(fresh.deps, {
      pageId: PAGE_ID,
      ownerType: "PLACE",
      category: "venue",
    });
    const freshSent = fresh.repo.applyTemplateSeed.mock.calls[0]![0] as ApplyTemplateSeedInput;
    expect(freshSent.blocks.filter((b) => b.pinned).map((b) => b.kind)).toEqual([
      "track_record",
    ]);
  });

  it("a page already at revision 4 with track_record present is a no-op (never a second pinned copy)", async () => {
    const allKinds = getPageTemplate("PLACE", "venue").map((s) => s.kind);
    const { deps, repo, getBlocks } = makeInMemoryRepo({
      initialBlocks: allKinds.map((kind, i) =>
        makeBlock({ id: `m-${kind}`, kind, orderIndex: i }),
      ),
      appliedCategories: ["venue", "venue@4"],
    });

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "PLACE",
      category: "venue",
    });

    expect(created).toEqual([]);
    expect(repo.applyTemplateSeed).not.toHaveBeenCalled();
    expect(getBlocks().filter((b) => b.kind === "track_record")).toHaveLength(1);
  });

  it("DOCUMENTED GAP: a page at revision 4 that lost track_record outside the app is NOT re-seeded here — recovery is the managePageBlocks `add` path", async () => {
    // The seeder is one-shot per (category, revision) and `applyTemplateSeed`
    // is marker-guarded, so at the current revision it cannot re-add a kind
    // without a create path that skips the marker — and without a
    // (pageId, kind) uniqueness guard that path would race two editor loads
    // into two undeletable copies. In-app removal is refused (BLOCK_PINNED),
    // so the only way here is a direct DB delete; `managePageBlocks` `add`
    // accepts a pinned kind when the page has none.
    const kinds = getPageTemplate("PLACE", "venue")
      .map((s) => s.kind)
      .filter((k) => k !== "track_record");
    const { deps, repo } = makeInMemoryRepo({
      initialBlocks: kinds.map((kind, i) =>
        makeBlock({ id: `m-${kind}`, kind, orderIndex: i }),
      ),
      appliedCategories: ["venue", "venue@4"],
    });

    const created = await seedPageTemplateBlocks(deps, {
      pageId: PAGE_ID,
      ownerType: "PLACE",
      category: "venue",
    });

    expect(created).toEqual([]);
    expect(repo.applyTemplateSeed).not.toHaveBeenCalled();
  });

  it("returns [] when the page does not exist", async () => {
    const repo = {
      getById: vi.fn(async () => null),
      listBlocks: vi.fn(),
      applyTemplateSeed: vi.fn(),
    };
    const deps: SeedPageTemplateBlocksDeps = {
      repos: { entityPages: repo as never },
    };

    const created = await seedPageTemplateBlocks(deps, {
      pageId: "missing",
      ownerType: "HUMAN",
      category: "musician",
    });

    expect(created).toEqual([]);
    expect(repo.applyTemplateSeed).not.toHaveBeenCalled();
  });
});
