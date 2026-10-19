-- Upsert curated event categories if the table exists (idempotent)
DO $$
BEGIN
  IF to_regclass('"Category"') IS NOT NULL THEN
    INSERT INTO "Category" ("slug", "name", "sortOrder") VALUES
      ('music', 'Music', 1),
      ('sports', 'Sports', 2),
      ('theatre', 'Theatre', 3),
      ('comedy', 'Comedy', 4),
      ('community', 'Community', 5),
      ('nightlife', 'Nightlife', 6),
      ('learning', 'Learning', 7),
      ('art', 'Art', 8),
      ('other', 'Other', 9)
    ON CONFLICT ("slug") DO UPDATE
      SET "name" = EXCLUDED."name",
          "active" = true,
          "sortOrder" = EXCLUDED."sortOrder",
          "updatedAt" = NOW();
  END IF;
END
$$;
