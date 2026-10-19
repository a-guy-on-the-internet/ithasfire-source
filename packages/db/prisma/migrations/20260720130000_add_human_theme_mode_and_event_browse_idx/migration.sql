-- Human.themeMode: persisted light/dark preference (web theme toggle account sync)
ALTER TABLE "Human" ADD COLUMN IF NOT EXISTS "theme_mode" TEXT;

-- Composite index backing public event browse/search queries
CREATE INDEX IF NOT EXISTS "Event_status_visibility_startsAt_idx" ON "Event"("status", "visibility", "startsAt");
