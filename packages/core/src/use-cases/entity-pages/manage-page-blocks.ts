import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import type { ClockPort } from "@th/ports/clock";
import type { EntityPagesRepo } from "@th/ports/repos/entity-pages";
import { fail } from "@th/errors";
import {
  isValidBlockKind,
  getValidBlockKinds,
  normalizeBlockData,
} from "./block-kinds";
import { blockImageUrlsIn, isPinnedBlockKind } from "./block-config";
import {
  normalizeBlockSection,
  pageBlockSectionSchema,
} from "./block-sections";
import {
  logCommunityPageUpdate,
  recheckCommunityPageEditor,
  resolveEntityPageEditor,
} from "./entity-page-access";
import { getEntityPageImageKeyPrefix } from "./page-image-upload-helpers";
import {
  ownedStrippedPageImageKeyFromUrl,
  type PageImageUrlScope,
} from "./page-image-urls";

// ── Action schemas ─────────────────────────────────────────────────────────

const addActionSchema = z.object({
  action: z.literal("add"),
  kind: z.string().min(1).max(100),
  data: z.unknown().optional(),
  visible: z.boolean().optional(),
  /** Page surface for the new block; defaults to "main" (see block-sections). */
  section: pageBlockSectionSchema.optional(),
});

const editActionSchema = z.object({
  action: z.literal("edit"),
  blockId: z.string().min(1),
  kind: z.string().min(1).max(100).optional(),
  data: z.unknown().optional(),
  visible: z.boolean().optional(),
});

const reorderActionSchema = z.object({
  action: z.literal("reorder"),
  orderedBlockIds: z.array(z.string().min(1)).min(1),
});

const toggleVisibilityActionSchema = z.object({
  action: z.literal("toggleVisibility"),
  blockId: z.string().min(1),
});

const deleteActionSchema = z.object({
  action: z.literal("delete"),
  blockId: z.string().min(1),
});

const blockActionSchema = z.discriminatedUnion("action", [
  addActionSchema,
  editActionSchema,
  reorderActionSchema,
  toggleVisibilityActionSchema,
  deleteActionSchema,
]);

// ── Input / Output ─────────────────────────────────────────────────────────

const pageOwnerTypeSchema = z.enum(["HUMAN", "ORGANIZATION", "PLACE"]);

export const managePageBlocksInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    ownerType: pageOwnerTypeSchema,
    ownerId: z.string().min(1),
    blockAction: blockActionSchema,
  })
  .strict();

const blockRecordSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  kind: z.string(),
  orderIndex: z.number(),
  data: z.unknown(),
  visible: z.boolean(),
  /** Page surface ("main" | "memberships"); adapter defaults it to "main". */
  section: z.string().default("main"),
});

export const managePageBlocksOutputSchema = z
  .object({
    /** The affected block (null for reorder/delete). */
    block: blockRecordSchema.nullable(),
    /** Full ordered block list after the operation. */
    blocks: z.array(blockRecordSchema),
  })
  .strict();

export type ManagePageBlocksInput = z.infer<typeof managePageBlocksInputSchema>;
export type ManagePageBlocksOutput = z.infer<
  typeof managePageBlocksOutputSchema
>;

// ── Deps ───────────────────────────────────────────────────────────────────

export type ManagePageBlocksDeps = {
  /**
   * `places`, `events` and `tx` serve the community moderator path only
   * (access rules, the claim-lock re-check and the audit row).
   */
  repos: Pick<Repos, "entityPages" | "authz" | "places" | "events" | "tx">;
  authz: AuthZPort;
  clock: ClockPort;
  /**
   * The file storage's public base URL (S3_PUBLIC_BASE_URL), against which
   * a community moderator's block image URLs are checked (the same rule
   * savePageDraft applies; see assertBlockImageUrlsAllowed). REQUIRED so a
   * composition root cannot forget it; null where the deployment has none,
   * which refuses every NEW image URL from a moderator (fail closed).
   */
  storagePublicBaseUrl: string | null;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function managePageBlocks(
  deps: ManagePageBlocksDeps,
  rawInput: unknown,
): Promise<ManagePageBlocksOutput> {
  const logger = deps.logger?.child({ useCase: "managePageBlocks" });

  const execute = async (): Promise<ManagePageBlocksOutput> => {
    const input = parseInput(managePageBlocksInputSchema, rawInput);

    const editor = await resolveEntityPageEditor(deps, input);

    const page = await deps.repos.entityPages.getByOwner(
      input.ownerType,
      input.ownerId,
    );
    if (!page) {
      throw fail("PAGE_NOT_FOUND");
    }

    const { blockAction } = input;
    const imageScope: PageImageUrlScope = {
      publicBaseUrl: deps.storagePublicBaseUrl,
      keyPrefix: getEntityPageImageKeyPrefix(input.ownerType, input.ownerId),
    };

    /**
     * The action against `entityPages` (the root repo for an owner, the
     * transaction's for a moderator), with what it changed for the audit.
     */
    const applyAction = async (
      entityPages: EntityPagesRepo,
    ): Promise<BlockActionResult> => {
      let affectedBlock: PageBlockRecord | null = null;
      let from: unknown = null;
      let to: unknown = null;
      let fields: string[] = [];

      switch (blockAction.action) {
        case "add": {
          validateKind(input.ownerType, blockAction.kind);
          // A pinned kind (venue-track-record R6 / FR-012) is seeded by the
          // template and lives ONCE per page: a second copy would be a second
          // block nobody can remove. Adding it is allowed only when the page
          // has none (the recovery path for a page that somehow lost it — see
          // seed-page-template-blocks), and never hidden.
          if (isPinnedBlockKind(blockAction.kind)) {
            if (blockAction.visible === false) {
              throw pinnedFailure(blockAction.kind, "add_hidden");
            }
            // Only the MAIN section reaches the public page; a pinned block
            // filed anywhere else would be invisible, undeletable, and — since
            // `edit` cannot move a block between sections — unrecoverable.
            if (
              blockAction.section !== undefined &&
              normalizeBlockSection(blockAction.section) !== "main"
            ) {
              throw pinnedFailure(blockAction.kind, "add_sectioned");
            }
            // "Present" means a MAIN-section copy — a stray non-main copy (only
            // possible from before this gate, or by hand) never counts, so it
            // can never SILENTLY satisfy the check. It does not make the add
            // succeed either: the DB's partial unique index on (pageId, kind)
            // for pinned kinds is section-blind, so the insert is refused and
            // the adapter maps that P2002 to the same BLOCK_PINNED
            // add_duplicate. The same index is the race guard for two
            // concurrent recovery adds that both pass this check.
            const alreadyPresent = (await entityPages.listBlocks(page.id)).some(
              (b) =>
                b.kind === blockAction.kind &&
                normalizeBlockSection(b.section) === "main",
            );
            if (alreadyPresent) {
              throw pinnedFailure(blockAction.kind, "add_duplicate");
            }
          }
          const data = validateBlockData(blockAction.kind, blockAction.data);
          if (editor.kind === "community_moderator") {
            assertBlockImageUrlsAllowed(
              blockAction.kind,
              data,
              imageScope,
              await entityPages.listBlocks(page.id),
            );
          }
          affectedBlock = await entityPages.createBlock({
            pageId: page.id,
            kind: blockAction.kind,
            data,
            visible: blockAction.visible ?? true,
            ...(blockAction.section !== undefined && {
              section: blockAction.section,
            }),
          });
          to = blockAuditSnapshot(affectedBlock);
          fields = [`blocks.${affectedBlock.id}`];
          break;
        }

        case "edit": {
          const liveBlocks = await entityPages.listBlocks(page.id);
          const existing = liveBlocks.find(
            (b) => b.id === blockAction.blockId,
          );
          if (!existing) {
            throw fail("BLOCK_NOT_FOUND");
          }

          const kind = blockAction.kind ?? existing.kind;
          validateKind(input.ownerType, kind);
          ensureEditKeepsPinned(existing, blockAction);

          const data =
            blockAction.data !== undefined
              ? validateBlockData(kind, blockAction.data)
              : blockAction.kind !== undefined
                ? validateBlockData(kind, undefined)
                : undefined;
          if (data !== undefined && editor.kind === "community_moderator") {
            assertBlockImageUrlsAllowed(kind, data, imageScope, liveBlocks);
          }

          affectedBlock = await entityPages.updateBlock({
            id: blockAction.blockId,
            ...(blockAction.kind !== undefined && { kind: blockAction.kind }),
            ...(data !== undefined && { data }),
            ...(blockAction.visible !== undefined && {
              visible: blockAction.visible,
            }),
          });
          from = blockAuditSnapshot(existing);
          to = blockAuditSnapshot(affectedBlock);
          fields = [`blocks.${existing.id}`];
          break;
        }

        case "reorder": {
          const pageBlocks = await entityPages.listBlocks(page.id);
          const pageBlockIds = new Set(pageBlocks.map((block) => block.id));
          const submittedBlockIds = new Set(blockAction.orderedBlockIds);
          const hasUnknownBlock = blockAction.orderedBlockIds.some(
            (blockId) => !pageBlockIds.has(blockId),
          );
          if (hasUnknownBlock) {
            throw fail("BLOCK_NOT_FOUND");
          }
          if (
            submittedBlockIds.size !== blockAction.orderedBlockIds.length ||
            submittedBlockIds.size !== pageBlockIds.size
          ) {
            throw fail("INVALID_BLOCK_ORDER");
          }

          await entityPages.reorderBlocks(page.id, blockAction.orderedBlockIds);
          from = { order: [...pageBlocks].sort(byOrderIndex).map((b) => b.id) };
          to = { order: blockAction.orderedBlockIds };
          fields = ["blocks.order"];
          break;
        }

        case "toggleVisibility": {
          const existing = (await entityPages.listBlocks(page.id)).find(
            (b) => b.id === blockAction.blockId,
          );
          if (!existing) {
            throw fail("BLOCK_NOT_FOUND");
          }
          // Hiding a pinned block removes it from the public page as surely as
          // deleting it (R6: "reorderable, not removable"). Refused both ways
          // so a stuck-hidden pinned block can never exist either.
          if (isPinnedBlockKind(existing.kind)) {
            throw pinnedFailure(existing.kind, "hide");
          }
          affectedBlock = await entityPages.updateBlock({
            id: blockAction.blockId,
            visible: !existing.visible,
          });
          from = blockAuditSnapshot(existing);
          to = blockAuditSnapshot(affectedBlock);
          fields = [`blocks.${existing.id}`];
          break;
        }

        case "delete": {
          const existing = (await entityPages.listBlocks(page.id)).find(
            (b) => b.id === blockAction.blockId,
          );
          if (!existing) {
            throw fail("BLOCK_NOT_FOUND");
          }
          // venue-track-record R6 / FR-012: a pinned kind is UNDELETABLE by the
          // owner. This is the only block-removal path in core (the adapter's
          // `deleteBlock` has no other caller), so the gate lives here.
          if (isPinnedBlockKind(existing.kind)) {
            throw pinnedFailure(existing.kind, "delete");
          }

          await entityPages.deleteBlock(blockAction.blockId);
          from = blockAuditSnapshot(existing);
          fields = [`blocks.${existing.id}`];
          break;
        }
      }

      return { block: affectedBlock, from, to, fields };
    };

    // The owner writes as before; a community moderator writes under the
    // place's claim lock, re-checked, with the audit row in the same tx.
    const affectedBlock =
      editor.kind === "owner"
        ? (await applyAction(deps.repos.entityPages)).block
        : await deps.repos.tx(async (tx) => {
            const now = deps.clock.now();
            await recheckCommunityPageEditor(tx, editor, now);
            const result = await applyAction(tx.entityPages);
            await logCommunityPageUpdate(
              tx,
              editor,
              {
                actorHumanId: input.actorHumanId,
                pageId: page.id,
                op: `managePageBlocks.${blockAction.action}`,
                fields: result.fields,
                from: result.from,
                to: result.to,
              },
              now,
            );
            return result.block;
          });

    const blocks = await deps.repos.entityPages.listBlocks(page.id);

    return managePageBlocksOutputSchema.parse({ block: affectedBlock, blocks });
  };

  if (logger) {
    return logger.withTime("managePageBlocks", execute);
  }
  return execute();
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * What a pinned block refused (`BLOCK_PINNED` meta.attempted). Exported so
 * the page editor's draft ops (page-draft-ops.ts) refuse with the same
 * vocabulary.
 */
export type PinnedRefusal =
  | "delete"
  | "hide"
  | "add_hidden"
  | "add_duplicate"
  | "add_sectioned"
  | "change_kind";

function pinnedFailure(kind: string, attempted: PinnedRefusal) {
  return fail("BLOCK_PINNED", {
    message: `'${kind}' is pinned: it can be reordered but not removed, hidden, re-kinded, added twice, or filed outside the main section (attempted: ${attempted})`,
    meta: { kind, attempted },
  });
}

/**
 * An `edit` can un-pin a block two ways without touching `delete`: flip a
 * pinned block's `visible` to false, or change its kind (which is a removal
 * plus an add). Changing ANOTHER block's kind INTO a pinned kind is the
 * duplicate-add case. All three are refused with the same code.
 */
function ensureEditKeepsPinned(
  existing: Pick<PageBlockRecord, "kind">,
  change: { kind?: string; visible?: boolean },
): void {
  const existingPinned = isPinnedBlockKind(existing.kind);
  if (existingPinned && change.visible === false) {
    throw pinnedFailure(existing.kind, "hide");
  }
  if (change.kind !== undefined && change.kind !== existing.kind) {
    if (existingPinned) {
      throw pinnedFailure(existing.kind, "change_kind");
    }
    if (isPinnedBlockKind(change.kind)) {
      throw pinnedFailure(change.kind, "add_duplicate");
    }
  }
}

function validateKind(ownerType: string, kind: string): void {
  if (!isValidBlockKind(ownerType as any, kind)) {
    const validKinds = getValidBlockKinds(ownerType as any);
    throw fail("INVALID_BLOCK_KIND", {
      message: `'${kind}' is not valid for ${ownerType}. Valid kinds: ${validKinds.join(", ")}`,
      meta: { kind, ownerType },
    });
  }
}

function validateBlockData(
  kind: string,
  data: unknown,
): Record<string, unknown> {
  const result = normalizeBlockData(kind, data);
  if (!result.ok) {
    throw fail("INVALID_BLOCK_DATA", {
      message: `'${kind}' ${result.issues.join(", ")}`,
      meta: { kind },
    });
  }
  return result.data;
}

/**
 * The image-URL rule savePageDraft applies to a block (page-draft-ops,
 * `isAllowedBlockImageUrl`), run for a COMMUNITY MODERATOR only: each URL
 * in an image-kind field (BLOCK_FIELD_KIND_IMAGE_URLS) must be this page's
 * own metadata-STRIPPED upload, or already be on one of the page's live
 * blocks (so an existing page keeps saving). Anything else (an outside URL,
 * a raw upload key that still carries EXIF/GPS, another page's key) is
 * refused: it would skip the image review a moderator's photos go through
 * (moderator place page spec R5, D10; the public gate only knows keys under
 * the page's own prefix).
 *
 * Not for an owner: the owner's live editor takes a typed photo URL, and
 * undo of a deleted block re-adds its snapshot (which may hold one); the
 * rule broke both, and an owner's uploads are not reviewed, so there is no
 * review for an outside URL to skip.
 */
function assertBlockImageUrlsAllowed(
  kind: string,
  data: unknown,
  scope: PageImageUrlScope,
  liveBlocks: readonly Pick<PageBlockRecord, "kind" | "data">[],
): void {
  const urls = blockImageUrlsIn([{ kind, data }]);
  if (urls.size === 0) return;
  const live = blockImageUrlsIn(liveBlocks);
  for (const url of urls) {
    if (ownedStrippedPageImageKeyFromUrl(url, scope) !== null) continue;
    if (live.has(url)) continue;
    throw fail("INVALID_BLOCK_DATA", {
      message: `'${kind}' image_url_not_allowed`,
      meta: { kind, reason: "image_url_not_allowed" },
    });
  }
}

type BlockActionResult = {
  block: PageBlockRecord | null;
  from: unknown;
  to: unknown;
  fields: string[];
};

function byOrderIndex(a: PageBlockRecord, b: PageBlockRecord): number {
  return a.orderIndex - b.orderIndex;
}

/**
 * A block as a moderator write's audit row records it (`data` is bounded
 * by logCommunityPageUpdate: long rich text is kept as a digest).
 */
function blockAuditSnapshot(block: PageBlockRecord) {
  return {
    blockId: block.id,
    kind: block.kind,
    section: block.section ?? "main",
    visible: block.visible,
    data: block.data,
  };
}
