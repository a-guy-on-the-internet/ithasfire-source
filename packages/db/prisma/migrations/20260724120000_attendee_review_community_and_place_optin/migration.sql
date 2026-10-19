-- Venue-rating-block-and-owner-optin (2026-07-23) — attendee community reviews
-- + Place-level publish opt-in.
--
-- PRE-PRODUCTION: no real review data, so this is a plain additive schema
-- change — NO backfill / data-preservation step. Existing AttendeeReview rows
-- (if any) default to source = VERIFIED_TICKET via the column default, keeping
-- the column non-null. The nullability relax on eventId/humanId is behaviour-
-- preserving for verified rows (both stay set); the @@unique([eventId, humanId])
-- still binds the verified path (Postgres treats NULL as distinct, so many
-- (null, *) community rows coexist without collision).

-- Provenance discriminator (FR-009 / FR-010).
CREATE TYPE "AttendeeReviewSource" AS ENUM ('VERIFIED_TICKET', 'COMMUNITY');

-- AttendeeReview: eventId/humanId become optional; add anonymous submitter
-- identity + the source tag. The eventId/humanId FKs (ON DELETE CASCADE) are
-- unchanged — only the NOT NULL constraint is dropped.
ALTER TABLE "AttendeeReview"
  ALTER COLUMN "eventId" DROP NOT NULL,
  ALTER COLUMN "humanId" DROP NOT NULL,
  ADD COLUMN "anonymousName" TEXT,
  ADD COLUMN "anonymousEmail" TEXT,
  ADD COLUMN "source" "AttendeeReviewSource" NOT NULL DEFAULT 'VERIFIED_TICKET';

-- Place: owner opt-in that publishes the ATTENDEE aggregate on the public venue
-- page (FR-004). Default false = private owner feedback.
ALTER TABLE "Place"
  ADD COLUMN "attendee_reviews_public" BOOLEAN NOT NULL DEFAULT false;
