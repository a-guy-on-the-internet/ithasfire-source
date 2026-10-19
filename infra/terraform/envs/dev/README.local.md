# Pipelines

We run **two separate pipelines** on purpose:

1) **Terraform pipeline**: provisions/updates infrastructure (Cloud Run services, IAM, Pub/Sub, Scheduler, Cloudflare DNS, secrets, etc.).
2) **gcloud/docker pipeline**: builds images, pushes them to Artifact Registry on a **stable tag**, then explicitly redeploys Cloud Run to pick up the new digest.

This avoids mixing "deploy" concerns into Terraform and keeps infra changes deterministic.

## Terraform (infra)

Use the wrapper so zsh always loads `infra/.env.local` (Cloudflare token, etc.):

```bash
./infra/terraform/scripts/tf-apply-dev.zsh plan
./infra/terraform/scripts/tf-apply-dev.zsh apply

# prod
./infra/terraform/scripts/tf-apply-prod.zsh plan
./infra/terraform/scripts/tf-apply-prod.zsh apply
```

### Terraform state + environments

Remote state is configured in `infra/terraform/main.tf` (GCS backend). Environment separation
is done via **Terraform CLI workspaces**.

- `dev` workspace uses inputs from `infra/terraform/envs/dev/dev.tfvars`
- `prod` workspace uses inputs from `infra/terraform/envs/prod/prod.tfvars`

## gcloud/docker (deploy)

Build & push stable tag `:dev` (or override `TAG=stage|prod`), then redeploy services:

```bash
./infra/terraform/scripts/deploy-dev.zsh

# Optional env knobs
TAG=dev SKIP_BUILD=1 ./infra/terraform/scripts/deploy-dev.zsh
DEPLOY_WEB=0 ./infra/terraform/scripts/deploy-dev.zsh
```

## Dev infra: local workflow helpers

This folder is meant to be runnable directly (`terraform init/plan/apply`) without having to rely on direnv.

## Terraform from zsh (loads `infra/.env.local`)

Use the wrapper script so `TF_VAR_*` is always present:

```zsh
cd ../../
terraform workspace select dev || terraform workspace new dev
terraform plan -var-file=envs/dev/dev.tfvars
```

## Build + push images (stable tag)

Pushes `api`, `web`, and `jobs` to a stable tag (default `:dev`).

```zsh
../../scripts/build-push-tags.zsh
```

To actually roll Cloud Run to the new digest after the push, use:

```zsh
../../scripts/deploy-dev.zsh
```
