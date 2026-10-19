/**
 * A community moderator writes the page of a PLACE nobody owns (moderator
 * place page spec docs/specs/2026-10-14/moderator-place-page.spec.yaml,
 * owner rulings R2 / R3 and 2026-10-15; FR-001..FR-004, D3..D5).
 *
 * Every page use case that writes runs the same matrix: the moderator
 * passes on an unowned ACTIVE place and writes ONE audit row; ownership,
 * a pending claim, an archived or suspended place refuse; a live organiser
 * event does not; a claim that lands between the advisory check and the
 * claim lock refuses the write and nothing is written; an outsider is
 * refused as before; the owner path takes no lock and writes no audit row.
 * HUMAN and ORGANIZATION pages refuse a moderator exactly as before.
 */

import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PageDraftRecord } from "@th/types/repos/entity-pages";

import { discardPageDraft } from "../discard-page-draft";
import {
  COMMUNITY_AUDIT_MAX_ITEMS,
  COMMUNITY_AUDIT_MAX_JSON,
  COMMUNITY_AUDIT_MAX_STRING,
  ENTITY_PAGE_AUDIT_ENTITY,
  ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
  boundAuditValue,
  resolveEntityPageEditor,
} from "../entity-page-access";
import { getPageDraft } from "../get-page-draft";
import { managePageBlocks } from "../manage-page-blocks";
import { publishPageDraft } from "../publish-page-draft";
import { savePageDraft } from "../save-page-draft";
import { updatePage } from "../update-page";
import { updatePageTheme } from "../update-page-theme";
import {
  CDN,
  HUMAN_A,
  HUMAN_B,
  NOW,
  ORG_ID,
  OUTSIDER,
  PAGE_ID,
  PLACE_ID,
  makeHarness,
  ownedImage,
  type Harness,
  type HarnessOptions,
} from "./page-draft-harness";

const MODERATOR = "human-moderator";

function deps(h: Harness) {
  return {
    repos: h.repos,
    authz: h.authz,
    clock: h.clock,
    logger: h.logger,
    storagePublicBaseUrl: CDN,
    // updatePage only HEADs a NEW image URL; these cases send none.
    storage: { getObjectUrl: async () => ({ url: "unused" }) },
  };
}

/** A harness whose place nobody owns (ACTIVE, no owners, no claim). */
function unownedHarness(options: HarnessOptions = {}): Harness {
  const h = makeHarness({ moderators: [MODERATOR], ...options });
  h.setPlace({
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    verificationStatus: "UNVERIFIED",
  });
  return h;
}

function draftRow(overrides: Partial<PageDraftRecord> = {}): PageDraftRecord {
  return {
    id: "draft-1",
    pageId: PAGE_ID,
    data: { "page.bio": "Draft bio" },
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

/** Everything a page write could change, for "nothing was written". */
function state(h: Harness) {
  return {
    page: h.page(),
    theme: h.theme(),
    blocks: h.blocks(),
    place: h.place(),
    row: h.row(),
    slugHistory: h.slugHistory(),
    audits: h.audits(),
    marks: h.marks(),
    pending: h.pending(),
  };
}

function communityAudits(h: Harness) {
  return h
    .audits()
    .filter((entry) => entry.action === ENTITY_PAGE_COMMUNITY_UPDATED_ACTION);
}

type Owner = { ownerType: "HUMAN" | "ORGANIZATION" | "PLACE"; ownerId: string };
const PLACE_OWNER: Owner = { ownerType: "PLACE", ownerId: PLACE_ID };

function who(actor: string, owner: Owner = PLACE_OWNER) {
  return { actorHumanId: actor, ...owner };
}

type WriteCase = {
  name: string;
  /** The audit row's `op`. */
  op: string;
  /** Set up the harness for this write (a draft row, say). */
  arrange?: (h: Harness) => void;
  run: (h: Harness, actor: string, owner?: Owner) => Promise<unknown>;
  /** The write landed. */
  landed: (h: Harness) => void;
  /** The audit row's from / to. */
  audit: { fields: string[]; from: unknown; to: unknown };
};

const WRITES: WriteCase[] = [
  {
    name: "updatePage",
    op: "updatePage",
    run: (h, actor, owner) =>
      updatePage(deps(h) as never, { ...who(actor, owner), bio: "New bio" }),
    landed: (h) => expect(h.page()?.bio).toBe("New bio"),
    audit: {
      fields: ["bio"],
      from: { bio: "Live bio" },
      to: { bio: "New bio" },
    },
  },
  {
    name: "managePageBlocks",
    op: "managePageBlocks.toggleVisibility",
    run: (h, actor, owner) =>
      managePageBlocks(deps(h) as never, {
        ...who(actor, owner),
        blockAction: { action: "toggleVisibility", blockId: "blk-amenities" },
      }),
    landed: (h) =>
      expect(
        h.blocks().find((candidate) => candidate.id === "blk-amenities")
          ?.visible,
      ).toBe(false),
    audit: {
      from: expect.objectContaining({
        blockId: "blk-amenities",
        kind: "amenities",
        visible: true,
      }),
      to: expect.objectContaining({ blockId: "blk-amenities", visible: false }),
      fields: ["blocks.blk-amenities"],
    },
  },
  {
    name: "updatePageTheme",
    op: "updatePageTheme",
    run: (h, actor, owner) =>
      updatePageTheme(deps(h) as never, {
        ...who(actor, owner),
        colorPrimary: "#112233",
      }),
    landed: (h) => expect(h.theme()?.colorPrimary).toBe("#112233"),
    audit: {
      fields: ["theme.colorPrimary"],
      from: null,
      to: expect.objectContaining({ colorPrimary: "#112233" }),
    },
  },
  {
    name: "savePageDraft",
    op: "savePageDraft",
    run: async (h, actor, owner) => {
      const result = await savePageDraft(deps(h) as never, {
        ...who(actor, owner),
        batchId: randomUUID(),
        clientRevision: h.row()?.revision ?? 0,
        ops: [{ path: "page.bio", value: "Saved bio" }],
      });
      expect(result).toMatchObject({ outcome: "applied" });
      return result;
    },
    landed: (h) => expect(h.row()?.data["page.bio"]).toBe("Saved bio"),
    audit: {
      fields: ["page.bio"],
      from: { revision: 0, paths: { "page.bio": { absent: true } } },
      to: { revision: 1, paths: { "page.bio": { value: "Saved bio" } } },
    },
  },
  {
    name: "discardPageDraft",
    op: "discardPageDraft",
    arrange: (h) => h.setRow(draftRow()),
    run: async (h, actor, owner) => {
      const result = await discardPageDraft(deps(h) as never, {
        ...who(actor, owner),
        expectedRevision: 1,
      });
      expect(result).toMatchObject({ outcome: "discarded" });
      return result;
    },
    landed: (h) => expect(h.row()?.data).toEqual({}),
    audit: {
      fields: ["page.bio"],
      // Paths only: no discarded values.
      from: { revision: 1 },
      to: { revision: 2 },
    },
  },
  {
    name: "publishPageDraft",
    op: "publishPageDraft",
    arrange: (h) => h.setRow(draftRow()),
    run: async (h, actor, owner) => {
      const result = await publishPageDraft(deps(h) as never, {
        ...who(actor, owner),
        draftRevision: 1,
      });
      expect(result).toMatchObject({ outcome: "published", replayed: false });
      return result;
    },
    landed: (h) => expect(h.page()?.bio).toBe("Draft bio"),
    audit: {
      // Publish also converts every live block's rich text (FR-022).
      fields: ["bio", "blocks.blk-about"],
      from: expect.objectContaining({ page: { bio: "Live bio" } }),
      to: expect.objectContaining({ page: { bio: "Draft bio" } }),
    },
  },
];

describe.each(WRITES)("$name: community moderator on a PLACE page", (c) => {
  it("passes on an unowned ACTIVE place, under the claim lock, with one audit row", async () => {
    const h = unownedHarness();
    c.arrange?.(h);
    await c.run(h, MODERATOR);
    c.landed(h);
    expect(h.claimLocks()).toEqual([`claim:${PLACE_ID}`]);
    expect(communityAudits(h)).toEqual([
      {
        entity: ENTITY_PAGE_AUDIT_ENTITY,
        entityId: PAGE_ID,
        action: ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
        data: {
          actorHumanId: MODERATOR,
          placeId: PLACE_ID,
          pageId: PAGE_ID,
          op: c.op,
          fields: c.audit.fields,
          from: c.audit.from,
          to: c.audit.to,
        },
        at: NOW,
      },
    ]);
  });

  it("is NOT refused by an organiser's live event at the place (D3)", async () => {
    const h = unownedHarness();
    h.setOwnedLiveEventsAtPlace(true);
    c.arrange?.(h);
    await c.run(h, MODERATOR);
    c.landed(h);
    expect(communityAudits(h)).toHaveLength(1);
  });

  it("is refused PLACE_HAS_OWNER (OWNED) on an owned place, writing nothing", async () => {
    const h = makeHarness({ moderators: [MODERATOR] }); // a verified org owns it
    c.arrange?.(h);
    const before = state(h);
    await expect(c.run(h, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { placeId: PLACE_ID, reason: "OWNED" },
    });
    expect(state(h)).toEqual(before);
  });

  it("is refused PLACE_HAS_OWNER (OWNED) by a verified ownership row", async () => {
    const h = unownedHarness();
    h.setOwnerships([{ id: "own-1", humanId: HUMAN_B, verified: true }]);
    c.arrange?.(h);
    await expect(c.run(h, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "OWNED" },
    });
  });

  it("is refused PLACE_HAS_OWNER (CLAIM_PENDING) while a claim is in review", async () => {
    const h = unownedHarness();
    h.setPlace({ verificationStatus: "PENDING" });
    c.arrange?.(h);
    const before = state(h);
    await expect(c.run(h, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
    expect(state(h)).toEqual(before);
  });

  it("is refused PLACE_ARCHIVED / PLACE_NOT_ACTIVE", async () => {
    const archived = unownedHarness();
    archived.setPlace({ status: "ARCHIVED" });
    c.arrange?.(archived);
    await expect(c.run(archived, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_ARCHIVED",
    });

    const suspended = unownedHarness();
    suspended.setPlace({ status: "SUSPENDED" });
    c.arrange?.(suspended);
    await expect(c.run(suspended, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_NOT_ACTIVE",
      meta: { status: "SUSPENDED" },
    });
  });

  it("a claim landing after the advisory check refuses the write under the lock (D4); nothing written", async () => {
    const h = unownedHarness();
    c.arrange?.(h);
    const before = state(h);
    // The advisory check passes; the claim commits while the write waits on
    // the claim lock, so the in-tx re-check sees it.
    h.onClaimLock(() =>
      h.setOwnerships([{ id: "own-1", humanId: HUMAN_B, verified: false }]),
    );
    await expect(c.run(h, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
    expect(h.authz.hasStaffRole).toHaveBeenCalled();
    expect(h.claimLocks()).toEqual([`claim:${PLACE_ID}`]);
    expect(state(h)).toEqual(before);
  });

  it("refuses a non-staff outsider NOT_RESOURCE_OWNER, before any lock", async () => {
    const h = unownedHarness();
    c.arrange?.(h);
    const before = state(h);
    await expect(c.run(h, OUTSIDER)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "place" },
    });
    expect(h.claimLocks()).toEqual([]);
    expect(state(h)).toEqual(before);
  });

  it("the owner path takes no claim lock and writes no community audit row", async () => {
    const h = makeHarness({ moderators: [MODERATOR] }); // HUMAN_A manages it
    c.arrange?.(h);
    await c.run(h, HUMAN_A);
    c.landed(h);
    expect(h.claimLocks()).toEqual([]);
    expect(communityAudits(h)).toEqual([]);
    expect(h.authz.hasStaffRole).not.toHaveBeenCalled();
  });
});

describe("community moderator: HUMAN and ORGANIZATION pages stay owner-only (R3)", () => {
  it.each(WRITES)(
    "$name refuses a moderator on a HUMAN page exactly as before",
    async (c) => {
      const h = makeHarness({
        moderators: [MODERATOR],
        ownerType: "HUMAN",
        ownerId: HUMAN_A,
      });
      c.arrange?.(h);
      const before = state(h);
      await expect(
        c.run(h, MODERATOR, { ownerType: "HUMAN", ownerId: HUMAN_A }),
      ).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "page" },
      });
      expect(h.authz.hasStaffRole).not.toHaveBeenCalled();
      expect(h.claimLocks()).toEqual([]);
      expect(state(h)).toEqual(before);
    },
  );

  it.each(WRITES)(
    "$name refuses a moderator on an ORGANIZATION page exactly as before",
    async (c) => {
      const h = makeHarness({
        moderators: [MODERATOR],
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
      });
      c.arrange?.(h);
      const before = state(h);
      await expect(
        c.run(h, MODERATOR, { ownerType: "ORGANIZATION", ownerId: ORG_ID }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(h.authz.hasStaffRole).not.toHaveBeenCalled();
      expect(h.claimLocks()).toEqual([]);
      expect(state(h)).toEqual(before);
    },
  );
});

describe("community moderator: draft specifics", () => {
  it("getPageDraft (a read) passes on an unowned place with no lock and no audit row", async () => {
    const h = unownedHarness();
    h.setRow(draftRow());
    const result = await getPageDraft(deps(h) as never, who(MODERATOR));
    expect(result.draft.data).toEqual({ "page.bio": "Draft bio" });
    expect(h.claimLocks()).toEqual([]);
    expect(h.audits()).toEqual([]);
  });

  it("getPageDraft refuses a moderator PLACE_HAS_OWNER on an owned place", async () => {
    const h = makeHarness({ moderators: [MODERATOR] });
    await expect(
      getPageDraft(deps(h) as never, who(MODERATOR)),
    ).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "OWNED" },
    });
  });

  it("getPageDraft still refuses a non-staff outsider", async () => {
    const h = unownedHarness();
    await expect(
      getPageDraft(deps(h) as never, who(OUTSIDER)),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("savePageDraft refuses a moderator SETTING a place.* path (D3), writing nothing", async () => {
    const h = unownedHarness();
    const before = state(h);
    const result = await savePageDraft(deps(h) as never, {
      ...who(MODERATOR),
      batchId: randomUUID(),
      clientRevision: 0,
      ops: [
        { path: "page.bio", value: "Fine" },
        { path: "place.capacity", value: 300 },
      ],
    });
    expect(result).toMatchObject({
      outcome: "refused",
      errors: [
        { index: 1, path: "place.capacity", code: "place_fact_not_for_moderator" },
      ],
    });
    expect(communityAudits(h)).toEqual([]);
    expect({ ...state(h), row: null }).toEqual({ ...before, row: null });
    expect(h.row()?.data ?? {}).toEqual({});
  });

  it("publishPageDraft refuses a moderator a draft holding a Place patch, writing nothing", async () => {
    const h = unownedHarness();
    h.setRow(
      draftRow({
        placePatch: { capacity: 300 },
        placeBase: { capacity: 200 },
      }),
    );
    const before = state(h);
    const result = await publishPageDraft(deps(h) as never, {
      ...who(MODERATOR),
      draftRevision: 1,
    });
    expect(result).toMatchObject({
      outcome: "refused",
      errors: [{ path: "place.capacity", code: "place_fact_not_for_moderator" }],
    });
    expect(h.places.upsert).not.toHaveBeenCalled();
    expect(state(h)).toEqual(before);
  });

  it("publishPageDraft: the claim lock is the transaction's FIRST lock (before the draft row)", async () => {
    const h = unownedHarness();
    h.setRow(draftRow());
    await publishPageDraft(deps(h) as never, {
      ...who(MODERATOR),
      draftRevision: 1,
    });
    const claimAt = h.places.lockPlaceForClaim.mock.invocationCallOrder[0]!;
    const draftAt = h.entityPages.lockDraftForUpdate.mock.invocationCallOrder[0]!;
    expect(claimAt).toBeLessThan(draftAt);
  });
});

describe("resolveEntityPageEditor", () => {
  it("answers owner for a place manager without asking hasStaffRole", async () => {
    const h = makeHarness({ moderators: [MODERATOR] });
    await expect(
      resolveEntityPageEditor(deps(h) as never, who(HUMAN_A)),
    ).resolves.toEqual({ kind: "owner" });
    expect(h.authz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("answers community_moderator on an unowned place, asking for the moderation roles", async () => {
    const h = unownedHarness();
    await expect(
      resolveEntityPageEditor(deps(h) as never, who(MODERATOR)),
    ).resolves.toEqual({ kind: "community_moderator", placeId: PLACE_ID });
    expect(h.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: MODERATOR,
      requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
    });
  });

  it("PLACE_NOT_FOUND for a moderator on a place that does not exist", async () => {
    const h = unownedHarness();
    await expect(
      resolveEntityPageEditor(deps(h) as never, {
        ...who(MODERATOR),
        ownerId: "place-missing",
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("a role holder without a second factor gets SECOND_FACTOR_REQUIRED, not NOT_RESOURCE_OWNER", async () => {
    const h = unownedHarness();
    h.authz.hasStaffRole.mockResolvedValueOnce({
      allowed: false,
      secondFactorRequired: true,
    } as never);
    await expect(
      resolveEntityPageEditor(deps(h) as never, who(MODERATOR)),
    ).rejects.toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
  });
});

describe("updatePage: a moderator write merges from the row read in the transaction", () => {
  it("keeps a field another write changed after the pre-transaction read", async () => {
    const h = unownedHarness();
    // Another moderator's write commits while this one waits on the claim
    // lock: the slug and the banner change.
    h.onClaimLock(() => {
      const page = h.page()!;
      h.setPage({ ...page, slug: "renamed-room", bannerUrl: null });
    });
    await updatePage(deps(h) as never, { ...who(MODERATOR), bio: "New bio" });
    expect(h.page()).toMatchObject({
      bio: "New bio",
      slug: "renamed-room",
      bannerUrl: null,
    });
    // Not a slug change of OURS: no history row, and the audit says bio.
    expect(h.slugHistory()).toEqual([]);
    expect(communityAudits(h)[0]?.data).toMatchObject({
      fields: ["bio"],
      from: { bio: "Live bio" },
      to: { bio: "New bio" },
    });
  });

  it("refuses a moderator's displayName on a PLACE page (a place has ONE name), writing nothing", async () => {
    const h = unownedHarness();
    const before = state(h);
    await expect(
      updatePage(deps(h) as never, {
        ...who(MODERATOR),
        displayName: "Another name",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { field: "displayName" },
    });
    expect(state(h)).toEqual(before);
  });

  it("bounds a long bio in the audit row to a digest", async () => {
    const h = unownedHarness();
    const bio = "x".repeat(1_500);
    await updatePage(deps(h) as never, { ...who(MODERATOR), bio });
    expect(h.page()?.bio).toBe(bio);
    expect(communityAudits(h)[0]?.data).toMatchObject({
      fields: ["bio"],
      to: {
        bio: {
          truncated: true,
          length: 1_500,
          sha256: createHash("sha256").update(bio).digest("hex"),
        },
      },
    });
  });
});

describe("getPageDraft: a moderator sees no Place facts", () => {
  function withPlaceDraft(h: Harness) {
    h.setRow(
      draftRow({
        data: { "page.bio": "Draft bio" },
        placePatch: { phone: "+1 612 555 0100" },
        placeBase: { phone: null },
        fieldEditors: {
          "page.bio": { humanId: HUMAN_A, at: NOW.toISOString(), rev: 1 },
          "place.phone": { humanId: HUMAN_A, at: NOW.toISOString(), rev: 1 },
        },
      }),
    );
  }

  it("returns no livePlace, an empty placePatch and no place.* editors or sync changes", async () => {
    const h = unownedHarness();
    h.setPlace({ addressLine1: "1 Main St", postalCode: "55401", lat: 44.9, lng: -93.2 });
    withPlaceDraft(h);
    const result = await getPageDraft(deps(h) as never, {
      ...who(MODERATOR),
      sinceRevision: 0,
    });
    expect(result.livePlace).toBeNull();
    expect(result.draft.placePatch).toEqual({});
    expect(result.draft.data).toEqual({ "page.bio": "Draft bio" });
    expect(result.draft.editors.map((e) => e.path)).toEqual(["page.bio"]);
    expect(result.sync?.changes.map((c) => c.path)).toEqual(["page.bio"]);
    expect(JSON.stringify(result)).not.toContain("55401");
    expect(JSON.stringify(result)).not.toContain("555 0100");
  });

  it("the owner still gets the Place facts and the patch", async () => {
    const h = makeHarness({ moderators: [MODERATOR] });
    withPlaceDraft(h);
    const result = await getPageDraft(deps(h) as never, who(HUMAN_A));
    expect(result.livePlace).not.toBeNull();
    expect(result.draft.placePatch).toEqual({ phone: "+1 612 555 0100" });
  });
});

describe("boundAuditValue", () => {
  it("keeps small values verbatim", () => {
    const value = { bio: "short", n: 3, ok: true, none: null, list: ["a", "b"] };
    expect(boundAuditValue(value)).toEqual(value);
  });

  it("digests a long string with its length", () => {
    const long = "y".repeat(COMMUNITY_AUDIT_MAX_STRING + 1);
    expect(boundAuditValue({ text: long })).toEqual({
      text: {
        truncated: true,
        length: long.length,
        sha256: createHash("sha256").update(long).digest("hex"),
      },
    });
  });

  it("keeps at most COMMUNITY_AUDIT_MAX_ITEMS array items and counts the rest", () => {
    const list = Array.from({ length: COMMUNITY_AUDIT_MAX_ITEMS + 5 }, (_, i) => i);
    const bounded = boundAuditValue(list) as unknown[];
    expect(bounded).toHaveLength(COMMUNITY_AUDIT_MAX_ITEMS + 1);
    expect(bounded.at(-1)).toEqual({ omittedItems: 5 });
  });

  it("a structure still too large serialised becomes ONE digest", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`field${i}`, "z".repeat(100)]),
    );
    const bounded = boundAuditValue(wide) as { truncated: boolean; length: number };
    expect(bounded).toMatchObject({ truncated: true });
    expect(bounded.length).toBeGreaterThan(COMMUNITY_AUDIT_MAX_JSON);
  });
});

describe("community moderator: an earlier owner's Place patch never reaches a moderator", () => {
  const SECRET_PHONE = "+1 612 555 0100";
  const SECRET_POSTCODE = "55499";

  /** A row an owner left: a pending phone and street address. */
  function withOwnersPlacePatch(h: Harness) {
    h.setRow(
      draftRow({
        data: { "page.bio": "Draft bio" },
        placePatch: {
          phone: SECRET_PHONE,
          address: {
            formatted: `9 Hidden Rd, Minneapolis, MN ${SECRET_POSTCODE}`,
            postalCode: SECRET_POSTCODE,
            countryCode: "US",
          },
        },
        placeBase: { phone: null, address: null },
        fieldEditors: {
          "page.bio": { humanId: HUMAN_A, at: NOW.toISOString(), rev: 1 },
          "place.phone": { humanId: HUMAN_A, at: NOW.toISOString(), rev: 1 },
          "place.address": { humanId: HUMAN_A, at: NOW.toISOString(), rev: 1 },
        },
      }),
    );
  }

  function expectNoSecrets(value: unknown) {
    const json = JSON.stringify(value);
    expect(json).not.toContain(SECRET_PHONE);
    expect(json).not.toContain(SECRET_POSTCODE);
  }

  it("savePageDraft: a refused place.* op answers with no Place value (clientRevision 0)", async () => {
    const h = unownedHarness();
    withOwnersPlacePatch(h);
    const result = await savePageDraft(deps(h) as never, {
      ...who(MODERATOR),
      batchId: randomUUID(),
      clientRevision: 0,
      ops: [{ path: "place.capacity", value: 300 }],
    });
    expect(result).toMatchObject({ outcome: "refused" });
    expectNoSecrets(result);
    expect(
      (result as { sync: { changes: { path: string }[] } }).sync.changes.map(
        (c) => c.path,
      ),
    ).toEqual(["page.bio"]);
  });

  it("savePageDraft: an applied save answers with no Place value, and a resync overlay has an empty placePatch", async () => {
    const h = unownedHarness();
    withOwnersPlacePatch(h);
    const result = await savePageDraft(deps(h) as never, {
      ...who(MODERATOR),
      batchId: randomUUID(),
      clientRevision: 0,
      ops: [{ path: "page.bio", value: "Moderator bio" }],
    });
    expect(result).toMatchObject({ outcome: "applied" });
    expectNoSecrets(result);
    const overlay = (result as { overlay: { placePatch: unknown } | null }).overlay;
    if (overlay) expect(overlay.placePatch).toEqual({});
  });

  it("savePageDraft: a moderator may not revert an owner's place.* edit either (one rule), writing nothing", async () => {
    const h = unownedHarness();
    withOwnersPlacePatch(h);
    const before = state(h);
    const result = await savePageDraft(deps(h) as never, {
      ...who(MODERATOR),
      batchId: randomUUID(),
      clientRevision: 1,
      ops: [{ path: "place.phone", revert: true }],
    });
    expect(result).toMatchObject({
      outcome: "refused",
      errors: [
        { index: 0, path: "place.phone", code: "place_fact_not_for_moderator" },
      ],
    });
    expect(h.row()?.placePatch).toHaveProperty("phone", SECRET_PHONE);
    expect(state(h)).toEqual(before);
    expect(communityAudits(h)).toEqual([]);
    expectNoSecrets(result);
  });

  it("publishPageDraft: \"theirs\" resolutions cannot get a moderator past the stored Place patch", async () => {
    const h = unownedHarness();
    withOwnersPlacePatch(h);
    const before = state(h);
    const result = await publishPageDraft(deps(h) as never, {
      ...who(MODERATOR),
      draftRevision: 1,
      resolutions: {
        phone: { choice: "theirs", live: null },
        address: { choice: "theirs", live: null },
      },
    });
    expect(result).toMatchObject({ outcome: "refused" });
    expect(result).not.toHaveProperty("conflicts");
    const codes = (result as { errors: { path: string; code: string }[] }).errors;
    expect(codes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "place.phone", code: "place_fact_not_for_moderator" }),
        expect.objectContaining({ path: "place.address", code: "place_fact_not_for_moderator" }),
      ]),
    );
    expectNoSecrets(result);
    expect(JSON.stringify(result)).not.toContain("1 Main St");
    // Nothing cleared or written: the owner's patch is still there.
    expect(state(h)).toEqual(before);
    expect(h.events.lockLocationsAtPlace).not.toHaveBeenCalled();
  });

  it("discardPageDraft: refuses a moderator when the draft holds a Place patch, writing nothing", async () => {
    const h = unownedHarness();
    withOwnersPlacePatch(h);
    const before = state(h);
    await expect(
      discardPageDraft(deps(h) as never, {
        ...who(MODERATOR),
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { reason: "page_draft_holds_place_patch" },
    });
    expect(state(h)).toEqual(before);
  });

  it("discardPageDraft: a draft holding ONLY an owner's Place patch is already_empty to a moderator", async () => {
    const h = unownedHarness();
    withOwnersPlacePatch(h);
    h.setRow({ ...h.row()!, data: {} });
    const before = state(h);
    await expect(
      discardPageDraft(deps(h) as never, {
        ...who(MODERATOR),
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: "already_empty" });
    expect(state(h)).toEqual(before);
  });

  it("the owner's discard still clears both overlays", async () => {
    const h = makeHarness({ moderators: [MODERATOR] });
    withOwnersPlacePatch(h);
    await expect(
      discardPageDraft(deps(h) as never, { ...who(HUMAN_A), expectedRevision: 1 }),
    ).resolves.toMatchObject({ outcome: "discarded" });
    expect(h.row()?.placePatch).toEqual({});
  });
});

describe("updatePage: an image URL re-sent after the in-tx row moved", () => {
  it("refuses the pre-transaction banner URL once the in-tx row no longer holds it", async () => {
    const h = unownedHarness();
    const oldBanner = ownedImage("live-banner");
    expect(h.page()?.bannerUrl).toBe(oldBanner);
    // Another write replaces the banner while this one waits on the lock.
    h.onClaimLock(() => h.setPage({ ...h.page()!, bannerUrl: null }));
    await expect(
      updatePage(deps(h) as never, {
        ...who(MODERATOR),
        bio: "New bio",
        bannerUrl: oldBanner,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { field: "bannerUrl" },
    });
    expect(h.page()?.bio).toBe("Live bio");
  });

  it("re-sending the unchanged banner still passes when nothing moved", async () => {
    const h = unownedHarness();
    const oldBanner = ownedImage("live-banner");
    await updatePage(deps(h) as never, {
      ...who(MODERATOR),
      bio: "New bio",
      bannerUrl: oldBanner,
    });
    expect(h.page()).toMatchObject({ bio: "New bio", bannerUrl: oldBanner });
  });
});
