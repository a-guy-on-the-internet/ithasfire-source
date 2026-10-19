-- Search index format version (2026-09-30): which SEARCH_INDEX_FORMAT_VERSION
-- (packages/core/src/use-cases/search/search-index-format.ts) the index was
-- last fully rebuilt at, and the claim that lets exactly one booting API
-- instance trigger the rebuild after a format change. Single statement; the
-- singleton row is created by the claim itself (INSERT ... ON CONFLICT DO
-- NOTHING), so no seed row is needed here.
CREATE TABLE "SearchIndexState" (
    "id" TEXT NOT NULL,
    "format_version" INTEGER NOT NULL DEFAULT 0,
    "rebuild_claimed_version" INTEGER,
    "rebuild_claimed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchIndexState_pkey" PRIMARY KEY ("id")
);
