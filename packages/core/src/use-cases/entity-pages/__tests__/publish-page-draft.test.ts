import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { PageDraftRecord } from "@th/types/repos/entity-pages";

import { normalizeBlockData } from "../block-config";
import { discardPageDraft } from "../discard-page-draft";
import { PAGE_DRAFT_DISCARD_DELETION_SOURCE } from "../page-draft-shared";
import { PAGE_IMAGE_CANCEL_CHUNK_SIZE } from "../page-image-urls";
import {
  publishPageDraft,
  type PublishPageDraftOutput,
} from "../publish-page-draft";
import { savePageDraft, type SavePageDraftOutput } from "../save-page-draft";
import {
  CDN,
  HUMAN_A,
  HUMAN_B,
  NOW,
  OUTSIDER,
  PAGE_ID,
  PLACE_ID,
  block,
  liveBlocks,
  makeHarness,
  ownedImage,
  rawUploadImage,
  ownedKey,
  ownerInput,
  type Harness,
  type HarnessOptions,
} from "./page-draft-harness";

const HUMAN_C = "human-c";

function deps(h: Harness, extra: Record<string, unknown> = {}) {
  return {
    repos: h.repos,
    authz: h.authz,
    clock: h.clock,
    logger: h.logger,
    storagePublicBaseUrl: CDN,
    ...extra,
  };
}

async function save(
  h: Harness,
  ops: unknown[],
  actor: string = HUMAN_A,
): Promise<number> {
  const result: SavePageDraftOutput = await savePageDraft(deps(h), {
    ...ownerInput(actor),
    batchId: randomUUID(),
    clientRevision: h.row()?.revision ?? 0,
    ops,
  });
  if (result.outcome !== "applied") {
    throw new Error(`save not applied: ${JSON.stringify(result)}`);
  }
  return result.revision;
}

function publish(
  h: Harness,
  draftRevision: number,
  opts: {
    actor?: string;
    resolutions?: Record<string, unknown>;
    ownerId?: string;
    extraDeps?: Record<string, unknown>;
  } = {},
): Promise<PublishPageDraftOutput> {
  return publishPageDraft(deps(h, opts.extraDeps), {
    ...ownerInput(opts.actor ?? HUMAN_A, "PLACE", opts.ownerId ?? PLACE_ID),
    draftRevision,
    ...(opts.resolutions && { resolutions: opts.resolutions }),
  });
}

function expectPublished(result: PublishPageDraftOutput) {
  if (result.outcome !== "published" || result.replayed) {
    throw new Error(`expected a fresh publish, got ${JSON.stringify(result)}`);
  }
  return result;
}

function blockData(h: Harness, id: string): Record<string, unknown> {
  const found = h.blocks().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no block ${id}`);
  return found.data as Record<string, unknown>;
}

/** Everything publish could write, for "nothing was written" checks. */
function liveState(h: Harness) {
  return {
    page: h.page(),
    theme: h.theme(),
    blocks: h.blocks(),
    place: h.place(),
    slugHistory: h.slugHistory(),
    audits: h.audits(),
    marks: h.marks(),
  };
}

function draftRow(overrides: Partial<PageDraftRecord>): PageDraftRecord {
  return {
    id: "draft-1",
    pageId: PAGE_ID,
    data: {},
    placePatch: {},
    placeBase: {},
    fieldEditors: {},
    appliedBatchIds: [],
    revision: 1,
    lastPublishedRevision: null,
    updatedByHumanId: HUMAN_A,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const NEW_FAQ = `new:${randomUUID()}`;

describe("publishPageDraft: happy path", () => {
  it("writes page, theme, blocks and Place in one transaction, then clears the draft", async () => {
    const h = makeHarness();
    const rev = await save(h, [
      { path: "page.bio", value: "A short line." },
      { path: "page.slug", value: "the-new-room" },
      { path: "theme.colorBg", value: "#112233" },
      { path: "place.capacity", value: 300 },
      {
        path: "blocks.blk-about.data.content",
        value: "<p><strong>Bold</strong> news</p>",
      },
      { path: "blocks.blk-amenities.visible", value: false },
      { path: `blocks.${NEW_FAQ}.kind`, value: "faq" },
      {
        path: `blocks.${NEW_FAQ}.data.items`,
        value: [{ question: "Parking?", answer: "Street only." }],
      },
      { path: "blocks.blk-tech.removed", value: true },
    ]);

    const result = expectPublished(await publish(h, rev));
    expect(result.publishedRevision).toBe(rev + 1);
    expect(result.revision).toBe(rev + 1);
    expect(result.placeWritten).toBe(true);
    expect(result.skippedEmptyBlockIds).toEqual([]);

    // Page and its slug history.
    expect(h.page()).toMatchObject({
      bio: "A short line.",
      slug: "the-new-room",
    });
    expect(h.slugHistory()).toEqual([{ pageId: PAGE_ID, slug: "the-room" }]);
    // Theme.
    expect(h.theme()).toMatchObject({ colorBg: "#112233" });
    // Blocks: updated, hidden, created, deleted, ordered.
    expect(blockData(h, "blk-about").content).toBe(
      "<p><strong>Bold</strong> news</p>",
    );
    expect(h.blocks().find((b) => b.id === "blk-amenities")?.visible).toBe(
      false,
    );
    const createdId = result.createdBlockIds[NEW_FAQ]!;
    expect(createdId).toBeDefined();
    expect(blockData(h, createdId).items).toEqual([
      { question: "Parking?", answer: "Street only." },
    ]);
    expect(h.blocks().some((b) => b.id === "blk-tech")).toBe(false);
    const order = h.blocks().map((b) => b.kind);
    expect(order[0]).toBe("about");
    expect(order[1]).toBe("photos");
    expect(order[order.length - 1]).toBe("booking_info");
    expect(order).toContain("faq");
    // Place, through upsertPlace's write path (its audit row included).
    expect(h.place().capacity).toBe(300);
    expect(h.place().name).toBe("The Room");
    expect(h.audits().map((entry) => entry.action)).toEqual([
      "updated",
      "entity_page.draft_published",
    ]);

    // Cleared in one UPDATE, the row kept.
    expect(h.entityPages.clearDraft).toHaveBeenCalledTimes(1);
    expect(h.entityPages.clearDraft).toHaveBeenCalledWith(PAGE_ID, {
      revision: rev + 1,
      lastPublishedRevision: rev + 1,
      updatedByHumanId: HUMAN_A,
    });
    expect(h.row()).toMatchObject({
      data: {},
      placePatch: {},
      placeBase: {},
      revision: rev + 1,
      lastPublishedRevision: rev + 1,
    });
  });

  it("queues the search reindex mark for the venue", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    expectPublished(await publish(h, rev));
    expect(h.marks()).toEqual([{ entityType: "place", entityId: PLACE_ID }]);
  });

  it("does not touch Place when the draft has no Place patch", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    const result = expectPublished(await publish(h, rev));
    expect(result.placeWritten).toBe(false);
    expect(h.places.upsert).not.toHaveBeenCalled();
    expect(h.events.lockLocationsAtPlace).not.toHaveBeenCalled();
  });

  it("an address change runs the tax lookup BEFORE the transaction, then writes it", async () => {
    const h = makeHarness();
    const rev = await save(h, [
      {
        path: "place.address",
        value: {
          formatted: "9 Side St, Minneapolis, MN 55401",
          line1: "9 Side St",
          city: "Minneapolis",
          region: "MN",
          postalCode: "55401",
          countryCode: "US",
        },
      },
    ]);
    const locksBefore = h.entityPages.lockDraftForUpdate.mock.calls.length;
    const lookupByPostalCode = vi.fn(async () => {
      // Outside the transaction: publish has not taken the draft lock yet.
      expect(h.entityPages.lockDraftForUpdate.mock.calls.length).toBe(
        locksBefore,
      );
      return { rateBps: 900, source: "test" };
    });
    const result = expectPublished(
      await publish(h, rev, {
        extraDeps: { taxRateLookup: { lookupByPostalCode } },
      }),
    );
    expect(result.placeWritten).toBe(true);
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(h.place()).toMatchObject({
      formattedAddress: "9 Side St, Minneapolis, MN 55401",
      postalCode: "55401",
    });
  });

  it("skips a new block with no content (FR-011)", async () => {
    const h = makeHarness();
    const empty = `new:${randomUUID()}`;
    const headingOnly = `new:${randomUUID()}`;
    const rev = await save(h, [
      { path: "page.bio", value: "New." },
      { path: `blocks.${empty}.kind`, value: "faq" },
      { path: `blocks.${headingOnly}.kind`, value: "house_rules" },
      { path: `blocks.${headingOnly}.data.heading`, value: "Rules" },
    ]);
    const before = h.blocks().length;
    const result = expectPublished(await publish(h, rev));
    expect(result.skippedEmptyBlockIds.sort()).toEqual(
      [empty, headingOnly].sort(),
    );
    expect(result.createdBlockIds).toEqual({});
    expect(h.entityPages.createBlock).not.toHaveBeenCalled();
    expect(h.blocks()).toHaveLength(before);
  });
});

describe("publishPageDraft: Place conflicts (R9)", () => {
  async function conflicted() {
    const h = makeHarness();
    const rev = await save(h, [
      { path: "place.capacity", value: 300 },
      { path: "page.bio", value: "New." },
    ]);
    h.setPlace({ capacity: 250 }); // Settings changed it meanwhile.
    return { h, rev };
  }

  it("returns both values and writes NOTHING", async () => {
    const { h, rev } = await conflicted();
    const rowBefore = h.row();
    const before = liveState(h);
    const result = await publish(h, rev);
    expect(result).toEqual({
      outcome: "conflicts",
      revision: rev,
      conflicts: [{ field: "capacity", base: 200, live: 250, mine: 300 }],
    });
    expect(liveState(h)).toEqual(before);
    expect(h.row()).toEqual(rowBefore);
    expect(h.places.upsert).not.toHaveBeenCalled();
    expect(h.entityPages.clearDraft).not.toHaveBeenCalled();
  });

  it("compares under the place-location lock, taken before the Place read", async () => {
    const { h, rev } = await conflicted();
    await publish(h, rev);
    expect(h.events.lockLocationsAtPlace).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      mode: "exclusive",
    });
    const lockOrder =
      h.events.lockLocationsAtPlace.mock.invocationCallOrder[0]!;
    const readOrders = h.places.getById.mock.invocationCallOrder;
    expect(readOrders.some((order) => order > lockOrder)).toBe(true);
  });

  it("'mine' (chosen against the live value) writes the draft's value", async () => {
    const { h, rev } = await conflicted();
    expectPublished(
      await publish(h, rev, {
        resolutions: { capacity: { choice: "mine", live: 250 } },
      }),
    );
    expect(h.place().capacity).toBe(300);
    expect(h.page()?.bio).toBe("New.");
  });

  it("'theirs' (chosen against the live value) keeps live and publishes the rest", async () => {
    const { h, rev } = await conflicted();
    const result = expectPublished(
      await publish(h, rev, {
        resolutions: { capacity: { choice: "theirs", live: 250 } },
      }),
    );
    expect(result.placeWritten).toBe(false);
    expect(h.place().capacity).toBe(250);
    expect(h.page()?.bio).toBe("New.");
    expect(h.row()?.placePatch).toEqual({});
  });

  it.each(["mine", "theirs"] as const)(
    "a second Settings change after the picker opened conflicts again ('%s'), nothing written",
    async (choice) => {
      const { h, rev } = await conflicted();
      expect(await publish(h, rev)).toMatchObject({ outcome: "conflicts" });
      h.setPlace({ capacity: 275 }); // Settings again, while the picker is open.
      const before = liveState(h);
      const rowBefore = h.row();
      expect(
        await publish(h, rev, {
          resolutions: { capacity: { choice, live: 250 } },
        }),
      ).toEqual({
        outcome: "conflicts",
        revision: rev,
        conflicts: [{ field: "capacity", base: 200, live: 275, mine: 300 }],
      });
      expect(liveState(h)).toEqual(before);
      expect(h.row()).toEqual(rowBefore);
      expect(h.places.upsert).not.toHaveBeenCalled();
    },
  );

  it("an up-front resolution whose live value does not match is a conflict (R9 not bypassed)", async () => {
    const { h, rev } = await conflicted();
    const before = liveState(h);
    expect(
      await publish(h, rev, {
        // Sent before any conflict was shown: the client guessed live.
        resolutions: { capacity: { choice: "mine", live: 200 } },
      }),
    ).toMatchObject({
      outcome: "conflicts",
      conflicts: [{ field: "capacity", live: 250 }],
    });
    expect(liveState(h)).toEqual(before);
  });

  it("an up-front 'mine' on a field with no conflict and a stale live is a conflict", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "place.capacity", value: 300 }]);
    expect(
      await publish(h, rev, {
        resolutions: { capacity: { choice: "mine", live: 999 } },
      }),
    ).toMatchObject({
      outcome: "conflicts",
      conflicts: [{ field: "capacity", base: 200, live: 200, mine: 300 }],
    });
    expect(h.place().capacity).toBe(200);
  });

  it("a resolution without the live value it was chosen against is refused as input", async () => {
    const { h, rev } = await conflicted();
    await expect(
      publish(h, rev, { resolutions: { capacity: { choice: "mine" } } }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: [
        expect.objectContaining({ path: ["resolutions", "capacity", "live"] }),
      ],
    });
    expect(h.place().capacity).toBe(250);
  });

  it("no conflict when Settings already set the draft's value", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "place.capacity", value: 300 }]);
    h.setPlace({ capacity: 300 });
    expectPublished(await publish(h, rev));
    expect(h.place().capacity).toBe(300);
  });

  it("iterates the patch, not placeBase (a stale base for a reverted field is ignored)", async () => {
    const h = makeHarness();
    h.setRow(
      draftRow({
        data: { "page.bio": "New." },
        placePatch: {},
        placeBase: { capacity: 1 },
      }),
    );
    expectPublished(await publish(h, 1));
  });
});

describe("publishPageDraft: the Place write", () => {
  it("a phone-only publish rewrites the stored address unchanged (NULL line kept, jurisdiction kept)", async () => {
    const h = makeHarness();
    h.setPlace({
      addressLine1: null,
      postalCode: "55401",
      admissionTaxRateBps: 900,
      taxRateSource: "test",
    });
    const before = h.place();
    const rev = await save(h, [{ path: "place.phone", value: "+16125550100" }]);
    expectPublished(await publish(h, rev));
    const after = h.place();
    expect(after.phone).toBe("+16125550100");
    for (const column of [
      "formattedAddress",
      "addressLine1",
      "addressLine2",
      "city",
      "region",
      "postalCode",
      "countryCode",
      "addressHash",
      "admissionTaxRateBps",
      "taxRateSource",
    ]) {
      expect([column, after[column]]).toEqual([column, before[column]]);
    }
  });

  it.each([
    ["no country", { countryCode: null }],
    ["no formatted address", { formattedAddress: null }],
  ])(
    "a phone-only publish on a place with %s is refused; address and jurisdiction untouched",
    async (_label, stored) => {
      const h = makeHarness();
      h.setPlace({ ...stored, admissionTaxRateBps: 900, taxRateSource: "t" });
      const rev = await save(h, [
        { path: "place.phone", value: "+16125550100" },
        { path: "page.bio", value: "New." },
      ]);
      const before = liveState(h);
      expect(await publish(h, rev)).toMatchObject({
        outcome: "refused",
        errors: [
          {
            path: "place.address",
            code: "value_invalid",
            meta: { issues: ["stored_address_incomplete"] },
          },
        ],
      });
      expect(liveState(h)).toEqual(before);
      expect(h.places.upsert).not.toHaveBeenCalled();
    },
  );

  it("an ownership removed after the pre-transaction check is caught under the lock", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "place.capacity", value: 300 }]);
    const owned = h.place();
    // The pre-transaction read still sees the org's access; then it is
    // removed before the transaction re-reads the row.
    h.places.getById.mockImplementationOnce(async () => owned);
    h.setPlace({ orgIdsWithAccess: [] });
    const before = liveState(h);
    await expect(publish(h, rev)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(liveState(h)).toEqual(before);
    expect(h.places.upsert).not.toHaveBeenCalled();
  });
});

describe("publishPageDraft: idempotency and the three branches", () => {
  it("(b) a retry of an applied publish is a no-op", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    expectPublished(await publish(h, rev));
    const upserts = h.entityPages.upsert.mock.calls.length;
    const before = liveState(h);

    const retry = await publish(h, rev);
    expect(retry).toEqual({
      outcome: "published",
      replayed: true,
      publishedRevision: rev + 1,
      revision: rev + 1,
    });
    expect(h.entityPages.upsert.mock.calls.length).toBe(upserts);
    expect(liveState(h)).toEqual(before);
  });

  it("(b) holds after a peer's autosave; the peer's edit stays in the draft", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    expectPublished(await publish(h, rev));
    const peerRev = await save(
      h,
      [{ path: "theme.colorBg", value: "#000000" }],
      HUMAN_B,
    );
    expect(peerRev).toBe(rev + 2);

    const retry = await publish(h, rev);
    expect(retry).toMatchObject({
      outcome: "published",
      replayed: true,
      publishedRevision: rev + 1,
      revision: peerRev,
    });
    expect(h.row()?.data).toEqual({ "theme.colorBg": "#000000" });
    expect(h.theme()?.colorBg ?? null).toBe(null);
  });

  it("(c) DISCARDED names who discarded it", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    await discardPageDraft(deps(h), {
      ...ownerInput(HUMAN_B),
      expectedRevision: rev,
    });
    const result = await publish(h, rev);
    expect(result).toEqual({
      outcome: "discarded",
      revision: rev + 1,
      discardedBy: { humanId: HUMAN_B, name: "Ben" },
    });
    expect(h.page()?.bio).toBe("Live bio");
  });

  it("(c) DISCARDED by an account that no longer resolves has no name", async () => {
    const h = makeHarness({ humans: [{ id: HUMAN_A, name: "Ana" }] });
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    await discardPageDraft(deps(h), {
      ...ownerInput(HUMAN_B),
      expectedRevision: rev,
    });
    expect(await publish(h, rev)).toMatchObject({
      outcome: "discarded",
      discardedBy: { humanId: HUMAN_B, name: null },
    });
  });

  it("(c) STALE when another editor saved after draftRevision", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "Mine." }]);
    await save(h, [{ path: "theme.colorBg", value: "#000000" }], HUMAN_B);
    const before = liveState(h);
    expect(await publish(h, rev)).toEqual({
      outcome: "stale",
      revision: rev + 1,
    });
    // Equality, never >=: the newer non-empty draft is not published.
    expect(liveState(h)).toEqual(before);
    expect(h.row()?.data).toEqual({
      "page.bio": "Mine.",
      "theme.colorBg": "#000000",
    });
  });

  it("(c) STALE, not DISCARDED, when a discard was followed by a save", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    await discardPageDraft(deps(h), {
      ...ownerInput(HUMAN_B),
      expectedRevision: rev,
    });
    await save(h, [{ path: "theme.colorBg", value: "#000000" }], HUMAN_B);
    expect(await publish(h, rev)).toEqual({
      outcome: "stale",
      revision: rev + 2,
    });
  });

  it("(c) STALE for an empty draft at draftRevision", async () => {
    const h = makeHarness();
    expect(await publish(h, 0)).toEqual({ outcome: "stale", revision: 0 });
    expect(h.entityPages.clearDraft).not.toHaveBeenCalled();
  });
});

describe("publishPageDraft: refusals and errors write nothing", () => {
  it("a pinned block's removal throws BLOCK_PINNED", async () => {
    const h = makeHarness();
    h.setRow(
      draftRow({
        data: { "page.bio": "New.", "blocks.blk-track.removed": true },
      }),
    );
    const before = liveState(h);
    await expect(publish(h, 1)).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "delete" },
    });
    expect(liveState(h)).toEqual(before);
    expect(h.row()?.revision).toBe(1);
  });

  it("hiding a pinned block throws BLOCK_PINNED", async () => {
    const h = makeHarness();
    h.setRow(draftRow({ data: { "blocks.blk-track.visible": false } }));
    await expect(publish(h, 1)).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { attempted: "hide" },
    });
  });

  it("the adapter's pinned-index refusal (P2002 → BLOCK_PINNED) rolls everything back", async () => {
    // A stray non-main copy passes core's main-section check; the
    // section-blind unique index refuses the insert.
    const blocks = liveBlocks()
      .filter((existing) => existing.kind !== "track_record")
      .concat(
        block("blk-stray", "track_record", 9, { section: "memberships" }),
      );
    const h = makeHarness({ blocks });
    const added = `new:${randomUUID()}`;
    h.setRow(
      draftRow({
        data: { "page.bio": "New.", [`blocks.${added}.kind`]: "track_record" },
      }),
    );
    const before = liveState(h);
    await expect(publish(h, 1)).rejects.toMatchObject({ code: "BLOCK_PINNED" });
    expect(liveState(h)).toEqual(before);
    expect(h.row()?.data).toMatchObject({ "page.bio": "New." });
  });

  it("a mid-transaction failure rolls back every write and leaves the draft", async () => {
    const h = makeHarness();
    const rev = await save(h, [
      { path: "page.bio", value: "New." },
      { path: "theme.colorBg", value: "#112233" },
      { path: "blocks.blk-about.data.heading", value: "Hello" },
      { path: "place.capacity", value: 300 },
    ]);
    const rowBefore = h.row();
    const before = liveState(h);
    h.places.upsert.mockRejectedValueOnce(new Error("connection reset"));
    await expect(publish(h, rev)).rejects.toThrow("connection reset");
    // The page, theme and block writes ran before the failure, and are gone.
    expect(h.entityPages.upsert).toHaveBeenCalled();
    expect(h.entityPages.updateBlock).toHaveBeenCalled();
    expect(liveState(h)).toEqual(before);
    expect(h.row()).toEqual(rowBefore);
  });

  it("a 40P01 deadlock against a page deletion surfaces, unreported", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    const deadlock = Object.assign(new Error("deadlock detected"), {
      code: "40P01",
    });
    h.entityPages.lockDraftForUpdate.mockRejectedValueOnce(deadlock);
    const reportError = vi.fn();
    await expect(publish(h, rev, { extraDeps: { reportError } })).rejects.toBe(
      deadlock,
    );
    expect(reportError).not.toHaveBeenCalled();
    expect(h.page()?.bio).toBe("Live bio");
  });

  it("a slug another page holds throws SLUG_TAKEN, as updatePage does", async () => {
    const h = makeHarness({ takenSlugs: ["taken"] });
    const rev = await save(h, [
      { path: "page.slug", value: "taken" },
      { path: "page.bio", value: "New." },
    ]);
    const before = liveState(h);
    await expect(publish(h, rev)).rejects.toMatchObject({ code: "SLUG_TAKEN" });
    expect(liveState(h)).toEqual(before);
    expect(h.row()?.revision).toBe(rev);
  });

  it("an invalid Place value in the row is refused through upsertPlace's schema", async () => {
    const h = makeHarness();
    h.setRow(
      draftRow({
        placePatch: { phone: "not a phone" },
        placeBase: { phone: null },
      }),
    );
    const result = await publish(h, 1);
    expect(result).toMatchObject({
      outcome: "refused",
      errors: [{ path: "place.phone", code: "value_invalid" }],
    });
    expect(h.places.upsert).not.toHaveBeenCalled();
  });
});

describe("publishPageDraft: authz (R13)", () => {
  it("refuses a non-member before touching the draft", async () => {
    const h = makeHarness();
    const rev = await save(h, [{ path: "page.bio", value: "New." }]);
    await expect(publish(h, rev, { actor: OUTSIDER })).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(h.entityPages.lockDraftForUpdate).toHaveBeenCalledTimes(1); // the save
    expect(h.page()?.bio).toBe("Live bio");
  });

  it("refuses a place-1 manager targeting place-2", async () => {
    const h = makeHarness({
      placeManagers: { [HUMAN_A]: [PLACE_ID] },
    });
    await expect(publish(h, 1, { ownerId: "place-2" })).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  // Owner ruling 2026-10-15: a community moderator has an owner's access to
  // the draft use cases on a PLACE nobody owns (resolveEntityPageEditor),
  // and is refused PLACE_HAS_OWNER once somebody owns or claims it.
  // (community-moderator-page-access.test.ts covers the lock and audit.)
  it("publishes for a community moderator on an unowned ACTIVE place", async () => {
    const h = makeHarness({ moderators: [OUTSIDER] });
    h.setPlace({ orgIdsWithAccess: [], verificationStatus: "UNVERIFIED" });
    h.setRow(draftRow({ data: { "page.bio": "New." } }));
    expectPublished(await publish(h, 1, { actor: OUTSIDER }));
    expect(h.page()?.bio).toBe("New.");
    expect(h.claimLocks()).toEqual([`claim:${PLACE_ID}`]);
  });

  it("refuses a community moderator PLACE_HAS_OWNER on an OWNED place", async () => {
    const h = makeHarness({ moderators: [OUTSIDER] });
    // The harness place has a verified owning org.
    h.setRow(draftRow({ data: { "page.bio": "New." } }));
    await expect(publish(h, 1, { actor: OUTSIDER })).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "OWNED" },
    });
    expect(h.page()?.bio).toBe("Live bio");
    expect(h.entityPages.lockDraftForUpdate).not.toHaveBeenCalled();
  });

  it("refuses a community moderator PLACE_HAS_OWNER while a claim is pending", async () => {
    const h = makeHarness({ moderators: [OUTSIDER] });
    h.setPlace({ orgIdsWithAccess: [], verificationStatus: "UNVERIFIED" });
    h.setOwnerships([{ id: "own-1", humanId: HUMAN_B, verified: false }]);
    h.setRow(draftRow({ data: { "page.bio": "New." } }));
    await expect(publish(h, 1, { actor: OUTSIDER })).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
    expect(h.page()?.bio).toBe("Live bio");
  });

  it("refuses an org VIEWER (canManagePlace says no)", async () => {
    const h = makeHarness({
      placeManagers: {},
      orgRoles: { [HUMAN_A]: { "org-1": "VIEWER" } },
    });
    await expect(publish(h, 1)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  // No real role can edit the page but not the Place: canManagePlace and
  // upsertPlace's check accept the same verified owners and ORG_EDIT_ROLES.
  // This fakes a divergence to prove the Place write runs upsertPlace's own
  // check and adds no access.
  it("a page editor upsertPlace would refuse publishes the page, never the Place", async () => {
    const options: HarnessOptions = {
      placeManagers: { [HUMAN_C]: [PLACE_ID] },
      humans: [{ id: HUMAN_C, name: "Cy" }],
      orgRoles: {},
    };
    const pageOnly = makeHarness(options);
    const rev = await save(
      pageOnly,
      [{ path: "page.bio", value: "New." }],
      HUMAN_C,
    );
    expectPublished(await publish(pageOnly, rev, { actor: HUMAN_C }));

    const withPlace = makeHarness(options);
    const rev2 = await save(
      withPlace,
      [
        { path: "page.bio", value: "New." },
        { path: "place.capacity", value: 300 },
      ],
      HUMAN_C,
    );
    await expect(
      publish(withPlace, rev2, { actor: HUMAN_C }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(withPlace.place().capacity).toBe(200);
    expect(withPlace.page()?.bio).toBe("Live bio");
  });

  it("a verified human owner writes the Place as themself", async () => {
    const h = makeHarness({ orgRoles: {} });
    h.setPlace({ orgIdsWithAccess: [], humanIdsWithAccess: [HUMAN_A] });
    const rev = await save(h, [{ path: "place.name", value: "New Room" }]);
    expectPublished(await publish(h, rev));
    expect(h.place().name).toBe("New Room");
    expect(h.places.upsert.mock.calls[0]![0].owner).toEqual({
      kind: "human",
      humanId: HUMAN_A,
    });
  });
});

describe("publishPageDraft: rich text", () => {
  it("stores sanitised HTML: script and onerror gone, allowed tags kept", async () => {
    const h = makeHarness();
    const rev = await save(h, [
      {
        path: "blocks.blk-about.data.content",
        value:
          '<p>Hi <strong>there</strong> <em>you</em><script>alert(1)</script><img src=x onerror="alert(1)"></p><ul><li><a href="https://example.test">link</a></li></ul>',
      },
    ]);
    expectPublished(await publish(h, rev));
    const content = blockData(h, "blk-about").content as string;
    expect(content).not.toMatch(/<script|onerror|<img/i);
    expect(content).toContain("<strong>there</strong>");
    expect(content).toContain("<em>you</em>");
    expect(content).toContain(
      '<ul><li><a href="https://example.test/" rel="noopener noreferrer nofollow">link</a></li></ul>',
    );
  });

  it("re-sanitises a row written behind save's back", async () => {
    const h = makeHarness();
    h.setRow(
      draftRow({
        data: {
          "blocks.blk-about.data.content":
            '<p>ok</p><img src=x onerror="alert(1)"><script>x()</script>',
        },
      }),
    );
    expectPublished(await publish(h, 1));
    const content = blockData(h, "blk-about").content as string;
    expect(content).toBe("<p>ok</p>");
  });

  it("converts legacy plain text to paragraphs when the block is published (FR-022)", async () => {
    const h = makeHarness();
    const rev = await save(h, [
      { path: "blocks.blk-about.data.heading", value: "About us" },
    ]);
    expectPublished(await publish(h, rev));
    expect(blockData(h, "blk-about")).toMatchObject({
      heading: "About us",
      content: "<p>We host shows.</p>",
    });
  });

  // Until step 7 ships the HTML renderer, the old editor's path
  // (managePageBlocks → normalizeBlockData) stays PLAIN TEXT: the public
  // About/Mission blocks render `content` as text, so HTML stored there
  // would show as literal tags.
  it("the old editor's writes stay plain text: tags are stripped, never stored as HTML", () => {
    expect(normalizeBlockData("about", { content: "Fish & chips" })).toEqual({
      ok: true,
      data: { content: "Fish & chips" },
    });
    const html = normalizeBlockData("mission", {
      content: "<p>We <b>care</b><script>x()</script></p>",
    });
    expect(html.ok).toBe(true);
    const stored = html.ok ? (html.data.content as string) : "";
    expect(stored).not.toMatch(/[<>]/);
    expect(stored).toContain("care");
    const tooLong = normalizeBlockData("about", {
      content: "a".repeat(10_001),
    });
    expect(tooLong.ok).toBe(false);
  });
});

describe("publishPageDraft: images", () => {
  it("cancels pending deletes for every key the whole draft mentions", async () => {
    const h = makeHarness();
    await h.pendingObjectDeletions.enqueueMany([
      {
        targetKey: ownedKey("queued"),
        targetKind: "KEY",
        source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
      },
    ]);
    h.setRow(
      draftRow({
        data: {
          "page.bannerUrl": ownedImage("queued"),
          "blocks.blk-photos.data.photos": [{ url: ownedImage("other") }],
        },
      }),
    );
    expectPublished(await publish(h, 1));
    const call = h.pendingObjectDeletions.cancelPending.mock.calls.at(-1)![0];
    expect(call.source).toBe(PAGE_DRAFT_DISCARD_DELETION_SOURCE);
    expect(call.targetKeys).toEqual(
      expect.arrayContaining([ownedKey("queued"), ownedKey("other")]),
    );
    expect(h.pending()).toEqual([]);
    expect(h.page()?.bannerUrl).toBe(ownedImage("queued"));
  });

  it("5,000 keys: every one is cancelled, across chunks of the cancel size", async () => {
    const h = makeHarness();
    const keys = Array.from({ length: 5_000 }, (_, i) => ownedKey(`k${i}`));
    await h.pendingObjectDeletions.enqueueMany(
      keys.map((targetKey) => ({
        targetKey,
        targetKind: "KEY" as const,
        source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
      })),
    );
    h.setRow(
      draftRow({
        data: {
          "page.bio": "New.",
          // A removed block's leftover leaves still mention its images; the
          // scan covers the whole draft, wherever a key appears.
          "blocks.blk-tech.removed": true,
          "blocks.blk-tech.data.notes": keys.join(" "),
        },
      }),
    );
    expectPublished(await publish(h, 1));
    const calls = h.pendingObjectDeletions.cancelPending.mock.calls.map(
      ([arg]) => arg as { source: string; targetKeys: string[] },
    );
    expect(calls).toHaveLength(Math.ceil(5_000 / PAGE_IMAGE_CANCEL_CHUNK_SIZE));
    expect(
      calls.every(
        (call) =>
          call.source === PAGE_DRAFT_DISCARD_DELETION_SOURCE &&
          call.targetKeys.length <= PAGE_IMAGE_CANCEL_CHUNK_SIZE,
      ),
    ).toBe(true);
    expect(new Set(calls.flatMap((call) => call.targetKeys))).toEqual(
      new Set(keys),
    );
    expect(h.pending()).toEqual([]);
  });

  describe("photo list ownership", () => {
    const PHOTOS = "blocks.blk-photos.data.photos";
    const OUTSIDE_LIVE = "https://elsewhere.test/live-outside.jpg";

    function harness() {
      const h = makeHarness();
      h.setBlocks(
        h
          .blocks()
          .map((existing) =>
            existing.id === "blk-photos"
              ? { ...existing, data: { photos: [{ url: OUTSIDE_LIVE }] } }
              : existing,
          ),
      );
      return h;
    }

    it("publishes this page's own upload", async () => {
      const h = harness();
      h.setRow(draftRow({ data: { [PHOTOS]: [{ url: ownedImage("mine") }] } }));
      expectPublished(await publish(h, 1));
      expect(blockData(h, "blk-photos").photos).toEqual([
        { url: ownedImage("mine") },
      ]);
    });

    it("keeps an outside URL the live page already shows", async () => {
      const h = harness();
      h.setRow(
        draftRow({
          data: {
            [PHOTOS]: [{ url: ownedImage("mine") }, { url: OUTSIDE_LIVE }],
          },
        }),
      );
      expectPublished(await publish(h, 1));
    });

    it("refuses a NEW outside URL, writing nothing", async () => {
      const h = harness();
      h.setRow(
        draftRow({
          data: {
            "page.bio": "New.",
            [PHOTOS]: [{ url: "https://evil.test/x.jpg" }],
          },
        }),
      );
      const before = liveState(h);
      expect(await publish(h, 1)).toMatchObject({
        outcome: "refused",
        errors: [{ path: PHOTOS, code: "image_url_not_allowed" }],
      });
      expect(liveState(h)).toEqual(before);
    });

    it("refuses a ?w=800 variant of an owned key", async () => {
      const h = harness();
      h.setRow(
        draftRow({
          data: { [PHOTOS]: [{ url: `${ownedImage("mine")}?w=800` }] },
        }),
      );
      expect(await publish(h, 1)).toMatchObject({
        outcome: "refused",
        errors: [{ code: "image_url_not_allowed" }],
      });
    });

    it("refuses a RAW upload key (uuid name: original bytes, GPS included)", async () => {
      const h = harness();
      h.setRow(draftRow({ data: { [PHOTOS]: [{ url: rawUploadImage() }] } }));
      expect(await publish(h, 1)).toMatchObject({
        outcome: "refused",
        errors: [{ path: PHOTOS, code: "image_url_not_allowed" }],
      });
    });

    it("accepts a stripped copy (32-hex name)", async () => {
      const h = harness();
      const stripped = `${CDN}/entity-pages/place/${PLACE_ID}/2026-10-08/${"a".repeat(32)}.webp`;
      h.setRow(draftRow({ data: { [PHOTOS]: [{ url: stripped }] } }));
      expectPublished(await publish(h, 1));
      expect(blockData(h, "blk-photos").photos).toEqual([{ url: stripped }]);
    });
  });

  it("refuses a raw upload as the avatar", async () => {
    const h = makeHarness();
    h.setRow(draftRow({ data: { "page.avatarUrl": rawUploadImage() } }));
    expect(await publish(h, 1)).toMatchObject({
      outcome: "refused",
      errors: [{ path: "page.avatarUrl", code: "image_url_not_allowed" }],
    });
  });

  it("keeps a live avatar that predates stripping (not new)", async () => {
    const h = makeHarness();
    h.setPage({ ...h.page()!, avatarUrl: rawUploadImage() });
    h.setRow(
      draftRow({
        data: { "page.avatarUrl": rawUploadImage(), "page.bio": "New." },
      }),
    );
    expectPublished(await publish(h, 1));
    expect(h.page()?.avatarUrl).toBe(rawUploadImage());
  });

  it("an avatar must be this page's upload or its live value", async () => {
    const h = makeHarness();
    h.setRow(
      draftRow({ data: { "page.avatarUrl": "https://evil.test/a.jpg" } }),
    );
    expect(await publish(h, 1)).toMatchObject({
      outcome: "refused",
      errors: [{ path: "page.avatarUrl", code: "image_url_not_allowed" }],
    });
  });
});
