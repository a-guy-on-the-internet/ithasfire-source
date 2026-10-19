# Terraform Environment Prefix Refactor

**Date:** 2026-04-16
**Status:** complete
**Priority:** P1 (Important)
**Depends on:** Existing Terraform modules in `infra/terraform/`
**Supersedes:** N/A

---

## Problem

Dev and prod Terraform workspaces share GCP project `hearthfire-491918` and the same Cloudflare zone (`hearthfire.community`). Resources created by Terraform have no environment prefix in their names. When the dev workspace runs `terraform apply`, it tries to create resources that already exist from the prod workspace, resulting in 409 conflicts (Pub/Sub topics), "record already exists" errors (Cloudflare DNS), and state collisions.

This means dev Terraform has **never successfully applied**. Cloud Scheduler jobs, Meilisearch configuration, and env var updates can only be applied through the prod workspace. Dev infrastructure changes are untestable.

---

## Goal

Prefix all shared Terraform resource names with the environment (`dev`, `prod`) so both workspaces can manage their own resources independently within the same GCP project and Cloudflare zone. Migrate existing prod resources to prefixed names without downtime.

---

## Context

| What exists | Where |
|---|---|
| Terraform root module | `infra/terraform/main.tf` |
| Jobs infrastructure (Pub/Sub, Cloud Scheduler) | `infra/terraform/generated-jobs.tf` |
| Cloud Run services module | `infra/terraform/modules/cloud-run-service/` |
| Cloud Run jobs service module | `infra/terraform/modules/cloud-run-jobs-service/` |
| Cloudflare DNS module | `infra/terraform/modules/cloudflare/` |
| SES module | `infra/terraform/modules/ses/` |
| Dev tfvars | `infra/terraform/envs/dev/dev.tfvars` |
| Prod tfvars | `infra/terraform/envs/prod/prod.tfvars` |
| Jobs manifest (topic names) | `apps/jobs/jobs.manifest.json` |
| `workspace_environment` local | `infra/terraform/main.tf` line 19 |
| Workaround: `jobs_create_pubsub = false` | `infra/terraform/envs/dev/dev.tfvars` |

---

## Current State Audit

### Already Prefixed (no changes needed)

| Resource type | Name pattern | Example |
|---|---|---|
| Cloud Run services | `hf-{env}-{service}` | `hf-dev-jobs`, `hf-prod-api` |
| Cloud Scheduler jobs | `${local.jobs_name_prefix}-{service}-{job}` | Uses `jobs_name_prefix` which includes env |
| GCS buckets | `hf-{env}-{purpose}` | `hf-dev-meilisearch-data` |

### Needs Prefixing (causes collisions)

| Resource type | Current name | Target name | Terraform resource |
|---|---|---|---|
| Pub/Sub topics | `hf-{topic}` | `hf-{env}-{topic}` | `google_pubsub_topic.jobs` |
| Pub/Sub subscriptions | `hf-{topic}-push` | `hf-{env}-{topic}-push` | `google_pubsub_subscription.jobs_push` |
| Cloudflare DNS (SES DKIM) | `{selector}._domainkey.{domain}` | Shared by design (single domain) — needs import, not prefix |
| Cloudflare DNS (SES verification) | `_amazonses.{domain}` | Shared — needs import |
| Cloudflare DNS (MAIL FROM MX) | `mail.{domain}` | Shared — needs import |
| Cloudflare DNS (app records) | `api.{domain}`, `{domain}` | Dev should use `api-dev.{domain}` or skip |

---

## Implementation Plan

### Phase 1: Prefix Pub/Sub Topics

The jobs manifest defines topic names without env prefix. The manifest should stay environment-agnostic (it's checked into code), and the prefix should be applied at the Terraform layer.

**1a. Update `generated-jobs.tf` to prefix topic names:**

```hcl
resource "google_pubsub_topic" "jobs" {
  for_each = var.jobs_image == null ? {} : local.jobs_queue_jobs
  name     = "hf-${local.workspace_environment}-${trimprefix(each.value.topic, "hf-")}"
  # ...
}
```

This transforms `hf-index-place` to `hf-dev-index-place` or `hf-prod-index-place`.

**1b. Update push subscription names to match:**

```hcl
resource "google_pubsub_subscription" "jobs_push" {
  name  = "hf-${local.workspace_environment}-${trimprefix(each.value.topic, "hf-")}-push"
  topic = google_pubsub_topic.jobs[each.key].id
  # ...
}
```

**1c. Update the jobs service to use prefixed topic names:**

The jobs service publishes to topics by name. It needs to know the environment prefix. Options:
- Pass `PUBSUB_TOPIC_PREFIX=hf-dev-` as an env var and prepend at publish time
- Or pass the full topic map as a JSON env var

Simplest: Add `PUBSUB_ENV_PREFIX` env var to the jobs service, and have the publisher prepend it.

**1d. Migrate existing prod topics:**

```bash
# For each topic in the manifest:
# 1. Create new prefixed topic
gcloud pubsub topics create hf-prod-index-place

# 2. Move subscriptions to new topic
# 3. Delete old topic after confirming no publishers remain
gcloud pubsub topics delete hf-index-place
```

Or use `terraform state mv` to rename in state + `terraform import` for the new names:

```bash
terraform state mv 'google_pubsub_topic.jobs["search.index-place"]' 'google_pubsub_topic.jobs["search.index-place"]'
# Then update the resource name in-place via terraform apply
```

### Phase 2: Handle Cloudflare DNS

DNS records for SES (DKIM, verification, MAIL FROM) are **domain-level** and shared by design — both dev and prod send email from `hearthfire.community`. These should NOT be prefixed. Instead:

**2a. Move SES DNS records to a shared module or the prod workspace only:**

Option A: Create a `shared` Terraform workspace that owns domain-level resources (SES DNS, domain verification). Dev and prod workspaces skip these.

Option B: Add `create_ses_dns = false` to dev.tfvars (like the pubsub workaround). Simpler but less clean.

**2b. App DNS records (api.hearthfire.community, etc.):**

These already point to environment-specific Cloud Run services. Verify they use the correct env-prefixed service URLs. If dev needs its own subdomain (`api-dev.hearthfire.community`), add it. If dev uses the same domains as prod (unlikely), skip DNS in dev.

### Phase 3: Remove Workarounds

After phases 1-2 are applied:
- Remove `jobs_create_pubsub` variable and `dev.tfvars` override
- Remove any conditional skips added as bandaids
- Verify both `terraform apply -var-file=envs/dev/dev.tfvars` and `terraform apply -var-file=envs/prod/prod.tfvars` succeed cleanly

---

## Migration Steps (Prod — Zero Downtime)

The migration must be done carefully to avoid dropping messages or breaking running jobs:

1. **Apply new prefixed topics** alongside old ones (Terraform creates new, old still exist in state)
2. **Update jobs service** to publish to new topic names (deploy new code)
3. **Verify** new subscriptions are receiving messages
4. **Remove old topics** from Terraform state (`terraform state rm`)
5. **Delete old topics** from GCP (`gcloud pubsub topics delete`)
6. **Clean up** — remove migration code, verify both workspaces apply clean

---

## Use Cases

No application-level use cases. This is a pure infrastructure refactor. The jobs service needs a code change to read the topic prefix from an env var.

---

## Acceptance Criteria

- [ ] `terraform apply -var-file=envs/dev/dev.tfvars` succeeds with zero errors
- [ ] `terraform apply -var-file=envs/prod/prod.tfvars` succeeds with zero errors
- [ ] Dev and prod Pub/Sub topics have environment prefixes (`hf-dev-*`, `hf-prod-*`)
- [ ] Dev and prod Cloud Scheduler jobs run independently
- [ ] Jobs service publishes to correct prefixed topics per environment
- [ ] SES DNS records are owned by one workspace only (no collision)
- [ ] No messages lost during migration
- [ ] `jobs_create_pubsub` workaround variable removed
- [ ] Dev deploy pipeline (`deploy-dev.yml`) terraform step passes
- [ ] Prod deploy pipeline (`deploy-prod.yml`) terraform step passes
- [ ] Job Discord alerts fire to correct channel per environment

---

## Open Questions

- **Shared workspace vs skip flags:** Should domain-level resources (SES DNS) live in a `shared` Terraform workspace, or should dev simply skip them? A shared workspace is cleaner but adds operational complexity (three workspaces to manage).
- **Topic migration timing:** Can we do a blue-green migration (both old and new topics exist simultaneously), or do we need to cut over atomically? Blue-green is safer but temporarily doubles Pub/Sub costs.
- **Dev DNS:** Does dev need its own DNS records at all? If dev only uses Cloud Run service URLs directly (no custom domain), we can skip all Cloudflare DNS in dev.
