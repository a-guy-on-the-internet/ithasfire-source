-- "A ban that sticks" (2026-09-29). Two additive tables and their enums.
-- Nothing here stores a raw IP address or email: every value column holds an
-- HMAC-SHA256 under a key derived from the server secret
-- (packages/core/src/lib/security/network-identity.ts).

-- CreateEnum
CREATE TYPE "NetworkSightingKind" AS ENUM ('SIGN_UP', 'SIGN_IN');

-- CreateEnum
CREATE TYPE "BannedIdentityKind" AS ENUM ('EMAIL', 'NETWORK');

-- CreateTable
CREATE TABLE "network_sighting" (
    "id" TEXT NOT NULL,
    "auth_user_id" TEXT NOT NULL,
    "human_id" TEXT,
    "kind" "NetworkSightingKind" NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "network_hash" TEXT NOT NULL,
    "country" TEXT,
    "user_agent_family" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "network_sighting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banned_identity" (
    "id" TEXT NOT NULL,
    "kind" "BannedIdentityKind" NOT NULL,
    "value_hash" TEXT NOT NULL,
    "source_human_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "banned_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "network_sighting_network_hash_created_at_idx" ON "network_sighting"("network_hash", "created_at");

-- CreateIndex
CREATE INDEX "network_sighting_human_id_created_at_idx" ON "network_sighting"("human_id", "created_at");

-- CreateIndex
CREATE INDEX "network_sighting_auth_user_id_created_at_idx" ON "network_sighting"("auth_user_id", "created_at");

-- CreateIndex
CREATE INDEX "network_sighting_created_at_idx" ON "network_sighting"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "banned_identity_source_human_id_kind_value_hash_key" ON "banned_identity"("source_human_id", "kind", "value_hash");

-- CreateIndex
CREATE INDEX "banned_identity_kind_value_hash_idx" ON "banned_identity"("kind", "value_hash");

-- CreateIndex
CREATE INDEX "banned_identity_expires_at_idx" ON "banned_identity"("expires_at");

-- AddForeignKey
ALTER TABLE "network_sighting" ADD CONSTRAINT "network_sighting_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_sighting" ADD CONSTRAINT "network_sighting_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banned_identity" ADD CONSTRAINT "banned_identity_source_human_id_fkey" FOREIGN KEY ("source_human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
