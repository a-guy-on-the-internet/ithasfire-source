# Rotating `UNSUBSCRIBE_SECRET`

**Applies to:** the API and the jobs service, per environment (`UNSUBSCRIBE_SECRET_DEV`, `UNSUBSCRIBE_SECRET_PROD` in GitHub secrets, delivered by Terraform's `secret_env` to both services).
**Related:** `packages/core/src/lib/location/obfuscation-key.ts`, `apps/api/src/scripts/ops/reproject-withheld-locations.ts`, `docs/runbooks/rollback.md`.

## What the secret keys

One secret does three unrelated jobs. Rotating it breaks all of them at the same moment.

1. **Unsubscribe links.** Every unsubscribe token in every email already sent is an HMAC under this secret. After rotation those links stop working. Recipients can still unsubscribe from newer emails and from their account settings.
2. **Every public location circle.** The location obfuscation key is `HKDF(UNSUBSCRIBE_SECRET, "ithasfire.location-obfuscation.v1")`. Each withheld venue and each OBSCURED event draws its public circle from that key. A new secret moves every circle.
3. **Every open-call status link.** The open-call status-token key is `HKDF(UNSUBSCRIBE_SECRET, "th-open-call-status-token.v1")` (`packages/core/src/lib/security/open-call-status-token-key.ts`). A guest's status link (`/call/<id>/application/<token>`) is an HMAC under that key. After rotation every link already emailed stops working, including its one-tap Drop out; later emails carry new links. The owner accepted this (2026-10-07). Signed-in applicants are unaffected.

## Why a rotation has a privacy cost

A circle is a sample of where a house is. Someone who saved the old circle and then sees the new one holds two independent samples, and two samples narrow the house down more than one. Rotate for a real reason, such as a leaked secret. Never rotate on a schedule.

## Before you start

- The new value must be at least 32 characters. The API and, since 2026-09-25, the jobs service both refuse to boot in production with a shorter one. Generate it with `openssl rand -base64 48`.
- The API and jobs must end up with the SAME value. The search index (built by jobs) and the public pages (served by the API) draw the same circles. If the two services disagree, every obscured location has two public circles.
- Plan to run steps 3 to 5 straight after the deploy. Until step 3 finishes, events at withheld venues still store the old circle centre (see below).

## Steps

### 1. Update the secret

Set the new value in GitHub (`UNSUBSCRIBE_SECRET_DEV` or `UNSUBSCRIBE_SECRET_PROD`). Deploy through the normal pipeline (`deploy-dev.yml` / `deploy-prod.yml`, which feed `TF_VAR_unsubscribe_secret` to Terraform). Do not edit the Cloud Run services by hand: Terraform reverts hand edits on its next apply.

### 2. Confirm both services booted with a live key

Both roots run a boot self-test right after they configure the key. It draws a canary circle through the same modules the read paths use. In production a failed canary stops the service from booting, so a service that starts serving has a working key. In other environments look for `location_obfuscation.self_test_failed` or `location_obfuscation.key_missing` in the logs. Either one means every obscured location is currently rendered with no map.

### 3. Re-project the stored event locations

An event at a withheld venue stores the venue's public projection, and that projection includes the venue's circle centre. Those stored centres are now stale. Run the re-projection script with the NEW secret against the environment's database:

```bash
cd apps/api
# DATABASE_URL = the environment's database; UNSUBSCRIBE_SECRET = the NEW value.
THC_SEED_ALLOW_REMOTE_DB=true \
DATABASE_URL='<env database url>' \
UNSUBSCRIBE_SECRET='<new secret>' \
  pnpm exec tsx src/scripts/ops/reproject-withheld-locations.ts            # dry run: lists stale venues

# --apply also needs the environment's REDIS_URL and REDIS_NAMESPACE (see below).
THC_SEED_ALLOW_REMOTE_DB=true DATABASE_URL='…' UNSUBSCRIBE_SECRET='…' \
REDIS_URL='<env redis url>' REDIS_NAMESPACE='<env namespace>' \
  pnpm exec tsx src/scripts/ops/reproject-withheld-locations.ts --apply    # write + reindex changed rows
```

What the script does:

- Refuses to run without a key, and runs the same canary as the services. Without a key the projection would be "no circle", and `--apply` would null every stored centre.
- Runs the same cascade `upsertPlace` runs when a venue's privacy changes: exclusive place-location lock, re-read the venue, `reprojectLocationForPlace`, and an audit row (`place.event_locations_reprojected`, reason `obfuscation_reprojection`). It writes only venues whose rows differ from the current projection.
- Is idempotent. Run `--apply` a second time and every venue should report `up_to_date`. That second run is the check that the rows match.
- Re-indexes the events it rewrote and their venues. Pass `--no-reindex` to skip this if step 4 follows straight away.
- On `--apply`, bumps the API's public-read cache generation in Redis after the rows and the reindex, because it writes the database directly and no tRPC mutation invalidates those caches. Without `REDIS_URL` it prints a warning and skips the bump, and the API's anonymous home-page reads can serve old locations for up to `PUBLIC_DISCOVERY_CACHE_TTL_S` (default 900 s). A local Redis bump does not reach a deployed environment. To fix a missed bump, re-run `--apply` with the right values; it is idempotent.
- Takes `--place <id>` (repeatable) to limit the run to specific venues.

Without `THC_SEED_ALLOW_REMOTE_DB=true` the script ignores a non-local `DATABASE_URL` and falls back to the local dev database. That is a guard, not a bug.

### 4. Full search reindex

Freeform OBSCURED events (events with no venue) and the venue documents draw their circles when they are indexed, so the whole index is stale. Rebuild it:

- **Deployed environments:** trigger the `search.full-reindex` job on the jobs service, or wait for its nightly run.
- **Locally:** `pnpm -F api reindex:search`.

A full reindex deletes the documents of each type and then rebuilds them, so search is briefly empty while it runs.

### 5. Verify

Run this leak query against the environment's database. It must return 0 rows:

```sql
SELECT e.id, e.title
FROM "Event" e
JOIN "Place" p ON p.id = e."placeId"
WHERE p.location_mode <> 'EXACT'
  AND (
    e."locationMode" <> 'OBSCURED'
    OR e."postalCode" IS NOT NULL
    OR e.geohash8 IS NOT NULL
    OR (p.lat IS NOT NULL AND e.lat = p.lat AND e.lng = p.lng)
    OR e."addressText" ILIKE '%' || NULLIF(btrim(p.address), '') || '%'
    OR e."addressText" ILIKE '%' || NULLIF(btrim(p."addrLine1"), '') || '%'
    OR e."addressText" ILIKE '%' || NULLIF(btrim(p.postcode), '') || '%'
  );
```

Then pick one withheld venue. Its public view (`places.getPlacePublic`) must return the same `lat`/`lng` as its events store (`SELECT DISTINCT lat, lng FROM "Event" WHERE "placeId" = '<id>'`).

### 6. Expect stale caches

Edge caches keep the old circles for a while after the rotation: public pages for about 7 minutes (`s-maxage=120` plus `stale-while-revalidate=300`), ICS feeds for up to 1 hour (`max-age=3600`, `apps/api/src/routes/ical.ts`). No action is needed. They expire on their own. The API's in-memory public-read caches clear when step 3 bumps the Redis generation.

## The same script after a geometry change

The re-projection script also covers a change to how circles are drawn. The nine-rung radius ladder with nested ring steps (2026-09-25) moved every circle. A stored radius that is no longer a rung is drawn at the next rung up (a stored 800 m draws a 1,000 m circle) until the next save rewrites it. Run steps 3 to 5 in each environment that has withheld venues when such a change ships. Dev was re-projected on 2026-09-25: Fishbowl House, 14 events, second run `up_to_date`, leak query 0 rows.
