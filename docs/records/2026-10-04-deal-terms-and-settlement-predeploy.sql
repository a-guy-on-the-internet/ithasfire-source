-- Pre-deploy guard for migration 20261003150000_deal_terms_and_settlement_sheet
-- (deal-terms-and-settlement P4b). Run against the TARGET database BEFORE the
-- deploy that applies the migration. See docs/records/2026-10-04-deal-terms-and-settlement-deploy.md.
--
-- The migration adds "PayoutTermsLine_deal_clause_shape_check", which requires
-- every PERCENT line's percent to be within 0..100. Every line editor has
-- enforced that since lines existed, but a row outside it would make the
-- migration fail mid-deploy with a bare CHECK violation. This turns that into
-- a clear refusal, with the count and the rows to fix, before anything runs.
--
-- Read-only: it raises or it notices; it changes nothing.

DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad
  FROM "PayoutTermsLine"
  WHERE "percent" IS NULL OR "percent" < 0 OR "percent" > 100;

  IF bad > 0 THEN
    RAISE EXCEPTION 'PayoutTermsLine.percent out of range on % rows; fix before deploying (see docs/records/2026-10-04-deal-terms-and-settlement-deploy.md)', bad;
  END IF;

  RAISE NOTICE 'PayoutTermsLine.percent: all rows within 0..100 — the deal-terms migration can apply.';
END
$$;

-- When it raises, list the rows:
--   SELECT id, "payoutTermsId", "payeeId", "percent"
--   FROM "PayoutTermsLine"
--   WHERE "percent" IS NULL OR "percent" < 0 OR "percent" > 100;
