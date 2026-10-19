-- Host attestation audit trail captured at event publish.

ALTER TABLE "Event"
  ADD COLUMN "current_attestation_id" TEXT;

CREATE TABLE "EventAttestation" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "attestedByHumanId" TEXT NOT NULL,
  "attestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" TEXT,
  "userAgent" VARCHAR(1024),
  "policyVersion" TEXT NOT NULL,
  "policyTextSnapshot" JSONB NOT NULL,
  "legalRightToHost" BOOLEAN NOT NULL,
  "zoningAndNoiseCompliance" BOOLEAN NOT NULL,
  "alcoholCompliance" BOOLEAN NOT NULL,
  "taxResponsibility" BOOLEAN NOT NULL,
  "organizerFaqReviewed" BOOLEAN NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EventAttestation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Event_current_attestation_id_key"
  ON "Event"("current_attestation_id");

CREATE INDEX "EventAttestation_eventId_attestedAt_idx"
  ON "EventAttestation"("eventId", "attestedAt");

CREATE INDEX "EventAttestation_attestedByHumanId_attestedAt_idx"
  ON "EventAttestation"("attestedByHumanId", "attestedAt");

ALTER TABLE "EventAttestation"
  ADD CONSTRAINT "EventAttestation_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EventAttestation"
  ADD CONSTRAINT "EventAttestation_attestedByHumanId_fkey"
  FOREIGN KEY ("attestedByHumanId") REFERENCES "Human"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Event"
  ADD CONSTRAINT "Event_current_attestation_id_fkey"
  FOREIGN KEY ("current_attestation_id") REFERENCES "EventAttestation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;