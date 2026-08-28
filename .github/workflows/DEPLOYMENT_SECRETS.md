# Deploy workflow secrets/vars

The `deploy-dev.yml` and `promote-prod.yml` workflows assume environment values are supplied via **GitHub Secrets** and/or **GitHub Repository Variables**.

> For a full CI/CD readiness audit (including Terraform pipelines, domain-swap
> checklist, and secret/variable inventory), see **`docs/dev/ci-cd-readiness.md`**.

## Required secrets

### Repo-level (shared across all environments)

- `GCP_WIF_PROVIDER`: Workload Identity Provider resource id.
- `GCP_WIF_SERVICE_ACCOUNT`: Service account email to impersonate.
- `APPLE_AUTH_KEY_P8`, `APPLE_CLIENT_ID`, `APPLE_KEY_ID`, `APPLE_TEAM_ID`: Apple auth (mobile).
- `EXPO_TOKEN`: Expo push/build token.

### Per-environment (GitHub Environment: `dev`, `prod`)

All Terraform secrets live on the **GitHub Environment**, not at repo level.
The `terraform-apply.yml` and `terraform-dev-plan.yml` workflows specify
`environment: dev` (or `${{ inputs.environment }}`) so they pull from the
correct scope.

| Category | Secrets |
| -------- | ------- |
| Cloudflare | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ACCOUNT_ID`, `TF_VAR_CLOUDFLARE_API_KEY`, `TF_VAR_CLOUDFLARE_EMAIL` |
| Stripe | Per-env: `STRIPE_SECRET_KEY_{DEV,PROD}`, `STRIPE_PUBLISHABLE_KEY_{DEV,PROD}`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_{DEV,PROD}`, `STRIPE_WEBHOOK_SECRET_{DEV,PROD}`, `STRIPE_CONNECT_WEBHOOK_SECRET_{DEV,PROD}`. Dev MUST use `sk_test_…` / `pk_test_…`; prod uses live. |
| Turnstile (bot protection on embed checkout) | Per-env: `NEXT_PUBLIC_TURNSTILE_SITE_KEY_{DEV,PROD}` (public site key, **baked into the web bundle at build time** — see `deploy-{dev,prod}.yml`) and `TURNSTILE_SECRET_KEY_{DEV,PROD}` (server secret → `TF_VAR_turnstile_secret_key` → API Cloud Run env). **Dev and prod may use the *same* real keys**: the single Turnstile widget is registered against `ithasfire.com`, and Turnstile matches subdomains, so the one widget covers `web-dev.ithasfire.com` and `ithasfire.com` alike — populate the `_DEV` secrets with the same value as `_PROD`. **Set the site key (web) AND secret (api) for an env together** — the API requires a token the widget can't produce if only one is set, which breaks embed checkout. **Activation order matters**: ship web-first (site key baked + deployed; harmless while the API is still noop — the widget renders and every token is accepted), *then* the API secret. The reverse order — or a pipeline that applies terraform but fails before the web deploy — leaves the API demanding tokens the serving bundle can't mint, hard-failing all embed guest checkouts until web catches up. Local dev uses Cloudflare's always-pass TEST keys (site `1x00000000000000000000AA` / secret `1x0000000000000000000000000000000AA`, valid on any hostname) in `apps/web/.env.local` + `apps/api/.env.local`; the real `ithasfire.com`-scoped keys will NOT validate on `localhost`. |
| Auth | Per-env: `BETTER_AUTH_SECRET_{DEV,PROD}` (HMAC for sessions/JWTs — rotating invalidates that env's tokens), `UNSUBSCRIBE_SECRET_{DEV,PROD}`, `VOLUNTEER_SCAN_TOKEN_SECRET_{DEV,PROD}`, `JOBS_API_KEY_{DEV,PROD}`, `MEILISEARCH_MASTER_KEY_{DEV,PROD}`, `ORIGIN_SHARED_SECRET_{DEV,PROD}` (maps to `TF_VAR_origin_shared_secret`; stamped onto the `x-origin-secret` header by the Cloudflare Transform Rule and verified by the API + Web origin-secret guard — see `docs/env.md`). |
| Consent audit log | Per-env: `CONSENT_IP_HASH_SALT_{DEV,PROD}` (so dev/prod hashes are not comparable; injected into API as `CONSENT_IP_HASH_SALT`. Used to one-way-hash client IPs in the GDPR consent log. Rotate either to invalidate that env's historical hashes — generate via `openssl rand -hex 32`.) |
| SES | `TF_VAR_SES_ACCESS_KEY_ID`, `TF_VAR_SES_SECRET_ACCESS_KEY` (still shared dev↔prod — see hardening backlog) |
| SMTP (SES) | `TF_VAR_SMTP_USERNAME`, `TF_VAR_SMTP_PASSWORD` (only needed when `enable_aws=false`; when `true`, Terraform creates SMTP credentials automatically; still shared) |
| Resend | Per-env: `RESEND_API_KEY_{DEV,PROD}`, `RESEND_WEBHOOK_SECRET_{DEV,PROD}` (injected into API + Jobs as `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`; mailer prefers Resend over SMTP when present). |
| Redis | Per-env: `REDIS_URL_{DEV,PROD}`. |
| Storage (R2 / S3) | Per-env: `STORAGE_S3_ACCESS_KEY_ID_{DEV,PROD}`, `STORAGE_S3_SECRET_ACCESS_KEY_{DEV,PROD}`, `STORAGE_S3_PUBLIC_BASE_URL_{DEV,PROD}` (R2 access tokens — generated in the Cloudflare dashboard, not by Terraform). **Dev and prod intentionally use the *same* R2 access key** — both point at the same buckets, separated only by object prefix. Populate the `_DEV` secrets with the same value as `_PROD`. |
| AWS (Terraform provider) | `TF_VAR_AWS_ACCESS_KEY_ID`, `TF_VAR_AWS_SECRET_ACCESS_KEY`, `TF_VAR_AWS_ASSUME_ROLE_ARN`. **Shared dev↔prod** (single AWS account `513758041680`); same key pair across environments. |
| Google OAuth | `TF_VAR_GOOGLE_CLIENT_ID`, `TF_VAR_GOOGLE_CLIENT_SECRET`, `TF_VAR_GOOGLE_WEB_CLIENT_ID`, `TF_VAR_GOOGLE_IOS_CLIENT_ID`, `TF_VAR_GOOGLE_ANDROID_CLIENT_ID` |
| Apple OAuth | `TF_VAR_APPLE_CLIENT_ID`, `TF_VAR_APPLE_CLIENT_SECRET`, `TF_VAR_APPLE_APP_BUNDLE_IDENTIFIER`. **`APPLE_CLIENT_SECRET` (GSM `hf-{env}-apple-client-secret`) is now owned by the `rotate-apple-secret` workflow** — Terraform seeds the value once then `ignore_changes` on it, so bumping `TF_VAR_APPLE_CLIENT_SECRET` alone no longer propagates; rotate the short-lived Apple JWT via that monthly workflow (or `gcloud secrets versions add`). |
| Apple Wallet passes | Per-env: `APPLE_PASS_CERTIFICATE_P12_BASE64_{DEV,PROD}`, `APPLE_PASS_CERTIFICATE_PASSWORD_{DEV,PROD}` (→ `TF_VAR_apple_pass_certificate_p12_base64` / `_password`). These MUST be per-env, not shared: dev and prod use **different Pass Type IDs** (`pass.com.ithasfire.ticket.dev` / `pass.com.ithasfire.ticket`) and therefore different certs, because Apple revocation is all-or-nothing per Pass Type ID and there is no sandbox/production split for passes. **Both variables default to `null`**, so leaving them unset does NOT fail the apply — the API silently falls back to the stub wallet adapter and every "Add to Apple Wallet" quietly does nothing. The non-secret `apple_team_id` / `apple_pass_type_identifier` live in the tfvars, not here. Team must be `FJG7F43395`, matching the cert issuer; the burned `5J9DRDR2TB` produces passes iOS rejects without a useful error. |
| Neon / Upstash | `TF_VAR_NEON_API_KEY`, `TF_VAR_UPSTASH_API_KEY`, `TF_VAR_UPSTASH_EMAIL` |
| API keys | `TF_VAR_ZIPTAX_API_KEY`, `TF_VAR_GEOAPIFY_API_KEY` |
| Discord (alerts) | Per-env: `DISCORD_ALERTS_WEBHOOK_{DEV,PROD}` (jobs alerts also self-tag with `[dev]`/`[prod]` derived from `K_SERVICE`) |
| Discord (support) | Per-env: `DISCORD_SUPPORT_WEBHOOK_{DEV,PROD}` — webhook for the support chat widget (new threads + human escalations), injected into the **API only** as `DISCORD_SUPPORT_WEBHOOK` via `TF_VAR_discord_support_webhook`. Optional: leave unset to disable support pings; the widget still works. |
| Discord (CI) | `DISCORD_DEPLOY_DEV_WEBHOOK`, `DISCORD_DEPLOY_PROD_WEBHOOK` |
| Sentry | `TF_VAR_SENTRY_DSN`, `TF_VAR_SENTRY_AUTH_TOKEN` |
| Platform admin seed (prod only) | `PROD_SEED_ADMIN_EMAIL`, `PROD_SEED_ADMIN_PASSWORD` — required on the `prod` environment. The `seed_admin` job in `deploy-prod.yml` fails fast if either is missing. **Dev does NOT use these** — dev hardcodes `admin@ithasfire.com` / `Dev-Login-2026!` (matches the local seed fixture in `apps/api/src/scripts/seed/ids.ts`) so scanners, web, and local devs all share one known test account. |

For Cloudflare auth, prefer `CLOUDFLARE_API_TOKEN`; Terraform falls back to `TF_VAR_CLOUDFLARE_API_KEY` plus `TF_VAR_CLOUDFLARE_EMAIL` only when no token is provided.

### Database backups (pg_dump → GCS)

The backup pipeline (`infra/terraform/db-backup.tf`, spec
`docs/specs/2026-05-22/completed/pg-dump-to-gcs.spec.md`) requires **no new CI
secrets**: the dump job reads the Terraform-managed
`hf-{env}-direct-database-url` GSM secret at runtime, and failure alerts
reuse `DISCORD_ALERTS_WEBHOOK_{DEV,PROD}` (already flowing as
`TF_VAR_discord_alerts_webhook`). Configuration is plain tfvars
(`enable_db_backups`, `db_backup_image`, `db_backup_lock_retention` in
`envs/prod/prod.tfvars`). The job image is built by `pg-dump-image.yml`
(manual dispatch, `prod` environment — uses the existing `GCP_SA_KEY` +
`GCP_PROJECT_ID`/`GCP_ARTIFACT_REGISTRY_REGION`/`GCP_ARTIFACT_REPO` vars) and
pinned by tag in `db_backup_image` — never `:latest`. Restore procedure +
quarterly drill: `docs/ops/db-backup-restore-runbook.md`.

### What values do I actually put?

- `GCP_WIF_PROVIDER` must be the **full Workload Identity Provider resource name**:

  - Format: `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL_ID>/providers/<PROVIDER_ID>`
  - Where to find it:
    - After creating the provider in GCP, copy the provider's **resource name** from the console, or
    - In Terraform outputs (if you manage WIF with Terraform), or
    - From gcloud (example):
      - `gcloud iam workload-identity-pools providers describe <PROVIDER_ID> --workload-identity-pool=<POOL_ID> --location=global --format='value(name)'`

- `GCP_WIF_SERVICE_ACCOUNT` must be the **service account email** GitHub actions should impersonate:

  - Format: `<SA_NAME>@<PROJECT_ID>.iam.gserviceaccount.com`
  - Example: `gh-actions@hearthfire-491918.iam.gserviceaccount.com`
  - If you’re creating it yourself, it’s usually the same SA you bound in IAM to your provider principal via `roles/iam.workloadIdentityUser`.

(If you still use Terraform-based infra apply in CI, you may also need Cloudflare secrets like `CLOUDFLARE_API_TOKEN` etc. Those are not required for the gcloud deploy pipeline.)

## Required repository variables

- `GCP_PROJECT_ID`: e.g. `hearthfire-491918`
- `GCP_REGION`: Cloud Run region, e.g. `us-central1`
- `GCP_ARTIFACT_REGISTRY_REGION`: Artifact Registry region, e.g. `us-central1`
- `GCP_ARTIFACT_REPO`: Artifact Registry repo id, e.g. `services`

- `CLOUD_RUN_DEV_API_SERVICE`: e.g. `hf-dev-api`
- `CLOUD_RUN_DEV_WEB_SERVICE`: e.g. `hf-dev-web`
- `CLOUD_RUN_DEV_JOBS_SERVICE`: e.g. `hf-dev-jobs`

- `CLOUD_RUN_PROD_API_SERVICE`: e.g. `hf-prod-api`
- `CLOUD_RUN_PROD_WEB_SERVICE`: e.g. `hf-prod-web`
- `CLOUD_RUN_PROD_JOBS_SERVICE`: e.g. `hf-prod-jobs`

## Repo-level secrets (build-time)

| Secret | Description |
| ------ | ----------- |
| `SENTRY_AUTH_TOKEN` | Sentry auth token for source-map uploads during Docker builds. Create at **sentry.io → Settings → Auth Tokens** with `project:releases` and `org:read` scopes. |

## Optional variables

- `SKIP_BUILD`: set to `1` to pass `SKIP_BUILD=1` through Docker builds.
- `CLOUD_RUN_DEV_TILESERVER_SERVICE`: (optional) Cloud Run service name for the self-hosted tileserver. When set, the deploy workflow builds and deploys the tileserver image. Leave empty to skip.
- `SENTRY_ORG`: Sentry organization slug, e.g. `hearth-fire`.
- `SENTRY_PROJECT`: Sentry project slug, e.g. `hearth-fire-web`.

## Environment variables (Terraform-managed)

All runtime environment variables for Cloud Run services (API, Web, Jobs) are managed exclusively via Terraform:

- **Non-secret config** (e.g. `NODE_ENV`, `WEB_API_BASE_URL`) lives in `var.api_env` / `var.web_env` / `var.jobs_env` inside `envs/<env>/<env>.tfvars` (safe to commit).
- **Infra-derived values** (e.g. `DATABASE_URL`, `MEILISEARCH_HOST`, `NEXT_PUBLIC_TILESERVER_URL`) are injected automatically via `resolved_*_env` locals in `main.tf`.
- **Secrets** (e.g. `ZIPTAX_API_KEY`, `NEXT_PUBLIC_GEOAPIFY_API_KEY`) are declared as `sensitive = true` variables in `variables.tf` and supplied via `TF_VAR_*` environment variables (direnv locally, GitHub Actions secrets in CI).

The deploy workflows (`deploy-dev.yml`, `promote-prod.yml`) only update the container image — they **never** pass `--set-env-vars` or `--update-env-vars`. This prevents accidental overwrites of Terraform-managed configuration.

### Adding a new secret

1. Add a `variable` block in `infra/terraform/variables.tf` with `sensitive = true` and `default = null`.
2. Merge it conditionally into the appropriate `resolved_*_env` local in `main.tf`.
3. Set `TF_VAR_<name>` in your local `.env.local` (direnv) and as a GitHub Environment secret. Most per-env secrets follow the symmetric `<NAME>_DEV` / `<NAME>_PROD` convention without the `TF_VAR_` prefix — the workflow maps Forgejo secret → `TF_VAR_<name>` env when invoking Terraform.
4. Run `terraform plan` to verify the new env var appears in the Cloud Run revision diff.

> **Renaming or splitting an existing secret can deadlock the apply.** Cloud Run
> references the secret *container* with `version="latest"`. If a rename destroys the old
> versions before a new enabled version exists, `latest` resolves to a DESTROYED version
> and the Cloud Run update aborts *before* Terraform recreates the versions — a permanent
> deadlock (broke deploy-dev #359). Recover by force-recreating the version first
> (`terraform apply -replace='google_secret_manager_secret_version.app["<key>"]'`) or by
> seeding an enabled version with `gcloud secrets versions add`, then re-apply.

## Stable tags

We push stable tags per environment:

- dev: `:dev`
- prod: `:prod`


Cloud Run needs an explicit deploy to pick up the newest digest for a tag, so the workflow runs `gcloud run deploy` after pushing.
