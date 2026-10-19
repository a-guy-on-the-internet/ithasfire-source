-- Composite index backing the geo×category SEO landing page fetch
-- (EventsRepo.listPublishedByCategoryAndCity): narrows to a category then
-- range-scans upcoming events before the slug-folded locality match.
-- CreateIndex
CREATE INDEX "Event_categoryId_startsAt_idx" ON "Event"("categoryId", "startsAt");
