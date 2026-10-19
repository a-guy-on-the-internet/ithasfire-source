-- Scoped API keys, step 1 guards v2 (scoped-api-keys spec 2026-10-08).
--
-- Replaces the v1 triggers of 20261012120100_scoped_api_keys_guards after
-- security review. Applied migrations are never edited, so v1's objects are
-- dropped here and v2's created. Unchanged v1 objects stay in place: the
-- marker columns, the composite scope FKs and their unique targets,
-- "api_keys_expiry_cap", "api_keys_key_last4_required" and
-- "api_keys_one_collect_per_request".
--
-- What v2 changes:
--  - The clock, not the writer, stamps time: api_keys.created_at on every
--    insert, the first revoked_at, and on api_key_requests the created_at,
--    decided_at and withdrawn_at. A writer can no longer back- or
--    forward-date a key to stretch its term or renew an expired key.
--  - Collect and renewal follow the request's state. The trigger is the ONLY
--    writer of api_key_requests.collected_at (one collect, within 7 days of
--    the decision) and of the renewed parent's 24-hour expiry cut. A renewal
--    needs auto-renew on the request and the parent key, and a parent in its
--    last 7 days, so a fresh key cannot be chain-renewed.
--  - A key request is inserted pending; deciding needs a decider.
--  - Both functions pin search_path and schema-qualify every table, so a
--    pg_temp table cannot shadow api_key_requests.
--  - Lock order is the same everywhere: the request row (FOR UPDATE), then
--    the key row. Concurrent collects or renewals of one request serialise
--    on the request row and the loser gets a clean check_violation or
--    unique_violation, not a deadlock.
--  - renewed_from_key_id is ON DELETE NO ACTION (was SET NULL): a renewal
--    link is never silently cut, and the guard no longer lets it go NULL.
--  - "api_keys_renewal_has_request": no legacy row in a renewal slot.
--  - "api_key_requests_self_approved_is_self" is relaxed to hold only while
--    a decider is recorded, so it is safe whichever FK action fires first
--    when a human is deleted; the trigger requires the decider instead.
--
-- Scope of the guarantee: these guards stop a BUGGY writer. A role that
-- owns the tables can disable triggers (or fake pg_trigger_depth() with a
-- trigger of its own), so they are not a defence against a hostile one.
--
-- Time zone: every timestamp the triggers stamp uses LOCALTIMESTAMP and
-- assumes the session TimeZone is UTC, matching the adapter's NOW() writes
-- into timestamp(3) and the UTC values Prisma writes from JS Dates. Dev is
-- Etc/UTC (verified 2026-10-13). The prod setting must be checked before
-- step 10 (cutover).
--
-- FR-013 cutover (orchestrator decision, 2026-10-13): subject, access and
-- request_id stay NULLABLE for good. The cutover revokes every legacy row,
-- adds CHECK (subject IS NOT NULL OR revoked_at IS NOT NULL), and makes
-- api_keys_guard reject inserts without a request. Legacy rows are kept for
-- the audit trail. This supersedes the "makes subject/access/request_id NOT
-- NULL" line in 20261012120000's header, which is applied and not edited.
--
-- Trigger errors use SQLSTATE check_violation (23514) and name the guard in
-- CONSTRAINT, as a CHECK failure would.

-- ── Drop v1 ───────────────────────────────────────────────────────────────

DROP TRIGGER "api_keys_guard" ON "api_keys";
DROP FUNCTION "api_keys_guard"();
DROP TRIGGER "api_key_requests_guard" ON "api_key_requests";
DROP FUNCTION "api_key_requests_guard"();
ALTER TABLE "api_key_requests" DROP CONSTRAINT "api_key_requests_self_approved_is_self";

-- ── Renewal link: NO ACTION (Prisma-generated) ────────────────────────────

-- DropForeignKey
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_renewed_from_key_id_fkey";

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_renewed_from_key_id_fkey" FOREIGN KEY ("renewed_from_key_id") REFERENCES "api_keys"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── CHECKs ────────────────────────────────────────────────────────────────

-- FR-003: while a decider is recorded, self_approved is true exactly when
-- the decider is the requester. NULL decider (undecided, or cleared by its
-- FK) passes; the trigger requires a decider when deciding.
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_self_approved_is_self"
  CHECK ("decided_by_human_id" IS NULL
         OR "self_approved" = ("decided_by_human_id" = "requester_human_id"));

-- A renewal belongs to a request; a legacy row cannot sit in a renewal slot.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_renewal_has_request"
  CHECK ("renewed_from_key_id" IS NULL OR "request_id" IS NOT NULL);

-- ── api_keys_guard ────────────────────────────────────────────────────────

CREATE FUNCTION public."api_keys_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public."api_key_requests"%ROWTYPE;
  p public."api_keys"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."created_at" := LOCALTIMESTAMP(3);

    -- Legacy insert; api_keys_scope_shape keeps it scope-less.
    IF NEW."request_id" IS NULL THEN
      RETURN NEW;
    END IF;

    -- Lock order: request first, then any key.
    SELECT * INTO r FROM public."api_key_requests" WHERE "id" = NEW."request_id" FOR UPDATE;
    IF NOT FOUND THEN
      RETURN NEW; -- api_keys_request_scope_fkey reports it
    END IF;

    IF r."decision" IS DISTINCT FROM 'APPROVED' OR r."withdrawn_at" IS NOT NULL THEN
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
         OR p."revoked_at" IS NOT NULL
         OR NOT p."auto_renew"
         OR p."expires_at" IS NULL
         OR p."expires_at" <= LOCALTIMESTAMP
         OR p."expires_at" > LOCALTIMESTAMP + interval '7 days' THEN
        RAISE EXCEPTION 'api key: renewal must continue a live auto-renewing key on the same request and holder, in its last 7 days'
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
            AND NEW."revoked_by_human_id" IS NOT NULL) THEN
    -- Final once revoked; the revoker may only be cleared by its FK.
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

-- last_used_at and expiry_notified_at are deliberately NOT listed.
CREATE TRIGGER "api_keys_guard"
  BEFORE INSERT OR UPDATE OF
    "id", "key_hash", "human_id", "request_id", "subject", "access", "org_id",
    "label", "key_last4", "created_at", "revoked_at", "revoke_reason",
    "revoked_by_human_id", "expires_at", "auto_renew", "renewed_from_key_id"
  ON public."api_keys"
  FOR EACH ROW EXECUTE FUNCTION public."api_keys_guard"();

-- ── api_key_requests_guard ────────────────────────────────────────────────

CREATE FUNCTION public."api_key_requests_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A request is born pending.
    IF NEW."decision" IS NOT NULL OR NEW."decided_at" IS NOT NULL
       OR NEW."decided_by_human_id" IS NOT NULL OR NEW."denial_reason" IS NOT NULL
       OR NEW."withdrawn_at" IS NOT NULL OR NEW."collected_at" IS NOT NULL
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
      IF NEW."decided_by_human_id" IS NULL THEN
        RAISE EXCEPTION 'key request: a decision names its decider'
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
            AND NEW."decided_by_human_id" IS NOT NULL) THEN
    -- Final once decided; the decider may only be cleared by its FK.
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

  -- collected_at: written once, and only by api_keys_guard (depth > 1).
  -- Guards against a buggy writer, not a hostile one.
  IF NEW."collected_at" IS DISTINCT FROM OLD."collected_at"
     AND (OLD."collected_at" IS NOT NULL OR pg_trigger_depth() <= 1) THEN
    RAISE EXCEPTION 'key request: collected_at is written once, by the collect insert only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_key_requests_guard';
  END IF;

  RETURN NEW;
END;
$$;

-- lapse_notified_at is deliberately NOT listed (the INSERT branch still
-- requires it NULL).
CREATE TRIGGER "api_key_requests_guard"
  BEFORE INSERT OR UPDATE OF
    "id", "requester_human_id", "subject", "org_id", "access", "label",
    "purpose", "expiry_days", "auto_renew", "created_at", "decision",
    "decided_at", "decided_by_human_id", "self_approved", "denial_reason",
    "collected_at", "withdrawn_at"
  ON public."api_key_requests"
  FOR EACH ROW EXECUTE FUNCTION public."api_key_requests_guard"();
