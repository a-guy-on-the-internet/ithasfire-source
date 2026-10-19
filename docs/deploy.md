# Deploy and operate

How code reaches dev and prod, how runtime config and secrets get there, and how to operate what runs. The workflow files, Terraform and the env schemas are the source of truth. This doc keeps what they don't say on their own: the order of things, the reasons, and the traps.

GCP project `hearthfire-491918`, region `us-east4` for every regional resource in both envs (`region` in `infra/terraform/envs/{dev,prod}/*.tfvars`). The git remote is GitHub `origin`, and CI is GitHub Actions in `.github/workflows/`. The Forgejo remote and its Actions are retired; workflow comments that still say "Forgejo" mean the old host.

## Where each fact lives

| Fact | Source of truth |
| --- | --- |
| What a pipeline does, in what order | The workflow file in `.github/workflows/` (each carries its own rationale comments) |
| Which GitHub secrets and variables exist | `grep -ho 'secrets\.[A-Za-z_0-9]*' .github/workflows/*.yml \| sort -u` (and `vars.` for variables) |
| Which Cloud Run service gets which secret | `api_secrets`, `jobs_secrets`, `web_secrets`, `audio_transcoder_secrets` in `infra/terraform/secrets.tf` |
| Non-secret runtime config per env | `api_env`, `web_env`, `jobs_env` in `infra/terraform/envs/<env>/<env>.tfvars`; infra-derived values in the `resolved_*_env` locals in `infra/terraform/main.tf` |
| Most env vars an app reads, with defaults and prod requirements | The env schemas: `apps/api/src/lib/env.ts`, `apps/jobs/src/lib/env.ts`, `apps/web/src/config/env.server.ts` + `env.public.ts`, `apps/audio-transcoder/src/lib/env.ts`. Some reads bypass them; see [Runtime config](#runtime-config-and-env-vars). |
| Mobile and scanner build-time values | `build.<profile>.env` in `apps/mobile/eas.json` and `apps/scanner/eas.json`; read in `app.config.ts` |
| Local env templates | `apps/api/.env.example`; `infra/.env.local.example` (copy to `infra/.env.local`, which direnv and `tf.sh` load); `infra/docker/.env.example` (copy to `infra/docker/.env`, the file compose reads from its project directory). Compose does not read `infra/.env.example`. Every compose variable has a default, so neither copy is required. |
| Scheduled jobs and their cron | `apps/jobs/jobs.manifest.json`; per-env overrides in `jobs_scheduler_overrides` in the tfvars |

## Dev: push to main

`deploy-dev.yml` runs on every push to `main` that touches more than docs and Markdown, and on dispatch.

- **On push**, path filters in the `changes` job decide what builds. `packages/**` and the root manifests count for api, web, jobs and audio; tileserver builds only on `infra/docker/tileserver/**` or `infra/docker/Dockerfile.tileserver`. Terraform runs only when `infra/terraform/**` or `apps/jobs/jobs.manifest.json` changed.
- **`migrate_db` runs on every run that builds, rolls or applies anything**, push or dispatch, because images built from the whole tree can carry migrations an earlier run never applied. It is a no-op when nothing is pending. The `packages/db/prisma/` filter only adds schema-only pushes, and `skip-migrate` is the only opt-out.
- **On dispatch**, the `services` input is a comma list of `web, api, jobs, tileserver, audio, terraform, migrate, seed`, or `all`. A typo fails the run instead of going green. `skip-migrate` is a break-glass modifier, explained in the `scope` step.
- **Order:** `quality_gate` + `typecheck` → build (each image tagged `dev-<sha7>` and `:dev`) → `migrate_db` → `terraform` → `deploy_dev` → `post_deploy_verify`, plus `seed_admin`, which upserts the fixture admin from `apps/api/src/scripts/seed/ids.ts` once the roll and the migration have both succeeded.
- **`deploy-dev.yml` has `concurrency: hf-dev` with `cancel-in-progress: true`, and a push to main cancels whatever is running in `hf-dev`, from any workflow.** That group is shared by `terraform-apply.yml` with `environment: dev`, `hotfix.yml` with target `dev`, and `terraform-state-rm-dead-aws-upstash.yml` on the dev workspace. Their own `cancel-in-progress: false` doesn't protect them, because the setting on the new run decides. A group also holds only one waiting run: whatever is pending is replaced by the next run queued, so a dev `terraform-apply` waiting behind a deploy is dropped by the next push. A cancelled apply can leave the GCS state lock held (`terraform-force-unlock.yml` / `terraform-clear-lock-object.yml` clear it). Don't push to main while a dev apply or a dev hotfix runs or waits.
- A run cancelled mid-migration can leave the dev DB at P3009. The way out is `skip-migrate`, plus `migration_drift_enforce = "false"` in `dev.tfvars`, because api and jobs refuse `/health` on schema drift and their startup probes then never pass. The full procedure is in the `scope` step comment and the `migration_drift_enforce` variable in `infra/terraform/variables.tf`. Revert it afterwards.
- A brand-new env has no `hf-<env>-database-url` until Terraform creates it, so the first run is a dispatch of `terraform,skip-migrate`.

## Prod: dispatch only

Every prod run is the owner's call: `deploy-prod`, `redeploy-prod`, `terraform-apply` with `environment: prod`, and `hotfix` with a prod target. Prepare the change and the exact dispatch, then hand it over.

- **`deploy-prod.yml`** runs `manifest_drift_guard` and `version_skew_guard` first, then promotes api, jobs, tileserver and audio-transcoder by **retagging the `:dev` digest the guard checked as `:prod`, with no rebuild**. Then it builds web from the dispatched ref, then runs `migrate_db` → `terraform_apply` → `deploy_prod` → `post_deploy_verify`. Two consequences:
  - Dispatch from main only. `version_skew_guard` (`scripts/ci/check-prod-version-skew.sh`) fails the run unless each promoted service's `:dev` image was built from the dispatched commit or from an ancestor whose diff to it misses that service's path filter in `deploy-dev.yml`. It also needs a green `deploy-dev` run at the dispatched commit, or at an ancestor with only `paths-ignore` files (docs) after it. The error names the service, the commit its image came from and the files since. What to do depends on which way `:dev` is off:
    - `:dev` newer than the dispatched commit (main moved on while prod was dispatched or queued): wait for the running `deploy-dev` to finish, then dispatch prod again. It runs at main HEAD.
    - `:dev` older: a dev run rebuilds only what its own diff touched, so dev can be green while one service is stale. Dispatch `deploy-dev` with that service (for example `services=api`), but only while no `deploy-dev` run is in progress, because a dispatch cancels a running one. Then dispatch prod again.
  - Web is rebuilt because `NEXT_PUBLIC_*` values are inlined at build time (`--build-arg` in the `build_web` step), so a dev web image would carry dev keys.
- **`redeploy-prod.yml`** reruns migrate → apply → roll on whatever `:prod` already points at, with no promote and no build. It is for a run that failed after its images were pushed.
- **`terraform-apply.yml`** applies one env and then migrates. It is the same Terraform the deploys run, without a roll. It picks secrets with `inputs.environment == 'prod' && secrets.X_PROD || secrets.X_DEV`: an **empty `_PROD` secret falls through to the `_DEV` value**, so a prod apply can quietly write a dev credential. An empty string is falsy in a GitHub expression, so `&&` yields it and `||` moves on to the dev secret. Check that the `_PROD` secret exists before adding one to this file.
- `manifest_drift_guard` (`pnpm -C apps/jobs validate:manifest`) fails when a `jobs_scheduler_overrides` key in the tfvars has no matching manifest entry. The staff console shows the manifest's schedule.
- `deploy-prod`, `redeploy-prod`, `terraform-apply` (prod), `terraform-state-rm-dead-aws-upstash` (prod) and `hotfix` (target `prod` or `both`) share `hf-prod` with `cancel-in-progress: false`. A running prod run is never cancelled, but only one run waits behind it: a third dispatch cancels the waiting one. Dispatch prod runs one at a time. In dev, a push also cancels the running run (see above).

Migration order: deploys migrate **before** applying Terraform, because an apply that changes service config creates a new revision on the moving tag, and that revision must not serve new code against an old schema. `terraform-apply.yml` migrates after it applies; `skip_migrate` is its break-glass.

## Hotfix and rollback

- **`hotfix.yml`** rolls one service (`web, api, jobs, tileserver, audio`) to `dev`, `prod` or `both`. You must type `confirm: HOTFIX`. It skips tests, Terraform and migrations. It refuses a ref that carries migrations not yet applied to the target DB, and a ref with un-applied `infra/terraform` or jobs-manifest changes unless `ignore_infra_drift` is set (`scripts/ci/check-infra-drift.sh`). It does not publish the search format trigger (see [After a deploy](#after-a-deploy-search-reindex)).
- **Each hotfix roll goes through `scripts/ci/roll-cloud-run.sh`.** It rolls `SVC` to the current `:<env>` image, probes it, and rolls back on its own only when that probe fails. It has no "roll back to revision X" mode.
- **Rolling back by hand** (in prod, the owner's call) repeats the script's failure branch. Pinning traffic alone does not hold: the Cloud Run module asserts latest-revision traffic and the `*_image` tfvars are moving tags, so the next apply routes traffic back onto the broken image. Runs without an apply undo a pin too: `deploy-dev` and `deploy-prod` run `update-traffic --to-latest` after each deploy (`deploy_service`), and `rotate-apple-secret.yml` (09:00 UTC on the 1st of each month) redeploys `hf-prod-api` on its current image and then runs `--to-latest`.

  ```bash
  SVC=hf-prod-api
  IMG=us-east4-docker.pkg.dev/hearthfire-491918/services/api:prod
  # 1. stop the bleeding
  gcloud run services update-traffic "$SVC" --region us-east4 --project hearthfire-491918 \
    --to-revisions=<good-revision>=100
  # 2. point the moving tag back at the good image
  GOOD=$(gcloud run revisions describe <good-revision> --region us-east4 --project hearthfire-491918 \
    --format='value(status.imageDigest)')
  gcloud artifacts docker tags add "$GOOD" "$IMG"
  # 3. new latest revision from that tag
  gcloud run deploy "$SVC" --region us-east4 --project hearthfire-491918 --image "$IMG"
  # 4. unpin
  gcloud run services update-traffic "$SVC" --region us-east4 --project hearthfire-491918 --to-latest
  ```

  When to roll back, per-service notes and the database side: [`runbooks/rollback.md`](runbooks/rollback.md).
- **Terraform owns what runs.** A revision made by hand (`gcloud run deploy`, a console edit, a traffic pin, a paused scheduler, a removed IAM binding) is reverted by the next apply. Change the tfvars or the module and ship through a workflow. To stop a scheduled job, set `enabled = false` for it in `jobs_scheduler_overrides`. Never use `infra/docker/deploy-tileserver-cloudrun.sh`: it is a hand deploy, and it defaults to the old region.

## Runtime config and env vars

The env schemas listed in [Where each fact lives](#where-each-fact-lives) are the main variable reference. Each entry carries its default, whether prod requires it, and why. They are not complete: the first bullet below lists what reads `process.env` directly. The rest is the cross-cutting part no single schema states.

- **Reads outside the schemas** (no validation, no default in a schema; `git grep -n 'process\.env\.' -- apps packages` finds the full set, including test and script-only reads):
  - `CORS_ALLOWED_ORIGINS` (`apps/api/src/plugins/cors.ts`): comma-separated allowlist of credentialed browser origins. **Unset with `NODE_ENV=production` gives an empty allowlist, and every credentialed browser call is refused.** That includes deployed dev. Outside production it defaults to local Next.js origins. Set per env in `api_env`.
  - `DATABASE_SSL_CA_PATH`, `DATABASE_SSL_REJECT_UNAUTHORIZED` (`packages/db/src/index.ts`): applied when `DATABASE_URL` has an `sslmode` that turns SSL on. `DATABASE_SSL_REJECT_UNAUTHORIZED=0` turns off certificate checks. `PRISMA_TX_TIMEOUT`, `DEBUG_PRISMA_QUERIES` and `DEBUG_PRISMA_QUERY_PARAMS` live in the same file.
  - `THC_EVENTS_DEFAULT_REGION_CODE` (`packages/transport/trpc/src/routers/events.ts`): default region for local event listings. `AUDIO_TRANSCODE_TOPIC` and `AUDIO_TRANSCODER_URL` are read there too: unset topic means a direct fetch to the transcoder. With neither set, uploads are never transcoded, and the only signal is a `logger.warn`, which Sentry does not capture.
  - `DEV_BYPASS_STAFF_2FA` (`packages/transport/trpc/src/dev-staff-2fa-bypass.ts`): `true` or `1` turns off the staff second-factor requirement, honoured only off Cloud Run (`K_SERVICE` and `CLOUD_RUN_JOB` unset) with `NODE_ENV` unset, empty, `development` or `test`, so it never applies to a deployed service; `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` (`src/instrument.ts` in api, jobs and audio-transcoder); `OTEL_*` (`packages/adapters/src/infra/otel-bootstrap.ts`).
  - Web: several `NEXT_PUBLIC_*` values are read straight from `process.env` outside `env.public.ts`, among them `NEXT_PUBLIC_TILESERVER_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_CDN_HOSTNAME` and the `NEXT_PUBLIC_SCANNER_*` install links. The same goes for `OG_HERO_ALLOWED_HOSTS`.

- **Deployed dev runs `NODE_ENV=production`** (`api_env`, `web_env`, `jobs_env` in `dev.tfvars`). Every `isProd` branch in the schemas applies to dev too: required secrets, `DEV_INSTANT_PAYOUTS` forced off, `STRIPE_CONNECT_FORCE_CAPABILITIES` ignored. That is why dev turns off `stripe-connect.reconcile-capabilities` through `jobs_scheduler_overrides` rather than through the flag. Keep that flag's api and jobs values identical locally, or the push and pull paths disagree.
- **Deploys never pass `--set-env-vars`.** The workflows only change the image, and Terraform sets every env var. A var added by hand to a revision vanishes on the next apply.
- **A missing tfvar omits the env var entirely**, with no error. The schema's prod requirement is what catches it, and a pre-boot crash never reaches Sentry: the revision fails its startup probe and the API looks fully down with no signal. `STRIPE_CONNECT_WEBHOOK_SECRET` is boot-required in prod. A precondition in `secrets.tf` fails a prod apply when it is empty, and does the same for `sentry_dsn`. Apply Terraform before rolling an image that newly requires a value.
- **`NEXT_PUBLIC_*` and `EXPO_PUBLIC_*` are public and baked in at build time.** Changing one needs a rebuild, not a redeploy. In the deploy workflows they come from repo `vars.*` or `secrets.*` and are passed as Docker build args. For mobile they come from `eas.json`.
  - `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is the single on/off switch for Plausible (unset = no script). It is cookieless, so it is not consent-gated and never appears in the cookie banner. `NEXT_PUBLIC_PLAUSIBLE_SRC` can point at a self-hosted instance.
  - `NEXT_PUBLIC_CF_BEACON_TOKEN` is the switch for Cloudflare Web Analytics. It is not a secret, so it is stored as a repo variable. The app injects the beacon itself because Cloudflare's automatic edge injection was on for this zone and never injected.
  - `NEXT_PUBLIC_GA_MEASUREMENT_ID` loads GA only after the user accepts all cookies. It is unset in every env.
- **Origin-secret guard.** A Cloudflare Transform Rule (`infra/terraform/modules/cloudflare`) stamps `ORIGIN_SHARED_SECRET` onto every request that passes the edge as `x-origin-secret`. The API (`apps/api/src/plugins/origin-guard.ts`) and web (`apps/web/src/middleware.ts`) compare it. `ENFORCE_ORIGIN_SECRET` (tfvar `enforce_origin_secret`, which sets both services) defaults to log-only. Before flipping it, check two things: `origin_secret_mismatch` must be quiet in prod logs, and an authenticated SSR page must render signed-in data. Web SSR calls the API at its `*.run.app` origin, so a broken origin would 403 all traffic once enforcement is on.
- **Cloud Tasks queue vars** (`CLOUD_TASKS_*`, `SEARCH_DRAIN_TARGET_URL`) are all set by Terraform. Unset means that delayed path is off, not an error. `CLOUD_TASKS_TAX_FILL_QUEUE` has no fallback queue.

## Secrets

Secret Manager ids are `hf-<env>-<kebab-name>` (`app_secret_id` in `infra/terraform/secrets.tf`). Terraform creates each secret **and writes its value** on every apply from a `TF_VAR_*` variable. The workflows map a GitHub secret onto it in the step's `env:`, for example `TF_VAR_stripe_secret_key: ${{ secrets.STRIPE_SECRET_KEY_DEV }}`. Cloud Run mounts each secret at version `latest`.

GitHub naming: per-env values are repo-level `<NAME>_DEV` / `<NAME>_PROD` (24 pairs). The 22 values shared by both envs keep a `TF_VAR_` prefix (`TF_VAR_NEON_API_KEY`, `TF_VAR_SENTRY_DSN`, the OAuth client ids, and others). `TF_VAR_SENTRY_AUTH_TOKEN` also feeds the source-map uploads (the web build's, and the api/jobs upload step after each image build, `scripts/ci/upload-service-sourcemaps.sh`), so it needs only `org:read`, `project:read` and `project:releases`. **An environment-scoped secret on the `prod` (or `dev`) GitHub environment shadows the repo-level secret of the same name** in every job with `environment: prod`. Check `gh api repos/<owner>/<repo>/environments/prod/secrets` when a value seems not to take effect.

### Add a secret

1. Declare a `variable` in `infra/terraform/variables.tf` with `sensitive = true` and `default = null`.
2. In `secrets.tf`, add the key to `app_secret_keys` (gated on the var being set) and `app_secret_value_lookup`, and to the consuming service's `*_secrets` list. A non-secret value goes into the matching `resolved_*_env` local in `main.tf` instead.
3. Add the GitHub secret(s), then map `TF_VAR_<name>` in **every workflow that runs Terraform for that env**: `deploy-dev.yml` and `terraform-dev-plan.yml` (dev); `deploy-prod.yml` and `redeploy-prod.yml` (prod); `terraform-apply.yml` (both). A secret with no wiring is never created, and the consumer falls back without a sound. The jobs image moderation falls back to an auto-approving stub; Apple Wallet falls back to a stub that does nothing.
4. Plan dev and confirm the new env var shows in the Cloud Run revision diff.

`terraform-dev-plan.yml` currently lacks eight of `deploy-dev.yml`'s mappings (`consent_ip_hash_salt`, `origin_shared_secret`, `redis_url`, `sentry_dsn`, `sentry_auth_token`, `storage_s3_*`). Its plans show those secrets as changes that a real deploy won't make.

### Rotate a secret

Update the GitHub secret, then get an apply to write the new version and roll the consumers so new instances read it.

- **Dev:** dispatch `deploy-dev` with `terraform` plus the consuming services (for example `terraform,api,jobs`). Re-running a push deploy does not do it: a push runs Terraform only when `infra/terraform/**` or the jobs manifest changed. Alternatively run `terraform-apply` (dev), then roll.
- **Prod** (owner's call): `redeploy-prod` applies and then rolls api, web and jobs.
- **Prod audio-transcoder** holds the R2 keys and needs its own roll. Neither `deploy-prod` nor `redeploy-prod` rolls it. `deploy-prod` only moves its `:prod` tag, and an apply makes a new revision only when the service config changes. Its secrets are mounted at `latest`, so any new revision reads the new value. A new revision also pulls whatever `:prod` points at, which can be newer than what audio runs now. The only workflow that rolls it is `hotfix` with service `audio`. That **rebuilds from the dispatched ref** and pushes `:prod` and `:prod-<sha>`. Audio has internal ingress, so it gets **no runner-side probe and no automatic rollback** (its Cloud Run startup probe on `/health` still gates Ready). Two ways to rotate, both the owner's call in prod. Without a rebuild: retag the running digest (step 1 below) to `:prod` and `gcloud run deploy hf-prod-audio-transcoder --image <...>/audio-transcoder:prod`, as in the manual rollback's steps 2 and 3; the new revision reads the `latest` secret and Terraform leaves it alone, because the audio module ignores image changes. With a rebuild of the running commit, which also refreshes the moving `node:22` base images, and runs that ref's own `hotfix.yml` and CI scripts:
  1. Find the commit prod audio runs. Take the running revision's digest with `gcloud run services describe hf-prod-audio-transcoder --region us-east4 --project hearthfire-491918 --format='value(status.traffic[0].revisionName)'`, then `gcloud run revisions describe <revision> --region us-east4 --project hearthfire-491918 --format='value(status.imageDigest)'`. Find the `dev-<sha>` or `prod-<sha>` tag on that digest with `gcloud artifacts docker tags list us-east4-docker.pkg.dev/hearthfire-491918/services/audio-transcoder`.
  2. Point a branch or tag at that commit. `workflow_dispatch` takes a branch or tag, not a SHA, and builds the last commit on it.
  3. Dispatch `hotfix` on that ref with service `audio`, target `prod`. Its infra-drift check compares the ref with the commit behind `:prod`, and refuses if `infra/terraform` or the jobs manifest differ; overriding with `ignore_infra_drift` is the owner's call. Its migration check passes for an older ref.
  4. The roll only waits for the revision's Ready condition (`roll-cloud-run.sh` exits 0 when there is no probe path). Check an audio upload transcodes afterwards.

A `gcloud secrets versions add` is overwritten by the next apply with the GitHub value, silently.

Exceptions, where the value does not come from a GitHub secret:

- `DATABASE_URL`, `DIRECT_DATABASE_URL`: from the Neon module output. Rotate in Neon.
- `MEILISEARCH_API_KEY`: `TF_VAR_meilisearch_master_key` when set, otherwise read from an existing Secret Manager secret (`meilisearch_secret_id`; `locals` at the top of `main.tf`). Moot while `enable_meilisearch = false` in both envs.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: generated by the `aws-hf-api` module when `enable_aws` (false in both envs until AWS approves SMS). The key may send SMS straight to phone numbers and read opt-outs; publishing to any SNS topic is denied. `enable_aws` turns on SMS only. SES (email identity, SMTP user, DKIM and MAIL FROM records) needs `enable_ses` as well and stays off, because mail goes via Resend. The non-secret SMS settings are tfvars, not secrets: `aws_sms_origination_otp` and `aws_sms_origination_notifications` (toll-free numbers, wired as `AWS_SMS_ORIGINATION_OTP` / `AWS_SMS_ORIGINATION_NOTIFICATIONS`) and `aws_sms_monthly_spend_limit`. The API also gets `AWS_SNS_SMS_INBOUND_TOPIC_ARN`, the topic that carries STOP/START replies to `/webhooks/aws/sms-inbound`.
- `APPLE_CLIENT_SECRET`: Terraform seeds the version once, then `ignore_changes`. `rotate-apple-secret.yml` owns it because Apple caps the JWT at 6 months: on the 1st of each month it mints a new one, adds versions to `hf-{dev,prod}-apple-client-secret` and rolls the API. Manual fallback: `node scripts/generate-apple-client-secret.js` (its defaults are the team, key and Services ID), then dispatch the workflow or add the version by hand. Bumping `TF_VAR_APPLE_CLIENT_SECRET` does nothing after the first seed.
- `BETTER_AUTH_SECRET`: Terraform generates one when the var is unset or still the `.env.example` placeholder.

What a rotation costs:

- `BETTER_AUTH_SECRET`: invalidates every session and token in that env.
- `UNSUBSCRIBE_SECRET`: also the HKDF root of the location-obfuscation key. Rotating it moves every public obfuscation circle. Follow `docs/runbooks/rotate-unsubscribe-secret.md`.
- `CONSENT_IP_HASH_SALT`: makes that env's stored consent-log IP hashes incomparable with new ones.

### Secret traps

- **Renaming or splitting a secret can deadlock the apply.** If a rename destroys the old versions before a new enabled one exists, `latest` resolves to a destroyed version and the Cloud Run update aborts before Terraform recreates it (deploy-dev #359). Recover with `terraform apply -replace='google_secret_manager_secret_version.app["<KEY>"]'`, or seed an enabled version with `gcloud secrets versions add`, then re-apply.
- **Stripe:** dev uses `sk_test_` / `pk_test_` keys and prod uses live ones. The Connect endpoint ("Listen to events on Connected accounts") has its own signing secret, `STRIPE_CONNECT_WEBHOOK_SECRET_*`. Without it every `account.updated` fails verification, and `account.updated` is the only writer of `payoutsEnabled`. Prod's key is restricted (`rk_live_`). A missing scope fails at call time, not at boot, so a new Stripe SDK call needs its permission added to the live key (comment above `STRIPE_SECRET_KEY` in `apps/api/src/lib/env.ts`).
- **Turnstile:** one widget registered on `ithasfire.com` covers every subdomain, so dev and prod may hold the same keys. Set the site key (web, build-time) and the secret (api) for an env together, and ship **web first**. If the API requires tokens before the serving bundle can mint them, every embed guest checkout fails. Locally, use Cloudflare's always-pass test keys (site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`) in `apps/web/.env.local` and `apps/api/.env.local`. The real keys do not validate on `localhost`.
- **R2:** dev and prod may share one R2 access key pair. Their buckets are separate (`storage_s3_bucket_name` in each tfvars). The keys come from the Cloudflare dashboard, not Terraform.
- **Apple Wallet:** the pass certificate secrets must be per env, because dev and prod use different Pass Type IDs (`apple_pass_type_identifier` in the tfvars) and Apple revocation is per Pass Type ID. They default to `null`, so leaving them unset passes the apply and every "Add to Apple Wallet" quietly does nothing. The team must be `FJG7F43395`, the cert issuer; passes signed under the retired `5J9DRDR2TB` are rejected by iOS with no useful error.
- **Database backups** need no CI secrets. The dump job reads `hf-<env>-direct-database-url` at runtime. Its image is built by `pg-dump-image.yml` (dispatch, `tag` input) and pinned by tag in `db_backup_image`, never `:latest`. Keep `db_backup_lock_retention = false` until a restore drill passes, because bucket lock is irreversible. Restore and drill: `docs/runbooks/db-backup-restore.md`.

## After a deploy: search reindex

A change to what a search document holds (a new `SearchDocument` column the read side depends on, a changed projection) leaves every existing row at the old shape until a full reindex rewrites it. The new column's default is usually the fail-closed answer, so search under-returns or mis-draws until then. In 2026-07, `is_public` defaulting to false hid every event; in 2026-09, `location_is_exact` hid every venue pin.

- **Bump `SEARCH_INDEX_FORMAT_VERSION`** (`packages/core/src/use-cases/search/search-index-format.ts`) in the same change. After jobs rolls, `deploy-dev.yml`, `deploy-prod.yml` and `redeploy-prod.yml` publish to `<env>-hf-trigger-search-ensure-format`. `search.ensure-format` sees the stored version is behind and runs one full reindex. The publish is non-fatal (a warning), and `hotfix.yml` never publishes it.
- **No bump, a failed publish, or a hotfix:** the nightly `search.full-reindex` (03:00 UTC) is up to a day away. Run it now: `gcloud scheduler jobs list --location us-east4 --project hearthfire-491918 --filter="name~search-full-reindex"`, then `gcloud scheduler jobs run <name> --location us-east4 --project hearthfire-491918`. Locally: `pnpm -F api reindex:search`.
- The full reindex is non-destructive (`search-index-format-rebuild.ts`): it rewrites documents in place, so search stays up while it runs.
- If the read-side gate and the indexer change must never be live apart, ship them as two deploys: the indexer first, then the reindex, then the gate.

## Terraform

The root is `infra/terraform/` (`main.tf`, `secrets.tf`, `variables.tf`, and one file per feature such as `search-reindex.tf`). It composes the stack through `stack/` and builds from `modules/`, one module per subsystem. Providers are configured in `providers.tf`. State lives in GCS (`backend "gcs"` in `main.tf`, bucket `hf-terraform-hearthfire-491918`). Each env is a workspace (`dev`, `prod`) with its values in `envs/<env>/<env>.tfvars`. `prod.tfvars` usually carries other sessions' uncommitted work, so change it by hunk.

- **Validate:** `infra/terraform/scripts/validate.sh` (`fmt -check`, then `validate` for each module).
- **Plan dev:** dispatch `terraform-dev-plan.yml` (mind its missing mappings, above). To plan locally: `cd infra/terraform && terraform workspace select dev && ./scripts/tf.sh plan -var-file=envs/dev/dev.tfvars -lock=false`. `tf.sh` loads `infra/.env.local` (`TF_VAR_*`) and passes through to `terraform`. Use `-lock=false` because a locked local plan can fail a concurrent `deploy-dev` apply. `tf.sh plan-env` is broken: it reads a `vars/` directory that doesn't exist. A prod plan goes through the owner.
- **Apply:** only through the workflows.

### Resource names pinned to `hearthfire-*`

The product was renamed Hearthfire → Ithas Fire, but some physical names are ForceNew. Renaming them destroys and recreates the live resource. They stay as they are:

| Where | Name | Why |
| --- | --- | --- |
| `infra/terraform/modules/redis-upstash/main.tf` `database_name` | `hearthfire-<env>` | ForceNew + `prevent_destroy`. A recreate wipes Redis and rotates its connection string. |
| `infra/terraform/modules/cloudflare-cache/main.tf` ruleset `name` | `hearthfire-cache-settings` | ForceNew; it would recreate the cache ruleset for nothing. |

Neon renames in place, so `infra/terraform/modules/neon/main.tf` uses `ithasfire-<env>`. Flipping the two above broke deploy-dev #355.

### The CI identity and the WIF provider

Workflows authenticate through Workload Identity Federation (`secrets.GCP_WIF_PROVIDER`, `secrets.GCP_WIF_SERVICE_ACCOUNT`) as `github-actions@hearthfire-491918.iam.gserviceaccount.com`. The provider is declared in `infra/terraform/modules/gh-oidc`, only in the `dev` workspace. Its `attribute_condition` admits only the `a-guy-on-the-internet/Ithasfire` repo, on `workflow_dispatch`, `schedule`, `pull_request` or a push to `main`. The CI identity cannot update the provider, so any diff on it fails an apply halfway (403). The module therefore `ignore_changes` it. Change it with `gcloud iam workload-identity-pools providers update-oidc`, then mirror the change in the module. Check the pool with `gcloud iam workload-identity-pools list --location=global --project=hearthfire-491918`.

## Terraform state surgery

State surgery and applies against the prod workspace are the owner's call; prepare the commands and hand them over. Run them in a local checkout with the workspace selected, in the `infra/terraform` root that CI uses. Use the **bare** resource address. A former `infra/terraform/envs/prod/imports.tf` (since deleted) used `module.infra.*` addresses in a directory CI never loads, so it did nothing.

**Import a resource created outside Terraform.** A resource made live through a cloud API (an alert policy armed during an incident, a hand-made Secret Manager secret) is absent from state, so the next apply tries to create it and gets a 409. Import it into the workspace that declares it:

```bash
cd infra/terraform
terraform workspace select prod
terraform import google_logging_metric.neon_compute_quota hf-prod-neon-compute-quota
```

Import blocks can't guard one non-`for_each` resource per workspace, and alert-policy ids are server-assigned numbers, so use an explicit `terraform import` when you codify such a resource.

**Move the shared Artifact Registry repo to another region.** The `services` repo is one physical resource for both envs. Only the workspace with `manage_shared_artifact_registry = true` owns it (prod); dev reads it through a data source. The resource has `prevent_destroy`, so a region change plans as a blocked replace. Do it in this order, so that no apply ever points a service at an empty image path:

1. Create the repo in the new region: `gcloud artifacts repositories create services --repository-format=docker --location=<new-region> --project hearthfire-491918`. The name is `var.artifact_registry_repository` (default `services`).
2. Copy every image the tfvars name into it, registry to registry. Authenticate both hosts first (`gcloud auth configure-docker <old-region>-docker.pkg.dev,<new-region>-docker.pkg.dev`). Then run, per image:

   ```bash
   crane copy --all-tags <old-region>-docker.pkg.dev/hearthfire-491918/services/<image> \
     <new-region>-docker.pkg.dev/hearthfire-491918/services/<image>
   ```

   `crane copy` keeps each digest, so the `dev-<sha>` / `prod-<sha>` tags still name the commit that the hotfix infra-drift check looks up. gcloud has no image copy command. Without crane, use `docker pull --platform linux/amd64` (the images are built for `linux/amd64`), `docker tag` and `docker push`, which can change the digest. Check each tag with `gcloud artifacts docker tags list <new-region>-docker.pkg.dev/hearthfire-491918/services/<image>`. Don't get there by flipping the repo variables and running `deploy-dev`. That run also rolls services in `GCP_REGION`, outside Terraform, and may apply.
3. In the owner workspace, swap the state entry onto the new repo:

   ```bash
   terraform workspace select prod
   terraform state rm 'google_artifact_registry_repository.services[0]'
   terraform import 'google_artifact_registry_repository.services[0]' \
     projects/hearthfire-491918/locations/<new-region>/repositories/services
   ```

4. Change `region` and the image host in every `*_image` tfvar in both envs, and set the `GCP_REGION` / `GCP_ARTIFACT_REGISTRY_REGION` repo variables to the new region. Then apply through the workflows, dev first, and prod right after dev. The region variables are shared by every deploy workflow, so a prod hotfix in between would roll prod in the new region before prod's Terraform has moved; allow none. Dev picks up the new repo through its data source.

The old-region repo is left orphaned; delete it by hand once nothing pulls from it.

A wider region move also recreates domain mappings (a short per-host 404 while certs issue), schedulers, and the tileserver and db-backup buckets. Re-upload PMTiles to `hf-<env>-tileserver-data` with `tiles-upload.yml`, passing `bucket` explicitly: its default, `hf-dev-tiles`, is not a bucket Terraform creates. `hf-<env>-db-backups` is never `force_destroy` (`infra/terraform/modules/db-backup/main.tf`), and prod's holds the real backups. Copy or keep them before an apply tries to replace the bucket, and keep `db_backup_lock_retention = false` through the move. The KMS keyring can't be deleted and lingers in the old region. The 2026-07 move is recorded in `docs/records/2026-07-09-region-move-us-east4.md`.

## Debugging Cloud Run

Services are `hf-<env>-<name>` for `api`, `web`, `jobs`, `tileserver` and `audio-transcoder`, all in `us-east4`. Terraform also declares `meilisearch` and `valhalla` services. Both are off in both envs: `enable_meilisearch = false`, and `enable_valhalla` defaults to false.

```bash
gcloud run services logs read hf-dev-api --region us-east4 --project hearthfire-491918 --limit 50
gcloud beta run services logs tail hf-dev-api --region us-east4 --project hearthfire-491918
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="hf-dev-api" AND severity>=ERROR' \
  --project hearthfire-491918 --limit 20 --format="table(timestamp,severity,textPayload)"
gcloud run services describe hf-dev-api --region us-east4 --project hearthfire-491918 --format yaml
gcloud run revisions list --service hf-dev-api --region us-east4 --project hearthfire-491918
gcloud artifacts docker tags list us-east4-docker.pkg.dev/hearthfire-491918/services/api
```

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `artifactregistry.repositories.uploadArtifacts` denied | The CI service account lacks Artifact Registry Writer, or the WIF pool is in the wrong project | `gcloud projects get-iam-policy hearthfire-491918 --flatten="bindings[].members" --filter="bindings.members:github-actions@"` |
| Revision never becomes ready / startup probe fails | A prod-required env var is missing (the schema crashes before Sentry is up), or migration drift makes `/health` return 503 | Read the revision's logs. Apply Terraform before the roll; run the migration. |
| `Image not found` | The tag was never pushed to the `us-east4` repo | `gcloud artifacts docker tags list …/services/<service>` |
| `forces replacement` blocked by `prevent_destroy` | A pinned `hearthfire-*` name was renamed, or a region changed | Revert the name; for a region move see [state surgery](#terraform-state-surgery) |
| Cloud Run update fails: secret has no usable version | Secret-version deadlock after a rename | See [Secret traps](#secret-traps) |
| Apply 409 "already exists" | A resource made outside Terraform | [Import it](#terraform-state-surgery) |

## Mobile releases

`mobile-release.yml` and `scanner-release.yml` build with EAS on a `mobile-v*` / `scanner-v*` tag push, or on dispatch with `platform`, `profile` (`development | preview | production`) and `submit`. They need only `secrets.EXPO_TOKEN` (expo.dev → Access Tokens). Build-time values are in each app's `eas.json` under `build.<profile>.env`. Submission targets are under `submit.production`: App Store Connect app ids, and the Play `internal` track as a draft.

- A tag push submits only when the tag contains `-release` (for example `mobile-v1.2.0-release`); otherwise set `submit` on dispatch.
- Play submission reads `serviceAccountKeyPath: ../../.secrets/play-service-account.json`, a key that exists only on a local machine. `scanner-release.yml` therefore submits iOS only, and Android goes out with `eas submit --platform android` run locally. `mobile-release.yml` submits the dispatch's `platform` input, or `all` on a tag push, with no such key on the runner. Any submit that includes Android has nothing to authenticate with.

- Android Google sign-in needs the Play **app-signing** certificate fingerprint (Play Console → App integrity) registered on the Google OAuth Android client, not just the upload key's. Keystore: `docs/runbooks/android-keystore.md`.
- Store listing fields: `docs/runbooks/app-store-connect-metadata.md`.

## Prod platform admin bootstrap

Admin access is not deploy-driven in `deploy-prod.yml`. A fresh prod env has no platform admin until someone runs `./scripts/seed-prod-admin.sh` once. It needs gcloud access to `hf-prod-database-url`. It prompts for email, name and password (`read -s`, never stored), asks for confirmation, then runs `seed-platform-admin.ts` against prod. Afterwards, sign in at ithasfire.com and turn on 2FA (Account Settings → Security). Later admins are added through the UI.

`redeploy-prod.yml` still has a `seed_admin` job that upserts the admin from `PROD_SEED_ADMIN_EMAIL` / `PROD_SEED_ADMIN_PASSWORD`, which resets the password on every run. `deploy-prod.yml` removed that job for that reason.

## Local stack

`cd infra/docker && docker compose up -d` starts PostGIS `db`, `redis`, `stripe-mock`, `meilisearch`, `mailpit`, `tileserver` (:8081), `minio` (S3 :9000, console :9001, bucket created by `minio-init`) and `valhalla`. Map tiles: `scripts/dev/download-tiles.sh`, then see `infra/docker/tileserver/README.md`. Local app env lives in gitignored `.env.local` files; the API loads `apps/api/.env.local` and the repo-root `.env.local`. Database workflows: `docs/db-setup.md`.
