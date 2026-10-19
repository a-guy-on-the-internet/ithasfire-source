-- Per-date RSVP confirmations on recurring community listings: an RsvpNotice
-- may now reference the specific EventDate the user RSVP'd to. NULL keeps the
-- existing event-level semantics unchanged; a set eventDateId makes the drain
-- resolve the DATE's startsAt/endsAt and skip if the date vanished / was
-- called off / was un-RSVP'd. Fully additive: one nullable column + index +
-- cascading FK (an outbox row must not outlive its date).

-- AlterTable
ALTER TABLE "RsvpNotice" ADD COLUMN "eventDateId" TEXT;

-- CreateIndex
CREATE INDEX "RsvpNotice_eventDateId_idx" ON "RsvpNotice"("eventDateId");

-- AddForeignKey
ALTER TABLE "RsvpNotice" ADD CONSTRAINT "RsvpNotice_eventDateId_fkey" FOREIGN KEY ("eventDateId") REFERENCES "EventDate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
