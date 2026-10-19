import type {
  BulkCreateEntityPageInput,
  ClearPageDraftInput,
  EntityPageRecord,
  PageBlockRecord,
  PageDraftRecord,
  PageThemeRecord,
  PageOwnerType,
  UpsertEntityPageInput,
  UpsertPageThemeInput,
  UpsertPageBlockInput,
  UpdatePageBlockInput,
  WritePageDraftInput,
} from "@th/types/repos/entity-pages";

export interface EntityPagesRepo {
  getById(pageId: string): Promise<EntityPageRecord | null>;
  getByOwner(
    ownerType: PageOwnerType,
    ownerId: string,
  ): Promise<EntityPageRecord | null>;

  /**
   * Batched `getByOwner` — one query for many owners of the same type.
   * Returns only the pages that exist (no null placeholders, order not
   * guaranteed); `[]` for an empty `ownerIds`. Exists so read-time lineup
   * derivation stays at 2 queries instead of 2N (lineup-listen-embeds spec).
   */
  getByOwners(
    ownerType: PageOwnerType,
    ownerIds: string[],
  ): Promise<EntityPageRecord[]>;
  getBySlug(slug: string): Promise<EntityPageRecord | null>;
  upsert(input: UpsertEntityPageInput): Promise<EntityPageRecord>;

  /**
   * Insert many pages in ONE statement. Exists so a bulk place import mints a
   * page per venue without N sequential round trips (a 500-row import).
   *
   * ALL-OR-NOTHING on the count: the implementation must report how many rows
   * it inserted, and a caller that gets back fewer than it asked for is
   * looking at a silently page-less entity — the exact defect this method was
   * added to fix. Call it inside `repos.tx()` and throw on a short count so
   * the whole batch rolls back.
   *
   * `{ created: 0 }` for an empty input.
   */
  bulkCreate(
    pages: BulkCreateEntityPageInput[],
  ): Promise<{ created: number }>;
  updateFollowSettings(
    pageId: string,
    settings: { allowFollows: boolean; showFollowerCount: boolean },
  ): Promise<EntityPageRecord>;

  /**
   * Hard-delete the owner's page (theme, blocks, slug history, and follows
   * cascade at the DB level). Idempotent no-op when the owner has no page.
   * Used by account deletion so a deleted human's public profile does not
   * survive as an orphan.
   */
  deleteByOwner(ownerType: PageOwnerType, ownerId: string): Promise<void>;

  /** Returns true when no EntityPage row uses this slug (or the slug belongs to the given page). */
  isSlugAvailable(slug: string, excludePageId?: string): Promise<boolean>;

  /**
   * Resolve a historical slug to the current page slug.
   * Returns the current slug if found in PageSlugHistory, or null.
   */
  resolveSlugHistory(slug: string): Promise<string | null>;

  /**
   * Record a slug change in PageSlugHistory so old URLs can redirect.
   */
  recordSlugHistory(pageId: string, slug: string): Promise<void>;

  // Theme
  getTheme(pageId: string): Promise<PageThemeRecord | null>;
  upsertTheme(input: UpsertPageThemeInput): Promise<PageThemeRecord>;

  // Blocks
  listBlocks(pageId: string): Promise<PageBlockRecord[]>;

  /**
   * Batched `listBlocks` — blocks for every page in `pageIds`, preserving
   * per-page `orderIndex` ordering (callers group by `pageId`; within a page
   * the stored sort order is intact). `[]` for an empty `pageIds`.
   */
  listBlocksByPageIds(pageIds: string[]): Promise<PageBlockRecord[]>;
  createBlock(input: UpsertPageBlockInput): Promise<PageBlockRecord>;
  updateBlock(input: UpdatePageBlockInput): Promise<PageBlockRecord>;
  deleteBlock(blockId: string): Promise<void>;
  reorderBlocks(pageId: string, orderedIds: string[]): Promise<void>;

  /**
   * Atomically seed template starter blocks for a (page, category) pair.
   *
   * In a SINGLE transaction:
   *  1. Append the applied marker (`appliedMarker`, defaulting to `category`)
   *     to `templateAppliedCategories` iff not already present (a conditional,
   *     row-locking UPDATE — this is the concurrency guard against two editor
   *     loads racing to seed the same category/revision).
   *  2. If the marker was already applied (race lost) → returns `[]` and
   *     inserts nothing.
   *  3. Otherwise appends each candidate block whose `kind` is not already
   *     present on the page, at the next `orderIndex` (max existing + 1,
   *     incrementing). Existing blocks are never edited, reordered, or deleted.
   *
   * Returns the newly-inserted blocks (possibly empty when every candidate
   * kind already existed but the category still gets marked applied).
   */
  applyTemplateSeed(input: ApplyTemplateSeedInput): Promise<PageBlockRecord[]>;

  // ── Draft (page editor; schema doc on `model PageDraft`) ──────────────────
  // STORAGE PRIMITIVES ONLY. Merge rules (per-path last write wins,
  // fieldEditors, placeBase on first touch, batch-id dedupe and trimming,
  // the reserved `data.v`, the publish branches) live in core. A save or
  // publish composes them inside ONE `repos.tx()`:
  //   lockDraftForUpdate → compute next state in core → writeDraft / clearDraft
  //
  // LOCK ORDER, for every caller that locks more than one of these rows
  // (save, publish, discard, and anything added later): PageDraft FIRST,
  // then EntityPage, then Place. Two transactions taking them in different
  // orders can deadlock.
  // Known exception: deleting an EntityPage cascades to PageDraft, which
  // takes the REVERSE order (EntityPage, then PageDraft). A save or publish
  // racing a page deletion can therefore deadlock; Postgres aborts one side
  // with 40P01. That is expected and must SURFACE as an error, never be
  // caught and swallowed. Also: the first-lock INSERT takes FOR KEY SHARE
  // on the EntityPage row (its FK check), which conflicts with a DELETE of
  // the page and with an UPDATE that changes its unique columns (slug,
  // ownerType/ownerId), not with ordinary column updates.
  //
  // The row's lifetime: created on first lock, never deleted by Publish or
  // Discard (they clear it), removed only when its EntityPage is deleted
  // (FK cascade). `revision` only ever increases, and the adapter enforces
  // it: a write or clear whose revision is not greater than the stored one
  // is refused.
  //
  // Lock / write / clear called OUTSIDE `repos.tx()` (on the root client)
  // throw INTERNAL `page_draft_<op>_outside_tx`.

  /**
   * Plain read, no lock: for getPageDraft and client polling. Never creates
   * a row. `null` and a row with empty overlays (revision 0 after a bare
   * lock, or any cleared draft) both mean "nothing pending"; core must not
   * tell them apart.
   */
  getDraft(pageId: string): Promise<PageDraftRecord | null>;

  /**
   * Lock the page's draft row and return it, creating an empty row
   * (revision 0, overlays `{}`) first if the page has none. ONLY valid
   * inside `repos.tx()`: the row lock is held until that transaction commits
   * or rolls back, and outside a transaction it is released at once, which
   * makes the returned state stale immediately.
   *
   * Concurrency: the insert is `ON CONFLICT ("pageId") DO NOTHING`, so two
   * concurrent first saves never raise a unique violation; the second waits
   * on the first's lock and then sees its committed row. A FOR UPDATE on a
   * missing row would lock nothing, which is why the row is ensured first.
   *
   * Throws PAGE_NOT_FOUND when no EntityPage has this id (the one 404 in
   * these primitives). A transaction that only locks (no write) still
   * leaves a revision-0 empty row behind when it commits; like `null`, it
   * means nothing pending.
   */
  lockDraftForUpdate(pageId: string): Promise<PageDraftRecord>;

  /**
   * Replace every column of the draft row in ONE statement (overlays,
   * appliedBatchIds, revision, updatedByHumanId, updatedAt). Call only
   * after `lockDraftForUpdate(pageId)` in the same `repos.tx()`; the
   * adapter does not re-check the lock.
   *
   * `appliedBatchIds` must already be trimmed by core (newest last, at most
   * PAGE_DRAFT_APPLIED_BATCH_IDS_MAX); the adapter throws INTERNAL on a
   * longer list rather than let the SQL CHECK abort the transaction with an
   * opaque error. It is written in the same statement as everything else,
   * because the cardinality CHECK cannot be deferred: an append followed by
   * a separate trim fails at batch 101.
   *
   * `revision` must be greater than the stored revision. Throws INTERNAL
   * `page_draft_row_missing_or_revision_not_increasing` when the row is
   * missing (the caller skipped the lock) or the revision does not
   * increase: both are caller bugs, not 404s, so they reach Sentry.
   */
  writeDraft(
    pageId: string,
    next: WritePageDraftInput,
  ): Promise<PageDraftRecord>;

  /**
   * Publish / Discard clear, in ONE statement: data, placePatch, placeBase
   * and fieldEditors become `{}` (never JSON null), `revision` is set,
   * `lastPublishedRevision` is set only when given, and appliedBatchIds is
   * KEPT (it is an idempotency key that must survive the clear). One
   * statement because the CHECK `lastPublishedRevision <= revision` holds
   * on the final row only when both columns change together.
   *
   * Same lock contract and INTERNAL errors as `writeDraft`. Also refuses
   * (INTERNAL) a `lastPublishedRevision` outside [1, revision] before it
   * reaches the SQL CHECK.
   */
  clearDraft(
    pageId: string,
    input: ClearPageDraftInput,
  ): Promise<PageDraftRecord>;
}

export interface ApplyTemplateSeedBlock {
  kind: string;
  data?: unknown;
  visible?: boolean;
  /**
   * A PINNED kind (core block-config `pinned`; today only `track_record`).
   * Its "already present" check counts MAIN-section rows only — a stray copy
   * filed under another section never renders on the public page and must
   * not satisfy the seed. Non-pinned kinds keep the section-blind check.
   */
  pinned?: boolean;
}

export interface ApplyTemplateSeedInput {
  pageId: string;
  category: string;
  /**
   * The applied-state marker to record in `templateAppliedCategories` and
   * race-guard on (template-revision markers like `"venue@2"`; see core
   * page-templates.ts `templateAppliedMarker`). Defaults to `category`
   * (revision 1). `category` itself is still what the page's CURRENT
   * classification column advances to.
   */
  appliedMarker?: string;
  /** Candidate blocks in template order; re-filtered by `kind` inside the tx. */
  blocks: ApplyTemplateSeedBlock[];
}

export type {
  BulkCreateEntityPageInput,
  ClearPageDraftInput,
  EntityPageRecord,
  PageBlockRecord,
  PageDraftRecord,
  PageThemeRecord,
  PageOwnerType,
  UpsertEntityPageInput,
  UpsertPageThemeInput,
  UpsertPageBlockInput,
  UpdatePageBlockInput,
  WritePageDraftInput,
  PublicPageData,
  EntitySummary,
} from "@th/types/repos/entity-pages";
