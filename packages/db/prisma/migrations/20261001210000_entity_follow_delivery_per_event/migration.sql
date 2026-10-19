-- Follow notifications, round 3 (additive).
--  * One delivery per (event, follower): someone who follows the org, the
--    venue and the host gets ONE alert for an event, not one per page.
--  * Recorded reasons: why a notice closed early, why a delivery finished.

ALTER TABLE "EntityEventNotice" ADD COLUMN "closedReason" TEXT;
CREATE INDEX "EntityEventNotice_eventId_idx" ON "EntityEventNotice"("eventId");

ALTER TABLE "EntityEventDelivery" ADD COLUMN "eventId" TEXT;
ALTER TABLE "EntityEventDelivery" ADD COLUMN "finishReason" TEXT;

UPDATE "EntityEventDelivery" d
SET "eventId" = n."eventId"
FROM "EntityEventNotice" n
WHERE n."id" = d."noticeId";

-- Existing cross-page duplicates: keep the row that already sent something,
-- then a finished one, then the oldest id; drop the rest so the unique index
-- can be built.
DELETE FROM "EntityEventDelivery"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "eventId", "humanId"
      ORDER BY ("inAppDone" OR "emailDone" OR "pushDone") DESC,
               ("finishedAt" IS NOT NULL) DESC,
               "id"
    ) AS rn
    FROM "EntityEventDelivery"
  ) ranked
  WHERE rn > 1
);

ALTER TABLE "EntityEventDelivery" ALTER COLUMN "eventId" SET NOT NULL;
CREATE UNIQUE INDEX "EntityEventDelivery_eventId_humanId_key" ON "EntityEventDelivery"("eventId", "humanId");
