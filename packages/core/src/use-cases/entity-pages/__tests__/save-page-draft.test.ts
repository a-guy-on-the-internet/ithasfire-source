import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { discardPageDraft } from "../discard-page-draft";
import { getPageDraft } from "../get-page-draft";
import { PAGE_DRAFT_DISCARD_DELETION_SOURCE } from "../page-draft-shared";
import {
  savePageDraft,
  type SavePageDraftOutput,
} from "../save-page-draft";
import {
  CDN,
  HUMAN_A,
  HUMAN_B,
  ORG_ID,
  OTHER_ORG_ID,
  OUTSIDER,
  PLACE_ID,
  makeHarness,
  ownedImage,
  ownedKey,
  rawUploadImage,
  ownerInput,
  type Harness,
  type HarnessOptions,
} from "./page-draft-harness";

function deps(h: Harness, storagePublicBaseUrl: string | null = CDN) {
  return {
    repos: h.repos,
    authz: h.authz,
    clock: h.clock,
    logger: h.logger,
    storagePublicBaseUrl,
  };
}

function save(
  h: Harness,
  ops: unknown[],
  opts: {
    actor?: string;
    clientRevision?: number;
    batchId?: string;
    owner?: { ownerType: "PLACE" | "ORGANIZATION" | "HUMAN"; ownerId: string };
    storagePublicBaseUrl?: string | null;
  } = {},
): Promise<SavePageDraftOutput> {
  const owner = opts.owner ?? { ownerType: "PLACE" as const, ownerId: PLACE_ID };
  return savePageDraft(
    deps(h, opts.storagePublicBaseUrl === undefined ? CDN : opts.storagePublicBaseUrl),
    {
      ...ownerInput(opts.actor ?? HUMAN_A, owner.ownerType, owner.ownerId),
      batchId: opts.batchId ?? randomUUID(),
      clientRevision: opts.clientRevision ?? 0,
      ops,
    },
  );
}

function expectApplied(result: SavePageDraftOutput) {
  if (result.outcome !== "applied") {
    throw new Error(`expected applied, got ${JSON.stringify(result)}`);
  }
  return result;
}

function refusalCodes(result: SavePageDraftOutput): string[] {
  if (result.outcome !== "refused") {
    throw new Error(`expected refused, got ${result.outcome}`);
  }
  return result.errors.map((error) => error.code);
}

describe("savePageDraft: authz (same as updatePage)", () => {
  it("refuses a human canManagePlace does not allow, before touching the draft", async () => {
    const h = makeHarness();
    await expect(
      save(h, [{ path: "page.bio", value: "Hi" }], { actor: OUTSIDER }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(h.authz.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: OUTSIDER,
      placeId: PLACE_ID,
    });
    expect(h.entityPages.lockDraftForUpdate).not.toHaveBeenCalled();
    expect(h.entityPages.writeDraft).not.toHaveBeenCalled();
  });

  it("refuses the manager of place-1 on place-2's page (canManagePlace is per place)", async () => {
    const h = makeHarness({ ownerId: "place-2" });
    await expect(
      save(h, [{ path: "page.bio", value: "Hi" }], {
        owner: { ownerType: "PLACE", ownerId: "place-2" },
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(h.authz.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: HUMAN_A,
      placeId: "place-2",
    });
    expect(h.entityPages.lockDraftForUpdate).not.toHaveBeenCalled();
  });

  it("the harness refuses draft lock / write / clear outside repos.tx, like the adapter", async () => {
    const h = makeHarness();
    await expect(
      h.rootEntityPages.lockDraftForUpdate("page-1"),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "page_draft_lock_outside_tx",
    });
    await expect(h.rootEntityPages.writeDraft("page-1", {})).rejects.toMatchObject({
      message: "page_draft_write_outside_tx",
    });
    await expect(h.rootEntityPages.clearDraft("page-1", {})).rejects.toMatchObject({
      message: "page_draft_clear_outside_tx",
    });
  });

  it("refuses a non-member of the page's org", async () => {
    const options: HarnessOptions = {
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    };
    const h = makeHarness(options);
    await expect(
      save(h, [{ path: "page.bio", value: "Hi" }], {
        actor: OUTSIDER,
        owner: { ownerType: "ORGANIZATION", ownerId: ORG_ID },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(h.entityPages.lockDraftForUpdate).not.toHaveBeenCalled();
  });

  it("refuses an editor of a DIFFERENT org", async () => {
    const h = makeHarness({
      ownerType: "ORGANIZATION",
      ownerId: OTHER_ORG_ID,
    });
    // HUMAN_A edits ORG_ID, not OTHER_ORG_ID.
    await expect(
      save(h, [{ path: "page.bio", value: "Hi" }], {
        owner: { ownerType: "ORGANIZATION", ownerId: OTHER_ORG_ID },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(h.authz.requireOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ actorHumanId: HUMAN_A, orgId: OTHER_ORG_ID }),
    );
    expect(h.entityPages.lockDraftForUpdate).not.toHaveBeenCalled();
  });

  it("refuses another human's page", async () => {
    const h = makeHarness({ ownerType: "HUMAN", ownerId: HUMAN_B });
    await expect(
      save(h, [{ path: "page.bio", value: "Hi" }], {
        owner: { ownerType: "HUMAN", ownerId: HUMAN_B },
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("PAGE_NOT_FOUND when the owner has no page", async () => {
    const h = makeHarness({ page: null });
    await expect(
      save(h, [{ path: "page.bio", value: "Hi" }]),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("refuses a page whose layout has no draft editor yet (org standard)", async () => {
    const h = makeHarness({ ownerType: "ORGANIZATION", ownerId: ORG_ID });
    await expect(
      save(h, [{ path: "page.bio", value: "Hi" }], {
        owner: { ownerType: "ORGANIZATION", ownerId: ORG_ID },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: expect.objectContaining({
        reason: "page_draft_layout_unsupported",
      }),
    });
    expect(h.entityPages.writeDraft).not.toHaveBeenCalled();
  });
});

describe("savePageDraft: merge", () => {
  it("applies a batch: revision + 1, fieldEditors stamped, batch id recorded", async () => {
    const h = makeHarness();
    const batchId = randomUUID();
    const result = expectApplied(
      await save(h, [{ path: "page.bio", value: "Short line" }], { batchId }),
    );

    expect(result.appliedRevision).toBe(1);
    expect(result.revision).toBe(1);
    expect(result.changeCount).toBe(1);
    expect(result.isEmpty).toBe(false);
    expect(result.touchedPaths).toEqual(["page.bio"]);
    expect(result.sync.clearedSince).toBe(false);
    expect(result.sync.changes).toEqual([
      expect.objectContaining({
        path: "page.bio",
        humanId: HUMAN_A,
        rev: 1,
        present: true,
        value: "Short line",
      }),
    ]);

    const row = h.row()!;
    expect(row.data).toEqual({ "page.bio": "Short line" });
    expect(row.fieldEditors["page.bio"]).toEqual({
      humanId: HUMAN_A,
      at: "2026-10-08T15:00:00.000Z",
      rev: 1,
    });
    expect(row.appliedBatchIds).toEqual([batchId]);
    expect(row.updatedByHumanId).toBe(HUMAN_A);
    expect(h.entityPages.lockDraftForUpdate).toHaveBeenCalledTimes(1);
    expect(h.entityPages.writeDraft).toHaveBeenCalledTimes(1);
  });

  it("records placeBase on the FIRST touch of a Place field only", async () => {
    const h = makeHarness();
    expectApplied(await save(h, [{ path: "place.capacity", value: 250 }]));
    expect(h.row()!.placeBase).toEqual({ capacity: 200 });
    expect(h.row()!.placePatch).toEqual({ capacity: 250 });

    // Settings changes the live value meanwhile; a second draft edit of the
    // same field keeps the ORIGINAL base, so Publish sees the conflict.
    h.setPlace({ capacity: 300 });
    expectApplied(
      await save(h, [{ path: "place.capacity", value: 260 }], {
        clientRevision: 1,
      }),
    );
    expect(h.row()!.placeBase).toEqual({ capacity: 200 });
    expect(h.row()!.placePatch).toEqual({ capacity: 260 });
  });

  it("does not read Place for a batch with no place.* op", async () => {
    const h = makeHarness();
    expectApplied(await save(h, [{ path: "page.bio", value: "Hi" }]));
    expect(h.places.getById).not.toHaveBeenCalled();
  });

  it("keeps both editors' batches on different paths (concurrent saves)", async () => {
    const h = makeHarness();
    const [a, b] = await Promise.all([
      save(h, [{ path: "page.bio", value: "From A" }], { actor: HUMAN_A }),
      save(h, [{ path: "place.phone", value: "+16125550100" }], {
        actor: HUMAN_B,
      }),
    ]);
    expect(a.outcome).toBe("applied");
    expect(b.outcome).toBe("applied");

    const row = h.row()!;
    expect(row.revision).toBe(2);
    expect(row.data["page.bio"]).toBe("From A");
    expect(row.placePatch.phone).toBe("+16125550100");
    expect(row.fieldEditors["page.bio"]).toMatchObject({ humanId: HUMAN_A });
    expect(row.fieldEditors["place.phone"]).toMatchObject({ humanId: HUMAN_B });
    expect(row.appliedBatchIds).toHaveLength(2);
  });

  it("last write wins on the same path", async () => {
    const h = makeHarness();
    expectApplied(await save(h, [{ path: "page.bio", value: "A" }]));
    expectApplied(
      await save(h, [{ path: "page.bio", value: "B" }], { actor: HUMAN_B }),
    );
    expect(h.row()!.data["page.bio"]).toBe("B");
    expect(h.row()!.fieldEditors["page.bio"]).toMatchObject({
      humanId: HUMAN_B,
      rev: 2,
    });
  });

  it("tells a client about another editor's change since its revision", async () => {
    const h = makeHarness();
    expectApplied(await save(h, [{ path: "page.bio", value: "A" }]));
    const mine = expectApplied(
      await save(h, [{ path: "theme.colorBg", value: "#101010" }], {
        actor: HUMAN_B,
        clientRevision: 0,
      }),
    );
    expect(mine.sync.changes.map((change) => change.path)).toEqual([
      "page.bio",
      "theme.colorBg",
    ]);
    expect(mine.overlay).toBeNull();
  });
});

describe("savePageDraft: idempotency", () => {
  it("a retried batch is a no-op success and writes nothing", async () => {
    const h = makeHarness();
    const batchId = randomUUID();
    expectApplied(
      await save(h, [{ path: "page.bio", value: "Once" }], { batchId }),
    );
    const retry = await save(h, [{ path: "page.bio", value: "Once" }], {
      batchId,
    });
    expect(retry.outcome).toBe("deduped");
    expect(retry.revision).toBe(1);
    expect(h.entityPages.writeDraft).toHaveBeenCalledTimes(1);
    expect(h.row()!.revision).toBe(1);
  });

  it("a retry whose ops would NOW fail validation still succeeds as a no-op", async () => {
    const h = makeHarness();
    const id = `new:${randomUUID()}`;
    expectApplied(
      await save(h, [
        { path: `blocks.${id}.kind`, value: "faq" },
        { path: `blocks.${id}.data.heading`, value: "FAQ" },
      ]),
    );
    const removeBatch = randomUUID();
    const removeOps = [{ path: `blocks.${id}.removed`, value: true }];
    expectApplied(
      await save(h, removeOps, { batchId: removeBatch, clientRevision: 1 }),
    );

    // The same ops under a NEW id are refused: the new block is gone...
    expect(
      refusalCodes(await save(h, removeOps, { clientRevision: 2 })),
    ).toEqual(["block_not_found"]);
    // ...but the lost-response retry of the applied batch is a success.
    const retry = await save(h, removeOps, {
      batchId: removeBatch,
      clientRevision: 1,
    });
    expect(retry.outcome).toBe("deduped");
    expect(h.entityPages.writeDraft).toHaveBeenCalledTimes(2);
    expect(h.row()!.revision).toBe(2);
    // Answered before validation: the retry never read the live blocks
    // (two applied saves + one refused save = three reads).
    expect(h.entityPages.listBlocks).toHaveBeenCalledTimes(3);
  });

  it("a retry after a Discard is still recognised (batch ids survive the clear)", async () => {
    const h = makeHarness();
    const batchId = randomUUID();
    expectApplied(
      await save(h, [{ path: "page.bio", value: "Once" }], { batchId }),
    );
    await discardPageDraft(
      {
        repos: h.repos,
        authz: h.authz,
        clock: h.clock,
        storagePublicBaseUrl: CDN,
      },
      { ...ownerInput(HUMAN_B), expectedRevision: h.row()!.revision },
    );
    const retry = await save(h, [{ path: "page.bio", value: "Once" }], {
      batchId,
    });
    expect(retry.outcome).toBe("deduped");
    expect(h.row()!.data).toEqual({});
  });

  it("refuses a batch id that is not a UUID", async () => {
    const h = makeHarness();
    await expect(
      save(h, [{ path: "page.bio", value: "x" }], { batchId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("savePageDraft: validation", () => {
  it("refuses an avatar URL on another host, even with the right path", async () => {
    const h = makeHarness();
    const foreign = ownedImage("x").replace(CDN, "https://evil.example");
    expect(
      refusalCodes(await save(h, [{ path: "page.avatarUrl", value: foreign }])),
    ).toEqual(["image_url_not_allowed"]);
    expect(h.entityPages.writeDraft).not.toHaveBeenCalled();
  });

  it("refuses an avatar URL under ANOTHER owner's key prefix on our CDN", async () => {
    const h = makeHarness();
    const otherPlace = ownedImage("x", "PLACE", "place-2");
    expect(
      refusalCodes(
        await save(h, [{ path: "page.bannerUrl", value: otherPlace }]),
      ),
    ).toEqual(["image_url_not_allowed"]);
  });

  it("refuses a traversal or encoded URL that a prefix check would pass", async () => {
    const h = makeHarness();
    const base = `${CDN}/entity-pages/place/${PLACE_ID}/`;
    for (const url of [
      `${base}../place-2/x.jpg`,
      `${base}%2e%2e/place-2/x.jpg`,
      `https://user:pw@cdn.test/entity-pages/place/${PLACE_ID}/x.jpg`,
    ]) {
      expect(
        refusalCodes(await save(h, [{ path: "page.avatarUrl", value: url }])),
      ).toEqual(["image_url_not_allowed"]);
    }
  });

  it("refuses every image URL when the storage has no public base URL", async () => {
    const h = makeHarness();
    expect(
      refusalCodes(
        await save(h, [{ path: "page.avatarUrl", value: ownedImage("a") }], {
          storagePublicBaseUrl: null,
        }),
      ),
    ).toEqual(["image_url_not_allowed"]);
  });

  it("accepts this page's own upload", async () => {
    const h = makeHarness();
    expectApplied(
      await save(h, [{ path: "page.avatarUrl", value: ownedImage("mine") }]),
    );
    expect(h.row()!.data["page.avatarUrl"]).toBe(ownedImage("mine"));
  });

  it("refuses the reserved format-version path", async () => {
    const h = makeHarness();
    expect(
      refusalCodes(await save(h, [{ path: "v", value: 2 }])),
    ).toEqual(["path_reserved"]);
    expect(
      refusalCodes(await save(h, [{ path: "v.x", value: 2 }])),
    ).toEqual(["path_reserved"]);
  });

  it("refuses a bio over 280 characters", async () => {
    const h = makeHarness();
    expect(
      refusalCodes(
        await save(h, [{ path: "page.bio", value: "x".repeat(281) }]),
      ),
    ).toEqual(["value_invalid"]);
  });

  it("stores sanitised rich text", async () => {
    const h = makeHarness();
    expectApplied(
      await save(h, [
        {
          path: "blocks.blk-about.data.content",
          value: "<p>Hi <strong>there</strong><script>alert(1)</script></p>",
        },
      ]),
    );
    const stored = h.row()!.data["blocks.blk-about.data.content"] as string;
    expect(stored).toContain("<strong>there</strong>");
    expect(stored).not.toContain("script");
  });

  it("a refused batch writes nothing and still reports the draft state", async () => {
    const h = makeHarness();
    expectApplied(await save(h, [{ path: "page.bio", value: "Kept" }]));
    const refused = await save(
      h,
      [
        { path: "page.bio", value: "New" },
        { path: "blocks.blk-track.removed", value: true },
      ],
      { clientRevision: 1 },
    );
    expect(refusalCodes(refused)).toEqual(["block_pinned"]);
    expect(refused.revision).toBe(1);
    expect(h.row()!.data["page.bio"]).toBe("Kept");
  });
});

describe("savePageDraft: withdraws pending deletes of keys it mentions", () => {
  async function queue(h: Harness, names: string[]) {
    await h.pendingObjectDeletions.enqueueMany(
      names.map((name) => ({
        targetKey: ownedKey(name),
        targetKind: "KEY" as const,
        source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
      })),
    );
  }

  it("a URL with a query string cancels its key", async () => {
    // In rich text: a photo list refuses the variant (see "photo list").
    const h = makeHarness();
    await queue(h, ["k"]);
    expectApplied(
      await save(h, [
        {
          path: "blocks.blk-about.data.content",
          value: `<p><a href="${ownedImage("k")}?w=800">photo</a></p>`,
        },
      ]),
    );
    expect(h.pending()).toEqual([]);
  });

  it("a key inside rich text cancels it", async () => {
    const h = makeHarness();
    await queue(h, ["k2"]);
    expectApplied(
      await save(h, [
        {
          path: "blocks.blk-about.data.content",
          value: `<p>Our room: <a href="${ownedImage("k2")}">photo</a>.</p>`,
        },
      ]),
    );
    expect(
      h.pendingObjectDeletions.cancelPending.mock.calls[0]![0].targetKeys,
    ).toContain(ownedKey("k2"));
    expect(h.pending()).toEqual([]);
  });

  it("leaves another page's keys and other producers' rows alone", async () => {
    const h = makeHarness();
    await h.pendingObjectDeletions.enqueueMany([
      { targetKey: ownedKey("k"), targetKind: "KEY", source: "human_delete" },
    ]);
    expectApplied(
      await save(h, [
        {
          path: "blocks.blk-photos.data.photos",
          value: [{ url: ownedImage("k") }],
        },
        {
          path: "blocks.blk-about.data.content",
          value: `<p><a href="${ownedImage("x", "PLACE", "place-10")}">x</a></p>`,
        },
      ]),
    );
    const keys = h.pendingObjectDeletions.cancelPending.mock.calls[0]![0]
      .targetKeys as string[];
    expect(keys.some((key) => key.includes("place-10"))).toBe(false);
    expect(h.pending()).toHaveLength(1);
  });
});

describe("savePageDraft: cleared since the client's revision", () => {
  it("applies on top of the cleared draft and says clearedSince", async () => {
    const h = makeHarness();
    expectApplied(await save(h, [{ path: "page.bio", value: "Old" }]));
    const discarded = await discardPageDraft(
      {
        repos: h.repos,
        authz: h.authz,
        clock: h.clock,
        storagePublicBaseUrl: CDN,
      },
      { ...ownerInput(HUMAN_B), expectedRevision: h.row()!.revision },
    );
    expect(discarded).toMatchObject({ outcome: "discarded", revision: 2 });

    // A's autosave was in flight from revision 1.
    const late = expectApplied(
      await save(h, [{ path: "theme.colorText", value: "#222222" }], {
        clientRevision: 1,
      }),
    );
    expect(late.appliedRevision).toBe(3);
    expect(late.sync.clearedSince).toBe(true);
    expect(late.sync.resync).toBe(true);
    // The whole overlay comes back, without the discarded bio.
    expect(late.overlay).toEqual({
      data: { "theme.colorText": "#222222" },
      placePatch: {},
    });

    // A client already at the clear's revision is not told "cleared".
    const fresh = expectApplied(
      await save(h, [{ path: "page.bio", value: "New" }], {
        actor: HUMAN_B,
        clientRevision: 3,
      }),
    );
    expect(fresh.sync.clearedSince).toBe(false);
    expect(fresh.overlay).toBeNull();

    const read = await getPageDraft(
      { repos: h.repos, authz: h.authz },
      { ...ownerInput(HUMAN_A), sinceRevision: 1 },
    );
    expect(read.sync?.clearedSince).toBe(true);
  });
});

describe("savePageDraft: photo list (image fields found by field kind)", () => {
  const PHOTOS = "blocks.blk-photos.data.photos";
  const OUTSIDE_LIVE = "https://elsewhere.test/live-outside.jpg";

  function harnessWithOutsidePhoto() {
    const h = makeHarness();
    h.setBlocks(
      h.blocks().map((existing) =>
        existing.id === "blk-photos"
          ? {
              ...existing,
              data: {
                photos: [{ url: ownedImage("live-photo") }, { url: OUTSIDE_LIVE }],
              },
            }
          : existing,
      ),
    );
    return h;
  }

  it("accepts this page's own upload", async () => {
    const h = makeHarness();
    expectApplied(await save(h, [{ path: PHOTOS, value: [{ url: ownedImage("new") }] }]));
  });

  it("keeps an outside URL the live page already shows", async () => {
    const h = harnessWithOutsidePhoto();
    expectApplied(
      await save(h, [
        {
          path: PHOTOS,
          value: [{ url: OUTSIDE_LIVE }, { url: ownedImage("new") }],
        },
      ]),
    );
  });

  it("refuses a NEW outside URL", async () => {
    const h = harnessWithOutsidePhoto();
    expect(
      refusalCodes(
        await save(h, [
          {
            path: PHOTOS,
            value: [{ url: OUTSIDE_LIVE }, { url: "https://evil.test/x.jpg" }],
          },
        ]),
      ),
    ).toEqual(["image_url_not_allowed"]);
    expect(h.row()?.revision ?? 0).toBe(0);
  });

  it("refuses a ?w=800 variant of an owned key", async () => {
    const h = makeHarness();
    expect(
      refusalCodes(
        await save(h, [
          { path: PHOTOS, value: [{ url: `${ownedImage("k")}?w=800` }] },
        ]),
      ),
    ).toEqual(["image_url_not_allowed"]);
  });

  it("refuses a RAW upload key (uuid name: original bytes, GPS included)", async () => {
    const h = makeHarness();
    expect(
      refusalCodes(await save(h, [{ path: PHOTOS, value: [{ url: rawUploadImage() }] }])),
    ).toEqual(["image_url_not_allowed"]);
  });

  it("refuses a raw upload as the avatar; the live avatar can be set again", async () => {
    const h = makeHarness();
    expect(
      refusalCodes(await save(h, [{ path: "page.avatarUrl", value: rawUploadImage() }])),
    ).toEqual(["image_url_not_allowed"]);

    h.setPage({ ...h.page()!, avatarUrl: rawUploadImage() });
    expectApplied(
      await save(h, [{ path: "page.avatarUrl", value: rawUploadImage() }]),
    );
  });

  it("the live value counts only for its own field (as publish decides)", async () => {
    const h = makeHarness();
    h.setPage({ ...h.page()!, bannerUrl: rawUploadImage() });
    // The live BANNER URL is not a live value of the avatar.
    expect(
      refusalCodes(
        await save(h, [{ path: "page.avatarUrl", value: rawUploadImage() }]),
      ),
    ).toEqual(["image_url_not_allowed"]);
    expectApplied(
      await save(h, [{ path: "page.bannerUrl", value: rawUploadImage() }]),
    );
  });

  it("refuses another owner's upload on our CDN", async () => {
    const h = makeHarness();
    expect(
      refusalCodes(
        await save(h, [
          {
            path: PHOTOS,
            value: [{ url: ownedImage("x", "PLACE", "place-10") }],
          },
        ]),
      ),
    ).toEqual(["image_url_not_allowed"]);
  });

  it("refuses every new photo when the storage has no public base URL", async () => {
    const h = makeHarness();
    expect(
      refusalCodes(
        await save(h, [{ path: PHOTOS, value: [{ url: ownedImage("new") }] }], {
          storagePublicBaseUrl: null,
        }),
      ),
    ).toEqual(["image_url_not_allowed"]);
  });
});
