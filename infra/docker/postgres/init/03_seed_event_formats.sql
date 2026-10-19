-- Upsert curated event formats if the table exists (idempotent)
DO $$
BEGIN
  IF to_regclass('"EventFormat"') IS NOT NULL THEN
    INSERT INTO "EventFormat" ("slug", "name", "sortOrder") VALUES
      ('in-person', 'In-person', 0),
      ('virtual', 'Virtual', 1),
      ('hybrid', 'Hybrid', 2),
      ('livestream', 'Livestream', 3),
      ('on-demand', 'On-demand', 4)
    ON CONFLICT ("slug") DO UPDATE
      SET "name" = EXCLUDED."name",
          "active" = true,
          "sortOrder" = EXCLUDED."sortOrder",
          "updatedAt" = NOW();
  END IF;
END
$$;
