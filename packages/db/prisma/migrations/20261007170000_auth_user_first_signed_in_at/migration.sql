-- auth_user.first_signed_in_at (owner ruling 2026-10-07, "Store first sign-in"):
--   "A new account is new the moment it gets created", i.e. when the person
--   first signs in, not when a guest checkout made a shadow auth_user row.
--
-- Before this, the account date was derived from the oldest surviving
-- auth_account / auth_session / passkey row. A passwordless ex-guest (email
-- code or magic link only, so no auth_account row) was dated by their oldest
-- session; sign-out or expiry deleted it and a years-old account read as new.
-- The column is set once by the session.create.after hook and never cleared,
-- with one exception: the unproven-account sweep (sweepUnprovenAccountInDb)
-- clears it with the squatter's sessions, so the inbox prover's sign-in
-- becomes the account's first.
--
-- Column only. The backfill is the next migration
-- (20261007170100_auth_user_first_signed_in_at_backfill): Prisma runs each
-- file as one transaction, and the ADD COLUMN's ACCESS EXCLUSIVE lock on
-- auth_user must not be held through a full-table UPDATE (every auth read
-- would queue behind it). A nullable column with no default is a catalog-only
-- change; lock_timeout makes it fail fast instead of queueing behind a long
-- transaction.
--
-- Expected after deploy, not a bug: a passwordless ex-guest whose sessions
-- had ALL expired or been deleted before the deploy has no row to backfill
-- from. They stay NULL and get stamped at their next sign-in, so they read as
-- a new account for one more week. Self-limiting: it happens at most once.
--
-- Rollback (by hand; deploy code that no longer reads or writes the column
-- FIRST, or the sign-in stamp and the invite allowance read both fail):
--   ALTER TABLE auth_user DROP COLUMN first_signed_in_at;

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "auth_user" ADD COLUMN "first_signed_in_at" TIMESTAMP(3);
