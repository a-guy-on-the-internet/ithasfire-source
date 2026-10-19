import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { discardPageDraft } from "../discard-page-draft";
import {
  PAGE_DRAFT_DISCARD_DELETE_GRACE_MS,
  PAGE_DRAFT_DISCARD_DELETION_SOURCE,
} from "../page-draft-shared";
import { savePageDraft } from "../save-page-draft";
import {
  CDN,
  HUMAN_A,
  HUMAN_B,
  NOW,
  OUTSIDER,
  PAGE_ID,
  block,
  liveBlocks,
  makeHarness,
  ownedImage,
  ownedKey,
  ownerInput,
  type Harness,
} from "./page-draft-harness";

const GRACE_END = new Date(NOW.getTime() + PAGE_DRAFT_DISCARD_DELETE_GRACE_MS);

async function save(
  h: Harness,
  ops: unknown[],
  clientRevision = 0,
  actor = HUMAN_A,
) {
  const result = await savePageDraft(
    {
      repos: h.repos,
      authz: h.authz,
      clock: h.clock,
      storagePublicBaseUrl: CDN,
    },
    {
      ...ownerInput(actor),
      batchId: randomUUID(),
      clientRevision,
      ops,
    },
  );
  if (result.outcome !== "applied") {
    throw new Error(`setup save not applied: ${JSON.stringify(result)}`);
  }
  return result;
}

/** Discard confirmed against `expectedRevision` (default: the row's current one). */
function discard(
  h: Harness,
  extra: { actor?: string; expectedRevision?: number } = {},
) {
  return discardPageDraft(
    {
      repos: h.repos,
      authz: h.authz,
      clock: h.clock,
      storagePublicBaseUrl: CDN,
      logger: h.logger,
    },
    {
      ...ownerInput(extra.actor ?? HUMAN_A),
      expectedRevision: extra.expectedRevision ?? h.row()?.revision ?? 0,
    },
  );
}

describe("discardPageDraft", () => {
  it("refuses someone who cannot manage the place, and touches nothing", async () => {
    const h = makeHarness();
    await save(h, [{ path: "page.bio", value: "Draft" }]);
    await expect(discard(h, { actor: OUTSIDER })).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(h.entityPages.clearDraft).not.toHaveBeenCalled();
    expect(h.row()!.data).toEqual({ "page.bio": "Draft" });
  });

  it("requires expectedRevision", async () => {
    const h = makeHarness();
    await expect(
      discardPageDraft(
        {
          repos: h.repos,
          authz: h.authz,
          clock: h.clock,
          storagePublicBaseUrl: CDN,
        },
        ownerInput(HUMAN_A),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("CLEARS the row (revision + 1, batch ids kept) and never deletes it", async () => {
    const h = makeHarness();
    await save(h, [{ path: "page.bio", value: "Draft" }]);
    await save(h, [{ path: "place.capacity", value: 250 }], 1);
    const before = h.row()!;

    const result = await discard(h, { actor: HUMAN_B, expectedRevision: 2 });

    expect(result).toEqual({
      outcome: "discarded",
      revision: 3,
      imagesQueuedForDeletion: 0,
    });
    expect(h.entityPages.clearDraft).toHaveBeenCalledWith(PAGE_ID, {
      revision: 3,
      updatedByHumanId: HUMAN_B,
    });
    const after = h.row()!;
    expect(after).not.toBeNull();
    expect(after.id).toBe(before.id);
    expect(after.data).toEqual({});
    expect(after.placePatch).toEqual({});
    expect(after.placeBase).toEqual({});
    expect(after.fieldEditors).toEqual({});
    expect(after.appliedBatchIds).toEqual(before.appliedBatchIds);
    expect(after.lastPublishedRevision).toBeNull();
    expect(h.entityPages.deleteByOwner).not.toHaveBeenCalled();
    // Nothing touched the live page.
    expect(h.entityPages.upsert).not.toHaveBeenCalled();
    expect(h.entityPages.updateBlock).not.toHaveBeenCalled();
    expect(h.entityPages.deleteBlock).not.toHaveBeenCalled();
  });

  it("a retry after a discard is a no-op", async () => {
    const h = makeHarness();
    await save(h, [{ path: "page.bio", value: "Draft" }]);
    await discard(h, { expectedRevision: 1 });
    // The lost-response retry carries the same expectedRevision.
    const again = await discard(h, { expectedRevision: 1 });
    expect(again).toEqual({
      outcome: "already_empty",
      revision: 2,
      imagesQueuedForDeletion: 0,
    });
    expect(h.entityPages.clearDraft).toHaveBeenCalledTimes(1);
  });

  it("is stale, and discards nothing, when the draft moved past expectedRevision", async () => {
    const h = makeHarness();
    await save(h, [{ path: "page.bio", value: "A's" }]);
    // B saves after A confirmed the discard at revision 1.
    await save(h, [{ path: "theme.colorBg", value: "#000000" }], 1, HUMAN_B);
    const result = await discard(h, { expectedRevision: 1 });
    expect(result).toEqual({
      outcome: "stale",
      revision: 2,
      imagesQueuedForDeletion: 0,
    });
    expect(h.entityPages.clearDraft).not.toHaveBeenCalled();
    expect(h.row()!.data).toMatchObject({ "theme.colorBg": "#000000" });

    const matched = await discard(h, { expectedRevision: 2 });
    expect(matched.outcome).toBe("discarded");
  });
});

describe("discardPageDraft: draft-only images", () => {
  it("queues only draft-only keys under the page's prefix, inside the tx, after the grace", async () => {
    const h = makeHarness();
    h.setBlocks([
      ...liveBlocks(),
      block("blk-member", "photos", 0, {
        section: "memberships",
        data: { photos: [{ url: ownedImage("members-only") }] },
      }),
    ]);
    await save(h, [
      // Draft-only upload: queued.
      { path: "page.avatarUrl", value: ownedImage("draft-avatar") },
      // The live banner, re-set in the draft: kept.
      { path: "page.bannerUrl", value: ownedImage("live-banner") },
      {
        path: "blocks.blk-photos.data.photos",
        value: [
          // Still on the live photos block: kept.
          { url: ownedImage("live-photo") },
          // Draft-only upload: queued.
          { url: ownedImage("draft-photo") },
          // Used by a live MEMBERSHIPS block: kept.
          { url: ownedImage("members-only") },
        ],
      },
      // Links in rich text (a photo list refuses foreign URLs at save):
      // another owner's object on our CDN, never ours to delete; and the
      // same path on another host, not a storage object at all.
      {
        path: "blocks.blk-about.data.content",
        value: `<p><a href="${ownedImage("theirs", "PLACE", "place-2")}">a</a> <a href="${ownedImage("elsewhere").replace(CDN, "https://other.example")}">b</a></p>`,
      },
    ]);

    let enqueuedInsideTx: boolean | null = null;
    const enqueue = h.pendingObjectDeletions.enqueueMany.getMockImplementation()!;
    h.pendingObjectDeletions.enqueueMany.mockImplementationOnce(
      async (...args: Parameters<typeof enqueue>) => {
        enqueuedInsideTx = h.inTx();
        return enqueue(...args);
      },
    );

    const result = await discard(h);

    expect(result).toEqual({
      outcome: "discarded",
      revision: 2,
      imagesQueuedForDeletion: 2,
    });
    // The transactional outbox: written in the same tx as the clear.
    expect(enqueuedInsideTx).toBe(true);
    expect(h.pending()).toEqual([
      {
        targetKey: ownedKey("draft-avatar"),
        targetKind: "KEY",
        source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
        sourceId: PAGE_ID,
        notBefore: GRACE_END,
        status: "PENDING",
      },
      {
        targetKey: ownedKey("draft-photo"),
        targetKind: "KEY",
        source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
        sourceId: PAGE_ID,
        notBefore: GRACE_END,
        status: "PENDING",
      },
    ]);
  });

  it("keeps a key the Place row mentions (every live surface is scanned)", async () => {
    const h = makeHarness();
    h.setPlace({ website: ownedImage("on-place") });
    await save(h, [
      { path: "page.avatarUrl", value: ownedImage("on-place") },
    ]);
    const result = await discard(h);
    expect(result.imagesQueuedForDeletion).toBe(0);
    expect(h.places.getById).toHaveBeenCalled();
    expect(h.pending()).toEqual([]);
  });

  it("queues nothing, and reads nothing live, when the draft holds no image", async () => {
    const h = makeHarness();
    await save(h, [{ path: "page.bio", value: "Draft" }]);
    await discard(h);
    expect(h.pending()).toEqual([]);
    expect(h.entityPages.getById).not.toHaveBeenCalled();
  });

  it("a failed enqueue rolls the discard back and surfaces", async () => {
    const h = makeHarness();
    await save(h, [
      { path: "page.avatarUrl", value: ownedImage("draft-avatar") },
    ]);
    h.pendingObjectDeletions.enqueueMany.mockRejectedValueOnce(
      new Error("neon blip"),
    );

    await expect(discard(h)).rejects.toThrow("neon blip");

    // The draft is untouched: still revision 1 with its avatar.
    expect(h.row()!.revision).toBe(1);
    expect(h.row()!.data).toEqual({
      "page.avatarUrl": ownedImage("draft-avatar"),
    });
    expect(h.pending()).toEqual([]);
  });

  it("a save that brings a discarded image back cancels its pending delete", async () => {
    const h = makeHarness();
    await save(h, [
      {
        path: "blocks.blk-photos.data.photos",
        value: [{ url: ownedImage("live-photo") }, { url: ownedImage("k") }],
      },
    ]);
    // A pending row of ANOTHER producer for the same key must survive the
    // cancel (DEAD rows: the adapter integration test).
    await h.pendingObjectDeletions.enqueueMany([
      { targetKey: ownedKey("k"), targetKind: "KEY", source: "other_source" },
    ]);

    await discard(h, { actor: HUMAN_A, expectedRevision: 1 });
    expect(
      h.pending().filter((row) => row.source === PAGE_DRAFT_DISCARD_DELETION_SOURCE),
    ).toEqual([
      expect.objectContaining({ targetKey: ownedKey("k"), notBefore: GRACE_END }),
    ]);

    // B's batch was in flight from revision 1; R14 applies it after the clear.
    const late = await save(
      h,
      [
        {
          path: "blocks.blk-photos.data.photos",
          value: [{ url: ownedImage("k") }, { url: ownedImage("live-photo") }],
        },
      ],
      1,
      HUMAN_B,
    );
    expect(late.sync.clearedSince).toBe(true);
    expect(h.pendingObjectDeletions.cancelPending).toHaveBeenCalledWith({
      source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
      // Every minted key the batch mentions (see pageImageKeysMentionedIn).
      targetKeys: expect.arrayContaining([
        ownedKey("k"),
        ownedKey("live-photo"),
      ]),
    });
    expect(h.pending()).toEqual([
      expect.objectContaining({ targetKey: ownedKey("k"), source: "other_source" }),
    ]);
  });

  it("a save with no owned image does not call cancelPending", async () => {
    const h = makeHarness();
    await save(h, [{ path: "page.bio", value: "Hi" }]);
    expect(h.pendingObjectDeletions.cancelPending).not.toHaveBeenCalled();
  });
});
