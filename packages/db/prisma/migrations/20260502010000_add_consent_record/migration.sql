-- GDPR Article 7(1) consent audit log.
-- One row per Accept All / Essential Only / Reset click — used to demonstrate
-- consent provenance to regulators and to fulfil DSARs.

-- CreateEnum
CREATE TYPE "ConsentChoice" AS ENUM ('ALL', 'ESSENTIAL', 'RESET');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('BANNER', 'FOOTER_MANAGE');

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "anonymous_id" TEXT NOT NULL,
    "human_id" TEXT,
    "choice" "ConsentChoice" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "privacy_policy_version" TEXT NOT NULL,
    "cookie_policy_version" TEXT NOT NULL,
    "ip_hash" TEXT,
    "user_agent" VARCHAR(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentRecord_human_id_createdAt_idx" ON "ConsentRecord"("human_id", "createdAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_anonymous_id_createdAt_idx" ON "ConsentRecord"("anonymous_id", "createdAt");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
