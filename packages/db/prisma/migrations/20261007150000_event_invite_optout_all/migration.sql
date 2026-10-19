-- Gated-event invite links, W2 (owner ruling 3(b), 2026-10-06):
-- "Stop all event invites", a second choice on the stop page that needs no
-- account. A row in EventInviteOptOut with NO owner (orgId and humanOwnerId
-- both NULL) is an opt-out from EVERY organiser for that address hash.
-- Invites already sent keep working; only sending new ones is blocked.
--
-- Same table, not a new one: the send-time check "is this address opted out
-- from this organiser" stays ONE query,
--   emailHash IN (…) AND ("orgId" = $1 OR ("orgId" IS NULL AND "humanOwnerId" IS NULL))
-- whose two arms each have a partial unique index below (BitmapOr).
--
-- Rollback (by hand; this DISCARDS every "Stop all event invites"):
--   DELETE FROM "EventInviteOptOut" WHERE "orgId" IS NULL AND "humanOwnerId" IS NULL;
--   DROP INDEX "EventInviteOptOut_all_email_key";
--   ALTER TABLE "EventInviteOptOut" DROP CONSTRAINT "EventInviteOptOut_at_most_one_owner_check";
--   ALTER TABLE "EventInviteOptOut" ADD CONSTRAINT "EventInviteOptOut_one_owner_check" CHECK (
--     ("orgId" IS NOT NULL AND "humanOwnerId" IS NULL)
--     OR ("orgId" IS NULL AND "humanOwnerId" IS NOT NULL));
-- Run the DELETE first: re-adding one_owner_check fails while any ownerless
-- (stop-all) row exists.

-- ── 1. At most one owner (none = all organisers) ────────────────────────────
ALTER TABLE "EventInviteOptOut" DROP CONSTRAINT "EventInviteOptOut_one_owner_check";

ALTER TABLE "EventInviteOptOut" ADD CONSTRAINT "EventInviteOptOut_at_most_one_owner_check" CHECK (
  "orgId" IS NULL OR "humanOwnerId" IS NULL
);

-- ── 2. One all-organisers row per address ───────────────────────────────────
-- NULLs are distinct in a plain unique index, so the per-owner uniques never
-- catch a repeat ownerless row; this partial unique does. Stopping all twice
-- is a no-op (INSERT … ON CONFLICT DO NOTHING in the adapter).
CREATE UNIQUE INDEX "EventInviteOptOut_all_email_key"
  ON "EventInviteOptOut"("emailHash")
  WHERE "orgId" IS NULL AND "humanOwnerId" IS NULL;
