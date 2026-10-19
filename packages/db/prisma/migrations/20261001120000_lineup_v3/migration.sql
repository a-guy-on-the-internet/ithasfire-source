-- ═══════════════════════════════════════════════════════════════════════════
-- LINEUP v3 — THE BILL CHANGES, GROUPS JOIN IT, AND A LINEUP ROW CAN BE A GROUP
-- (lineup-booking-requests v3, docs/specs/2026-09-25/lineup-booking-requests-
-- v3.spec.yaml: FR-001, FR-009, FR-015, decisions L5, L13, L17, L18)
--
-- 1. BookingRequestAct.removedAt — the sender can take an act off the bill
--    (L5). A SOFT delete: the row keeps its (request, ownerType, ownerId)
--    unique key, so an act that passed can never be re-added by inserting a
--    fresh row, and the bill_changed ledger entry can still name what left.
--    Every reader filters "removedAt" IS NULL.
-- 2. BookingRequestAct.customRoleLabel — each act carries what a lineup row
--    carries (L13): a role, and a label when the role is OTHER. Same bound
--    as the event-humans input (plainTextOptional(60)).
-- 3. TAGGED acts may be groups (L17): the shape CHECK stops forcing a TAGGED
--    row to be a human. Everything else in it stands.
-- 4. EventHuman.orgId (FR-015) — a lineup row can be an Organization, so a
--    joined group lands on the event linked instead of as free text.
--
-- Additive only: two nullable columns on BookingRequestAct, one on
-- EventHuman, and CHECKs every existing row satisfies (verified on
-- the dev DB 2026-09-30: 30 EventHuman rows, 28 human-only, 2 free-text,
-- 0 with neither; customRoleLabel is a new column, so its CHECK holds).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 + 2. BookingRequestAct columns ─────────────────────────────────────────

-- AlterTable
ALTER TABLE "BookingRequestAct" ADD COLUMN "removedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BookingRequestAct" ADD COLUMN "customRoleLabel" VARCHAR(60);

-- A label only means something beside OTHER (EventHuman's attach nulls it
-- for every other role; this makes the bill's copy of it honest in SQL).
ALTER TABLE "BookingRequestAct" ADD CONSTRAINT "BookingRequestAct_custom_role_label_check" CHECK (
  "customRoleLabel" IS NULL OR "role" = 'OTHER'
);

-- ── 3. TAGGED may be a human OR an organization ──────────────────────────────
--
-- Recreated rather than altered (Postgres has no ALTER CONSTRAINT for a
-- CHECK's expression). Identical to 20260925120000_booking_request_acts minus
-- the `"source" <> 'TAGGED' OR "actOwnerType" = 'human'` clause. The owner
-- type stays closed to the stored vocabulary 'human' | 'organization'.
ALTER TABLE "BookingRequestAct" DROP CONSTRAINT "BookingRequestAct_source_shape_check";

ALTER TABLE "BookingRequestAct" ADD CONSTRAINT "BookingRequestAct_source_shape_check" CHECK (
  (
    "source" IN ('SELF', 'TAGGED')
    AND "actOwnerType" IS NOT NULL
    AND "actOwnerId" IS NOT NULL
    AND "externalName" IS NULL
    AND "actOwnerType" IN ('human', 'organization')
  )
  OR (
    "source" = 'EXTERNAL'
    AND "externalName" IS NOT NULL
    AND "actOwnerType" IS NULL
    AND "actOwnerId" IS NULL
  )
);

-- "BookingRequestAct_pending_only_tagged_check" is unchanged.

-- ── 4. EventHuman.orgId ──────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "EventHuman" ADD COLUMN "orgId" TEXT;

-- CreateIndex
CREATE INDEX "EventHuman_orgId_idx" ON "EventHuman"("orgId");

-- CreateIndex
-- One link per group per event, beside the human one. NULLs are distinct, so
-- human and free-text rows never collide on it.
CREATE UNIQUE INDEX "EventHuman_eventId_orgId_key" ON "EventHuman"("eventId", "orgId");

-- AddForeignKey
ALTER TABLE "EventHuman" ADD CONSTRAINT "EventHuman_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The row's identity: a lineup row is a person OR a group, never both.
--
-- Deliberately NOT the spec's "exactly one of humanId / orgId / externalName":
--   · a LINKED row may keep externalName as its displayed stage name —
--     EventHumansRepo.linkHuman stamps humanId and leaves externalName in
--     place, attachEventHuman accepts both, and create-event-from-agreement's
--     pre-bill headliner writes { humanId, externalName: actName };
--   · a row with NONE of the three is refused by attachEventHuman
--     (HUMAN_ID_OR_EXTERNAL_NAME_REQUIRED) but is not forbidden here: the
--     venue track record reader deliberately tolerates such rows
--     (event-humans-acts-by-place.test.ts plants one), and whether prod holds
--     any is unverified — a CHECK that fails on deploy is worse than one arm
--     left to the app. Add that arm in its own migration once prod is counted.
ALTER TABLE "EventHuman" ADD CONSTRAINT "EventHuman_identity_check" CHECK (
  num_nonnulls("humanId", "orgId") <= 1
);
