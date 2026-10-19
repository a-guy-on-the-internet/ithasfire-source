-- Ban that sticks, review round 1 (2026-09-29).

-- 1. The database no longer holds raw client IPs on sessions. Better Auth's
--    session.create.before hook now writes ip_address = NULL (the rate
--    limiter reads the IP from the request, not from this column), and this
--    clears the values already stored. The column stays (Better Auth's
--    session model declares it) but is always NULL from here on.
UPDATE "auth_session" SET "ip_address" = NULL WHERE "ip_address" IS NOT NULL;

-- 2. Public list reads resolve the set of BANNED humans once per call
--    (packages/adapters/src/db/prisma/banned-owner.ts). A partial index keeps
--    that lookup proportional to the number of bans, not the number of humans.
--    Raw SQL only: Prisma's datamodel cannot express a partial index, so it is
--    owned here (like the search_doc raw indexes) and `migrate diff` will list
--    it as a standing divergence.
CREATE INDEX "Human_banned_id_idx" ON "Human" ("id") WHERE "status" = 'BANNED';
