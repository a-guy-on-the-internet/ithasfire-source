-- PageDraft: the unpublished edits to one EntityPage (page editor, spec
-- docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml).
--
-- One shared draft per page (R14): editors' autosaves merge field-level patch
-- ops {path, value} into the row, last write wins per path. Public reads never
-- touch this table, so the public page is unchanged (R2). Publish applies the
-- draft to EntityPage, PageTheme, PageBlock and Place in one transaction.
--
-- The row is created on a page's first save and never deleted by Publish or
-- Discard: they CLEAR it (the four JSON overlays back to '{}') and keep
-- "revision" increasing and "appliedBatchIds", because both are idempotency
-- keys that must not repeat across publishes. "Has unpublished changes" is
-- derived from non-empty overlays (ignoring "data"->'v'). The row goes only
-- with its EntityPage (ON DELETE CASCADE).
--
-- Publish with draftRevision: (a) writes only when draftRevision = "revision"
-- and the overlays are non-empty, then clears and sets
-- "lastPublishedRevision" to the new revision; (b)
-- "lastPublishedRevision" = draftRevision + 1 is the caller's own retried
-- Publish (even if newer edits were saved since), a no-op returning the
-- published result; (c) anything else is
-- STALE/DISCARDED, returned with "updatedByHumanId". Equality, never >=.
-- Discard clears and leaves "lastPublishedRevision" alone.
--
-- "data" is an open JSON overlay, not typed columns, so a later phase adds
-- draftable fields (layout and styling freedom, owner R19) without a
-- migration; "data"->'v' is reserved for the overlay's format version
-- (absent = 1). "placeBase" holds each patched Place field's live value at
-- first touch, for Publish's conflict check (R9).
--
-- Human ids ("updatedByHumanId", and those inside "fieldEditors") carry no FK
-- (precedent: Order."compIssuedByHumanId"); readers must handle an id that no
-- longer resolves.
--
-- New, empty table: no backfill, no lock on existing tables beyond the FK
-- validation of an empty table.
--
-- Rollback (by hand; DISCARDS every unpublished draft):
--   DROP TABLE "PageDraft";

-- CreateTable
CREATE TABLE "PageDraft" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "placePatch" JSONB NOT NULL DEFAULT '{}',
    "placeBase" JSONB NOT NULL DEFAULT '{}',
    "fieldEditors" JSONB NOT NULL DEFAULT '{}',
    "appliedBatchIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 0,
    "lastPublishedRevision" INTEGER,
    "updatedByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageDraft_pkey" PRIMARY KEY ("id")
);

-- Every overlay is a JSON object keyed by path or field name; an array or
-- scalar here is a writer bug, not data.
ALTER TABLE "PageDraft" ADD CONSTRAINT "PageDraft_json_objects_check" CHECK (
  jsonb_typeof("data") = 'object'
  AND jsonb_typeof("placePatch") = 'object'
  AND jsonb_typeof("placeBase") = 'object'
  AND jsonb_typeof("fieldEditors") = 'object'
);

ALTER TABLE "PageDraft" ADD CONSTRAINT "PageDraft_revision_check" CHECK (
  "revision" >= 0
);

-- A Publish clears to revision + 1 >= 1, and revision never goes down, so
-- the last published revision can never exceed the current one.
ALTER TABLE "PageDraft" ADD CONSTRAINT "PageDraft_last_published_revision_check" CHECK (
  "lastPublishedRevision" IS NULL
  OR ("lastPublishedRevision" >= 1 AND "lastPublishedRevision" <= "revision")
);

-- Op-batch replay guard: the adapter keeps the newest 100 batch ids; this is
-- the backstop that keeps the row from growing without bound.
ALTER TABLE "PageDraft" ADD CONSTRAINT "PageDraft_applied_batch_ids_check" CHECK (
  cardinality("appliedBatchIds") <= 100
);

-- One draft per page (R14); also the lookup index.
CREATE UNIQUE INDEX "PageDraft_pageId_key" ON "PageDraft"("pageId");

ALTER TABLE "PageDraft" ADD CONSTRAINT "PageDraft_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "EntityPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
