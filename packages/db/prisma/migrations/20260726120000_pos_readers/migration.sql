-- POS reader registry.
--
-- Stripe Terminal readers register on the PLATFORM Stripe account (SCT: the
-- card-present PaymentIntent is created on the platform, so the Reader and its
-- Location must live there too). Stripe therefore has no concept of which org
-- owns a reader — this table is the only source of truth for that, and every
-- reader-driving procedure checks "org_id" against the event's org before
-- dispatching a charge.

-- CreateTable
CREATE TABLE "pos_readers" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "stripe_reader_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "place_id" TEXT,
    "device_type" TEXT,
    "paired_by_human_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_readers_pkey" PRIMARY KEY ("id")
);

-- One piece of hardware belongs to exactly one org at a time. Unpairing
-- deletes the row, freeing the reader to be paired again.
CREATE UNIQUE INDEX "pos_readers_stripe_reader_id_key" ON "pos_readers"("stripe_reader_id");

-- Reader list for an org's POS settings screen and the Sell-screen picker.
CREATE INDEX "pos_readers_org_id_idx" ON "pos_readers"("org_id");

-- FK maintenance on venue deletion (SetNull scans by place_id).
CREATE INDEX "pos_readers_place_id_idx" ON "pos_readers"("place_id");

-- FK maintenance / "who paired this" lookups.
CREATE INDEX "pos_readers_paired_by_human_id_idx" ON "pos_readers"("paired_by_human_id");

-- Deleting an org takes its readers with it; the Stripe-side registration is
-- cleaned up by the unpair use case, not by this cascade.
ALTER TABLE "pos_readers" ADD CONSTRAINT "pos_readers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Venue pin is advisory; detach it rather than blocking a venue delete.
ALTER TABLE "pos_readers" ADD CONSTRAINT "pos_readers_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Restrict: an operator who paired a live reader can't be hard-deleted out
-- from under it. Unpair first.
ALTER TABLE "pos_readers" ADD CONSTRAINT "pos_readers_paired_by_human_id_fkey" FOREIGN KEY ("paired_by_human_id") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
