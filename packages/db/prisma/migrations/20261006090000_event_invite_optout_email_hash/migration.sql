-- Gated-event invite links, fix round 1 (security review W3, 2026-10-06):
-- "Stop invites from this organiser" stores a KEYED HASH of the canonical
-- address instead of the address itself (core `hashInviteOptOutEmail`,
-- HMAC-SHA256, 43 base64url chars). The opt-out link carries the same hash,
-- so no address reaches request logs or this table.
--
-- The previous migration (20261005200000) is already applied on dev and the
-- table holds no rows anywhere (the feature is unreleased), so the column is
-- replaced outright. On a non-empty table the NOT NULL add below fails
-- loudly rather than silently dropping opt-outs.

-- ── 1. Drop the plaintext column and everything keyed on it ─────────────────
DROP INDEX "EventInviteOptOut_org_email_key";
DROP INDEX "EventInviteOptOut_human_email_key";
ALTER TABLE "EventInviteOptOut" DROP CONSTRAINT "EventInviteOptOut_email_lower_check";
ALTER TABLE "EventInviteOptOut" DROP COLUMN "emailLower";

-- ── 2. The hash ─────────────────────────────────────────────────────────────
ALTER TABLE "EventInviteOptOut" ADD COLUMN "emailHash" TEXT NOT NULL;

ALTER TABLE "EventInviteOptOut" ADD CONSTRAINT "EventInviteOptOut_email_hash_check" CHECK (
  "emailHash" ~ '^[A-Za-z0-9_-]{43}$'
);

-- One row per (owner, address), per owner kind. Opting out twice is a no-op
-- (INSERT … ON CONFLICT DO NOTHING in the adapter). The org one also serves
-- the send-time lookup by (orgId, emailHash).
CREATE UNIQUE INDEX "EventInviteOptOut_org_email_key"
  ON "EventInviteOptOut"("orgId", "emailHash")
  WHERE "orgId" IS NOT NULL;

CREATE UNIQUE INDEX "EventInviteOptOut_human_email_key"
  ON "EventInviteOptOut"("humanOwnerId", "emailHash")
  WHERE "humanOwnerId" IS NOT NULL;
