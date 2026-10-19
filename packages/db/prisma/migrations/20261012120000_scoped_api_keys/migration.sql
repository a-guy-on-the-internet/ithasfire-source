-- Scoped API keys, step 1: schema only (scoped-api-keys spec 2026-10-08).
--
-- A key covers one key scope (subject + access) and exists only after
-- someone other than the requester approves a key request. This migration
-- adds the key request table, the scope columns on api_keys, and the three
-- enums. Nothing reads them yet; later steps add the use cases.
--
-- Additive only. Every new api_keys column is nullable (or defaulted) so the
-- legacy rows minted by `apiKeys.create` stay valid. The cutover migration
-- (FR-013) revokes every row with a NULL subject, then makes subject, access
-- and request_id NOT NULL.
--
-- Pending / lapsed / uncollected requests are derived from timestamps;
-- there is no status column on purpose.
--
-- The CHECK constraints at the end are SQL-only (Prisma cannot express
-- them); they are listed in the /// comments on ApiKey and ApiKeyRequest in
-- auth.prisma. The api_keys checks all pass for legacy rows (subject NULL).

-- CreateEnum
CREATE TYPE "ApiKeySubject" AS ENUM ('ORG', 'PERSONAL', 'STAFF', 'PLATFORM_WIDE');

-- CreateEnum
CREATE TYPE "ApiKeyAccess" AS ENUM ('READ', 'READ_WRITE');

-- CreateEnum
CREATE TYPE "ApiKeyRequestDecision" AS ENUM ('APPROVED', 'DENIED');

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "access" "ApiKeyAccess",
ADD COLUMN     "auto_renew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "key_last4" TEXT,
ADD COLUMN     "org_id" TEXT,
ADD COLUMN     "renewed_from_key_id" TEXT,
ADD COLUMN     "request_id" TEXT,
ADD COLUMN     "revoke_reason" TEXT,
ADD COLUMN     "revoked_by_human_id" TEXT,
ADD COLUMN     "subject" "ApiKeySubject";

-- CreateTable
CREATE TABLE "api_key_requests" (
    "id" TEXT NOT NULL,
    "requester_human_id" TEXT NOT NULL,
    "subject" "ApiKeySubject" NOT NULL,
    "org_id" TEXT,
    "access" "ApiKeyAccess" NOT NULL,
    "label" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiry_days" INTEGER,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decision" "ApiKeyRequestDecision",
    "decided_by_human_id" TEXT,
    "denial_reason" TEXT,
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "withdrawn_at" TIMESTAMP(3),
    "collected_at" TIMESTAMP(3),

    CONSTRAINT "api_key_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_key_requests_requester_human_id_created_at_idx" ON "api_key_requests"("requester_human_id", "created_at");

-- CreateIndex
CREATE INDEX "api_key_requests_org_id_decided_at_idx" ON "api_key_requests"("org_id", "decided_at");

-- CreateIndex
CREATE INDEX "api_key_requests_subject_decided_at_idx" ON "api_key_requests"("subject", "decided_at");

-- CreateIndex
CREATE INDEX "api_key_requests_decided_by_human_id_idx" ON "api_key_requests"("decided_by_human_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_renewed_from_key_id_key" ON "api_keys"("renewed_from_key_id");

-- CreateIndex
CREATE INDEX "api_keys_org_id_idx" ON "api_keys"("org_id");

-- CreateIndex
CREATE INDEX "api_keys_request_id_idx" ON "api_keys"("request_id");

-- CreateIndex
CREATE INDEX "api_keys_revoked_by_human_id_idx" ON "api_keys"("revoked_by_human_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "api_key_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_renewed_from_key_id_fkey" FOREIGN KEY ("renewed_from_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_human_id_fkey" FOREIGN KEY ("revoked_by_human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_requester_human_id_fkey" FOREIGN KEY ("requester_human_id") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_decided_by_human_id_fkey" FOREIGN KEY ("decided_by_human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── SQL-only CHECKs: api_key_requests ─────────────────────────────────────

-- orgId is set exactly when the subject is ORG.
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_org_shape"
  CHECK (("subject" = 'ORG') = ("org_id" IS NOT NULL));

-- A platform-wide key is read-only (R19).
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_platform_wide_read_only"
  CHECK ("subject" <> 'PLATFORM_WIDE' OR "access" = 'READ');

-- Expiry caps (R6): NULL = never, ORG / PERSONAL only; otherwise 1..90 days;
-- STAFF and PLATFORM_WIDE must expire within 30 days.
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_expiry_days_cap"
  CHECK (
    ("expiry_days" IS NULL OR "expiry_days" BETWEEN 1 AND 90)
    AND ("subject" NOT IN ('STAFF', 'PLATFORM_WIDE')
         OR ("expiry_days" IS NOT NULL AND "expiry_days" BETWEEN 1 AND 30))
  );

-- A decision and its time are written together.
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_decision_shape"
  CHECK (("decision" IS NULL) = ("decided_at" IS NULL));

-- A denial carries a reason; nothing else does (FR-004).
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_denial_reason_shape"
  CHECK (
    ("decision" = 'DENIED' AND "denial_reason" IS NOT NULL)
    OR ("decision" IS DISTINCT FROM 'DENIED' AND "denial_reason" IS NULL)
  );

-- Only an approved STAFF request can be self-approved (FR-003).
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_self_approved_shape"
  CHECK (NOT "self_approved" OR ("decision" = 'APPROVED' AND "subject" = 'STAFF'));

-- A withdrawn request was never decided (only a pending request is withdrawn).
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_withdrawn_shape"
  CHECK ("withdrawn_at" IS NULL OR "decision" IS NULL);

-- Only an approved request is collected.
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_collected_shape"
  CHECK ("collected_at" IS NULL OR "decision" = 'APPROVED');

-- ── SQL-only CHECKs: api_keys (each passes for legacy subject-NULL rows) ──

-- subject, access and request_id are all set (scoped key) or all NULL (legacy).
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scope_shape"
  CHECK (
    ("subject" IS NULL) = ("access" IS NULL)
    AND ("subject" IS NULL) = ("request_id" IS NULL)
  );

-- orgId is set exactly when the subject is ORG; legacy rows have neither.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_shape"
  CHECK (
    ("subject" IS NULL AND "org_id" IS NULL)
    OR ("subject" IS NOT NULL AND ("subject" = 'ORG') = ("org_id" IS NOT NULL))
  );

-- A platform-wide key is read-only (R19).
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_platform_wide_read_only"
  CHECK ("subject" IS DISTINCT FROM 'PLATFORM_WIDE' OR "access" = 'READ');

-- Who revoked and why exist only on a revoked key.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoke_shape"
  CHECK (
    "revoked_at" IS NOT NULL
    OR ("revoke_reason" IS NULL AND "revoked_by_human_id" IS NULL)
  );

-- keyLast4 is exactly the last four characters.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_last4_length"
  CHECK ("key_last4" IS NULL OR char_length("key_last4") = 4);

-- A key cannot be its own renewal.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_not_renewed_from_self"
  CHECK ("renewed_from_key_id" IS NULL OR "renewed_from_key_id" <> "id");
