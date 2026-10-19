-- Edit-triggered batched search reindex (2026-09-30): the durable list of
-- entities whose search document may be stale. Marked inside the edit's own
-- transaction; cleared by the post-commit reindex, the scheduled drain job
-- (search.drain-reindex-pending) or the nightly full reindex. Single
-- statement; the composite primary key is the only index (the table holds a
-- handful of rows between drains).
CREATE TABLE "SearchReindexPending" (
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "marked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMPTZ(6),

    CONSTRAINT "SearchReindexPending_pkey" PRIMARY KEY ("entity_type","entity_id")
);
