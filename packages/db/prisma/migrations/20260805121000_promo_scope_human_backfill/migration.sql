-- Backfill: convert dead human-owned "ORG"-scoped promos to scope HUMAN.
--
-- Why: the admin promos UI passes ownerType "HUMAN" in personal-admin
-- context, and create-promo used to store those as scope='ORG' with
-- scopeId=<humanId>. Such rows listed fine (list-promos queried
-- ORG + ownerId) but NEVER applied at checkout — the ORG eligibility case
-- compares scopeId to event.orgId, which is never a Human id. They were
-- dead codes. Now that scope-ownership requires ownerType ORGANIZATION for
-- ORG scope and HUMAN owners get scope='HUMAN', re-home the existing rows
-- so they list under (and apply for) their human owner.
--
-- Guard: only rows whose scopeId is an existing Human AND NOT an existing
-- Organization id are converted — a scopeId that matches a real org is a
-- legitimate org promo and must not be touched.
UPDATE "Coupon" c
SET "scope" = 'HUMAN'
WHERE c."scope" = 'ORG'
  AND EXISTS (SELECT 1 FROM "Human" h WHERE h."id" = c."scopeId")
  AND NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o."id" = c."scopeId");
