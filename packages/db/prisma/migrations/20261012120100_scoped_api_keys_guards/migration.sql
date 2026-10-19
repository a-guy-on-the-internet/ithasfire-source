-- Scoped API keys, step 1 guards (scoped-api-keys spec 2026-10-08).
--
-- Follows 20261012120000_scoped_api_keys while both tables are still empty.
-- Adds what review asked the database to enforce, so a buggy or hostile
-- writer cannot mint a key wider than its approved request:
--
--  1. Composite FKs binding a key's (request, holder, subject, access) and
--     (request, org) to its request row, replacing the single-column request
--     FK. MATCH SIMPLE: legacy rows (request_id NULL) and non-ORG keys
--     (org_id NULL) skip the check they cannot take part in.
--  2. CHECKs: key expiry caps (R6), self-approval tied to who decided
--     (FR-003), keyLast4 on every scoped key (R25).
--  3. One collect per approval: partial unique on request_id for keys that
--     are not renewals.
--  4. Triggers making the scope immutable and the lifecycle one-way. They
--     list their columns in UPDATE OF, so the per-call last_used_at write and
--     the sweep's *_notified_at markers never fire them, and they let the
--     FKs' ON DELETE SET NULL writes through.
--  5. Notice markers for the daily sweep (lapse_notified_at,
--     expiry_notified_at): a record that a notice was sent, not a status.
--
-- Expiry checks have NO slack: the writer derives created_at and expires_at
-- from one timestamp (the INSERT's NOW()), as the adapter's raw INSERT does.
--
-- Everything SQL-only here is listed in the /// comments on ApiKey and
-- ApiKeyRequest in auth.prisma. Trigger errors use SQLSTATE check_violation
-- (23514) and name the guard in CONSTRAINT, like a CHECK failure would.

-- DropForeignKey
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_request_id_fkey";


-- AlterTable
ALTER TABLE "api_key_requests" ADD COLUMN     "lapse_notified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "expiry_notified_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "api_key_requests_id_requester_human_id_subject_access_key" ON "api_key_requests"("id", "requester_human_id", "subject", "access");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_requests_id_org_id_key" ON "api_key_requests"("id", "org_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_request_scope_fkey" FOREIGN KEY ("request_id", "human_id", "subject", "access") REFERENCES "api_key_requests"("id", "requester_human_id", "subject", "access") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_request_org_fkey" FOREIGN KEY ("request_id", "org_id") REFERENCES "api_key_requests"("id", "org_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── CHECKs ────────────────────────────────────────────────────────────────

-- R6: STAFF / PLATFORM_WIDE expire within 30 days; ORG / PERSONAL never or
-- within 90 days. Legacy rows (subject NULL) pass.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_expiry_cap"
  CHECK (
    "subject" IS NULL
    OR ("subject" IN ('STAFF', 'PLATFORM_WIDE')
        AND "expires_at" IS NOT NULL
        AND "expires_at" <= "created_at" + interval '30 days')
    OR ("subject" IN ('ORG', 'PERSONAL')
        AND ("expires_at" IS NULL OR "expires_at" <= "created_at" + interval '90 days'))
  );

-- R25: every scoped key can be told apart by its last four characters.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_last4_required"
  CHECK ("subject" IS NULL OR "key_last4" IS NOT NULL);

-- FR-003: self_approved is true exactly when the decider is the requester.
-- Undecided rows: decider NULL ≠ requester, so false. A non-self decider
-- removed by its FK's SET NULL stays false = false.
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_self_approved_is_self"
  CHECK ("self_approved" = ("decided_by_human_id" IS NOT DISTINCT FROM "requester_human_id"));

-- ── One collect per approval ──────────────────────────────────────────────

CREATE UNIQUE INDEX "api_keys_one_collect_per_request"
  ON "api_keys" ("request_id")
  WHERE "renewed_from_key_id" IS NULL;

-- ── api_keys_guard ────────────────────────────────────────────────────────

CREATE FUNCTION "api_keys_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r "api_key_requests"%ROWTYPE;
  p "api_keys"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Legacy insert; api_keys_scope_shape keeps it scope-less.
    IF NEW."request_id" IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT * INTO r FROM "api_key_requests" WHERE "id" = NEW."request_id" FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW; -- api_keys_request_scope_fkey reports it
    END IF;

    IF r."decision" IS DISTINCT FROM 'APPROVED' OR r."withdrawn_at" IS NOT NULL THEN
      RAISE EXCEPTION 'api key: request % is not approved', r."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
    END IF;

    IF (r."expiry_days" IS NULL) <> (NEW."expires_at" IS NULL)
       OR NEW."expires_at" > NEW."created_at" + make_interval(days => r."expiry_days") THEN
      RAISE EXCEPTION 'api key: expiry outside the request''s term'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
    END IF;

    IF NEW."auto_renew" AND NOT r."auto_renew" THEN
      RAISE EXCEPTION 'api key: request % does not allow auto-renew', r."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
    END IF;

    -- A renewal continues a live, expiring key on the same request and holder.
    IF NEW."renewed_from_key_id" IS NOT NULL THEN
      SELECT * INTO p FROM "api_keys" WHERE "id" = NEW."renewed_from_key_id" FOR UPDATE;
      IF NOT FOUND
         OR p."request_id" IS DISTINCT FROM NEW."request_id"
         OR p."human_id" <> NEW."human_id"
         OR p."revoked_at" IS NOT NULL
         OR p."expires_at" IS NULL
         OR p."expires_at" <= NEW."created_at" THEN
        RAISE EXCEPTION 'api key: renewal must continue a live expiring key on the same request and holder'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE: identity and scope are fixed for the key's life.
  IF (NEW."id", NEW."key_hash", NEW."human_id", NEW."request_id", NEW."subject",
      NEW."access", NEW."org_id", NEW."label", NEW."key_last4", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."key_hash", OLD."human_id", OLD."request_id", OLD."subject",
      OLD."access", OLD."org_id", OLD."label", OLD."key_last4", OLD."created_at") THEN
    RAISE EXCEPTION 'api key: identity and scope columns are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
  END IF;

  -- Revocation is terminal; afterwards the revoker may only be cleared by
  -- its FK's SET NULL.
  IF OLD."revoked_at" IS NOT NULL AND (
       NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason"
       OR (NEW."revoked_by_human_id" IS DISTINCT FROM OLD."revoked_by_human_id"
           AND NEW."revoked_by_human_id" IS NOT NULL)) THEN
    RAISE EXCEPTION 'api key: revocation is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
  END IF;

  -- Expiry only moves earlier (never → a date counts as earlier).
  IF OLD."expires_at" IS NOT NULL
     AND (NEW."expires_at" IS NULL OR NEW."expires_at" > OLD."expires_at") THEN
    RAISE EXCEPTION 'api key: expiry can only move earlier'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
  END IF;

  IF NEW."auto_renew" AND NOT OLD."auto_renew" AND NOT EXISTS (
       SELECT 1 FROM "api_key_requests"
       WHERE "id" = NEW."request_id" AND "auto_renew") THEN
    RAISE EXCEPTION 'api key: its request does not allow auto-renew'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
  END IF;

  -- The renewal link changes only to NULL (its FK's SET NULL).
  IF NEW."renewed_from_key_id" IS DISTINCT FROM OLD."renewed_from_key_id"
     AND NEW."renewed_from_key_id" IS NOT NULL THEN
    RAISE EXCEPTION 'api key: renewed_from_key_id is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
  END IF;

  RETURN NEW;
END;
$$;

-- last_used_at and expiry_notified_at are deliberately NOT listed.
CREATE TRIGGER "api_keys_guard"
  BEFORE INSERT OR UPDATE OF
    "id", "key_hash", "human_id", "request_id", "subject", "access", "org_id",
    "label", "key_last4", "created_at", "revoked_at", "revoke_reason",
    "revoked_by_human_id", "expires_at", "auto_renew", "renewed_from_key_id"
  ON "api_keys"
  FOR EACH ROW EXECUTE FUNCTION "api_keys_guard"();

-- ── api_key_requests_guard ────────────────────────────────────────────────

CREATE FUNCTION "api_key_requests_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- What the approver read is what they approved.
  IF (NEW."id", NEW."requester_human_id", NEW."subject", NEW."org_id", NEW."access",
      NEW."label", NEW."purpose", NEW."expiry_days", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."requester_human_id", OLD."subject", OLD."org_id", OLD."access",
      OLD."label", OLD."purpose", OLD."expiry_days", OLD."created_at") THEN
    RAISE EXCEPTION 'key request: content is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  -- Auto-renew may be switched off (an approver's "no"), never back on.
  IF NEW."auto_renew" AND NOT OLD."auto_renew" THEN
    RAISE EXCEPTION 'key request: auto-renew can only be switched off'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  -- A decision is final; afterwards the decider may only be cleared by its
  -- FK's SET NULL.
  IF OLD."decision" IS NOT NULL AND (
       (NEW."decision", NEW."decided_at", NEW."self_approved", NEW."denial_reason")
         IS DISTINCT FROM
       (OLD."decision", OLD."decided_at", OLD."self_approved", OLD."denial_reason")
       OR (NEW."decided_by_human_id" IS DISTINCT FROM OLD."decided_by_human_id"
           AND NEW."decided_by_human_id" IS NOT NULL)) THEN
    RAISE EXCEPTION 'key request: decision is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  IF (OLD."collected_at" IS NOT NULL AND NEW."collected_at" IS DISTINCT FROM OLD."collected_at")
     OR (OLD."withdrawn_at" IS NOT NULL AND NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at") THEN
    RAISE EXCEPTION 'key request: collected_at and withdrawn_at are final once set'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  RETURN NEW;
END;
$$;

-- lapse_notified_at is deliberately NOT listed.
CREATE TRIGGER "api_key_requests_guard"
  BEFORE UPDATE OF
    "id", "requester_human_id", "subject", "org_id", "access", "label",
    "purpose", "expiry_days", "auto_renew", "created_at", "decision",
    "decided_at", "decided_by_human_id", "self_approved", "denial_reason",
    "collected_at", "withdrawn_at"
  ON "api_key_requests"
  FOR EACH ROW EXECUTE FUNCTION "api_key_requests_guard"();
