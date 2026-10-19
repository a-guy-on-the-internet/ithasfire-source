-- Invite complaint auto-pause (W4, owner ruling 2026-10-06):
--   "auto-pause an organiser's invites after complaints (start: 3 complaints,
--    or >1% of recent sends), staff review to lift, organiser told why + how
--    to ask for review."
--
-- 1. EventInviteComplaint: one spam complaint (Resend `email.complained`) on a
--    personal invite email, attributed to the event OWNER (org, or the human
--    owning a person-owned event) through the invite's `meta_inviteOwner`
--    tag. Keyed hash of the address only, never the address. Unique on the
--    provider's event id, so a webhook replay inserts nothing.
-- 2. EventInvitePause: the owner's invite emails are paused until staff lift
--    it. At most one OPEN pause (liftedAt IS NULL) per owner.
--
-- Both tables are new and empty: no backfill, no lock on existing tables
-- beyond the FK validation of an empty table.
--
-- Rollback (by hand; DISCARDS every complaint and pause, so invites resume):
--   DROP TABLE "EventInvitePause";
--   DROP TABLE "EventInviteComplaint";
--   DROP TYPE "EventInvitePauseDecision";
--   DROP TYPE "EventInvitePauseReason";

-- ── 0. Enums ────────────────────────────────────────────────────────────────
CREATE TYPE "EventInvitePauseReason" AS ENUM ('COMPLAINT_COUNT', 'COMPLAINT_RATE');

CREATE TYPE "EventInvitePauseDecision" AS ENUM ('LIFTED', 'KEPT');

-- ── 1. EventInviteComplaint ─────────────────────────────────────────────────
CREATE TABLE "EventInviteComplaint" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "orgId" TEXT,
    "humanOwnerId" TEXT,
    "eventId" TEXT,
    "emailHash" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventInviteComplaint_pkey" PRIMARY KEY ("id")
);

-- Exactly one owner: an org-owned event's organiser is the org; a
-- person-owned event's organiser is that human.
ALTER TABLE "EventInviteComplaint" ADD CONSTRAINT "EventInviteComplaint_one_owner_check" CHECK (
  ("orgId" IS NOT NULL AND "humanOwnerId" IS NULL)
  OR ("orgId" IS NULL AND "humanOwnerId" IS NOT NULL)
);

-- Same keyed hash (and format) as EventInviteOptOut.emailHash.
ALTER TABLE "EventInviteComplaint" ADD CONSTRAINT "EventInviteComplaint_email_hash_check" CHECK (
  "emailHash" ~ '^[A-Za-z0-9_-]{43}$'
);

ALTER TABLE "EventInviteComplaint" ADD CONSTRAINT "EventInviteComplaint_provider_event_id_check" CHECK (
  char_length("providerEventId") BETWEEN 1 AND 255
);

-- Replay guard: INSERT … ON CONFLICT DO NOTHING in the adapter.
CREATE UNIQUE INDEX "EventInviteComplaint_providerEventId_key" ON "EventInviteComplaint"("providerEventId");

-- The trip count: COUNT(DISTINCT "emailHash") for one owner WHERE
--   "sentAt" >= cutoff OR ("sentAt" IS NULL AND "occurredAt" >= cutoff)
-- (send time, else the complaint's own time). The owner column leads, so the
-- scan is one owner's complaints; that set stays small.
CREATE INDEX "EventInviteComplaint_orgId_occurredAt_idx" ON "EventInviteComplaint"("orgId", "occurredAt");

CREATE INDEX "EventInviteComplaint_humanOwnerId_occurredAt_idx" ON "EventInviteComplaint"("humanOwnerId", "occurredAt");

-- Backs the ON DELETE SET NULL from Event.
CREATE INDEX "EventInviteComplaint_eventId_idx" ON "EventInviteComplaint"("eventId");

ALTER TABLE "EventInviteComplaint" ADD CONSTRAINT "EventInviteComplaint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventInviteComplaint" ADD CONSTRAINT "EventInviteComplaint_humanOwnerId_fkey" FOREIGN KEY ("humanOwnerId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventInviteComplaint" ADD CONSTRAINT "EventInviteComplaint_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. EventInvitePause ─────────────────────────────────────────────────────
CREATE TABLE "EventInvitePause" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "humanOwnerId" TEXT,
    "reason" "EventInvitePauseReason" NOT NULL,
    "complaintCount" INTEGER NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "pausedAt" TIMESTAMP(3) NOT NULL,
    "reviewRequestedAt" TIMESTAMP(3),
    "reviewRequestNote" TEXT,
    "decision" "EventInvitePauseDecision",
    "decidedAt" TIMESTAMP(3),
    "decidedByHumanId" TEXT,
    "decisionNote" TEXT,
    "liftedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventInvitePause_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_one_owner_check" CHECK (
  ("orgId" IS NOT NULL AND "humanOwnerId" IS NULL)
  OR ("orgId" IS NULL AND "humanOwnerId" IS NOT NULL)
);

ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_counts_check" CHECK (
  "complaintCount" >= 1 AND "recipientCount" >= 0
);

-- A note only travels with a request.
ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_review_note_check" CHECK (
  "reviewRequestNote" IS NULL
  OR ("reviewRequestedAt" IS NOT NULL AND char_length("reviewRequestNote") <= 1000)
);

ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_decision_note_check" CHECK (
  "decisionNote" IS NULL OR char_length("decisionNote") <= 2000
);

-- A decision is all-or-nothing: what, when (who may be SET NULL later, when
-- that staff member's Human row is deleted).
ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_decision_check" CHECK (
  ("decision" IS NULL) = ("decidedAt" IS NULL)
);

-- Lifted ⇔ the decision is LIFTED.
ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_lifted_check" CHECK (
  ("liftedAt" IS NOT NULL) = ("decision" IS NOT NULL AND "decision" = 'LIFTED')
);

-- At most one OPEN pause per owner, per owner kind. The trip runs under a
-- per-owner advisory lock; these are the backstop.
CREATE UNIQUE INDEX "EventInvitePause_org_open_key"
  ON "EventInvitePause"("orgId")
  WHERE "orgId" IS NOT NULL AND "liftedAt" IS NULL;

CREATE UNIQUE INDEX "EventInvitePause_human_open_key"
  ON "EventInvitePause"("humanOwnerId")
  WHERE "humanOwnerId" IS NOT NULL AND "liftedAt" IS NULL;

-- History per owner (latest lift = start of the complaint window).
CREATE INDEX "EventInvitePause_orgId_liftedAt_idx" ON "EventInvitePause"("orgId", "liftedAt");

CREATE INDEX "EventInvitePause_humanOwnerId_liftedAt_idx" ON "EventInvitePause"("humanOwnerId", "liftedAt");

CREATE INDEX "EventInvitePause_decidedByHumanId_idx" ON "EventInvitePause"("decidedByHumanId");

-- The staff queue: open pauses waiting on a review, oldest request first.
CREATE INDEX "EventInvitePause_awaiting_review_idx"
  ON "EventInvitePause"("reviewRequestedAt")
  WHERE "liftedAt" IS NULL AND "reviewRequestedAt" IS NOT NULL;

ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_humanOwnerId_fkey" FOREIGN KEY ("humanOwnerId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventInvitePause" ADD CONSTRAINT "EventInvitePause_decidedByHumanId_fkey" FOREIGN KEY ("decidedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
