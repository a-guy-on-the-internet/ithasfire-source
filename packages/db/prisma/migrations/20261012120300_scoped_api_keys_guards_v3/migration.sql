-- Scoped API keys, step 1 guards v3 (scoped-api-keys spec 2026-10-08).
--
-- Replaces the two guard functions of 20261012120200_scoped_api_keys_guards_v2
-- (CREATE OR REPLACE; the triggers, CHECKs and indexes stay as they are).
--
-- What v3 fixes:
--  - CORRECTION to v2's header, which claimed "a fresh key cannot be
--    chain-renewed". That was false for any term of 7 days or less: every
--    such key is born inside its own last-7-days window, so renewals chained
--    at once and one approval minted unlimited live keys. v3 refuses a
--    renewal while the request has any live key other than the parent.
--    Result: at most 2 live keys per approval (the parent in its 24-hour
--    overlap and its renewal), and one renewal per overlap. R7 is unchanged:
--    a key renews in its last 7 days and the old key lives 24 hours more.
--  - The FK-only NULLs: decided_by_human_id and revoked_by_human_id may be
--    set to NULL only by their FK's ON DELETE SET NULL, i.e. from inside a
--    trigger (pg_trigger_depth() > 1). An application UPDATE that clears
--    them is refused.
--  - A pending request lapses at 14 days (FR-004): approving a request
--    created 14+ days ago is refused. Denying it is still allowed.
--  - Both functions SET TimeZone = 'UTC', so every LOCALTIMESTAMP they stamp
--    or compare is UTC whatever the calling session's TimeZone. This
--    replaces v2's assumption that the session is UTC; it no longer depends
--    on the session (prod included). Writers still compute expires_at in
--    UTC (the adapter's NOW() is converted with the session TimeZone, UTC
--    on dev; check prod before step 10).
--  - Every INSERT (legacy included) must leave revoked_at,
--    revoked_by_human_id, revoke_reason, expiry_notified_at and last_used_at
--    NULL: no key is born revoked, notified or used.
--  - A renewal keeps its parent's label.
--
-- Scope of the guarantee (unchanged): these guards stop a BUGGY writer. A
-- role that owns the tables can disable triggers, or fake pg_trigger_depth()
-- with a trigger of its own; they are not a defence against a hostile one.

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
            AND (NEW."revoked_by_human_id" IS NOT NULL OR pg_trigger_depth() <= 1)) THEN
    -- Final once revoked; the revoker may only be cleared by its FK's
    -- SET NULL (which runs this at trigger depth > 1).
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
            AND (NEW."decided_by_human_id" IS NOT NULL OR pg_trigger_depth() <= 1)) THEN
    -- Final once decided; the decider may only be cleared by its FK's
    -- SET NULL (which runs this at trigger depth > 1).
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
