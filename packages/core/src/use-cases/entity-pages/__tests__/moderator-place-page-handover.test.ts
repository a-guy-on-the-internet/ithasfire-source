/**
 * The moderator place page's probe, attribution and owner handover (moderator
 * place page spec docs/specs/2026-10-14/moderator-place-page.spec.yaml,
 * FR-005..FR-007, D6 / D7):
 *
 *  - getPlacePageEditAccess answers owner / moderator / outsider and the
 *    refusal reasons, writing nothing;
 *  - the attribution is DERIVED from audit rows: present after a moderator
 *    write, gone after a handover row, back after a later moderator write;
 *  - getCommunityHandover is the owner's alone;
 *  - resolveCommunityHandover "keep" logs and leaves the page; "clear"
 *    resets page fields, main-section blocks and theme in one transaction,
 *    refuses while a draft is pending, records the before-state, and queues
 *    the orphaned images, which the drain re-checks before deleting (an
 *    image put back is kept); nothing pending = no write.
 */

import { describe, expect, it, vi } from "vitest";

import { drainPendingDeletions } from "../../storage/drain-pending-deletions";
import {
  COMMUNITY_HANDOVER_MAX_UPDATES,
  COMMUNITY_SEED_TEMPLATE_OP,
  ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION,
  findCommunityAttribution,
  findPendingCommunityHandover,
} from "../community-handover-state";
import {
  ENTITY_PAGE_AUDIT_ENTITY,
  ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
} from "../entity-page-access";
import { getCommunityHandover } from "../get-community-handover";
import { getPlacePageEditAccess } from "../get-place-page-edit-access";
import { managePageBlocks } from "../manage-page-blocks";
import { PAGE_DRAFT_DISCARD_DELETE_GRACE_MS } from "../page-draft-shared";
import { COMMUNITY_HANDOVER_CLEAR_DELETION_SOURCE } from "../page-image-references";
import { getPageTemplate } from "../page-templates";
import { resolveCommunityHandover } from "../resolve-community-handover";
import { templateSpecToBlock } from "../seed-page-template-blocks";
import { updatePage } from "../update-page";
import {
  CDN,
  HUMAN_A,
  NOW,
  OUTSIDER,
  PAGE_ID,
  PLACE_ID,
  block,
  makeHarness,
  ownedImage,
  strippedName,
  type Harness,
  type HarnessOptions,
} from "./page-draft-harness";

const MODERATOR = "human-moderator";
const OTHER_MODERATOR = "human-moderator-2";
const PLATFORM_ADMIN = "human-platform-admin";
// The probe and the handover take a uuid place id.
const PLACE_UUID = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

/** An owned image / its key under the uuid place's prefix. */
function uuidImage(name: string): string {
  return ownedImage(name, "PLACE", PLACE_UUID);
}
function uuidKey(name: string): string {
  return `entity-pages/place/${PLACE_UUID}/2026-10-08/${strippedName(name)}.jpg`;
}

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
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

function moderatorWrite(
  h: Harness,
  when: Date,
  actor = MODERATOR,
  op = "updatePage",
  fields = ["bio"],
) {
  h.seedAudit({
    entity: ENTITY_PAGE_AUDIT_ENTITY,
    entityId: PAGE_ID,
    action: ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
    data: {
      actorHumanId: actor,
      placeId: PLACE_ID,
      pageId: PAGE_ID,
      op,
      fields,
      from: {},
      to: {},
    },
    at: when,
  });
}

function handoverRow(h: Harness, when: Date, choice = "keep") {
  h.seedAudit({
    entity: ENTITY_PAGE_AUDIT_ENTITY,
    entityId: PAGE_ID,
    action: ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION,
    data: { actorHumanId: HUMAN_A, pageId: PAGE_ID, placeId: PLACE_ID, choice },
    at: when,
  });
}

function handovers(h: Harness) {
  return h
    .audits()
    .filter((row) => row.action === ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION);
}

// ── FR-005: the probe ──────────────────────────────────────────────────────

describe("getPlacePageEditAccess", () => {
  /** The harness keys its place by PLACE_ID; the probe sends that id. */
  function probe(h: Harness, actor: string) {
    return getPlacePageEditAccess(
      { authz: h.authz, repos: h.repos, clock: h.clock, logger: h.logger },
      { actorHumanId: actor, placeId: PLACE_UUID },
    );
  }

  /** Points the harness place lookups at the uuid the probe sends. */
  function atUuid(h: Harness): Harness {
    const getById = h.places.getById.getMockImplementation();
    h.places.getById.mockImplementation(async (id: string) =>
      id === PLACE_UUID ? ((await getById?.(PLACE_ID)) ?? null) : null,
    );
    return h;
  }

  it("an owner may edit, as owner", async () => {
    const h = atUuid(makeHarness({ placeManagers: { [HUMAN_A]: [PLACE_UUID] } }));
    await expect(probe(h, HUMAN_A)).resolves.toEqual({
      placeId: PLACE_UUID,
      canEditPage: true,
      editorKind: "owner",
      reason: null,
    });
  });

  it("a moderator may edit an unowned ACTIVE place, as community moderator", async () => {
    const h = atUuid(unownedHarness());
    await expect(probe(h, MODERATOR)).resolves.toEqual({
      placeId: PLACE_UUID,
      canEditPage: true,
      editorKind: "community_moderator",
      reason: null,
    });
  });

  it("writes nothing and takes no claim lock", async () => {
    const h = atUuid(unownedHarness());
    const before = { audits: h.audits(), blocks: h.blocks(), page: h.page() };
    await probe(h, MODERATOR);
    expect({ audits: h.audits(), blocks: h.blocks(), page: h.page() }).toEqual(
      before,
    );
    expect(h.claimLocks()).toEqual([]);
    expect(h.entityPages.applyTemplateSeed).not.toHaveBeenCalled();
  });

  it("an outsider is NOT_ALLOWED, owned place or not, with nothing about ownership", async () => {
    for (const h of [atUuid(unownedHarness()), atUuid(makeHarness())]) {
      await expect(probe(h, OUTSIDER)).resolves.toEqual({
        placeId: PLACE_UUID,
        canEditPage: false,
        editorKind: null,
        reason: "NOT_ALLOWED",
      });
    }
  });

  it("a moderator on an OWNED place is refused OWNED", async () => {
    const h = atUuid(makeHarness({ moderators: [MODERATOR] }));
    await expect(probe(h, MODERATOR)).resolves.toMatchObject({
      canEditPage: false,
      editorKind: null,
      reason: "OWNED",
    });
  });

  it("a moderator on a place with a claim in review is refused CLAIM_PENDING", async () => {
    const h = atUuid(unownedHarness());
    h.setPlace({ verificationStatus: "PENDING" });
    await expect(probe(h, MODERATOR)).resolves.toMatchObject({
      canEditPage: false,
      reason: "CLAIM_PENDING",
    });
  });

  it("a moderator on an ARCHIVED place is refused ARCHIVED; SUSPENDED is NOT_ACTIVE", async () => {
    const archived = atUuid(unownedHarness());
    archived.setPlace({ status: "ARCHIVED" });
    await expect(probe(archived, MODERATOR)).resolves.toMatchObject({
      canEditPage: false,
      reason: "ARCHIVED",
    });
    const suspended = atUuid(unownedHarness());
    suspended.setPlace({ status: "SUSPENDED" });
    await expect(probe(suspended, MODERATOR)).resolves.toMatchObject({
      canEditPage: false,
      reason: "NOT_ACTIVE",
    });
  });

  it("a role holder without a second factor is told so, not thrown at", async () => {
    const h = atUuid(unownedHarness());
    h.authz.hasStaffRole.mockResolvedValueOnce({
      allowed: false,
      secondFactorRequired: true,
    } as never);
    await expect(probe(h, MODERATOR)).resolves.toMatchObject({
      canEditPage: false,
      reason: "SECOND_FACTOR_REQUIRED",
    });
  });

  it("a moderator asking about an unknown place gets PLACE_NOT_FOUND", async () => {
    const h = unownedHarness();
    h.places.getById.mockResolvedValue(null);
    await expect(probe(h, MODERATOR)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });

  it("refuses a non-uuid place id", async () => {
    const h = unownedHarness();
    await expect(
      getPlacePageEditAccess(
        { authz: h.authz, repos: h.repos, clock: h.clock },
        { actorHumanId: MODERATOR, placeId: PLACE_ID },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ── FR-006: the attribution, derived ────────────────────────────────────────

describe("findCommunityAttribution", () => {
  it("is null with no moderator write", async () => {
    const h = makeHarness();
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toBeNull();
  });

  it("is present after a real moderator write (updatePage's audit row)", async () => {
    const h = unownedHarness();
    await updatePage(
      {
        repos: h.repos,
        authz: h.authz,
        clock: h.clock,
        storage: { getObjectUrl: async () => ({ url: "unused" }) },
      },
      {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        bio: "Written by the community",
      },
    );
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toEqual({
      maintainedByCommunity: true,
      lastUpdatedAt: NOW,
    });
  });

  it("is gone after a handover row, and back after a later moderator write", async () => {
    const h = makeHarness();
    moderatorWrite(h, at(1));
    moderatorWrite(h, at(2));
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toEqual({
      maintainedByCommunity: true,
      lastUpdatedAt: at(2),
    });

    handoverRow(h, at(3));
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toBeNull();

    moderatorWrite(h, at(10));
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toEqual({
      maintainedByCommunity: true,
      lastUpdatedAt: at(10),
    });
  });

  it("ignores another page's rows and other entity_page actions", async () => {
    const h = makeHarness();
    h.seedAudit({
      entity: ENTITY_PAGE_AUDIT_ENTITY,
      entityId: "page-other",
      action: ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
      data: { actorHumanId: MODERATOR },
      at: at(1),
    });
    h.seedAudit({
      entity: ENTITY_PAGE_AUDIT_ENTITY,
      entityId: PAGE_ID,
      action: "entity_page.draft_published",
      data: { actorHumanId: HUMAN_A },
      at: at(2),
    });
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toBeNull();
  });

  it("reads two single rows, exact-match", async () => {
    const h = makeHarness();
    moderatorWrite(h, at(1));
    handoverRow(h, at(0));
    await findCommunityAttribution(h.repos, PAGE_ID);
    expect(h.audit.listForEntity.mock.calls).toEqual([
      [
        {
          entity: "entity_page",
          entityId: PAGE_ID,
          actions: [ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION],
          limit: 1,
        },
      ],
      [
        {
          entity: "entity_page",
          entityId: PAGE_ID,
          actions: [ENTITY_PAGE_COMMUNITY_UPDATED_ACTION],
          after: at(0),
          limit: 1,
        },
      ],
    ]);
  });
});

describe("findPendingCommunityHandover", () => {
  it("bounds the list and says it was truncated", async () => {
    const h = makeHarness();
    for (let i = 0; i < COMMUNITY_HANDOVER_MAX_UPDATES + 5; i += 1) {
      moderatorWrite(h, at(i));
    }
    const pending = await findPendingCommunityHandover(h.repos, PAGE_ID);
    expect(pending?.updates).toHaveLength(COMMUNITY_HANDOVER_MAX_UPDATES);
    expect(pending?.truncated).toBe(true);
    expect(pending?.updates[0]?.at).toEqual(at(COMMUNITY_HANDOVER_MAX_UPDATES + 4));
  });

  it("lists a malformed row and reports it; a throwing reporter changes nothing", async () => {
    const h = makeHarness();
    h.seedAudit({
      entity: ENTITY_PAGE_AUDIT_ENTITY,
      entityId: PAGE_ID,
      action: ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
      data: { note: "no actor, op or fields" },
      at: at(1),
    });
    const reports: unknown[] = [];
    const pending = await findPendingCommunityHandover(
      h.repos,
      PAGE_ID,
      (err, context) => {
        reports.push({ err, context });
        throw new Error("reporter down");
      },
    );
    expect(pending?.updates).toEqual([
      { humanId: null, op: "unknown", fields: [], at: at(1) },
    ]);
    expect(reports).toHaveLength(1);
  });
});

// ── FR-007a: the owner's read ──────────────────────────────────────────────

describe("template seed rows are not moderator content", () => {
  const seed = (h: Harness, when: Date) =>
    moderatorWrite(h, when, MODERATOR, COMMUNITY_SEED_TEMPLATE_OP, ["blocks.b1"]);

  it("seed-only rows give no attribution and no pending handover", async () => {
    const h = makeHarness();
    seed(h, at(1));
    seed(h, at(2));
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toBeNull();
    await expect(
      findPendingCommunityHandover(h.repos, PAGE_ID),
    ).resolves.toBeNull();
  });

  it("a seed plus a real write gives attribution and one change", async () => {
    const h = makeHarness();
    moderatorWrite(h, at(1));
    seed(h, at(2));
    seed(h, at(3));
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toEqual({
      maintainedByCommunity: true,
      lastUpdatedAt: at(1),
    });
    const pending = await findPendingCommunityHandover(h.repos, PAGE_ID);
    expect(pending?.updates).toHaveLength(1);
    expect(pending?.updates[0]?.op).toBe("updatePage");
    expect(pending?.truncated).toBe(false);
  });

  it("a seed after a handover does not re-arm it", async () => {
    const h = makeHarness();
    moderatorWrite(h, at(1));
    handoverRow(h, at(2));
    seed(h, at(3));
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toBeNull();
    await expect(
      findPendingCommunityHandover(h.repos, PAGE_ID),
    ).resolves.toBeNull();
  });

  it("seed rows crowding the window do not hide a real write or fake truncation", async () => {
    const h = makeHarness();
    moderatorWrite(h, at(0));
    for (let i = 1; i <= COMMUNITY_HANDOVER_MAX_UPDATES + 3; i += 1) {
      seed(h, at(i));
    }
    const pending = await findPendingCommunityHandover(h.repos, PAGE_ID);
    expect(pending?.updates).toHaveLength(1);
    expect(pending?.truncated).toBe(false);
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toEqual({
      maintainedByCommunity: true,
      lastUpdatedAt: at(0),
    });
  });
});

describe("a 500-row audit read cap", () => {
  it("is truncated, not exhausted, when 500+ seed rows hide the real writes", async () => {
    const h = makeHarness();
    moderatorWrite(h, at(0));
    for (let i = 1; i <= 520; i += 1) {
      moderatorWrite(h, at(i), MODERATOR, COMMUNITY_SEED_TEMPLATE_OP, ["blocks.b"]);
    }
    // The adapter never returns more than 500 rows, whatever is asked.
    const fake = h.audit.listForEntity.getMockImplementation();
    h.audit.listForEntity.mockImplementation((input) =>
      fake!({ ...input, limit: Math.min(input.limit, 500) }),
    );
    const pending = await findPendingCommunityHandover(h.repos, PAGE_ID);
    expect(pending?.truncated).toBe(true);
    expect(pending?.updates).toEqual([]);
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toBeNull();
  });
});

describe("getCommunityHandover", () => {
  function read(h: Harness, actor: string) {
    return getCommunityHandover(
      { authz: h.authz, repos: h.repos, logger: h.logger },
      { actorHumanId: actor, placeId: PLACE_UUID },
    );
  }

  /** An owned place (HUMAN_A manages it) whose page moderators wrote. */
  function claimedHarness(): Harness {
    const h = makeHarness({
      // The ADMIN holds a staff role but manages no place (canManagePlace
      // never lets a platform role in).
      moderators: [MODERATOR, OTHER_MODERATOR, PLATFORM_ADMIN],
      placeManagers: { [HUMAN_A]: [PLACE_UUID] },
      humans: [
        { id: HUMAN_A, name: "Ana" },
        { id: MODERATOR, name: "Mo" },
        { id: PLATFORM_ADMIN, name: "Admin" },
      ],
    });
    h.setPage({ ...h.page()!, ownerId: PLACE_UUID });
    return h;
  }

  it("lists the writers by account id and name, ops, fields and times for the owner", async () => {
    const h = claimedHarness();
    moderatorWrite(h, at(1), MODERATOR, "updatePage", ["bio"]);
    moderatorWrite(h, at(2), OTHER_MODERATOR, "managePageBlocks.edit", [
      "blocks.blk-about",
    ]);
    moderatorWrite(h, at(3), MODERATOR, "updatePageTheme", ["theme.colorBg"]);

    await expect(read(h, HUMAN_A)).resolves.toEqual({
      placeId: PLACE_UUID,
      pageId: PAGE_ID,
      pending: {
        sinceHandoverAt: null,
        firstUpdatedAt: at(1).toISOString(),
        lastUpdatedAt: at(3).toISOString(),
        writers: [
          {
            humanId: MODERATOR,
            name: "Mo",
            updateCount: 2,
            firstUpdatedAt: at(1).toISOString(),
            lastUpdatedAt: at(3).toISOString(),
          },
          {
            // A human gone since keeps the id, shows without a name.
            humanId: OTHER_MODERATOR,
            name: null,
            updateCount: 1,
            firstUpdatedAt: at(2).toISOString(),
            lastUpdatedAt: at(2).toISOString(),
          },
        ],
        updates: [
          {
            humanId: MODERATOR,
            name: "Mo",
            op: "updatePageTheme",
            fields: ["theme.colorBg"],
            at: at(3).toISOString(),
          },
          {
            humanId: OTHER_MODERATOR,
            name: null,
            op: "managePageBlocks.edit",
            fields: ["blocks.blk-about"],
            at: at(2).toISOString(),
          },
          {
            humanId: MODERATOR,
            name: "Mo",
            op: "updatePage",
            fields: ["bio"],
            at: at(1).toISOString(),
          },
        ],
        truncated: false,
      },
    });
  });

  it("only counts writes after the latest handover", async () => {
    const h = claimedHarness();
    moderatorWrite(h, at(1));
    handoverRow(h, at(2));
    moderatorWrite(h, at(5));
    const result = await read(h, HUMAN_A);
    expect(result.pending?.sinceHandoverAt).toBe(at(2).toISOString());
    expect(result.pending?.updates.map((update) => update.at)).toEqual([
      at(5).toISOString(),
    ]);
  });

  it("is pending: null when nothing is pending", async () => {
    const h = claimedHarness();
    moderatorWrite(h, at(1));
    handoverRow(h, at(2));
    await expect(read(h, HUMAN_A)).resolves.toEqual({
      placeId: PLACE_UUID,
      pageId: PAGE_ID,
      pending: null,
    });
  });

  it("a malformed row keeps a null id on its update and makes no writer", async () => {
    const h = claimedHarness();
    moderatorWrite(h, at(1));
    h.seedAudit({
      entity: ENTITY_PAGE_AUDIT_ENTITY,
      entityId: PAGE_ID,
      action: ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
      data: { note: "no actor, op or fields" },
      at: at(2),
    });
    const result = await read(h, HUMAN_A);
    expect(result.pending?.updates).toEqual([
      {
        humanId: null,
        name: null,
        op: "unknown",
        fields: [],
        at: at(2).toISOString(),
      },
      {
        humanId: MODERATOR,
        name: "Mo",
        op: "updatePage",
        fields: ["bio"],
        at: at(1).toISOString(),
      },
    ]);
    expect(result.pending?.writers.map((writer) => writer.humanId)).toEqual([
      MODERATOR,
    ]);
    expect(h.humans.getByIds).toHaveBeenCalledWith([MODERATOR]);
  });

  // The output carries account ids, so the owner check must come before any
  // read that could reach one.
  it.each([
    ["a moderator who wrote", MODERATOR],
    ["a platform ADMIN who is not an owner", PLATFORM_ADMIN],
    ["an unrelated human", OUTSIDER],
  ])(
    "refuses %s (NOT_RESOURCE_OWNER) before reading any audit row or human",
    async (_label, actor) => {
      const h = claimedHarness();
      moderatorWrite(h, at(1));
      await expect(read(h, actor)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
      expect(h.authz.canManagePlace).toHaveBeenCalledWith({
        actorHumanId: actor,
        placeId: PLACE_UUID,
      });
      expect(h.entityPages.getByOwner).not.toHaveBeenCalled();
      expect(h.audit.listForEntity).not.toHaveBeenCalled();
      expect(h.humans.getByIds).not.toHaveBeenCalled();
      expect(h.humans.getById).not.toHaveBeenCalled();
    },
  );
});


// ── FR-007b: Keep / Clear ──────────────────────────────────────────────────

describe("resolveCommunityHandover", () => {
  const PHOTO = uuidImage("moderator-photo");
  const AVATAR = uuidImage("moderator-avatar");
  const BANNER = uuidImage("live-banner");
  const MEMBER_PHOTO = uuidImage("member-photo");
  // Owned-shaped keys of OTHER owners: never this page's to queue.
  const OTHER_PLACE_PHOTO = ownedImage(
    "other-place-photo",
    "PLACE",
    "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
  );
  const ORG_PHOTO = ownedImage("org-photo", "ORGANIZATION", "org-1");
  const THEME_BEFORE = {
    id: "theme-1",
    pageId: PAGE_ID,
    colorPrimary: "#ff0000",
    colorBg: "#000000",
    colorText: null,
    fontKey: "serif",
    layoutKey: null,
  };

  /** Owned by HUMAN_A, written by a moderator before the claim. */
  function claimedHarness(): Harness {
    const h = makeHarness({
      moderators: [MODERATOR],
      placeManagers: { [HUMAN_A]: [PLACE_UUID] },
      theme: THEME_BEFORE,
      blocks: [
        block("blk-about", "about", 0, {
          data: { heading: "About", content: "Moderator words" },
        }),
        block("blk-photos", "photos", 1, {
          data: {
            photos: [
              { url: PHOTO },
              { url: OTHER_PLACE_PHOTO },
              { url: ORG_PHOTO },
            ],
          },
        }),
        block("blk-track", "track_record", 2, { data: { heading: "Shows" } }),
        block("blk-member", "text", 3, {
          section: "memberships",
          data: { text: "member note", image: MEMBER_PHOTO },
        }),
      ],
    });
    h.setPage({
      ...h.page()!,
      ownerId: PLACE_UUID,
      bio: "Moderator bio",
      avatarUrl: AVATAR,
      bannerUrl: BANNER,
      displayName: "The Room",
    });
    // The place lookups use the uuid the action sends.
    const getById = h.places.getById.getMockImplementation();
    h.places.getById.mockImplementation(async (id: string) =>
      id === PLACE_UUID ? ((await getById?.(PLACE_ID)) ?? null) : null,
    );
    moderatorWrite(h, at(-10));
    return h;
  }

  function resolve(
    h: Harness,
    choice: "keep" | "clear",
    actor = HUMAN_A,
    storagePublicBaseUrl: string | null = CDN,
  ) {
    return resolveCommunityHandover(
      {
        repos: h.repos,
        authz: h.authz,
        clock: h.clock,
        logger: h.logger,
        storagePublicBaseUrl,
      },
      { actorHumanId: actor, placeId: PLACE_UUID, choice },
    );
  }

  function txCalls(h: Harness): number {
    return (h.repos as unknown as { tx: { mock: { calls: unknown[] } } }).tx
      .mock.calls.length;
  }

  function everything(h: Harness) {
    return {
      page: h.page(),
      theme: h.theme(),
      blocks: h.blocks(),
      row: h.row(),
      audits: h.audits(),
      pending: h.pending(),
      marks: h.marks(),
    };
  }

  function draftWith(data: Record<string, unknown>, placePatch = {}) {
    return {
      id: "draft-1",
      pageId: PAGE_ID,
      data,
      placePatch,
      placeBase: {},
      fieldEditors: {},
      appliedBatchIds: [],
      revision: 4,
      lastPublishedRevision: null,
      updatedByHumanId: HUMAN_A,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  /**
   * Runs the real deletion drain over the harness outbox, after the grace,
   * against the harness page rows (its live-reference re-check reads them).
   */
  async function drainAfterGrace(h: Harness) {
    const deleted: string[] = [];
    const due = h.pending().map((row, index) => ({
      id: `pod-${index}`,
      targetKey: row.targetKey,
      targetKind: row.targetKind,
      status: "PENDING",
      attempts: 0,
      lastError: null,
      nextAttemptAt: row.notBefore ?? NOW,
      source: row.source,
      sourceId: row.sourceId,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const pendingObjectDeletions = {
      listDue: vi.fn().mockResolvedValueOnce(due).mockResolvedValue([]),
      markDeleted: vi.fn(async () => 1),
      markFailed: vi.fn(async () => undefined),
      markDead: vi.fn(async () => undefined),
    };
    const result = await drainPendingDeletions(
      {
        repos: {
          pendingObjectDeletions,
          entityPages: h.rootEntityPages,
          places: h.places,
        } as never,
        fileStorage: {
          deleteObject: vi.fn(async ({ key }: { key: string }) => {
            deleted.push(key);
            return { ok: true as const };
          }),
          listObjects: vi.fn(),
        } as never,
        logger: h.logger,
        clock: {
          now: () =>
            new Date(NOW.getTime() + PAGE_DRAFT_DISCARD_DELETE_GRACE_MS + 1),
        },
      },
      {},
    );
    return { deleted, result, pendingObjectDeletions };
  }

  it("keep: logs the handover and leaves every row as it was", async () => {
    const h = claimedHarness();
    const before = everything(h);

    await expect(resolve(h, "keep")).resolves.toEqual({
      outcome: "kept",
      pageId: PAGE_ID,
      imagesQueuedForDeletion: 0,
    });

    const { audits: _audits, row: _row, ...after } = everything(h);
    const { audits: _a, row: _r, ...unchanged } = before;
    expect(after).toEqual(unchanged);
    expect(handovers(h)).toEqual([
      {
        entity: "entity_page",
        entityId: PAGE_ID,
        action: ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION,
        data: {
          actorHumanId: HUMAN_A,
          pageId: PAGE_ID,
          placeId: PLACE_UUID,
          choice: "keep",
          pendingUpdateCount: 1,
          pendingTruncated: false,
        },
        at: NOW,
      },
    ]);
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toBeNull();
  });

  it("keep is allowed with a pending draft and leaves the draft alone", async () => {
    const h = claimedHarness();
    h.setRow(draftWith({ "page.bio": "Owner's unpublished bio" }));
    await expect(resolve(h, "keep")).resolves.toMatchObject({ outcome: "kept" });
    expect(h.row()?.data).toEqual({ "page.bio": "Owner's unpublished bio" });
  });

  it("clear: resets the page fields, MAIN blocks and theme in ONE transaction", async () => {
    const h = claimedHarness();

    await expect(resolve(h, "clear")).resolves.toEqual({
      outcome: "cleared",
      pageId: PAGE_ID,
      imagesQueuedForDeletion: 3,
    });
    expect(txCalls(h)).toBe(1);

    // Page: bio and images emptied; slug, name and visibility kept.
    expect(h.page()).toMatchObject({
      slug: "the-room",
      displayName: "The Room",
      visibility: "PUBLIC",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
    });

    // Main section: the PLACE template fresh, in order, as the seed writes
    // it; the pinned block kept in its template slot.
    const template = getPageTemplate("PLACE", "venue");
    const main = h.blocks().filter((b) => b.section === "main");
    expect(main.map((b) => b.kind)).toEqual(template.map((spec) => spec.kind));
    expect(main.map((b) => b.orderIndex)).toEqual(template.map((_, i) => i));
    expect(main.find((b) => b.kind === "track_record")).toMatchObject({
      id: "blk-track",
      data: { heading: "Shows" },
    });
    for (const spec of template) {
      if (spec.kind === "track_record") continue;
      const written = main.find((b) => b.kind === spec.kind);
      const seeded = templateSpecToBlock(spec);
      expect(written).toMatchObject({
        data: seeded.data,
        visible: seeded.visible,
      });
      expect(written?.id.startsWith("blk-created-")).toBe(true);
    }

    // Theme: the defaults.
    expect(h.theme()).toMatchObject({
      colorPrimary: null,
      colorBg: null,
      colorText: null,
      fontKey: null,
      layoutKey: null,
    });

    // Search: the place is marked (its document carries the bio).
    expect(h.marks()).toEqual([
      expect.objectContaining({ entityType: "place", entityId: PLACE_UUID }),
    ]);
    await expect(findCommunityAttribution(h.repos, PAGE_ID)).resolves.toBeNull();
  });

  it("clear leaves non-main sections (and their images) alone, only moved after the main column", async () => {
    const h = claimedHarness();
    await resolve(h, "clear");
    const member = h.blocks().find((b) => b.id === "blk-member");
    expect(member).toMatchObject({
      section: "memberships",
      kind: "text",
      data: { text: "member note", image: MEMBER_PHOTO },
      orderIndex: getPageTemplate("PLACE", "venue").length,
    });
    expect(h.pending().map((row) => row.targetKey)).not.toContain(
      uuidKey("member-photo"),
    );
  });

  it("clear queues only THIS place's owned images, under its own source, after the grace", async () => {
    const h = claimedHarness();
    await resolve(h, "clear");
    const notBefore = new Date(NOW.getTime() + PAGE_DRAFT_DISCARD_DELETE_GRACE_MS);
    expect(h.pending().map((row) => row.targetKey).sort()).toEqual(
      [
        uuidKey("moderator-photo"),
        uuidKey("moderator-avatar"),
        uuidKey("live-banner"),
      ].sort(),
    );
    // Another place's key and an org page's key in a cleared block: not ours.
    const keys = h.pending().map((row) => row.targetKey).join(" ");
    expect(keys).not.toContain(strippedName("other-place-photo"));
    expect(keys).not.toContain(strippedName("org-photo"));
    for (const row of h.pending()) {
      expect(row).toMatchObject({
        targetKind: "KEY",
        source: COMMUNITY_HANDOVER_CLEAR_DELETION_SOURCE,
        sourceId: PAGE_ID,
        notBefore,
        status: "PENDING",
      });
    }
  });

  it("clear records the before-state and the queued keys in the handover row", async () => {
    const h = claimedHarness();
    const mainBefore = h.blocks().filter((b) => b.section === "main");
    await resolve(h, "clear");
    const [row] = handovers(h);
    expect(row?.data).toEqual({
      actorHumanId: HUMAN_A,
      pageId: PAGE_ID,
      placeId: PLACE_UUID,
      choice: "clear",
      pendingUpdateCount: 1,
      pendingTruncated: false,
      before: {
        bio: "Moderator bio",
        avatarUrl: AVATAR,
        bannerUrl: BANNER,
        theme: {
          colorPrimary: "#ff0000",
          colorBg: "#000000",
          colorText: null,
          fontKey: "serif",
          layoutKey: null,
        },
        mainBlocks: mainBefore.map((b) => ({
          id: b.id,
          kind: b.kind,
          orderIndex: b.orderIndex,
          visible: b.visible,
          data: b.data,
        })),
      },
      queuedImageKeys: expect.arrayContaining([
        uuidKey("moderator-photo"),
        uuidKey("moderator-avatar"),
        uuidKey("live-banner"),
      ]),
    });
  });

  it("the handover row says when the pending count is only a lower bound", async () => {
    const h = claimedHarness();
    for (let i = 0; i < COMMUNITY_HANDOVER_MAX_UPDATES + 3; i += 1) {
      moderatorWrite(h, at(-9 + i / 1000));
    }
    await resolve(h, "keep");
    expect(handovers(h)[0]?.data).toMatchObject({
      pendingUpdateCount: COMMUNITY_HANDOVER_MAX_UPDATES,
      pendingTruncated: true,
    });
  });

  it.each([
    ["page data", draftWith({ "page.bio": "Owner's unpublished bio" })],
    ["a Place patch", draftWith({}, { phone: "+15555550100" })],
  ])(
    "clear REFUSES while the draft holds %s (handover_draft_pending), writing nothing",
    async (_label, draft) => {
      const h = claimedHarness();
      h.setRow(draft);
      const before = everything(h);
      await expect(resolve(h, "clear")).rejects.toMatchObject({
        code: "INVALID_INPUT",
        meta: { reason: "handover_draft_pending" },
      });
      expect(everything(h)).toEqual(before);
      expect(h.entityPages.clearDraft).not.toHaveBeenCalled();
    },
  );

  it("clear never clears the draft (an empty one stays untouched)", async () => {
    const h = claimedHarness();
    h.setRow(draftWith({}));
    await resolve(h, "clear");
    expect(h.entityPages.clearDraft).not.toHaveBeenCalled();
    expect(h.row()?.revision).toBe(4);
  });

  it("REGRESSION: an image the owner puts back after Clear is not deleted by the drain", async () => {
    const h = claimedHarness();
    await resolve(h, "clear");
    expect(h.pending()).toHaveLength(3);

    // Undo in the editor: the moderator's photo block comes back through
    // managePageBlocks `add`, and updatePage sets the old avatar again.
    await managePageBlocks(
      {
        repos: h.repos,
        authz: h.authz,
        clock: h.clock,
        // The owner's own stripped upload passes the block image-URL rule.
        storagePublicBaseUrl: CDN,
      },
      {
        actorHumanId: HUMAN_A,
        ownerType: "PLACE",
        ownerId: PLACE_UUID,
        blockAction: {
          action: "add",
          kind: "photos",
          data: { photos: [{ url: PHOTO }] },
        },
      },
    );
    await updatePage(
      {
        repos: h.repos,
        authz: h.authz,
        clock: h.clock,
        // HEADs the stripped copy: it still exists (nothing deleted yet).
        storage: {
          getObjectUrl: async ({ key }: { key: string }) => ({
            url: `${CDN}/${key}`,
          }),
        },
      },
      {
        actorHumanId: HUMAN_A,
        ownerType: "PLACE",
        ownerId: PLACE_UUID,
        avatarUrl: AVATAR,
      },
    );

    const { deleted, result, pendingObjectDeletions } = await drainAfterGrace(h);
    // Only the banner, which nothing uses any more, is deleted.
    expect(deleted).toEqual([uuidKey("live-banner")]);
    expect(result).toMatchObject({ deleted: 1, skippedStillReferenced: 2 });
    // The skipped rows leave the outbox (their objects stay).
    expect(pendingObjectDeletions.markDeleted).toHaveBeenCalledTimes(3);
  });

  it("the drain deletes a Clear's images when nothing put them back", async () => {
    const h = claimedHarness();
    await resolve(h, "clear");
    const { deleted, result } = await drainAfterGrace(h);
    expect(deleted.sort()).toEqual(
      [
        uuidKey("moderator-photo"),
        uuidKey("moderator-avatar"),
        uuidKey("live-banner"),
      ].sort(),
    );
    expect(result).toMatchObject({ deleted: 3, skippedStillReferenced: 0 });
  });

  it("the drain keeps an image a later DRAFT references", async () => {
    const h = claimedHarness();
    await resolve(h, "clear");
    h.setRow(draftWith({ "page.avatarUrl": AVATAR }));
    const { deleted } = await drainAfterGrace(h);
    expect(deleted).not.toContain(uuidKey("moderator-avatar"));
  });

  it("clear keeps an image the Place row still uses", async () => {
    const h = claimedHarness();
    h.setPlace({ imageUrl: AVATAR });
    await resolve(h, "clear");
    const keys = h.pending().map((row) => row.targetKey);
    expect(keys).not.toContain(uuidKey("moderator-avatar"));
    expect(keys).toContain(uuidKey("live-banner"));
  });

  it("clear with no storage base URL queues nothing (never the wrong object)", async () => {
    const h = claimedHarness();
    await expect(resolve(h, "clear", HUMAN_A, null)).resolves.toMatchObject({
      outcome: "cleared",
      imagesQueuedForDeletion: 0,
    });
    expect(h.pending()).toEqual([]);
  });

  it("clear rolls back every write when a step fails", async () => {
    const h = claimedHarness();
    const before = everything(h);
    h.pendingObjectDeletions.enqueueMany.mockRejectedValueOnce(
      new Error("outbox down"),
    );
    await expect(resolve(h, "clear")).rejects.toThrow("outbox down");
    const { row: _r, ...after } = everything(h);
    const { row: _b, ...unchanged } = before;
    expect(after).toEqual(unchanged);
  });

  it("takes the draft lock FIRST and re-reads the pending state after it", async () => {
    const h = claimedHarness();
    const order: string[] = [];
    h.entityPages.lockDraftForUpdate.mockImplementationOnce(async () => {
      order.push("lockDraft");
      // Another owner's Keep committed while this one waited on the lock.
      handoverRow(h, at(0));
      return draftWith({});
    });
    const list = h.audit.listForEntity.getMockImplementation();
    h.audit.listForEntity.mockImplementationOnce(async (input) => {
      order.push("readPending");
      return list!(input);
    });
    await expect(resolve(h, "clear")).resolves.toMatchObject({
      outcome: "nothing_pending",
    });
    expect(order).toEqual(["lockDraft", "readPending"]);
    expect(handovers(h)).toHaveLength(1);
    expect(h.page()?.bio).toBe("Moderator bio");
  });

  it.each(["keep", "clear"] as const)(
    "%s with nothing pending is a no-op success: no write, no audit row",
    async (choice) => {
      const h = claimedHarness();
      handoverRow(h, at(-5));
      const before = everything(h);
      await expect(resolve(h, choice)).resolves.toEqual({
        outcome: "nothing_pending",
        pageId: PAGE_ID,
        imagesQueuedForDeletion: 0,
      });
      const { row: _r, ...after } = everything(h);
      const { row: _b, ...unchanged } = before;
      expect(after).toEqual(unchanged);
    },
  );

  it.each([
    ["a MODERATOR", MODERATOR],
    ["an OUTSIDER", OUTSIDER],
  ])(
    "refuses %s with NOT_RESOURCE_OWNER before any transaction or read",
    async (_label, actor) => {
      const h = claimedHarness();
      const before = everything(h);
      for (const choice of ["keep", "clear"] as const) {
        await expect(resolve(h, choice, actor)).rejects.toMatchObject({
          code: "NOT_RESOURCE_OWNER",
        });
      }
      expect(txCalls(h)).toBe(0);
      expect(h.audit.listForEntity).not.toHaveBeenCalled();
      expect(h.entityPages.getByOwner).not.toHaveBeenCalled();
      expect(everything(h)).toEqual(before);
    },
  );

  it("refuses an unknown choice", async () => {
    const h = claimedHarness();
    await expect(
      resolveCommunityHandover(
        {
          repos: h.repos,
          authz: h.authz,
          clock: h.clock,
          storagePublicBaseUrl: CDN,
        },
        { actorHumanId: HUMAN_A, placeId: PLACE_UUID, choice: "delete" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
