# r2-bucket

Minimal Terraform module that provisions a **Cloudflare R2 bucket**.

## Notes on credentials

This module **does not create R2 access keys**. Cloudflare does not expose a stable Terraform resource for R2 API tokens/keys in the provider versions we pin.

The intended pattern in Ithas Fire is:

- Terraform creates the bucket
- R2 API credentials are stored in Secret Manager / Terraform Cloud vars / CI secrets
- Runtime services receive `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` as secrets

## Known drift — public custom domains are managed manually

The R2 **custom domains** that serve public objects are **not managed by Terraform**:

- prod: `cdn.ithasfire.com` → `hf-prod-storage`
- dev: `cdn-dev.ithasfire.com` → `hf-dev-storage`

They are connected by hand in the Cloudflare dashboard (R2 → bucket → Settings →
Custom Domains → Connect Domain), which auto-creates the proxied DNS record, the
edge TLS cert, and the bucket binding. The hostname is wired into runtime via
`storage_s3_public_base_url` (set in each env's tfvars); without it the S3/R2
adapter throws `public_base_url_not_configured` on public uploads and the API
refuses to boot in prod.

Why not in Terraform: the pinned `cloudflare/cloudflare` provider (`~> 4.0`,
locked at 4.52.7) has **no `cloudflare_r2_custom_domain` resource** (it first
ships in provider v5), and even the v5 resource has **no import support** — so
the live bindings can neither be expressed under the current pin nor imported
after a v5 upgrade (they'd have to be recreated, briefly disrupting the live
CDN mapping). Unmanaged resources are not touched by `terraform apply`, so this
drift is safe; it only means the bindings aren't reproducible from code.

**TODO (separate PR):** when upgrading the Cloudflare provider to v5, add a
`cloudflare_r2_custom_domain` resource to this module and reconcile the two live
domains via a planned recreate during a maintenance window.

## Inputs

- `account_id` (required)
- `name` (required)
- `location` (optional)
- `public_base_url` (optional)
- `default_public` (optional)

Optional passthroughs (typically injected from secrets):

- `endpoint`
- `access_key_id`
- `secret_access_key`

## Outputs

- `bucket_name`
- `endpoint`
- `public_base_url`
- `default_public`
- `access_key_id` (sensitive)
- `secret_access_key` (sensitive)
