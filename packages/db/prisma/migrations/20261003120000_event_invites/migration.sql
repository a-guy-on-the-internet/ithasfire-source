-- Gated-event invite links (docs/specs/2026-10-02/gated-event-invite-links.spec.yaml).
--
-- EventMagicLink becomes EventInvite: a SHARED link (one live per event,
-- anyone holding it) or a PERSONAL link (one live per invitee email, emailed
-- to that guest). Single-use semantics are gone, so expiresAt, redeemedAt,
-- redeemedByHumanId and targetHumanId are dropped. Links die at event end,
-- derived at check time, never stored (FR-008). Only the SHA-256 hex of the
-- token is kept (tokenHash replaces the raw token).
--
-- EventUnlock and EventApplicationSubmission gain a nullable inviteId so a
-- personal revoke can find what it granted (FR-006) and invite approvals can
-- be excluded from maxSubmissions and labelled "Via invite" (FR-009).
--
-- The table is RENAMED, not recreated, and its pkey / FK names are renamed to
-- what Prisma generates for "EventInvite", so a later `migrate diff` is clean.
-- createdByHumanId becomes nullable with ON DELETE SET NULL: deleting a
-- co-organizer's Human must not delete their invites (that would null every
-- grant's inviteId and break revoke-by-invite and the cap exclusion).

-- ── 1. Existing rows ─────────────────────────────────────────────────────────
-- No link was ever created outside e2e seeds, and those rows cannot be carried
-- over: they hold a raw token (no hash), no kind, and single-use state that
-- means nothing under the new model. Delete them so the NOT NULL "kind" and
-- "tokenHash" columns can be added without a default. Nothing references this
-- table yet, so the delete cascades nowhere.
DELETE FROM "EventMagicLink";

-- ── 2. Rename the table and the constraints that survive ────────────────────
ALTER TABLE "EventMagicLink" RENAME TO "EventInvite";
ALTER TABLE "EventInvite" RENAME CONSTRAINT "EventMagicLink_pkey" TO "EventInvite_pkey";
ALTER TABLE "EventInvite" RENAME CONSTRAINT "EventMagicLink_eventId_fkey" TO "EventInvite_eventId_fkey";

-- ── 3. Drop single-use / raw-token state ────────────────────────────────────
ALTER TABLE "EventInvite" DROP CONSTRAINT "EventMagicLink_targetHumanId_fkey";
ALTER TABLE "EventInvite" DROP CONSTRAINT "EventMagicLink_redeemedByHumanId_fkey";
-- Recreated in section 6 with ON DELETE SET NULL (was CASCADE).
ALTER TABLE "EventInvite" DROP CONSTRAINT "EventMagicLink_createdByHumanId_fkey";

DROP INDEX "EventMagicLink_token_key";
DROP INDEX "EventMagicLink_eventId_idx";
DROP INDEX "EventMagicLink_expiresAt_idx";

ALTER TABLE "EventInvite"
DROP COLUMN "token",
DROP COLUMN "targetHumanId",
DROP COLUMN "expiresAt",
DROP COLUMN "redeemedAt",
DROP COLUMN "redeemedByHumanId";

-- ── 4. New columns ───────────────────────────────────────────────────────────
CREATE TYPE "EventInviteKind" AS ENUM ('SHARED', 'PERSONAL');

ALTER TABLE "EventInvite"
ADD COLUMN "kind" "EventInviteKind" NOT NULL,
ADD COLUMN "inviteeName" TEXT,
ADD COLUMN "inviteeEmail" TEXT,
ADD COLUMN "tokenHash" TEXT NOT NULL,
ADD COLUMN "inviteListEntryId" TEXT,
ADD COLUMN "revokedAt" TIMESTAMP(3),
ADD COLUMN "firstRedeemedAt" TIMESTAMP(3),
ADD COLUMN "redemptionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sentAt" TIMESTAMP(3),
ALTER COLUMN "createdByHumanId" DROP NOT NULL;

-- PERSONAL rows carry a lowercase email; SHARED rows carry no invitee. Makes
-- lowercase storage a guarantee rather than an app-side convention.
ALTER TABLE "EventInvite" ADD CONSTRAINT "EventInvite_kind_invitee_check" CHECK (
  ("kind" = 'PERSONAL' AND "inviteeEmail" IS NOT NULL AND "inviteeEmail" = lower("inviteeEmail"))
  OR ("kind" = 'SHARED' AND "inviteeEmail" IS NULL AND "inviteeName" IS NULL)
);

ALTER TABLE "EventUnlock" ADD COLUMN "inviteId" TEXT;

ALTER TABLE "EventApplicationSubmission" ADD COLUMN "inviteId" TEXT;

-- ── 5. Indexes ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "EventInvite_tokenHash_key" ON "EventInvite"("tokenHash");
CREATE INDEX "EventInvite_eventId_kind_idx" ON "EventInvite"("eventId", "kind");
CREATE INDEX "EventInvite_inviteListEntryId_idx" ON "EventInvite"("inviteListEntryId");
CREATE INDEX "EventUnlock_inviteId_idx" ON "EventUnlock"("inviteId");
CREATE INDEX "EventApplicationSubmission_inviteId_idx" ON "EventApplicationSubmission"("inviteId");

-- SQL-only partial / expression uniques (Prisma can't express them; noted on
-- the EventInvite model in event.prisma). The use cases pre-check; these are
-- the race backstop and the adapter maps their P2002.
--
-- At most one live SHARED link per event (FR-001). Reset revokes the old row
-- and inserts the new one in one transaction.
CREATE UNIQUE INDEX "EventInvite_live_shared_key"
  ON "EventInvite"("eventId")
  WHERE "kind" = 'SHARED' AND "revokedAt" IS NULL;

-- At most one LIVE PERSONAL invite per guest email per event. FR-003 dedupe
-- means "a live invite exists for this email" -> reuse it. A re-invite after
-- a revoke inserts a fresh row (new id, new token), so the revoked row's link
-- and its th_ei_ cookies (keyed on inviteId) stay dead; the revoked row stays
-- as history. The CHECK above guarantees stored emails are lowercase, so
-- lower() here is belt-and-braces.
CREATE UNIQUE INDEX "EventInvite_personal_email_key"
  ON "EventInvite"("eventId", lower("inviteeEmail"))
  WHERE "kind" = 'PERSONAL' AND "revokedAt" IS NULL;

-- ── 6. Foreign keys ──────────────────────────────────────────────────────────
ALTER TABLE "EventInvite" ADD CONSTRAINT "EventInvite_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EventInvite" ADD CONSTRAINT "EventInvite_inviteListEntryId_fkey" FOREIGN KEY ("inviteListEntryId") REFERENCES "InviteListEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EventUnlock" ADD CONSTRAINT "EventUnlock_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "EventInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EventApplicationSubmission" ADD CONSTRAINT "EventApplicationSubmission_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "EventInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
