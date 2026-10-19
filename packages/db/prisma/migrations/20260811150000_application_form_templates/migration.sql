-- Application-driven events, Phase 4 (docs/specs/2026-08-10/
-- application-driven-events.spec.md, decision D4): reusable application-form
-- templates.
--
-- Purely additive — one new table, no enums, nothing existing changes shape,
-- so this is safe to apply ahead of the application code that reads it.
--
-- Design notes that are not obvious from the DDL:
--
--  * `questions` is a SNAPSHOT (jsonb-style Json column), not a set of FK
--    references. Applying a template FORKS its entries into real
--    `EventApplicationQuestion` rows — the same fork-on-use contract as
--    `TicketTypeTemplate` (20260804140000_ticket_type_packs). There is
--    therefore deliberately NO foreign key from a form or question back to a
--    template: editing a template must never mutate a form that already
--    shipped, and deleting one must never cascade into live event data.
--
--  * Two kinds of row share the table, exactly like `TicketTypeTemplate`:
--    OWNED (`ownerId` set, `isPlatform` false) and PLATFORM (`ownerId` NULL,
--    `isPlatform` true — the seeded starter catalogue). `ownerScope` is NOT
--    NULL because it is NOT NULL on every other template table; on a platform
--    row it is ORGANIZATION by convention and ignored.
--
--  * `createdByHumanId` is ON DELETE SET NULL, not CASCADE: an org's template
--    library must survive the departure of the person who wrote it.
--
--  * No unique index on (ownerScope, ownerId, name). Unlike ticket-type
--    templates — whose names are the apply-time skip key — an application
--    template's name is a label only; nothing keys on it, and two similarly
--    named forks of the same catalogue entry are a legitimate organizer
--    state. Name collisions are surfaced by the create/update use cases as
--    TEMPLATE_NAME_TAKEN (a courtesy pre-check), not enforced here.
--
-- Reversible by dropping the table.

-- CreateTable
CREATE TABLE "ApplicationFormTemplate" (
    "id" TEXT NOT NULL,
    "ownerScope" "TemplateOwnerScope" NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "introText" TEXT,
    "questions" JSONB NOT NULL,
    "isPlatform" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationFormTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The list read: an owner's non-archived library, and (ownerId IS NULL) the
-- platform catalogue.
CREATE INDEX "ApplicationFormTemplate_ownerScope_ownerId_archivedAt_idx" ON "ApplicationFormTemplate"("ownerScope", "ownerId", "archivedAt");

-- CreateIndex
CREATE INDEX "ApplicationFormTemplate_createdByHumanId_idx" ON "ApplicationFormTemplate"("createdByHumanId");

-- CreateIndex
-- The catalogue read is `isPlatform = true` on its own (never inferred from a
-- NULL ownerId), so it gets its own index — same shape as
-- TicketTypeTemplate_isPlatform_idx.
CREATE INDEX "ApplicationFormTemplate_isPlatform_idx" ON "ApplicationFormTemplate"("isPlatform");

-- AddForeignKey
ALTER TABLE "ApplicationFormTemplate" ADD CONSTRAINT "ApplicationFormTemplate_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
