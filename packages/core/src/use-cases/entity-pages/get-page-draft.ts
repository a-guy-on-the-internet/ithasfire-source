/**
 * getPageDraft: the page as its editors see it, with the shared draft
 * applied (page editor spec docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml,
 * R2, R14, FR-014, FR-015; storage: `model PageDraft`).
 *
 * Read-only: never creates a draft row (a missing row and an empty one both
 * mean "nothing pending", and nothing here tells them apart). Same authz as
 * updatePage: only someone who can edit the page sees its draft.
 *
 * Returns the overlaid view (applyOverlay), the draft's overlays and
 * revision, the change count, the last editor of each path and of the draft
 * (human ids that no longer resolve, a deleted account, come back with a
 * null name and never fail the read), and the live Place facts (R9). With
 * `sinceRevision` it also answers "what changed since", including
 * `clearedSince` when a Publish or Discard cleared the draft after that
 * revision, so the client drops its local overlay instead of merging it.
 *
 * SERVER-ONLY (imports page-draft-ops). Import by subpath:
 * `@th/core/use-cases/entity-pages/get-page-draft`.
 */

import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  EntityPageRecord,
  PageThemeRecord,
} from "@th/types/repos/entity-pages";

import { parseInput } from "../../lib/io";
import {
  applyOverlay,
  changeCount,
  isEmptyDraft,
  placeDraftFactsFromRecord,
  type PageDraftView,
  type PlaceDraftFacts,
} from "./page-draft-ops";
import {
  buildDraftSync,
  draftForEditor,
  loadPageForDraft,
  pageDraftOwnerInputShape,
  pageLayoutKey,
  requireDraftLayout,
  withoutPlacePaths,
  type PageDraftSync,
} from "./page-draft-shared";

export const getPageDraftInputSchema = z
  .object({
    ...pageDraftOwnerInputShape,
    /** The revision the client holds; adds `sync` to the result. */
    sinceRevision: z.number().int().min(0).optional(),
  })
  .strict();

export type GetPageDraftInput = z.infer<typeof getPageDraftInputSchema>;

export type PageDraftEditorInfo = {
  humanId: string;
  /** null when the human no longer resolves (deleted) or has no name. */
  name: string | null;
};

export type PageDraftPathEditor = PageDraftEditorInfo & {
  path: string;
  /** ISO time of the edit; null when unreadable. */
  at: string | null;
  /** The revision that wrote it; null when unreadable. */
  rev: number | null;
};

export type PageDraftLastEdit = PageDraftEditorInfo & {
  /** ISO time of the last write to the draft row. */
  at: string;
};

export type GetPageDraftOutput = {
  pageId: string;
  layoutKey: string;
  /** Live page with the draft applied (what the canvas renders). */
  view: PageDraftView<EntityPageRecord, PageThemeRecord>;
  /** Live Place facts (R9 conflicts are judged against these); null off PLACE. */
  livePlace: PlaceDraftFacts | null;
  draft: {
    /** 0 when the page has no draft row. */
    revision: number;
    lastPublishedRevision: number | null;
    changeCount: number;
    isEmpty: boolean;
    /** The open overlays (R19), keyed by op path / Place field. */
    data: Record<string, unknown>;
    placePatch: Record<string, unknown>;
    /** Last editor of each path in the current overlay, newest first. */
    editors: PageDraftPathEditor[];
    /**
     * Who last changed the draft and when (the toolbar's "edited by … at
     * …"): the row's updatedByHumanId / updatedAt, so a revert or a clear
     * counts too. After a Publish or Discard it names who cleared it. null
     * when the page has no draft row or nobody has written it.
     */
    lastEdit: PageDraftLastEdit | null;
    updatedAt: Date | null;
  };
  /** Present only when `sinceRevision` was given. */
  sync: PageDraftSync | null;
};

export type GetPageDraftDeps = {
  /** `events` serves the community moderator access rules. */
  repos: Pick<Repos, "entityPages" | "places" | "humans" | "events">;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  /** The moderator access rules' clock (live events at the place). */
  clock: ClockPort;
  logger?: LoggerPort;
};

type RawEditor = { humanId: string; at: string | null; rev: number | null };

function readEditors(
  fieldEditors: Record<string, unknown>,
  livePaths: ReadonlySet<string>,
): (RawEditor & { path: string })[] {
  const result: (RawEditor & { path: string })[] = [];
  for (const [path, raw] of Object.entries(fieldEditors)) {
    if (path.startsWith("$") || !livePaths.has(path)) continue;
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.humanId !== "string") continue;
    result.push({
      path,
      humanId: entry.humanId,
      at: typeof entry.at === "string" ? entry.at : null,
      rev: typeof entry.rev === "number" ? entry.rev : null,
    });
  }
  return result.sort(
    (a, b) => (b.rev ?? -1) - (a.rev ?? -1) || a.path.localeCompare(b.path),
  );
}

export async function getPageDraft(
  deps: GetPageDraftDeps,
  rawInput: unknown,
): Promise<GetPageDraftOutput> {
  const logger = deps.logger?.child({ useCase: "getPageDraft" });

  const execute = async (): Promise<GetPageDraftOutput> => {
    const input = parseInput(getPageDraftInputSchema, rawInput);
    // Authz, and the page id. This row is NOT used for the view: it was
    // read before the draft (see below). A read: a community moderator's
    // advisory check is the whole check (no lock, no audit row).
    const {
      page: { id: pageId },
      editor: pageEditor,
    } = await loadPageForDraft(deps, input);
    // A community moderator sees no Place facts (street, postcode, exact
    // pin, phone; also for a place that withholds its address) and no Place
    // patch: they cannot set or publish `place.*` (D3) and change facts
    // through updateCommunityPlace, whose read applies its own privacy.
    const withPlaceFacts = pageEditor.kind === "owner";

    // DRAFT FIRST, then every live table, the page row included. No
    // transaction here, so the reads can straddle a Publish, which writes
    // the live tables and clears the draft in ONE transaction.
    // - Draft read AFTER the Publish: it is cleared, and every live read
    //   below comes later still, so it sees the published state. This is
    //   the case the order exists for: the other order could pair the OLD
    //   live page with a cleared draft and show the editor a page without
    //   the edits it just published, with nothing pending to fix it.
    // - Draft read BEFORE the Publish, live read after: the old overlay is
    //   applied over the published page. Mostly harmless (the overlay holds
    //   the values just published), but not exact: an added block can show
    //   twice for a moment (the overlay still holds `blocks.new:X` while
    //   live already has its published copy). The next poll reads the
    //   cleared draft and heals it.
    const storedDraft = await deps.repos.entityPages.getDraft(pageId);
    const draft = storedDraft && draftForEditor(storedDraft, pageEditor);
    const page = await deps.repos.entityPages.getById(pageId);
    if (!page) fail("PAGE_NOT_FOUND");
    const theme = await deps.repos.entityPages.getTheme(page.id);
    const layout = requireDraftLayout(input.ownerType, theme);
    const blocks = await deps.repos.entityPages.listBlocks(page.id);

    let livePlace: PlaceDraftFacts | null = null;
    if (input.ownerType === "PLACE" && withPlaceFacts) {
      const place = await deps.repos.places.getById(input.ownerId);
      if (!place) fail("OWNER_NOT_FOUND", { meta: { entity: "place" } });
      livePlace = placeDraftFactsFromRecord(place);
    }

    const view = applyOverlay(
      { page, theme, blocks, place: livePlace },
      draft,
      layout,
    );

    // Last editor per path still in the overlay. Entries for reverted paths
    // stay in fieldEditors for sync only; they are not "edits pending".
    const data = draft?.data ?? {};
    const placePatch = draft?.placePatch ?? {};
    const livePaths = new Set<string>([
      ...Object.keys(data),
      ...Object.keys(placePatch).map((field) => `place.${field}`),
    ]);
    const rawEditors = readEditors(draft?.fieldEditors ?? {}, livePaths);

    // Plain ids, no FK: a human deleted since shows without a name.
    const humanIds = [
      ...new Set([
        ...rawEditors.map((editor) => editor.humanId),
        ...(draft?.updatedByHumanId ? [draft.updatedByHumanId] : []),
      ]),
    ];
    const humans =
      humanIds.length > 0 ? await deps.repos.humans.getByIds(humanIds) : [];
    const names = new Map(humans.map((human) => [human.id, human.name]));
    const editors: PageDraftPathEditor[] = rawEditors.map((editor) => ({
      ...editor,
      name: names.get(editor.humanId) ?? null,
    }));

    return {
      pageId: page.id,
      layoutKey: pageLayoutKey(input.ownerType, theme),
      view,
      livePlace,
      draft: {
        revision: draft?.revision ?? 0,
        lastPublishedRevision: draft?.lastPublishedRevision ?? null,
        changeCount: changeCount(draft),
        isEmpty: isEmptyDraft(draft),
        data,
        placePatch,
        editors,
        lastEdit: draft?.updatedByHumanId
          ? {
              humanId: draft.updatedByHumanId,
              name: names.get(draft.updatedByHumanId) ?? null,
              at: draft.updatedAt.toISOString(),
            }
          : null,
        updatedAt: draft?.updatedAt ?? null,
      },
      sync:
        input.sinceRevision === undefined
          ? null
          : withoutPlacePaths(
              buildDraftSync(draft, input.sinceRevision),
              pageEditor,
            ),
    };
  };

  if (logger) return logger.withTime("getPageDraft", execute);
  return execute();
}

