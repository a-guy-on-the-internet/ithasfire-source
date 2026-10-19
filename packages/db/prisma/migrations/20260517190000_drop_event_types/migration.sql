-- Drop the EventType sub-category taxonomy. Tags now cover the same ground
-- (multi-value, free-form, no admin approval pipeline). See the seed
-- function `ensureGenreTags` for the curated genre list that replaces the
-- former SEED_EVENT_TYPES.
--
-- The `EventCategoryRequestKind` enum still includes `EVENT_TYPE` because
-- Postgres makes enum-value removal expensive; no new code path emits it,
-- and existing `EVENT_TYPE` rows (if any) become orphaned but harmless
-- pending a future enum rebuild.

-- Drop FK + index from Event.typeId first.
ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS "Event_typeId_fkey";
DROP INDEX IF EXISTS "Event_typeId_idx";
ALTER TABLE "Event" DROP COLUMN IF EXISTS "typeId";

-- Drop the resolvedEventTypeId column from the request audit trail.
ALTER TABLE "EventCategoryRequest"
  DROP COLUMN IF EXISTS "resolvedEventTypeId";

-- Drop the table itself (CASCADE not needed — FK already gone above).
DROP TABLE IF EXISTS "EventType";
