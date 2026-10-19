-- Floor-0 pay-what-you-want never reads "Free" on a listing (owner ruling
-- 2026-10-06, F2). The search document records it apart from has_free_tier,
-- which now means genuinely free tiers only. Constant default: metadata-only,
-- no table rewrite.
--
-- Existing rows read false until they are re-indexed, and until then a
-- floor-0 PWYW event still has has_free_tier = true and reads "Free" on
-- index-backed surfaces. Run `search.full-reindex` after this migration
-- (docs/decisions/listing-pay-what-you-want-never-free.md).
ALTER TABLE "SearchDocument" ADD COLUMN "has_pay_what_you_want_tier" BOOLEAN NOT NULL DEFAULT false;
