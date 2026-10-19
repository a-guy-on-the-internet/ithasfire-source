-- Ordering guard for Payee capability writes.
--
-- `account.updated` webhooks are not ordered by Stripe and retries can arrive
-- late, so an older delivery could overwrite a newer one and leave a payee
-- permanently stuck at payoutsEnabled = false (blocking paid-event publish).
-- `syncCapabilities` now only applies a write whose observedAt is >= this
-- column.
--
-- Backfill: intentionally left NULL. NULL means "never synced", which makes the
-- next observation from ANY source (webhook or the live-read write-back) apply
-- unconditionally. That is exactly what we want for existing rows — including
-- the rows that are currently stale — so they self-heal on first contact
-- instead of being pinned by a synthetic timestamp.
ALTER TABLE "Payee" ADD COLUMN "capabilitiesSyncedAt" TIMESTAMP(3);

-- Index for the nightly reconcile sweep.
--
-- This is a DEFAULT btree, i.e. ASC NULLS LAST. It deliberately does NOT try to
-- serve `ORDER BY capabilitiesSyncedAt ASC NULLS FIRST` — no scan direction of
-- a default btree produces that ordering (forward = ASC NULLS LAST, backward =
-- DESC NULLS FIRST), so such a query would plan a Seq Scan + Sort regardless.
-- `listForCapabilityReconcile` is therefore split into two queries this index
-- does serve: an `IS NULL` lookup, then `ORDER BY ... ASC` over the non-null
-- rows (a forward scan that stops early). Keep them in that shape.
CREATE INDEX "Payee_capabilitiesSyncedAt_idx" ON "Payee"("capabilitiesSyncedAt");
