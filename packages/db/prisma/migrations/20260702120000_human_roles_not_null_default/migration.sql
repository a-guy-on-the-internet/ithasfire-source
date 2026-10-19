-- Human.roles was created as "HumanRole"[] with no DEFAULT and no NOT NULL
-- (consolidated baseline), and no production create path (humans.create,
-- ensureGuestHuman, the Better-Auth link path) ever set it — so every real
-- (non-seed) human stored SQL NULL. Postgres array operators return NULL
-- (not TRUE) against a NULL array, so authz.grantHumanRole's idempotency
-- guard (`NOT ("roles" @> ARRAY[role])`) matched zero rows and FR-010
-- moderator approvals silently never granted the role.
--
-- Backfill NULL rows to the empty array, then pin DEFAULT '{}' + NOT NULL so
-- the column can never be SQL NULL again.

-- Backfill
UPDATE "Human" SET "roles" = '{}' WHERE "roles" IS NULL;

-- AlterTable
ALTER TABLE "Human" ALTER COLUMN "roles" SET DEFAULT ARRAY[]::"HumanRole"[];
ALTER TABLE "Human" ALTER COLUMN "roles" SET NOT NULL;
