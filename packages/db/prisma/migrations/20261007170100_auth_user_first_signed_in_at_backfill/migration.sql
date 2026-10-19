-- Backfill auth_user.first_signed_in_at (added by
-- 20261007170000_auth_user_first_signed_in_at, kept apart so this UPDATE
-- takes row locks only, never the column add's ACCESS EXCLUSIVE lock).
--
-- Each user gets the earliest of their auth_account, auth_session and passkey
-- rows, only where one exists. Users with none stay NULL: they have never
-- signed in, or (passwordless ex-guest, every session expired) have nothing
-- left to date them; the sign-in hook stamps them at their next sign-in.
-- A stamp the hook already wrote is only ever moved EARLIER (to the oldest
-- row), never later. In a normal deploy both files run back to back before
-- the new code ships, so no such stamp exists; it matters where the files
-- ran in separate runs (dev, 2026-10-07) or this backfill is re-run after a
-- failure, and then that stamp is the deploy moment, not the first sign-in.
--
-- RESET: the column migration's `SET lock_timeout = '5s'` is session-level
-- and outlives its transaction on migrate deploy's shared connection. This
-- UPDATE takes row locks only, so it waits normally.
--
-- Rollback: none needed (data only); dropping the column undoes it.

RESET lock_timeout;

UPDATE "auth_user" u
SET "first_signed_in_at" = LEAST(u."first_signed_in_at", f.first_at)
FROM (
  SELECT u2."id" AS user_id,
         LEAST(
           (SELECT MIN(a."created_at") FROM "auth_account" a WHERE a."user_id" = u2."id"),
           (SELECT MIN(s."created_at") FROM "auth_session" s WHERE s."user_id" = u2."id"),
           (SELECT MIN(k."created_at") FROM "passkey" k WHERE k."user_id" = u2."id")
         ) AS first_at
  FROM "auth_user" u2
) f
WHERE u."id" = f.user_id
  AND f.first_at IS NOT NULL
  AND (u."first_signed_in_at" IS NULL OR f.first_at < u."first_signed_in_at");
