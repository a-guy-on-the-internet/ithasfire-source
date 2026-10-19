-- Generic volunteering asks (PLACE | ORG | HUMAN | EVENT subjects) with
-- ask-scoped groups and roster broadcasts.
-- See docs/specs/2026-06-29/generic-volunteering-asks.spec.yaml.
--
-- Part 1: additive DDL — new enums + VolunteerAsk / VolunteerGroup /
--         VolunteerBroadcast tables, nullable askId/groupId columns on the
--         existing volunteer tables, eventId relaxed to nullable.
-- Part 2: idempotent backfill — one EVENT-subject ask per event with
--         volunteering enabled or with pre-existing volunteer data, then
--         stamp askId onto its roles and signups. eventId stays populated
--         everywhere so legacy reads keep working. Migrations run in a
--         single transaction on Postgres, and every statement below is
--         guarded so a re-run is a no-op.

-- CreateEnum
CREATE TYPE "VolunteerSubjectType" AS ENUM ('PLACE', 'ORG', 'HUMAN', 'EVENT');

-- CreateEnum
CREATE TYPE "VolunteerAskStatus" AS ENUM ('DRAFT', 'OPEN', 'PAUSED', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "VolunteerAskCadence" AS ENUM ('ONE_TIME', 'ONGOING', 'RECURRING');

-- AlterTable
ALTER TABLE "EventVolunteerRole" ADD COLUMN     "askId" TEXT,
ADD COLUMN     "defaultHours" DECIMAL(5,2),
ALTER COLUMN "eventId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Human" ADD COLUMN     "volunteerIcsFeedToken" TEXT;

-- AlterTable
ALTER TABLE "VolunteerSignup" ADD COLUMN     "askId" TEXT,
ADD COLUMN     "groupId" TEXT,
ALTER COLUMN "eventId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "VolunteerAsk" (
    "id" TEXT NOT NULL,
    "subjectType" "VolunteerSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "orgId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "VolunteerAskStatus" NOT NULL DEFAULT 'DRAFT',
    "cadence" "VolunteerAskCadence" NOT NULL DEFAULT 'ONE_TIME',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "capacity" INTEGER,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "waiverRequired" BOOLEAN NOT NULL DEFAULT false,
    "smsOptInEnabled" BOOLEAN NOT NULL DEFAULT false,
    "formSchema" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerAsk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerGroup" (
    "id" TEXT NOT NULL,
    "askId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "capacity" INTEGER,
    "coordinatorHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerBroadcast" (
    "id" TEXT NOT NULL,
    "askId" TEXT NOT NULL,
    "senderHumanId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VolunteerBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VolunteerAsk_subjectType_subjectId_idx" ON "VolunteerAsk"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "VolunteerAsk_orgId_status_idx" ON "VolunteerAsk"("orgId", "status");

-- CreateIndex
CREATE INDEX "VolunteerGroup_askId_idx" ON "VolunteerGroup"("askId");

-- CreateIndex
CREATE INDEX "VolunteerGroup_coordinatorHumanId_idx" ON "VolunteerGroup"("coordinatorHumanId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerGroup_askId_name_key" ON "VolunteerGroup"("askId", "name");

-- CreateIndex
CREATE INDEX "VolunteerBroadcast_askId_createdAt_idx" ON "VolunteerBroadcast"("askId", "createdAt");

-- CreateIndex
CREATE INDEX "VolunteerBroadcast_senderHumanId_idx" ON "VolunteerBroadcast"("senderHumanId");

-- CreateIndex
CREATE INDEX "EventVolunteerRole_askId_idx" ON "EventVolunteerRole"("askId");

-- CreateIndex
CREATE UNIQUE INDEX "EventVolunteerRole_askId_name_key" ON "EventVolunteerRole"("askId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Human_volunteerIcsFeedToken_key" ON "Human"("volunteerIcsFeedToken");

-- CreateIndex
CREATE INDEX "VolunteerSignup_askId_status_idx" ON "VolunteerSignup"("askId", "status");

-- CreateIndex
CREATE INDEX "VolunteerSignup_groupId_idx" ON "VolunteerSignup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerSignup_askId_roleId_contactEmail_key" ON "VolunteerSignup"("askId", "roleId", "contactEmail");

-- CreateIndex (raw SQL — Prisma's schema language can't express partial
-- indexes, following the 20260512_search_documents precedent of hand-written
-- SQL for constructs beyond Prisma's expressiveness). Enforces "at most one
-- EVENT-subject ask per event" at the DB level. This index is intentionally
-- absent from the Prisma schema and will show up as expected drift.
CREATE UNIQUE INDEX "VolunteerAsk_event_subject_key" ON "VolunteerAsk"("subjectId") WHERE "subjectType" = 'EVENT';

-- AddForeignKey
ALTER TABLE "VolunteerGroup" ADD CONSTRAINT "VolunteerGroup_askId_fkey" FOREIGN KEY ("askId") REFERENCES "VolunteerAsk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerGroup" ADD CONSTRAINT "VolunteerGroup_coordinatorHumanId_fkey" FOREIGN KEY ("coordinatorHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerBroadcast" ADD CONSTRAINT "VolunteerBroadcast_askId_fkey" FOREIGN KEY ("askId") REFERENCES "VolunteerAsk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerBroadcast" ADD CONSTRAINT "VolunteerBroadcast_senderHumanId_fkey" FOREIGN KEY ("senderHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventVolunteerRole" ADD CONSTRAINT "EventVolunteerRole_askId_fkey" FOREIGN KEY ("askId") REFERENCES "VolunteerAsk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_askId_fkey" FOREIGN KEY ("askId") REFERENCES "VolunteerAsk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VolunteerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill (idempotent — every statement is a no-op on re-run)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) One EVENT-subject ask per event that has volunteering enabled OR has
--    pre-existing volunteer data (roles/signups from a since-disabled
--    toggle — those rows must still get an ask so askId never stays NULL).
--    Ask status mirrors the toggle: enabled → OPEN, disabled → CLOSED.
--    Carries over the event-level volunteer knobs. `smsOptInEnabled` is set
--    TRUE because the existing event signup form offers the SMS opt-in
--    checkbox unconditionally today — this preserves current behavior when
--    reads move to the ask. `volunteerIntroText` maps onto the ask
--    description. gen_random_uuid() follows the 20260408000000_place_review_v3
--    precedent.
INSERT INTO "VolunteerAsk" (
  "id", "subjectType", "subjectId", "orgId", "title", "description",
  "status", "cadence", "autoApprove", "waiverRequired", "smsOptInEnabled",
  "formSchema", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  'EVENT'::"VolunteerSubjectType",
  e."id",
  e."orgId",
  e."title",
  e."volunteerIntroText",
  CASE WHEN e."volunteeringEnabled" THEN 'OPEN' ELSE 'CLOSED' END::"VolunteerAskStatus",
  'ONE_TIME'::"VolunteerAskCadence",
  e."volunteerAutoApprove",
  e."volunteerWaiverRequired",
  true,
  '{}'::jsonb,
  now(),
  now()
FROM "Event" e
WHERE (
    e."volunteeringEnabled" = true
    OR EXISTS (
      SELECT 1 FROM "EventVolunteerRole" r WHERE r."eventId" = e."id"
    )
    OR EXISTS (
      SELECT 1 FROM "VolunteerSignup" s WHERE s."eventId" = e."id"
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "VolunteerAsk" a
    WHERE a."subjectType" = 'EVENT'
      AND a."subjectId" = e."id"
  );

-- 2) Stamp askId onto the event's roles.
UPDATE "EventVolunteerRole" r
SET "askId" = a."id"
FROM "VolunteerAsk" a
WHERE a."subjectType" = 'EVENT'
  AND a."subjectId" = r."eventId"
  AND r."askId" IS NULL;

-- 3) Stamp askId onto the event's signups. eventId is intentionally LEFT
--    populated — legacy event-scoped reads keep working unchanged.
UPDATE "VolunteerSignup" s
SET "askId" = a."id"
FROM "VolunteerAsk" a
WHERE a."subjectType" = 'EVENT'
  AND a."subjectId" = s."eventId"
  AND s."askId" IS NULL;
