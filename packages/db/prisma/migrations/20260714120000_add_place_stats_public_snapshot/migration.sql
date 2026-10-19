-- Public anonymized snapshot columns (place-review-anonymization FR-002).
-- Public surfaces serve PlaceStats."publicSnapshot" verbatim; it is written
-- only by the weekly places.recompute-public-snapshots job, so a fresh review
-- is publicly invisible for up to 7 days and indistinguishable within the
-- weekly batch thereafter. Additive, no backfill: NULL means "no snapshot
-- published yet" and public reads return null until the job first runs.

ALTER TABLE "PlaceStats"
  ADD COLUMN "publicSnapshot" JSONB,
  ADD COLUMN "publicSnapshotAt" TIMESTAMP(3);
