-- Add explicit public eligibility for announcements rendered on entity pages.
-- Existing announcements default to private for public page purposes.

ALTER TABLE "Announcement"
    ADD COLUMN "publicOnEntityPage" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Announcement_orgId_publicOnEntityPage_sentAt_idx"
    ON "Announcement"("orgId", "publicOnEntityPage", "sentAt");

CREATE INDEX "Announcement_sentBy_publicOnEntityPage_sentAt_idx"
    ON "Announcement"("sentBy", "publicOnEntityPage", "sentAt");