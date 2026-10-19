-- Ticket-type templates: a named, owner-scoped bundle of ticket-type
-- configurations an organizer can apply to an event later. Entries live in
-- the "ticketTypes" JSONB column (no per-entry table) — they are copied onto
-- real "TicketType" rows at apply time, deliberately excluding event-specific
-- fields (seatSectionId, doorPriceCents). Reuses the existing
-- "TemplateOwnerScope" enum introduced with "EventTemplate".

-- CreateTable
CREATE TABLE "TicketTypeTemplate" (
    "id" TEXT NOT NULL,
    "ownerScope" "TemplateOwnerScope" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ticketTypes" JSONB NOT NULL,
    "createdByHumanId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketTypeTemplate_pkey" PRIMARY KEY ("id")
);

-- Owner listings exclude archived rows.
CREATE INDEX "TicketTypeTemplate_ownerScope_ownerId_archivedAt_idx" ON "TicketTypeTemplate"("ownerScope", "ownerId", "archivedAt");

-- Name-collision lookups at create time (case-insensitive equals scan).
CREATE INDEX "TicketTypeTemplate_ownerScope_ownerId_name_idx" ON "TicketTypeTemplate"("ownerScope", "ownerId", "name");

-- FK maintenance on account deletion (SetNull scans by createdByHumanId).
CREATE INDEX "TicketTypeTemplate_createdByHumanId_idx" ON "TicketTypeTemplate"("createdByHumanId");

-- Creator reference is detached (SetNull) on account deletion.
ALTER TABLE "TicketTypeTemplate" ADD CONSTRAINT "TicketTypeTemplate_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
