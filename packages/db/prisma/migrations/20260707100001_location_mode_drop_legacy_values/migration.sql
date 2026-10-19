-- Location-visibility-reveal spec (2026-06-23), migration 2 of 2.
-- Recreate EventLocationMode as exactly {EXACT, OBSCURED}, dropping the
-- legacy APPROXIMATE/HIDDEN values.
--
-- INVARIANT (assert): by this point 0 rows reference APPROXIMATE or HIDDEN —
-- migration 20260707100000 backfilled every such row to OBSCURED, and the
-- application layer (deployed with these migrations) only ever writes
-- EXACT|OBSCURED. The USING cast below would fail loudly ("invalid input
-- value for enum") if any legacy row somehow remained, which is the desired
-- fail-stop behaviour.
--
-- Postgres cannot DROP a single enum value, so: rename old type → create new
-- type → retype the column through text → drop old type. Safe inside one
-- transaction (no ALTER TYPE ... ADD VALUE involved).

-- AlterEnum
ALTER TYPE "EventLocationMode" RENAME TO "EventLocationMode_old";

CREATE TYPE "EventLocationMode" AS ENUM ('EXACT', 'OBSCURED');

ALTER TABLE "Event" ALTER COLUMN "locationMode" DROP DEFAULT;

ALTER TABLE "Event"
  ALTER COLUMN "locationMode" TYPE "EventLocationMode"
  USING ("locationMode"::text::"EventLocationMode");

ALTER TABLE "Event" ALTER COLUMN "locationMode" SET DEFAULT 'EXACT';

DROP TYPE "EventLocationMode_old";
