CREATE TYPE "PayeeLedgerEntryType" AS ENUM (
  'SETTLEMENT_CREDIT',
  'REFUND_DEBIT',
  'DISPUTE_HOLD',
  'DISPUTE_DEBIT',
  'DISPUTE_RELEASE',
  'PAYOUT',
  'RESERVE_HOLD',
  'RESERVE_RELEASE',
  'MANUAL_ADJUSTMENT'
);

CREATE TABLE "PayeeLedgerEntry" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "type" "PayeeLedgerEntryType" NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "orderId" TEXT,
  "settlementId" TEXT,
  "disputeId" TEXT,
  "relatedEntryId" TEXT,
  "description" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayeeLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayeeLedgerBalance" (
  "payeeId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "ledgerBalanceCents" INTEGER NOT NULL DEFAULT 0,
  "ledgerPendingHoldCents" INTEGER NOT NULL DEFAULT 0,
  "reserveBalanceCents" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PayeeLedgerBalance_pkey" PRIMARY KEY ("payeeId", "currency")
);

CREATE UNIQUE INDEX "PayeeLedgerEntry_idempotencyKey_key"
  ON "PayeeLedgerEntry"("idempotencyKey");

CREATE UNIQUE INDEX "PayeeLedgerEntry_relatedEntryId_consumed_key"
  ON "PayeeLedgerEntry"("relatedEntryId")
  WHERE "relatedEntryId" IS NOT NULL
    AND "type" IN (
      'DISPUTE_RELEASE'::"PayeeLedgerEntryType",
      'DISPUTE_DEBIT'::"PayeeLedgerEntryType"
    );

CREATE INDEX "PayeeLedgerEntry_payeeId_createdAt_idx"
  ON "PayeeLedgerEntry"("payeeId", "createdAt");

CREATE INDEX "PayeeLedgerEntry_orderId_idx"
  ON "PayeeLedgerEntry"("orderId");

CREATE INDEX "PayeeLedgerEntry_disputeId_idx"
  ON "PayeeLedgerEntry"("disputeId");

ALTER TABLE "PayeeLedgerEntry"
  ADD CONSTRAINT "PayeeLedgerEntry_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "Payee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayeeLedgerEntry"
  ADD CONSTRAINT "PayeeLedgerEntry_disputeId_fkey"
  FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayeeLedgerEntry"
  ADD CONSTRAINT "PayeeLedgerEntry_relatedEntryId_fkey"
  FOREIGN KEY ("relatedEntryId") REFERENCES "PayeeLedgerEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayeeLedgerBalance"
  ADD CONSTRAINT "PayeeLedgerBalance_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "Payee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;