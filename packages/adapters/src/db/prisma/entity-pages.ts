import { Prisma } from "@prisma/client";
import { fail } from "@th/errors";
import type {
  ApplyTemplateSeedInput,
  EntityPagesRepo,
} from "@th/ports/repos/entity-pages";
import {
  PAGE_DRAFT_APPLIED_BATCH_IDS_MAX,
  type ClearPageDraftInput,
  type PageBlockRecord,
  type PageDraftRecord,
  type PageOwnerType,
  type WritePageDraftInput,
} from "@th/types/repos/entity-pages";

import type { PrismaClientOrTx } from "./types";
import { makeBansRepo } from "./bans";

type PrismaWithTransaction = PrismaClientOrTx & {
  $transaction: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;
};

function hasTransaction(p: PrismaClientOrTx): p is PrismaWithTransaction {
  return typeof (p as { $transaction?: unknown }).$transaction === "function";
}

async function withEntityPagesTransaction<T>(
  p: PrismaClientOrTx,
  fn: (tx: PrismaClientOrTx) => Promise<T>,
): Promise<T> {
  if (!hasTransaction(p)) return fn(p);
  // Call on `p` directly — extracting the method into a local loses `this`
  // and blows up the driver-adapter engine (`_engineConfig` of undefined).
  return (p as PrismaWithTransaction).$transaction(
    (tx: Prisma.TransactionClient) => fn(tx),
  );
}

const pageSelect = {
  id: true,
  ownerType: true,
  ownerId: true,
  slug: true,
  displayName: true,
  bio: true,
  avatarUrl: true,
  bannerUrl: true,
  visibility: true,
  allowFollows: true,
  showFollowerCount: true,
  category: true,
  templateAppliedCategories: true,
  createdAt: true,
  updatedAt: true,
} as const;

const themeSelect = {
  id: true,
  pageId: true,
  colorPrimary: true,
  colorBg: true,
  colorText: true,
  fontKey: true,
  layoutKey: true,
} as const;

const DEFAULT_BLOCK_SECTION = "main";

/**
 * Core's section vocabulary (block-sections.ts: "main" | "memberships") is
 * the authority; this adapter cannot import core. Mirror its normaliser
 * exactly: an unknown / forward-vocabulary value renders as "main" there, so
 * it must COUNT as main here — otherwise core's seeder and this transaction
 * would disagree on whether a pinned block is present.
 */
const KNOWN_NON_MAIN_SECTIONS: ReadonlySet<string> = new Set(["memberships"]);
function countsAsMainSection(section: string | null | undefined): boolean {
  return section == null || !KNOWN_NON_MAIN_SECTIONS.has(section);
}

/**
 * The ONLY unique index on PageBlock besides the uuid PK is the partial
 * "PageBlock_pinned_kind_per_page_key" on (pageId, kind) for pinned kinds
 * (migration 20260924140000), so a P2002 from a block insert is always a
 * second pinned copy. Map it to the SAME typed error core raises from its
 * own check-then-create, so the loser gets a 412 (or a typed Sentry entry
 * from the seed path), not a raw Prisma error. Postgres reports a raw index's
 * violation as P2002 with no `meta.target`, so the code alone is the signal.
 */
function pinnedDuplicateOr(error: unknown, kind: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw fail("BLOCK_PINNED", {
      message: `'${kind}' is pinned and this page already has one`,
      meta: { kind, attempted: "add_duplicate" },
      cause: error,
    });
  }
  throw error;
}

// Legacy select — every column EXCEPT `section`. Kept because `section` was
// added by migration 20260810170000 and local/dev databases receive
// migrations asynchronously (seed wipe / CD): every read tries the full
// select first and falls back to this shape + the "main" default when the
// column does not exist yet (P2022). Existing rows all carry the column
// default ("main"), so the fallback is value-identical, never lossy.
const legacyBlockSelect = {
  id: true,
  pageId: true,
  kind: true,
  orderIndex: true,
  data: true,
  visible: true,
} as const;

const blockSelect = {
  ...legacyBlockSelect,
  section: true,
} as const;

/** Prisma P2022: "The column `X` does not exist in the current database." */
function isMissingColumnError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2022"
  );
}

async function withSectionFallback<T>(
  query: () => Promise<T>,
  legacyQuery: () => Promise<T>,
): Promise<T> {
  try {
    return await query();
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    return legacyQuery();
  }
}

function withDefaultSection<T extends object>(
  block: T,
): T & { section: string } {
  const section = (block as { section?: string }).section;
  return { ...block, section: section ?? DEFAULT_BLOCK_SECTION };
}

const draftSelect = {
  id: true,
  pageId: true,
  data: true,
  placePatch: true,
  placeBase: true,
  fieldEditors: true,
  appliedBatchIds: true,
  revision: true,
  lastPublishedRevision: true,
  updatedByHumanId: true,
  createdAt: true,
  updatedAt: true,
} as const;

type DraftRow = Prisma.PageDraftGetPayload<{ select: typeof draftSelect }>;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The SQL CHECK `PageDraft_json_objects_check` guarantees the four overlays
 * are JSON objects, so a non-object here is a broken invariant, not data to
 * coerce: throw rather than hand core a silently emptied overlay.
 */
function draftOverlay(
  row: DraftRow,
  column: "data" | "placePatch" | "placeBase" | "fieldEditors",
): Record<string, unknown> {
  const value = row[column];
  if (!isJsonObject(value)) {
    throw fail("INTERNAL", {
      message: "page_draft_overlay_not_object",
      meta: { pageId: row.pageId, column },
    });
  }
  return value;
}

function toDraftRecord(row: DraftRow): PageDraftRecord {
  return {
    id: row.id,
    pageId: row.pageId,
    data: draftOverlay(row, "data"),
    placePatch: draftOverlay(row, "placePatch"),
    placeBase: draftOverlay(row, "placeBase"),
    fieldEditors: draftOverlay(row, "fieldEditors"),
    appliedBatchIds: row.appliedBatchIds,
    revision: row.revision,
    lastPublishedRevision: row.lastPublishedRevision,
    updatedByHumanId: row.updatedByHumanId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The draft lock/write primitives are meaningful only inside `repos.tx()`:
 * outside one, the FOR UPDATE lock is released as soon as its statement
 * ends, and a write is no longer ordered after the lock that justified it.
 * A transaction client has no `$transaction`; the root client does.
 */
function assertInTransaction(
  p: PrismaClientOrTx,
  op: "lock" | "write" | "clear",
): void {
  if (hasTransaction(p)) {
    throw fail("INTERNAL", { message: `page_draft_${op}_outside_tx` });
  }
}

function assertIntRevision(
  pageId: string,
  name: "revision" | "lastPublishedRevision",
  value: number,
  min: number,
  max?: number,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    throw fail("INTERNAL", {
      message: `page_draft_${name}_out_of_range`,
      meta: { pageId, value, min, ...(max !== undefined && { max }) },
    });
  }
}

/**
 * Refuse a write the table's CHECKs would reject, BEFORE it reaches
 * Postgres: a CHECK violation aborts the caller's whole transaction with an
 * opaque raw error, while this names the broken invariant. Every case is a
 * core bug (core trims appliedBatchIds and builds the overlays).
 */
function assertWritableDraft(pageId: string, next: WritePageDraftInput): void {
  assertIntRevision(pageId, "revision", next.revision, 0);
  if (next.appliedBatchIds.length > PAGE_DRAFT_APPLIED_BATCH_IDS_MAX) {
    throw fail("INTERNAL", {
      message: "page_draft_applied_batch_ids_over_cap",
      meta: {
        pageId,
        count: next.appliedBatchIds.length,
        max: PAGE_DRAFT_APPLIED_BATCH_IDS_MAX,
      },
    });
  }
  for (const column of [
    "data",
    "placePatch",
    "placeBase",
    "fieldEditors",
  ] as const) {
    if (!isJsonObject(next[column])) {
      throw fail("INTERNAL", {
        message: "page_draft_overlay_not_object",
        meta: { pageId, column },
      });
    }
  }
}

/**
 * Same idea for a clear: `revision >= 0`, and a given
 * `lastPublishedRevision` in [1, revision] (PageDraft_revision_check,
 * PageDraft_last_published_revision_check).
 */
function assertClearableDraft(pageId: string, input: ClearPageDraftInput): void {
  assertIntRevision(pageId, "revision", input.revision, 0);
  if (input.lastPublishedRevision !== undefined) {
    assertIntRevision(
      pageId,
      "lastPublishedRevision",
      input.lastPublishedRevision,
      1,
      input.revision,
    );
  }
}

/** Prisma P2025 from `update`: no row matched (no DB error; the tx stays usable). */
function isRecordNotFound(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025"
  );
}

/**
 * ONE UPDATE of the page's draft row, guarded by `revision < next revision`
 * so storage itself enforces that revision only goes up (the schema's
 * lifetime rule; a repeated revision would break Publish idempotency).
 *
 * No match (P2025) is a CALLER bug, never a 404: either the caller skipped
 * `lockDraftForUpdate` (which creates the row), or it computed a revision
 * that does not increase. INTERNAL, so it reaches Sentry; the page itself
 * exists or the lock would have said PAGE_NOT_FOUND.
 */
async function updateDraftRow(
  p: PrismaClientOrTx,
  pageId: string,
  revision: number,
  data: Prisma.PageDraftUpdateInput,
): Promise<PageDraftRecord> {
  try {
    const row = await p.pageDraft.update({
      where: { pageId, revision: { lt: revision } },
      data,
      select: draftSelect,
    });
    return toDraftRecord(row);
  } catch (err) {
    if (isRecordNotFound(err)) {
      throw fail("INTERNAL", {
        message: "page_draft_row_missing_or_revision_not_increasing",
        meta: { pageId, revision },
        cause: err,
      });
    }
    throw err;
  }
}

export function makeEntityPagesRepo(p: PrismaClientOrTx): EntityPagesRepo {
  return {
    getById: (pageId: string) =>
      p.entityPage.findUnique({
        where: { id: pageId },
        select: pageSelect,
      }),

    getByOwner: (ownerType: PageOwnerType, ownerId: string) =>
      p.entityPage.findUnique({
        where: { ownerType_ownerId: { ownerType, ownerId } },
        select: pageSelect,
      }),

    getByOwners: async (ownerType: PageOwnerType, ownerIds: string[]) => {
      if (ownerIds.length === 0) return [];
      return p.entityPage.findMany({
        where: { ownerType, ownerId: { in: ownerIds } },
        select: pageSelect,
      });
    },

    // The public read also DERIVES `ownerBanned` (ban-that-sticks) with the
    // same SQL predicates the list reads use (./banned-owner.ts), so
    // `getPublicPage` can 404 a banned owner's page without a second port.
    getBySlug: async (slug: string) => {
      const page = await p.entityPage.findUnique({
        where: { slug },
        select: pageSelect,
      });
      if (!page) return null;
      if (page.ownerType !== "HUMAN" && page.ownerType !== "ORGANIZATION") {
        return { ...page, ownerBanned: false };
      }
      const banned = await makeBansRepo(p).findBannedOwners(
        page.ownerType === "HUMAN"
          ? { humanIds: [page.ownerId], orgIds: [] }
          : { humanIds: [], orgIds: [page.ownerId] },
      );
      return {
        ...page,
        ownerBanned:
          banned.humanIds.includes(page.ownerId) ||
          banned.orgIds.includes(page.ownerId),
      };
    },

    deleteByOwner: async (ownerType: PageOwnerType, ownerId: string) => {
      // deleteMany so a missing page is an idempotent no-op (delete() throws
      // P2025). PageTheme/PageBlock/PageSlugHistory/EntityFollow cascade at
      // the DB level (onDelete: Cascade on their EntityPage FKs).
      await p.entityPage.deleteMany({
        where: { ownerType, ownerId },
      });
    },

    isSlugAvailable: async (slug: string, excludePageId?: string) => {
      const existing = await p.entityPage.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!existing) return true;
      return excludePageId !== undefined && existing.id === excludePageId;
    },

    resolveSlugHistory: async (slug: string) => {
      const entry = await p.pageSlugHistory.findUnique({
        where: { slug },
        select: { pageId: true },
      });
      if (!entry) return null;
      const page = await p.entityPage.findUnique({
        where: { id: entry.pageId },
        select: { slug: true },
      });
      return page?.slug ?? null;
    },

    recordSlugHistory: async (pageId: string, slug: string) => {
      // Upsert so re-recording the same slug is idempotent.
      await p.pageSlugHistory.upsert({
        where: { slug },
        create: { pageId, slug, recordedAt: new Date() },
        update: { pageId, recordedAt: new Date() },
      });
    },

    upsert: async ({
      ownerType,
      ownerId,
      slug,
      displayName,
      bio,
      avatarUrl,
      bannerUrl,
      visibility,
      allowFollows,
      showFollowerCount,
    }) => {
      const existing = await p.entityPage.findUnique({
        where: { ownerType_ownerId: { ownerType, ownerId } },
        select: pageSelect,
      });

      if (existing) {
        return p.entityPage.update({
          where: { id: existing.id },
          data: {
            slug,
            displayName,
            ...(bio !== undefined && { bio }),
            ...(avatarUrl !== undefined && { avatarUrl }),
            ...(bannerUrl !== undefined && { bannerUrl }),
            ...(visibility !== undefined && { visibility }),
            ...(allowFollows !== undefined && { allowFollows }),
            ...(showFollowerCount !== undefined && { showFollowerCount }),
          },
          select: pageSelect,
        });
      }

      try {
        return await p.entityPage.create({
          data: {
            ownerType,
            ownerId,
            slug,
            displayName,
            bio: bio ?? null,
            avatarUrl: avatarUrl ?? null,
            bannerUrl: bannerUrl ?? null,
            visibility: visibility ?? "PUBLIC",
            allowFollows: allowFollows ?? true,
            showFollowerCount: showFollowerCount ?? false,
          },
          select: pageSelect,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const fallback = await p.entityPage.findUnique({
            where: { ownerType_ownerId: { ownerType, ownerId } },
            select: pageSelect,
          });
          if (fallback) return fallback;
        }
        throw error;
      }
    },

    bulkCreate: async (pages) => {
      if (pages.length === 0) return { created: 0 };

      // `skipDuplicates` so a collision on either unique index
      // (`slug`, or `(ownerType, ownerId)`) does NOT surface as an opaque
      // P2002 that aborts the enclosing transaction mid-batch. The caller
      // compares `created` against what it sent and decides — see the port
      // doc. Dropping the row silently here is exactly the bug this method
      // fixes, so the count is the contract.
      const result = await p.entityPage.createMany({
        data: pages.map((page) => ({
          ownerType: page.ownerType,
          ownerId: page.ownerId,
          slug: page.slug,
          displayName: page.displayName,
          bio: page.bio ?? null,
        })),
        skipDuplicates: true,
      });

      return { created: result.count };
    },

    updateFollowSettings: (
      pageId: string,
      settings: { allowFollows: boolean; showFollowerCount: boolean },
    ) =>
      p.entityPage.update({
        where: { id: pageId },
        data: settings,
        select: pageSelect,
      }),

    // ── Theme ──────────────────────────────────────────────────────────
    getTheme: (pageId: string) =>
      p.pageTheme.findUnique({ where: { pageId }, select: themeSelect }),

    upsertTheme: async ({ pageId, ...data }) => {
      const existing = await p.pageTheme.findUnique({
        where: { pageId },
        select: themeSelect,
      });
      if (existing) {
        return p.pageTheme.update({
          where: { pageId },
          data,
          select: themeSelect,
        });
      }
      return p.pageTheme.create({
        data: { pageId, ...data },
        select: themeSelect,
      });
    },

    // ── Blocks ─────────────────────────────────────────────────────────
    listBlocks: (pageId: string) =>
      withSectionFallback(
        () =>
          p.pageBlock.findMany({
            where: { pageId },
            orderBy: { orderIndex: "asc" },
            select: blockSelect,
          }),
        async () =>
          (
            await p.pageBlock.findMany({
              where: { pageId },
              orderBy: { orderIndex: "asc" },
              select: legacyBlockSelect,
            })
          ).map(withDefaultSection),
      ),

    listBlocksByPageIds: async (pageIds: string[]) => {
      if (pageIds.length === 0) return [];
      return withSectionFallback(
        () =>
          p.pageBlock.findMany({
            where: { pageId: { in: pageIds } },
            // Group by page, then preserve the per-page stored sort order.
            orderBy: [{ pageId: "asc" }, { orderIndex: "asc" }],
            select: blockSelect,
          }),
        async () =>
          (
            await p.pageBlock.findMany({
              where: { pageId: { in: pageIds } },
              orderBy: [{ pageId: "asc" }, { orderIndex: "asc" }],
              select: legacyBlockSelect,
            })
          ).map(withDefaultSection),
      );
    },

    createBlock: async ({ pageId, kind, orderIndex, data, visible, section }) => {
      // Default orderIndex to max + 1
      const maxBlock = await p.pageBlock.findFirst({
        where: { pageId },
        orderBy: { orderIndex: "desc" },
        select: { orderIndex: true },
      });
      const idx = orderIndex ?? (maxBlock ? maxBlock.orderIndex + 1 : 0);

      const baseData = {
        pageId,
        kind,
        orderIndex: idx,
        data: (data ?? {}) as Prisma.InputJsonValue,
        visible: visible ?? true,
      };

      try {
        return await withSectionFallback(
          () =>
            p.pageBlock.create({
              data: {
                ...baseData,
                ...(section !== undefined && { section }),
              },
              select: blockSelect,
            }),
          async () => {
            // Pre-migration DB: a non-default section CANNOT be persisted —
            // fail loudly rather than silently filing the block under "main".
            if (section !== undefined && section !== DEFAULT_BLOCK_SECTION) {
              throw new Error(
                "PageBlock.section column is not migrated yet; cannot create a sectioned block",
              );
            }
            return withDefaultSection(
              await p.pageBlock.create({
                data: baseData,
                select: legacyBlockSelect,
              }),
            );
          },
        );
      } catch (error) {
        // The race core's check-then-create in managePageBlocks `add` cannot
        // close on its own: two concurrent adds of a pinned kind, or a
        // recovery add against a stray copy filed under another section.
        pinnedDuplicateOr(error, kind);
      }
    },

    updateBlock: async ({ id, ...data }) => {
      const updateData = {
        ...(data.kind !== undefined && { kind: data.kind }),
        ...(data.orderIndex !== undefined && { orderIndex: data.orderIndex }),
        ...(data.data !== undefined && {
          data: data.data as Prisma.InputJsonValue,
        }),
        ...(data.visible !== undefined && { visible: data.visible }),
      };
      return withSectionFallback(
        () =>
          p.pageBlock.update({
            where: { id },
            data: updateData,
            select: blockSelect,
          }),
        async () =>
          withDefaultSection(
            await p.pageBlock.update({
              where: { id },
              data: updateData,
              select: legacyBlockSelect,
            }),
          ),
      );
    },

    deleteBlock: async (blockId: string) => {
      await p.pageBlock.delete({ where: { id: blockId } });
    },

    reorderBlocks: async (pageId: string, orderedIds: string[]) => {
      await Promise.all(
        orderedIds.map((id, idx) =>
          p.pageBlock.update({ where: { id }, data: { orderIndex: idx } }),
        ),
      );
    },

    applyTemplateSeed: async ({
      pageId,
      category,
      appliedMarker,
      blocks,
    }: ApplyTemplateSeedInput): Promise<PageBlockRecord[]> =>
      withEntityPagesTransaction(p, async (tx) => {
        // The applied-state marker: bare category for revision 1, or a
        // versioned `"<category>@<N>"` marker for template-revision bumps
        // (core page-templates.ts). The guard/append runs on the MARKER; the
        // `category` column still advances to the plain category.
        const marker = appliedMarker ?? category;
        // Concurrency guard: append `marker` iff not already present. This
        // conditional UPDATE row-locks the page; a racing seed of the same
        // (category, revision) blocks here, then re-evaluates the WHERE
        // against the committed row, finds the marker present, and affects 0
        // rows.
        const affected = await tx.$executeRaw(Prisma.sql`
          UPDATE "EntityPage"
          SET "templateAppliedCategories" =
                array_append("templateAppliedCategories", ${marker}),
              -- Advance the current classification to the category we're
              -- seeding (fires on forward transitions and revision bumps; a
              -- same-category revision bump rewrites the same value, so this
              -- still reflects the latest content classification).
              "category" = ${category},
              "updatedAt" = NOW()
          WHERE "id" = ${pageId}
            AND NOT (${marker} = ANY("templateAppliedCategories"))
        `);
        if (affected === 0) return [];

        // Re-read current block state INSIDE the tx so a manual block added
        // between the use case's pre-check and now is not duplicated, and the
        // orderIndex is computed against the authoritative state. `section`
        // is selected here (no legacy fallback inside a tx): the column
        // landed in 20260810170000 and every environment that runs this is
        // past it.
        const existing = await tx.pageBlock.findMany({
          where: { pageId },
          select: { kind: true, orderIndex: true, section: true },
        });
        const presentKinds = new Set(existing.map((b) => b.kind));
        // A PINNED candidate is present only if a MAIN-section row carries
        // its kind (see the port doc on `pinned`): a stray copy under another
        // section never renders and must not SILENTLY satisfy the seed. The
        // insert that follows then hits the section-blind partial unique
        // index and is refused as a typed BLOCK_PINNED (below) — surfaced by
        // getMyPage's seed report on every editor load until the stray is
        // removed by hand. Never a quiet "present, skip".
        const presentMainKinds = new Set(
          existing
            .filter((b) => countsAsMainSection(b.section))
            .map((b) => b.kind),
        );
        let nextIndex = existing.reduce(
          (max, b) => Math.max(max, b.orderIndex + 1),
          0,
        );

        const created: PageBlockRecord[] = [];
        for (const block of blocks) {
          const present = block.pinned
            ? presentMainKinds.has(block.kind)
            : presentKinds.has(block.kind);
          if (present) continue;
          presentKinds.add(block.kind);
          presentMainKinds.add(block.kind);
          // legacyBlockSelect deliberately: template seeds never set `section`
          // (the DB default "main" is always correct), and a P2022 retry is
          // not possible inside this transaction — the fallback pattern the
          // other block reads use would abort the whole tx instead.
          let row;
          try {
            row = await tx.pageBlock.create({
              data: {
                pageId,
                kind: block.kind,
                orderIndex: nextIndex,
                data: (block.data ?? {}) as Prisma.InputJsonValue,
                visible: block.visible ?? true,
              },
              select: legacyBlockSelect,
            });
          } catch (error) {
            // Seed-vs-concurrent-add collision on a pinned kind, or a stray
            // non-main copy: typed, so the tx rollback reads as BLOCK_PINNED
            // in Sentry rather than a raw P2002.
            pinnedDuplicateOr(error, block.kind);
          }
          created.push(withDefaultSection(row));
          nextIndex += 1;
        }
        return created;
      }),

    // ── Draft storage primitives (port doc: lock contract + lock order) ──

    getDraft: async (pageId: string) => {
      const row = await p.pageDraft.findUnique({
        where: { pageId },
        select: draftSelect,
      });
      return row ? toDraftRecord(row) : null;
    },

    lockDraftForUpdate: async (pageId: string) => {
      assertInTransaction(p, "lock");
      // 1. Ensure the row exists. INSERT … SELECT from EntityPage so a
      //    missing page inserts nothing (no FK error, which would abort the
      //    caller's transaction) and is reported as PAGE_NOT_FOUND below.
      //    ON CONFLICT ("pageId") covers exactly the PageDraft_pageId_key
      //    unique index: when a concurrent first save has inserted but not
      //    committed, Postgres waits for it, then skips. No P2002 is
      //    possible from this path. `updatedAt` has no DB default
      //    (`@updatedAt` is client-side), so it is set here explicitly.
      await p.$executeRaw(Prisma.sql`
        INSERT INTO "PageDraft" ("id", "pageId", "updatedAt")
        SELECT gen_random_uuid()::text, ep."id", CURRENT_TIMESTAMP
        FROM "EntityPage" ep
        WHERE ep."id" = ${pageId}
        ON CONFLICT ("pageId") DO NOTHING
      `);
      // 2. Lock it. Blocks behind any other transaction holding the row.
      const locked = await p.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "PageDraft" WHERE "pageId" = ${pageId} FOR UPDATE
      `);
      if (locked.length === 0) {
        throw fail("PAGE_NOT_FOUND", { meta: { pageId } });
      }
      // 3. Re-read under the lock. At READ COMMITTED this statement takes a
      //    fresh snapshot, so it sees whatever the previous lock holder
      //    committed.
      const row = await p.pageDraft.findUnique({
        where: { pageId },
        select: draftSelect,
      });
      // Locked a moment ago in this transaction, so a missing row here is an
      // invariant break (not a 404): INTERNAL, so it reaches Sentry.
      if (!row) {
        throw fail("INTERNAL", {
          message: "page_draft_row_missing_after_lock",
          meta: { pageId },
        });
      }
      return toDraftRecord(row);
    },

    writeDraft: async (pageId: string, next: WritePageDraftInput) => {
      assertInTransaction(p, "write");
      assertWritableDraft(pageId, next);
      // ONE UPDATE for every column, appliedBatchIds included: the
      // cardinality CHECK is not deferrable, so it must hold on this single
      // statement's result. Prisma's `update` sets `updatedAt` (@updatedAt).
      return updateDraftRow(p, pageId, next.revision, {
        data: next.data as Prisma.InputJsonObject,
        placePatch: next.placePatch as Prisma.InputJsonObject,
        placeBase: next.placeBase as Prisma.InputJsonObject,
        fieldEditors: next.fieldEditors as Prisma.InputJsonObject,
        appliedBatchIds: { set: next.appliedBatchIds },
        revision: next.revision,
        updatedByHumanId: next.updatedByHumanId,
      });
    },

    clearDraft: async (pageId: string, input: ClearPageDraftInput) => {
      assertInTransaction(p, "clear");
      assertClearableDraft(pageId, input);
      // ONE UPDATE: overlays to '{}' (never JSON null, which the object CHECK
      // rejects), revision and lastPublishedRevision together so the CHECK
      // `lastPublishedRevision <= revision` holds on the final row.
      // appliedBatchIds is deliberately untouched.
      return updateDraftRow(p, pageId, input.revision, {
        data: {},
        placePatch: {},
        placeBase: {},
        fieldEditors: {},
        revision: input.revision,
        updatedByHumanId: input.updatedByHumanId,
        ...(input.lastPublishedRevision !== undefined && {
          lastPublishedRevision: input.lastPublishedRevision,
        }),
      });
    },
  };
}
