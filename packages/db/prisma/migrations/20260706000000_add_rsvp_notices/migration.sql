-- RSVP-confirmation notification outbox (mirrors the EventChangeNotice outbox
-- from 20260704000000_add_event_change_notices, simplified to a SINGLE
-- recipient per row). rsvp-to-event enqueues one row per NEWLY-created RSVP
-- (best-effort sequential write — the RSVP upsert deliberately runs outside
-- any transaction, see the event-rsvps adapter docstring). A scheduled
-- jobs-service task drains undispatched rows (dispatchedAt IS NULL, oldest
-- first) and sends one in-app + email confirmation per row. No payload
-- column: event details are resolved at dispatch time. Fully additive: one
-- new table, cascading from Event and Human on hard-delete.

-- CreateTable
CREATE TABLE "RsvpNotice" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RsvpNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RsvpNotice_dispatchedAt_createdAt_idx" ON "RsvpNotice"("dispatchedAt", "createdAt");

-- CreateIndex
CREATE INDEX "RsvpNotice_eventId_idx" ON "RsvpNotice"("eventId");

-- CreateIndex
CREATE INDEX "RsvpNotice_humanId_idx" ON "RsvpNotice"("humanId");

-- AddForeignKey
ALTER TABLE "RsvpNotice" ADD CONSTRAINT "RsvpNotice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpNotice" ADD CONSTRAINT "RsvpNotice_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
