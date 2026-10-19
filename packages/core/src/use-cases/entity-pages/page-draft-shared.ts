/**
 * Pieces shared by getPageDraft, savePageDraft and discardPageDraft (page
 * editor spec docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml):
 * the owner input, the page lookup behind the same authz as updatePage, the
 * page's zone table, and the "what changed since your revision" answer.
 *
 * SERVER-ONLY (imports page-draft-ops); not in the entity-pages barrel.
 */

import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { EntityPagesRepo } from "@th/ports/repos/entity-pages";
import type {
  EntityPageRecord,
  PageDraftRecord,
  PageOwnerType,
  PageThemeRecord,
} from "@th/types/repos/entity-pages";

import {
  changedSince,
  type PageDraftChange,
} from "./page-draft-ops";
import {
  resolveEntityPageEditor,
  type EntityPageEditor,
} from "./entity-page-access";
import {
  entityPageOwnerTypeSchema,
  getEntityPageImageKeyPrefix,
} from "./page-image-upload-helpers";
import type { PageImageUrlScope } from "./page-image-urls";
import { resolvePageZoneLayout, type PageZoneLayout } from "./page-zones";
import {
  normalizeEntityPageLayoutKey,
  resolveDefaultEntityPageLayoutKey,
} from "./theme-options";

/** The owner fields every draft use case takes (the same as updatePage). */
export const pageDraftOwnerInputShape = {
  actorHumanId: z.string().min(1),
  ownerType: entityPageOwnerTypeSchema,
  ownerId: z.string().min(1).max(200),
};

export type PageDraftOwnerInput = {
  actorHumanId: string;
  ownerType: PageOwnerType;
  ownerId: string;
};

/** What {@link loadPageForDraft} needs: the page access check's deps. */
export type PageDraftAccessDeps = {
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  repos: Pick<Repos, "places" | "events"> & {
    entityPages: Pick<EntityPagesRepo, "getByOwner">;
  };
  clock: ClockPort;
};

/**
 * Authorise exactly as updatePage does (`resolveEntityPageEditor`: self for
 * HUMAN, ORG_EDIT_ROLES for ORGANIZATION, canManagePlace for PLACE, and a
 * community moderator on a PLACE nobody owns; R13: the draft adds no role),
 * then load the page. Read and write share the check: only someone who can
 * edit the page may see its unpublished draft. The check is ADVISORY for a
 * moderator: a write re-checks under the claim lock in its transaction
 * (`recheckCommunityPageEditor`, taken BEFORE `lockDraftForUpdate`, so the
 * claim lock stays the first lock of the transaction) and logs
 * `entity_page.community_updated` there.
 */
export async function loadPageForDraft(
  deps: PageDraftAccessDeps,
  input: PageDraftOwnerInput,
): Promise<{ page: EntityPageRecord; editor: EntityPageEditor }> {
  const editor = await resolveEntityPageEditor(deps, input);
  const page = await deps.repos.entityPages.getByOwner(
    input.ownerType,
    input.ownerId,
  );
  if (!page) fail("PAGE_NOT_FOUND");
  return { page, editor };
}

/** The layout key the page renders with (theme value, else the default). */
export function pageLayoutKey(
  ownerType: PageOwnerType,
  theme: Pick<PageThemeRecord, "layoutKey"> | null,
): string {
  return (
    normalizeEntityPageLayoutKey(theme?.layoutKey) ??
    resolveDefaultEntityPageLayoutKey(ownerType)
  );
}

/**
 * The page's zone table. A layout with no table yet (org and human pages,
 * the freeform layouts: later phases, R6/R7) has no draft editor, so the
 * draft use cases refuse it rather than guess at an order.
 */
export function requireDraftLayout(
  ownerType: PageOwnerType,
  theme: Pick<PageThemeRecord, "layoutKey"> | null,
): PageZoneLayout {
  const layoutKey = pageLayoutKey(ownerType, theme);
  const layout = resolvePageZoneLayout(ownerType, layoutKey);
  if (!layout) {
    fail("INVALID_INPUT", {
      message: "page_draft_layout_unsupported",
      meta: { reason: "page_draft_layout_unsupported", ownerType, layoutKey },
    });
  }
  return layout;
}

/** Where this page's uploaded images live (see page-image-urls.ts). */
export function pageImageScope(
  ownerType: PageOwnerType,
  ownerId: string,
  publicBaseUrl: string | null,
): PageImageUrlScope {
  return {
    publicBaseUrl,
    keyPrefix: getEntityPageImageKeyPrefix(ownerType, ownerId),
  };
}

// ── Draft-only image cleanup (Discard → outbox; Save cancels) ─────────────

/**
 * `source` of the pending-object-deletions rows a Discard writes. Defined in
 * page-image-references (the drain re-checks these rows against the live
 * page before deleting).
 */
export { PAGE_DRAFT_DISCARD_DELETION_SOURCE } from "./page-image-references";

/**
 * How long a Discard's delete intents wait before the drain may run them.
 * Any save in that window that references the key again cancels the intent
 * (savePageDraft; publishPageDraft does the same over the whole draft), so
 * an editor whose batch was in flight, or who had not yet seen the clear,
 * cannot publish an image that is about to be deleted.
 */
export const PAGE_DRAFT_DISCARD_DELETE_GRACE_MS = 24 * 60 * 60 * 1000;

// ── "Changed since your revision" ──────────────────────────────────────────

export type PageDraftSyncChange = PageDraftChange & {
  /** false: the path was reverted (the live value shows again). */
  present: boolean;
  /** The path's current draft value; undefined when not present. */
  value?: unknown;
};

export type PageDraftSync = {
  /** The revision the caller said it holds. */
  sinceRevision: number;
  /**
   * The draft was cleared by a Publish or Discard after `sinceRevision`.
   * The client DROPS its local overlay (and its undo entries that point into
   * it) and takes the server's; it must not merge its old overlay back.
   */
  clearedSince: boolean;
  /**
   * The client cannot catch up path by path (cleared, or editor entries
   * newer than its revision were pruned): take `overlay` whole.
   */
  resync: boolean;
  /** Paths written after `sinceRevision` (by anyone), oldest first. */
  changes: PageDraftSyncChange[];
};

/** A draft path's value: `present: false` when the path is not in it. */
export function draftValueAt(
  draft: Pick<PageDraftRecord, "data" | "placePatch">,
  path: string,
): { present: boolean; value?: unknown } {
  const [store, key] = path.startsWith("place.")
    ? [draft.placePatch, path.slice("place.".length)]
    : [draft.data, path];
  return Object.prototype.hasOwnProperty.call(store, key)
    ? { present: true, value: store[key] }
    : { present: false };
}

export function buildDraftSync(
  draft: Pick<
    PageDraftRecord,
    "data" | "placePatch" | "fieldEditors" | "revision"
  > | null,
  sinceRevision: number,
): PageDraftSync {
  const since = changedSince(draft, sinceRevision);
  return {
    sinceRevision,
    clearedSince: since.cleared,
    resync: since.resync,
    changes: since.changes.map((change) => ({
      ...change,
      ...(draft ? draftValueAt(draft, change.path) : { present: false }),
    })),
  };
}

// ── A community moderator's view of the draft ──────────────────────────────
// A moderator cannot set or publish `place.*` (moderator place page spec,
// D3) and never sees Place facts: an earlier owner's pending Place patch
// (a street address, a phone) stays out of every answer they get.

/** The draft as `editor` may see it: no Place patch for a moderator. */
export function draftForEditor<T extends Pick<PageDraftRecord, "placePatch">>(
  draft: T,
  editor: EntityPageEditor,
): T {
  return editor.kind === "owner" ? draft : { ...draft, placePatch: {} };
}

/** A moderator's sync answer carries no `place.*` path. */
export function withoutPlacePaths(
  sync: PageDraftSync,
  editor: EntityPageEditor,
): PageDraftSync {
  if (editor.kind === "owner") return sync;
  return {
    ...sync,
    changes: sync.changes.filter((change) => !change.path.startsWith("place.")),
  };
}
