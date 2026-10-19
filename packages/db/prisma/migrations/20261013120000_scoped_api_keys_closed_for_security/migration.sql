-- Scoped API keys, R31 (owner 2026-10-13, picked "Close them, say why";
-- scoped-api-keys spec 2026-10-08).
--
-- A password reset or a ban closes the holder's pending AND
-- approved-but-uncollected key requests, not only their keys. The request
-- records WHY it was withdrawn, so a closed request never reads as "you
-- withdrew".
--
--  - enum "ApiKeyRequestWithdrawal" (REQUESTER | ACCOUNT_SECURITY) and column
--    api_key_requests.withdrawal_reason.
--  - "api_key_requests_withdrawal_reason_shape": the reason is set exactly
--    when withdrawn_at is.
--  - "api_key_requests_withdrawn_shape" replaced: REQUESTER only on an
--    undecided request (as before); ACCOUNT_SECURITY on an undecided one or
--    an APPROVED one not yet collected.
--  - Both guard functions replaced (CREATE OR REPLACE, copied from
--    20261012120400_scoped_api_keys_guards_v4; every v4 rule kept):
--    api_key_requests_guard refuses deciding a withdrawn request (the old
--    withdrawn_shape CHECK did that; the new one allows an APPROVED closed
--    request), refuses a reason on insert, and makes the reason final;
--    api_keys_guard refuses any key (collect or renewal) under a withdrawn
--    request with its own message.
--  - The api_key_requests_guard trigger is re-created so its UPDATE OF list
--    includes withdrawal_reason.
--
-- Both tables are empty on every environment at this point (feature not
-- launched), so the new CHECKs validate nothing existing.
-- Scope of the guarantee (unchanged): these guards stop a BUGGY writer.

-- CreateEnum
CREATE TYPE "ApiKeyRequestWithdrawal" AS ENUM ('REQUESTER', 'ACCOUNT_SECURITY');

-- AlterTable
ALTER TABLE "api_key_requests" ADD COLUMN     "withdrawal_reason" "ApiKeyRequestWithdrawal";

-- ── CHECKs ────────────────────────────────────────────────────────────────

ALTER TABLE "api_key_requests" DROP CONSTRAINT "api_key_requests_withdrawn_shape";

-- The reason is recorded exactly when the request is withdrawn.
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_withdrawal_reason_shape"
  CHECK (("withdrawn_at" IS NULL) = ("withdrawal_reason" IS NULL));

-- A requester withdraws only a pending request; account security (R31) also
-- closes an approved request that was not collected.
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_withdrawn_shape"
  CHECK (
    "withdrawal_reason" IS NULL
    OR ("withdrawal_reason" = 'REQUESTER' AND "decision" IS NULL)
    OR ("withdrawal_reason" = 'ACCOUNT_SECURITY'
        AND ("decision" IS NULL
             OR ("decision" = 'APPROVED' AND "collected_at" IS NULL)))
  );

-- ── api_keys_guard / api_key_requests_guard ───────────────────────────────

CREATE OR REPLACE FUNCTION public."api_keys_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  r public."api_key_requests"%ROWTYPE;
  p public."api_keys"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."created_at" := LOCALTIMESTAMP(3);

    -- No key is born revoked, notified or used.
    IF NEW."revoked_at" IS NOT NULL OR NEW."revoked_by_human_id" IS NOT NULL
       OR NEW."revoke_reason" IS NOT NULL OR NEW."expiry_notified_at" IS NOT NULL
       OR NEW."last_used_at" IS NOT NULL THEN
      RAISE EXCEPTION 'api key: a new key has no revoke, notice or use yet'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
    END IF;

    -- Legacy insert; api_keys_scope_shape keeps it scope-less.
    IF NEW."request_id" IS NULL THEN
      RETURN NEW;
    END IF;

    -- Lock order: request first, then any key.
    SELECT * INTO r FROM public."api_key_requests" WHERE "id" = NEW."request_id" FOR UPDATE;
    IF NOT FOUND THEN
      RETURN NEW; -- api_keys_request_scope_fkey reports it
    END IF;

    -- R31: no key (collect or renewal) under a withdrawn request, whether
    -- the requester withdrew it or account security closed it.
    IF r."withdrawn_at" IS NOT NULL THEN
      RAISE EXCEPTION 'api key: request % was withdrawn or closed for account security', r."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
    END IF;

    IF r."decision" IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'api key: request % is not approved', r."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
    END IF;

    IF (r."expiry_days" IS NULL) <> (NEW."expires_at" IS NULL)
       OR NEW."expires_at" <= NEW."created_at"
       OR NEW."expires_at" > NEW."created_at" + make_interval(days => r."expiry_days") THEN
      RAISE EXCEPTION 'api key: expiry outside the request''s term'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
    END IF;

    IF NEW."auto_renew" AND NOT r."auto_renew" THEN
      RAISE EXCEPTION 'api key: request % does not allow auto-renew', r."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
    END IF;

    IF NEW."renewed_from_key_id" IS NULL THEN
      -- Collect (FR-005): once, within 7 days of the approval.
      IF r."collected_at" IS NOT NULL
         OR r."decided_at" <= LOCALTIMESTAMP - interval '7 days' THEN
        RAISE EXCEPTION 'api key: request % is already collected or its collection window lapsed', r."id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
      END IF;
      -- The only writer of collected_at.
      UPDATE public."api_key_requests" SET "collected_at" = NEW."created_at" WHERE "id" = r."id";
    ELSE
      -- Renewal (FR-009).
      IF NOT r."auto_renew" THEN
        RAISE EXCEPTION 'api key: request % does not allow auto-renew', r."id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
      END IF;
      SELECT * INTO p FROM public."api_keys" WHERE "id" = NEW."renewed_from_key_id" FOR UPDATE;
      IF NOT FOUND
         OR p."request_id" IS DISTINCT FROM NEW."request_id"
         OR p."human_id" <> NEW."human_id"
         OR p."label" IS DISTINCT FROM NEW."label"
         OR p."revoked_at" IS NOT NULL
         OR NOT p."auto_renew"
         OR p."expires_at" IS NULL
         OR p."expires_at" <= LOCALTIMESTAMP
         OR p."expires_at" > LOCALTIMESTAMP + interval '7 days' THEN
        RAISE EXCEPTION 'api key: renewal must continue a live auto-renewing key on the same request, holder and label, in its last 7 days'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
      END IF;
      -- At most 2 live keys per approval: the parent (in its overlap) and
      -- this renewal. The request row is locked, so this check cannot race.
      IF EXISTS (
           SELECT 1 FROM public."api_keys" k
           WHERE k."request_id" = r."id"
             AND k."id" <> p."id"
             AND k."revoked_at" IS NULL
             AND (k."expires_at" IS NULL OR k."expires_at" > LOCALTIMESTAMP)) THEN
        RAISE EXCEPTION 'api key: request % already has another live key; renew once the overlap ends', r."id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
      END IF;
      -- The only writer of the parent's 24-hour overlap cut.
      UPDATE public."api_keys"
        SET "expires_at" = LEAST("expires_at", LOCALTIMESTAMP(3) + interval '24 hours')
        WHERE "id" = p."id";
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE: identity, scope and the renewal link are fixed for the key's life.
  IF (NEW."id", NEW."key_hash", NEW."human_id", NEW."request_id", NEW."subject",
      NEW."access", NEW."org_id", NEW."label", NEW."key_last4", NEW."created_at",
      NEW."renewed_from_key_id")
     IS DISTINCT FROM
     (OLD."id", OLD."key_hash", OLD."human_id", OLD."request_id", OLD."subject",
      OLD."access", OLD."org_id", OLD."label", OLD."key_last4", OLD."created_at",
      OLD."renewed_from_key_id") THEN
    RAISE EXCEPTION 'api key: identity and scope columns are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
  END IF;

  IF OLD."revoked_at" IS NULL THEN
    IF NEW."revoked_at" IS NOT NULL THEN
      NEW."revoked_at" := LOCALTIMESTAMP(3); -- the clock stamps the revoke
    END IF;
  ELSIF NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
        OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason"
        OR (NEW."revoked_by_human_id" IS DISTINCT FROM OLD."revoked_by_human_id"
            AND (NEW."revoked_by_human_id" IS NOT NULL
                 OR EXISTS (SELECT 1 FROM public."Human" h WHERE h."id" = OLD."revoked_by_human_id"))) THEN
    -- Final once revoked; the revoker may only be cleared by its FK's
    -- SET NULL, i.e. once the referenced Human row is gone (it is
    -- invisible inside the ON DELETE SET NULL action).
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
       SELECT 1 FROM public."api_key_requests"
       WHERE "id" = NEW."request_id" AND "auto_renew") THEN
    RAISE EXCEPTION 'api key: its request does not allow auto-renew'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_keys_guard';
  END IF;

  RETURN NEW;
END;
$$;

-- ── api_key_requests_guard ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public."api_key_requests_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A request is born pending.
    IF NEW."decision" IS NOT NULL OR NEW."decided_at" IS NOT NULL
       OR NEW."decided_by_human_id" IS NOT NULL OR NEW."denial_reason" IS NOT NULL
       OR NEW."withdrawn_at" IS NOT NULL OR NEW."withdrawal_reason" IS NOT NULL
       OR NEW."collected_at" IS NOT NULL
       OR NEW."lapse_notified_at" IS NOT NULL OR NEW."self_approved" THEN
      RAISE EXCEPTION 'key request: a request is inserted pending'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
    END IF;
    NEW."created_at" := LOCALTIMESTAMP(3);
    RETURN NEW;
  END IF;

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

  IF OLD."decision" IS NULL THEN
    IF NEW."decision" IS NOT NULL THEN
      -- R31: a withdrawn or closed request is never decided.
      IF OLD."withdrawn_at" IS NOT NULL OR NEW."withdrawn_at" IS NOT NULL THEN
        RAISE EXCEPTION 'key request: request % was withdrawn and cannot be decided', OLD."id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
      END IF;
      IF NEW."decided_by_human_id" IS NULL THEN
        RAISE EXCEPTION 'key request: a decision names its decider'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
      END IF;
      -- FR-004: a pending request lapses at 14 days; it can still be denied.
      IF NEW."decision" = 'APPROVED'
         AND OLD."created_at" <= LOCALTIMESTAMP - interval '14 days' THEN
        RAISE EXCEPTION 'key request: request % lapsed (14 days) and cannot be approved', OLD."id"
          USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
      END IF;
      NEW."decided_at" := LOCALTIMESTAMP(3); -- the clock stamps the decision
    ELSIF NEW."decided_by_human_id" IS NOT NULL THEN
      RAISE EXCEPTION 'key request: an undecided request has no decider'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
    END IF;
  ELSIF (NEW."decision", NEW."decided_at", NEW."self_approved", NEW."denial_reason")
          IS DISTINCT FROM
        (OLD."decision", OLD."decided_at", OLD."self_approved", OLD."denial_reason")
        OR (NEW."decided_by_human_id" IS DISTINCT FROM OLD."decided_by_human_id"
            AND (NEW."decided_by_human_id" IS NOT NULL
                 OR EXISTS (SELECT 1 FROM public."Human" h WHERE h."id" = OLD."decided_by_human_id"))) THEN
    -- Final once decided; the decider may only be cleared by its FK's
    -- SET NULL, i.e. once the referenced Human row is gone (it is
    -- invisible inside the ON DELETE SET NULL action).
    RAISE EXCEPTION 'key request: decision is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  IF OLD."withdrawn_at" IS NULL THEN
    IF NEW."withdrawn_at" IS NOT NULL THEN
      NEW."withdrawn_at" := LOCALTIMESTAMP(3); -- the clock stamps the withdrawal
    END IF;
  ELSIF NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at" THEN
    RAISE EXCEPTION 'key request: withdrawn_at is final once set'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  -- R31: who or what withdrew it is final once recorded.
  IF OLD."withdrawal_reason" IS NOT NULL
     AND NEW."withdrawal_reason" IS DISTINCT FROM OLD."withdrawal_reason" THEN
    RAISE EXCEPTION 'key request: withdrawal_reason is final once set'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  -- collected_at: written once, and only by api_keys_guard (depth > 1).
  -- Guards against a buggy writer only: a role with TEMP can fake the depth
  -- with a pg_temp trigger.
  IF NEW."collected_at" IS DISTINCT FROM OLD."collected_at"
     AND (OLD."collected_at" IS NOT NULL OR pg_trigger_depth() <= 1) THEN
    RAISE EXCEPTION 'key request: collected_at is written once, by the collect insert only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  RETURN NEW;
END;
$$;

-- ── api_key_requests_guard trigger: add withdrawal_reason to UPDATE OF ────

DROP TRIGGER "api_key_requests_guard" ON public."api_key_requests";
CREATE TRIGGER "api_key_requests_guard"
  BEFORE INSERT OR UPDATE OF
    "id", "requester_human_id", "subject", "org_id", "access", "label",
    "purpose", "expiry_days", "auto_renew", "created_at", "decision",
    "decided_at", "decided_by_human_id", "self_approved", "denial_reason",
    "collected_at", "withdrawn_at", "withdrawal_reason"
  ON public."api_key_requests"
  FOR EACH ROW EXECUTE FUNCTION public."api_key_requests_guard"();
