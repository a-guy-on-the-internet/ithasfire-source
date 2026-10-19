-- booking-conversation-and-event-step FR-006: draft-event anchor on Agreement.
-- createEventFromAgreement mints a DRAFT event before finalize is possible;
-- draftEventId makes the create idempotent without overloading eventId
-- (eventId-set still means "finalized" everywhere). SetNull on event deletion
-- lets a venue discard the draft and mint a fresh one.

-- AlterTable
ALTER TABLE "Agreement" ADD COLUMN "draftEventId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Agreement_draftEventId_key" ON "Agreement"("draftEventId");

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_draftEventId_fkey" FOREIGN KEY ("draftEventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
