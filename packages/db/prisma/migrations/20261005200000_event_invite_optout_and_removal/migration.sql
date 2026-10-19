-- Gated-event invite links, owner rulings 2026-10-05 (evening):
--
-- 1. "Stop invites from this organiser": EventInviteOptOut records an email
--    that asked ONE organiser (an org, or the human owning person-owned
--    events) for no more event invites. Every invite send filters against
--    it. Exactly one owner column is set.
-- 2. "Reset and remove everyone" on the SHARED link: EventInvite gains
--    grantsRevokedAt. Once set on a SHARED row, the grants that link handed
--    out (th_ei_ cookies, unlocks, approvals) stop holding. A plain reset
--    leaves it null, so its holders stay in (R5 stays the default).

-- ── 1. EventInvite.grantsRevokedAt ───────────────────────────────────────────
ALTER TABLE "EventInvite" ADD COLUMN "grantsRevokedAt" TIMESTAMP(3);

-- ── 2. EventInviteOptOut ─────────────────────────────────────────────────────
CREATE TABLE "EventInviteOptOut" (
    "id" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "orgId" TEXT,
    "humanOwnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventInviteOptOut_pkey" PRIMARY KEY ("id")
);

-- Exactly one owner: an org-owned event's organiser is the org; a
-- person-owned event's organiser is that human.
ALTER TABLE "EventInviteOptOut" ADD CONSTRAINT "EventInviteOptOut_one_owner_check" CHECK (
  ("orgId" IS NOT NULL AND "humanOwnerId" IS NULL)
  OR ("orgId" IS NULL AND "humanOwnerId" IS NOT NULL)
);

-- Stored lowercase, so plain equality against a lowercased input is exact.
ALTER TABLE "EventInviteOptOut" ADD CONSTRAINT "EventInviteOptOut_email_lower_check" CHECK (
  "emailLower" = lower("emailLower")
);

CREATE INDEX "EventInviteOptOut_humanOwnerId_idx" ON "EventInviteOptOut"("humanOwnerId");

-- SQL-only partial uniques (noted on the model in event.prisma): one row per
-- (owner, email), per owner kind. Opting out twice is a no-op
-- (INSERT … ON CONFLICT DO NOTHING in the adapter). The org one also serves
-- the send-time lookup by (orgId, emailLower).
CREATE UNIQUE INDEX "EventInviteOptOut_org_email_key"
  ON "EventInviteOptOut"("orgId", "emailLower")
  WHERE "orgId" IS NOT NULL;

CREATE UNIQUE INDEX "EventInviteOptOut_human_email_key"
  ON "EventInviteOptOut"("humanOwnerId", "emailLower")
  WHERE "humanOwnerId" IS NOT NULL;

ALTER TABLE "EventInviteOptOut" ADD CONSTRAINT "EventInviteOptOut_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventInviteOptOut" ADD CONSTRAINT "EventInviteOptOut_humanOwnerId_fkey" FOREIGN KEY ("humanOwnerId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
