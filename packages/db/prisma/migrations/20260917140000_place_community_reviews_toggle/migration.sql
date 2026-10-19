-- Place community-review consent (review-tier-separation FR-002).
--
-- One venue-level switch over the UNVERIFIED review tier — both of them:
--   · `PlaceReview` (performer testimony, anonymous name/email, no attendance
--     gate), and
--   · `AttendeeReview` rows tagged `source = 'COMMUNITY'` (venue-direct,
--     no scanned-ticket check).
--
-- It deliberately does NOT reach the VERIFIED_TICKET tier. A review backed by a
-- scanned ticket keeps its provenance regardless of this column, so turning the
-- switch off never silences someone who actually attended and was scanned.
--
-- ADDITIVE ONLY. DEFAULT true, NO backfill: every pre-existing venue keeps
-- exactly today's behaviour. The OFF-by-default case for a venue whose address
-- is withheld is applied at CREATE time in `upsertPlace` — a column default
-- cannot read the `location_mode` being written in the same INSERT.

ALTER TABLE "Place"
  ADD COLUMN "community_reviews_enabled" BOOLEAN NOT NULL DEFAULT true;
