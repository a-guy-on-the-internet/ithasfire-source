ALTER TABLE "Organization"
  ADD COLUMN "chargebackTermsVersion" TEXT,
  ADD COLUMN "chargebackTermsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "chargebackTermsAcceptedByHumanId" TEXT;

ALTER TABLE "Human"
  ADD COLUMN "chargebackTermsVersion" TEXT,
  ADD COLUMN "chargebackTermsAcceptedAt" TIMESTAMP(3);

CREATE INDEX "Organization_chargebackTermsAcceptedByHumanId_idx"
  ON "Organization"("chargebackTermsAcceptedByHumanId");

ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_chargebackTermsAcceptedByHumanId_fkey"
  FOREIGN KEY ("chargebackTermsAcceptedByHumanId") REFERENCES "Human"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;