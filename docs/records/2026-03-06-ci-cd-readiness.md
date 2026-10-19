# CI/CD Readiness (dev environment)

> Last verified: 2026-03-06

## Will it work?

**Yes.** Both the deploy pipeline (`deploy-dev.yml`) and the Terraform pipelines
(`terraform-apply.yml`, `terraform-dev-plan.yml`) have every secret, variable,
and config value they need to run against the `dev` environment.

### Verified inventory

| Layer | Source | Status |
|-------|--------|--------|
| **Repo-level secrets** (7) | `GCP_WIF_PROVIDER`, `GCP_WIF_SERVICE_ACCOUNT`, `APPLE_AUTH_KEY_P8`, `APPLE_CLIENT_ID`, `APPLE_KEY_ID`, `APPLE_TEAM_ID`, `EXPO_TOKEN` | All set |
| **`dev` environment secrets** (27) | All `TF_VAR_*` and `CLOUDFLARE_*` secrets (Stripe, Auth, SES, AWS, Google/Apple OAuth, Neon, Upstash, Ziptax, Geoapify) | All set |
| **Repo-level variables** (11) | `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ARTIFACT_REGISTRY_REGION`, `GCP_ARTIFACT_REPO`, `CLOUD_RUN_DEV_*` (4 services), `CLOUD_RUN_PROD_*` (3 services) | All set |
| **`envs/dev/dev.tfvars`** | project, region, domain, images, Cloudflare, Neon, Upstash, Meilisearch, Tileserver, R2, api_env, web_env, jobs_env | Complete |
| **`prod` environment** | Empty (no secrets yet) | Expected |

### How the pieces fit

```text
push to main
  └─ deploy-dev.yml
       ├─ builds 4 Docker images (api, web, jobs, tileserver)
       │    uses: repo secrets (GCP_WIF_*) + repo variables (GCP_*, CLOUD_RUN_DEV_*)
       └─ gcloud run deploy (rolls new revisions)

PR touching infra/**
  └─ terraform-dev-plan.yml
       ├─ environment: dev  ← pulls secrets from the dev GitHub Environment
       ├─ terraform init / workspace select dev
       └─ terraform plan -var-file=envs/dev/dev.tfvars
            uses: dev env secrets (TF_VAR_*) + values baked into dev.tfvars

manual dispatch
  └─ terraform-apply.yml
       ├─ environment: ${{ inputs.environment }}  ← dev or prod
       ├─ terraform init / workspace select
       └─ terraform apply -var-file=envs/<env>/<env>.tfvars
            uses: environment secrets (TF_VAR_*) + values baked into tfvars
```

### Terraform variable coverage

Only 3 Terraform variables are **truly required** (no default):
`project_id`, `region`, `domain` — all set in `envs/dev/dev.tfvars`.

Everything else has `default = null` or a concrete default in `variables.tf`.
Secrets that aren't in the tfvars (because they're sensitive) are injected via
`TF_VAR_*` env vars from the GitHub Environment secrets.

**Zero secrets are referenced in workflows that don't exist in GitHub.** Verified
with `comm -23` between workflow references and actual `gh secret list` output.

---

## Two tfvars files

There are two dev tfvars files. They should stay in sync:

| File | Purpose |
|------|---------|
| `infra/terraform/envs/dev/dev.tfvars` | **Local dev** via `direnv` + `./scripts/tf.sh plan-env dev`. Has inline comments explaining each section. Secrets go in `infra/.env.local`. |
| `infra/terraform/envs/dev/dev.tfvars` | **CI/CD** — referenced by `terraform-apply.yml` and `terraform-dev-plan.yml` via `-var-file=envs/dev/dev.tfvars`. Should mirror `envs/dev/dev.tfvars` for non-secret values. |

If you change a non-secret config value (e.g. add an entry to `api_env`), update **both** files.

---

## Domain swap checklist

The current domain is `ithasfire.com`. It's parameterized and swappable.
Production source code has **zero hardcoded domain references** (remaining
occurrences are only in test fixtures, email preview samples, and Storybook).

When you switch to the final domain:

### 1. Terraform tfvars (both files)

Update these values in `envs/dev/dev.tfvars` **and** `envs/dev/dev.tfvars`:

```hcl
domain = "newdomain.com"

api_env = {
  APP_BASE_URL                = "https://api.dev.newdomain.com"
  PUBLIC_WEB_URL              = "https://web.dev.newdomain.com"
  SUPPORT_URL                 = "https://help.newdomain.com"
  BETTER_AUTH_BASE_URL        = "https://api.dev.newdomain.com"
  BETTER_AUTH_JWKS_URL        = "https://api.dev.newdomain.com/api/auth/jwks"
  BETTER_AUTH_TRUSTED_ORIGINS = "https://web.dev.newdomain.com,https://api.dev.newdomain.com"
  SMTP_DEFAULT_FROM_EMAIL     = "no-reply@newdomain.com"
  # ... rest stays the same
}

web_env = {
  WEB_API_BASE_URL            = "https://api.dev.newdomain.com"
  NEXT_PUBLIC_SITE_URL        = "https://web.dev.newdomain.com"
  NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.dev.newdomain.com"
  # ... rest stays the same
}

tileserver_allowed_origins = "https://*.newdomain.com,http://localhost:3000,http://localhost:3001"
```

If transactional email is routed through Resend, keep `SMTP_DEFAULT_FROM_EMAIL` in the tfvars maps and add `TF_VAR_RESEND_API_KEY` to the deployment environment secrets so Terraform can inject `RESEND_API_KEY` into API and Jobs.

### 2. External services

| Service | Action |
|---------|--------|
| **Cloudflare** | Transfer/add the new domain zone. Update `cloudflare_zone_id` in tfvars. |
| **AWS SES** | Verify the new domain (DKIM + MAIL FROM). Request production sending if still in sandbox. |
| **Stripe** | Update the webhook endpoint URL (Dashboard > Developers > Webhooks). |
| **Google OAuth** | Update authorized redirect URIs in the GCP OAuth consent screen. |
| **Apple OAuth** | Update the Services ID redirect URLs in the Apple Developer portal. |

### 3. Apply

```bash
# Local
cd infra/terraform && ./scripts/tf.sh apply-env dev

# Or via CI
# Trigger the "Terraform apply (manual)" workflow with environment=dev
```

### 4. Verify

- Hit `https://api.dev.newdomain.com/health`
- Hit `https://web.dev.newdomain.com`
- Fire a test Stripe webhook
- Send a test email (check From domain in headers)

---

## Adding a new secret to CI

1. Add a `variable` block in `infra/terraform/variables.tf` with `sensitive = true` and `default = null`.
2. Wire it into the appropriate `resolved_*_env` local in `main.tf`.
3. Add `TF_VAR_<name>: ${{ secrets.TF_VAR_<NAME> }}` to **both** `terraform-apply.yml` and `terraform-dev-plan.yml`.
4. Create the GitHub secret:
   ```bash
   gh secret set TF_VAR_<NAME> --env dev --body "<value>"
   ```
5. Run `terraform plan` to verify the new env var appears in the Cloud Run revision diff.

## Adding a new non-secret config value

1. Add the value to `api_env` / `web_env` / `jobs_env` in **both** `envs/dev/dev.tfvars` and `envs/dev/dev.tfvars`.
2. If the API reads it, add it to the Zod schema in `apps/api/src/lib/env.ts`.
3. Run `terraform plan` and verify.
