-- Self-serve account deletion fix: 8 non-financial "creator/actor reference"
-- FKs against Human were ON DELETE RESTRICT (6 explicit + 2 implicit via
-- required relations), which made any organizer who ever created an event
-- image/template/series/layout/embed/audio upload — or attested an event or
-- submitted a place-verification request — permanently undeletable (surfaced
-- to the user as CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY, i.e. "order
-- history", which was wrong).
--
-- These are creator attributions, not financial records: make the columns
-- nullable and switch the FKs to ON DELETE SET NULL so deleting the Human
-- detaches the reference ("deleted user") while the content survives.
--
-- The genuinely financial Restrict FKs (Order.buyer, Ticket.owner,
-- TicketScan.actor, TicketTransfer.from/to, PendingTicketTransfer.from,
-- Claim.claimant/respondent, ResaleListing.seller, ResaleListingHold.buyer)
-- are intentionally untouched and continue to block self-serve deletion.

-- Embed.createdBy
ALTER TABLE "Embed" DROP CONSTRAINT "Embed_createdBy_fkey";
ALTER TABLE "Embed" ALTER COLUMN "createdBy" DROP NOT NULL;
ALTER TABLE "Embed" ADD CONSTRAINT "Embed_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PlaceLayout.created_by_human_id
ALTER TABLE "place_layouts" DROP CONSTRAINT "place_layouts_created_by_human_id_fkey";
ALTER TABLE "place_layouts" ALTER COLUMN "created_by_human_id" DROP NOT NULL;
ALTER TABLE "place_layouts" ADD CONSTRAINT "place_layouts_created_by_human_id_fkey" FOREIGN KEY ("created_by_human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- EventTemplate.createdByHumanId
ALTER TABLE "EventTemplate" DROP CONSTRAINT "EventTemplate_createdByHumanId_fkey";
ALTER TABLE "EventTemplate" ALTER COLUMN "createdByHumanId" DROP NOT NULL;
ALTER TABLE "EventTemplate" ADD CONSTRAINT "EventTemplate_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- EventSeries.createdByHumanId
ALTER TABLE "EventSeries" DROP CONSTRAINT "EventSeries_createdByHumanId_fkey";
ALTER TABLE "EventSeries" ALTER COLUMN "createdByHumanId" DROP NOT NULL;
ALTER TABLE "EventSeries" ADD CONSTRAINT "EventSeries_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Image.createdByHumanId (table: event_images)
ALTER TABLE "event_images" DROP CONSTRAINT "event_images_createdByHumanId_fkey";
ALTER TABLE "event_images" ALTER COLUMN "createdByHumanId" DROP NOT NULL;
ALTER TABLE "event_images" ADD CONSTRAINT "event_images_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AudioUpload.createdByHumanId (table: audio_uploads)
ALTER TABLE "audio_uploads" DROP CONSTRAINT "audio_uploads_createdByHumanId_fkey";
ALTER TABLE "audio_uploads" ALTER COLUMN "createdByHumanId" DROP NOT NULL;
ALTER TABLE "audio_uploads" ADD CONSTRAINT "audio_uploads_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- EventAttestation.attestedByHumanId (implicit Restrict via required relation)
ALTER TABLE "EventAttestation" DROP CONSTRAINT "EventAttestation_attestedByHumanId_fkey";
ALTER TABLE "EventAttestation" ALTER COLUMN "attestedByHumanId" DROP NOT NULL;
ALTER TABLE "EventAttestation" ADD CONSTRAINT "EventAttestation_attestedByHumanId_fkey" FOREIGN KEY ("attestedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PlaceVerificationRequest.submittedById (implicit Restrict via required relation)
ALTER TABLE "PlaceVerificationRequest" DROP CONSTRAINT "PlaceVerificationRequest_submittedById_fkey";
ALTER TABLE "PlaceVerificationRequest" ALTER COLUMN "submittedById" DROP NOT NULL;
ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
