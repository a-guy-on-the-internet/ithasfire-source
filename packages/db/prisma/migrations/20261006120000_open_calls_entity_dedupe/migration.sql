-- Open calls v1, owner ruling Q42 (2026-10-06): "one open application per
-- applicant ENTITY per call". A person may apply as themselves AND as each
-- organisation they belong to; an organisation holds one open application
-- per call, whoever submits it.
--
--   self rows:  ("formId", "humanId")         WHERE "applyingAsOrgId" IS NULL
--   org rows:   ("formId", "applyingAsOrgId") WHERE "applyingAsOrgId" IS NOT NULL
--   guest rows: ("formId", lower("contactEmail")) — unchanged
--
-- Attendee (ATTEND) rows never set "applyingAsOrgId", so the attendee gate's
-- dedupe is unchanged by the narrower human index.
--
-- 20261005120000_open_calls is already applied and must not change, so this
-- is its own migration.

-- Fail loudly (never delete) if existing rows would violate the new org
-- index. The narrowed human index only admits FEWER rows to its predicate,
-- so it cannot be violated by data the old one accepted.
DO $$
DECLARE
  dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT "formId", "applyingAsOrgId"
    FROM "EventApplicationSubmission"
    WHERE "applyingAsOrgId" IS NOT NULL
      AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED')
    GROUP BY "formId", "applyingAsOrgId"
    HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'open_calls_entity_dedupe: % (formId, applyingAsOrgId) pair(s) hold more than one open application; resolve them by hand before applying',
      dupes;
  END IF;
END $$;

DROP INDEX IF EXISTS "EventApplicationSubmission_open_human_key";

-- Signed-in rows applying AS THEMSELVES.
CREATE UNIQUE INDEX "EventApplicationSubmission_open_human_key"
  ON "EventApplicationSubmission" ("formId", "humanId")
  WHERE "humanId" IS NOT NULL
    AND "applyingAsOrgId" IS NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');

-- Rows applying FOR AN ORGANISATION (Q33 / Q42).
CREATE UNIQUE INDEX "EventApplicationSubmission_open_org_key"
  ON "EventApplicationSubmission" ("formId", "applyingAsOrgId")
  WHERE "applyingAsOrgId" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');
