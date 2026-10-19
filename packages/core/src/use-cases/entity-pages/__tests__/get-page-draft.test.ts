import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { getPageDraft } from "../get-page-draft";
import { savePageDraft } from "../save-page-draft";
import {
  CDN,
  HUMAN_A,
  HUMAN_B,
  HUMAN_GONE,
  NOW,
  OUTSIDER,
  PAGE_ID,
  makeHarness,
  ownerInput,
  pageRecord,
  type Harness,
} from "./page-draft-harness";

function get(h: Harness, actor = HUMAN_A, sinceRevision?: number) {
  return getPageDraft(
    { repos: h.repos, authz: h.authz, logger: h.logger },
    {
      ...ownerInput(actor),
      ...(sinceRevision !== undefined && { sinceRevision }),
    },
  );
}

async function save(h: Harness, actor: string, ops: unknown[], rev = 0) {
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
      clientRevision: rev,
      ops,
    },
  );
  if (result.outcome !== "applied") throw new Error(result.outcome);
  return result;
}

describe("getPageDraft", () => {
  it("refuses someone who cannot manage the place, before reading the draft", async () => {
    const h = makeHarness();
    await expect(get(h, OUTSIDER)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(h.entityPages.getDraft).not.toHaveBeenCalled();
  });

  it("with no draft row: the live page, revision 0, empty, and no row created", async () => {
    const h = makeHarness();
    const result = await get(h);

    expect(result.pageId).toBe(PAGE_ID);
    expect(result.layoutKey).toBe("standard");
    expect(result.draft).toMatchObject({
      revision: 0,
      changeCount: 0,
      isEmpty: true,
      editors: [],
      lastEdit: null,
    });
    expect(result.view.page.bio).toBe("Live bio");
    expect(result.livePlace).toMatchObject({ name: "The Room", capacity: 200 });
    expect(result.sync).toBeNull();
    expect(h.entityPages.lockDraftForUpdate).not.toHaveBeenCalled();
    expect(h.row()).toBeNull();
  });

  it("applies the overlay and reports count, editors and the last edit", async () => {
    const h = makeHarness();
    await save(h, HUMAN_A, [{ path: "page.bio", value: "Draft bio" }]);
    await save(h, HUMAN_B, [{ path: "place.capacity", value: 250 }], 1);

    const result = await get(h);

    expect(result.view.page.bio).toBe("Draft bio");
    expect(result.view.place).toMatchObject({ capacity: 250 });
    // Live Place facts stay live, for R9 conflict display.
    expect(result.livePlace).toMatchObject({ capacity: 200 });
    expect(result.draft.revision).toBe(2);
    expect(result.draft.changeCount).toBe(2);
    expect(result.draft.isEmpty).toBe(false);
    expect(result.draft.editors).toEqual([
      {
        path: "place.capacity",
        humanId: HUMAN_B,
        name: "Ben",
        at: NOW.toISOString(),
        rev: 2,
      },
      {
        path: "page.bio",
        humanId: HUMAN_A,
        name: "Ana",
        at: NOW.toISOString(),
        rev: 1,
      },
    ]);
    expect(result.draft.lastEdit).toEqual({
      humanId: HUMAN_B,
      name: "Ben",
      at: NOW.toISOString(),
    });
  });

  it("tolerates a human id that no longer resolves: no name, no throw", async () => {
    const h = makeHarness();
    await save(h, HUMAN_A, [{ path: "page.bio", value: "Draft bio" }]);
    const row = h.row()!;
    h.setRow({
      ...row,
      data: { ...row.data, "theme.colorBg": "#111111" },
      fieldEditors: {
        ...row.fieldEditors,
        "theme.colorBg": { humanId: HUMAN_GONE, at: NOW.toISOString(), rev: 2 },
      },
      revision: 2,
      updatedByHumanId: HUMAN_GONE,
    });

    const result = await get(h);

    expect(h.humans.getByIds).toHaveBeenCalledWith(
      expect.arrayContaining([HUMAN_A, HUMAN_GONE]),
    );
    expect(result.draft.lastEdit).toEqual({
      humanId: HUMAN_GONE,
      name: null,
      at: NOW.toISOString(),
    });
    expect(
      result.draft.editors.find((editor) => editor.humanId === HUMAN_GONE),
    ).toEqual({
      path: "theme.colorBg",
      humanId: HUMAN_GONE,
      name: null,
      at: NOW.toISOString(),
      rev: 2,
    });
    expect(
      result.draft.editors.find((editor) => editor.humanId === HUMAN_A)?.name,
    ).toBe("Ana");
  });

  it("lastEdit follows the row, so a revert by another editor counts", async () => {
    const h = makeHarness();
    await save(h, HUMAN_A, [{ path: "page.bio", value: "Draft bio" }]);
    await save(h, HUMAN_B, [{ path: "page.bio", revert: true }], 1);
    const result = await get(h);
    expect(result.draft.isEmpty).toBe(true);
    expect(result.draft.editors).toEqual([]);
    expect(result.draft.lastEdit).toMatchObject({ humanId: HUMAN_B, name: "Ben" });
  });

  it("reads the draft BEFORE the live tables (no torn read across a Publish)", async () => {
    const h = makeHarness();
    await get(h);
    const draftAt = h.entityPages.getDraft.mock.invocationCallOrder[0]!;
    expect(draftAt).toBeLessThan(
      h.entityPages.getById.mock.invocationCallOrder[0]!,
    );
    expect(draftAt).toBeLessThan(
      h.entityPages.getTheme.mock.invocationCallOrder[0]!,
    );
    expect(draftAt).toBeLessThan(
      h.entityPages.listBlocks.mock.invocationCallOrder[0]!,
    );
    expect(draftAt).toBeLessThan(h.places.getById.mock.invocationCallOrder[0]!);
  });

  it("builds the view from the page row read AFTER the draft (a Publish in between)", async () => {
    const h = makeHarness();
    await save(h, HUMAN_A, [{ path: "page.bio", value: "Published bio" }]);
    // A Publish commits right after authz read the page row: live gets the
    // bio, the draft is cleared. getDraft runs after it.
    h.entityPages.getDraft.mockImplementationOnce(async () => {
      h.setPage(pageRecord({ bio: "Published bio" }));
      const row = h.row()!;
      return {
        ...row,
        data: {},
        placePatch: {},
        placeBase: {},
        fieldEditors: {},
        revision: row.revision + 1,
      };
    });

    const result = await get(h);

    expect(result.draft.isEmpty).toBe(true);
    expect(result.view.page.bio).toBe("Published bio");
  });

  it("skips a malformed editor entry instead of failing", async () => {
    const h = makeHarness();
    await save(h, HUMAN_A, [{ path: "page.bio", value: "Draft bio" }]);
    const row = h.row()!;
    h.setRow({
      ...row,
      fieldEditors: { ...row.fieldEditors, "page.bio": "garbage" },
    });
    const result = await get(h);
    expect(result.draft.editors).toEqual([]);
    expect(result.draft.changeCount).toBe(1);
  });

  it("answers sync: changes since a revision, and clearedSince after a clear", async () => {
    const h = makeHarness();
    await save(h, HUMAN_A, [{ path: "page.bio", value: "One" }]);
    await save(h, HUMAN_B, [{ path: "theme.colorBg", value: "#000000" }], 1);

    const since1 = await get(h, HUMAN_A, 1);
    expect(since1.sync).toMatchObject({
      sinceRevision: 1,
      clearedSince: false,
      resync: false,
      changes: [
        {
          path: "theme.colorBg",
          humanId: HUMAN_B,
          rev: 2,
          present: true,
          value: "#000000",
        },
      ],
    });

    // A Publish / Discard clear at revision 3.
    const row = h.row()!;
    h.setRow({
      ...row,
      data: {},
      placePatch: {},
      placeBase: {},
      fieldEditors: {},
      revision: 3,
    });
    const afterClear = await get(h, HUMAN_A, 2);
    expect(afterClear.sync).toMatchObject({
      clearedSince: true,
      resync: true,
      changes: [],
    });
    expect(afterClear.draft.isEmpty).toBe(true);

    const upToDate = await get(h, HUMAN_A, 3);
    expect(upToDate.sync?.clearedSince).toBe(false);
  });
});
