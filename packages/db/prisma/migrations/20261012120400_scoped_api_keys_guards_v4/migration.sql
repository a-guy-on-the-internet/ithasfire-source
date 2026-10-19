-- Scoped API keys, step 1 guards v4 (scoped-api-keys spec 2026-10-08).
--
-- Follows 20261012120300_scoped_api_keys_guards_v3. Adds one CHECK and
-- replaces both guard functions (CREATE OR REPLACE; triggers, other CHECKs
-- and indexes are untouched).
--
--  - Auto-renew needs 2+ days (OWNER 2026-10-13: "Auto-renew needs 2+
--    days"). With v3's rule (at most 2 live keys per approval; each key
--    renews at most once), a 1-day key renewed at age t left its renewal
--    only t to renew in (often minutes) before it silently lapsed. With a
--    term of 2+ days the renewed key always has 24h or more after its
--    parent's overlap ends. "api_key_requests_auto_renew_min_term" also
--    refuses auto-renew on a never-expiring term: such a key has nothing to
--    renew (api_keys_guard refuses to renew a key with no expiry), so the
--    flag would only show an auto-renew that never happens. A 1-day or
--    never-expiring key can still be requested, without auto-renew; the
--    never-expire option for ORG and PERSONAL is unchanged. On api_keys no
--    new CHECK is needed: a key may auto-renew only if its request does.
--  - Security L1: v3 let decided_by_human_id / revoked_by_human_id go NULL
--    when pg_trigger_depth() > 1, which a non-owner role with the UPDATE
--    grant and the default TEMP privilege can fake by firing the UPDATE
--    from a pg_temp trigger. The clear is now allowed only when the
--    referenced Human row no longer exists, which is true inside the FK's
--    ON DELETE SET NULL action (the deleted row is invisible there) and
--    false for any application UPDATE.
--  - collected_at stays depth-gated. A role with TEMP can still fake the
--    depth for it, so that rule is a buggy-writer guard only.
--
-- Scope of the guarantee (unchanged): these guards stop a BUGGY writer. A
-- role that owns the tables can disable triggers.

-- ── api_key_requests_auto_renew_min_term ──────────────────────────────────

-- Auto-renew needs a term, of 2 days or more (owner 2026-10-13).
ALTER TABLE "api_key_requests" ADD CONSTRAINT "api_key_requests_auto_renew_min_term"
  CHECK (NOT "auto_renew" OR ("expiry_days" IS NOT NULL AND "expiry_days" >= 2));

-- ── api_keys_guard ────────────────────────────────────────────────────────

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
