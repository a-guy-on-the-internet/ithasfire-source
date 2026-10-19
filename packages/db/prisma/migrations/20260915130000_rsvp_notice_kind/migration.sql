-- RsvpNotice gains a KIND so one outbox can carry two messages.
--
-- Until now every row meant "you're going" (a confirmation enqueued by
-- rsvp-to-event / rsvp-to-event-date). A moderator calling ONE night of a
-- recurring listing off now enqueues a second kind against the same table, so
-- "that night is off" reuses the existing drain, retry/dead-letter bookkeeping
-- and retention purge instead of growing a second outbox nobody remembers to
-- drain.
--
-- Backfill-free by construction: the column is NOT NULL with a CONFIRMATION
-- default, which is exactly what every pre-existing row means.

-- CreateEnum
CREATE TYPE "RsvpNoticeKind" AS ENUM ('CONFIRMATION', 'DATE_CANCELLED');

-- AlterTable
ALTER TABLE "RsvpNotice"
  ADD COLUMN "kind" "RsvpNoticeKind" NOT NULL DEFAULT 'CONFIRMATION';

-- The drain claims by (dispatchedAt, createdAt) and is kind-agnostic, so no new
-- index is needed for it. `restoreEventDate` deletes UNDISPATCHED DATE_CANCELLED
-- rows for one date (a night called off by mistake must not still mail "it's
-- off"), which is served by the existing "RsvpNotice_eventDateId_idx".
