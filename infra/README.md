# Ithas Fire infrastructure

- `terraform/`: GCP (Cloud Run, Cloud Tasks, Scheduler, Secret Manager), Cloudflare, Neon and Upstash. The root composes `stack/` from `modules/`; each env is a workspace with its values in `terraform/envs/<env>/<env>.tfvars`.
- `docker/`: the local compose stack (`docker-compose.yml`) and the image sources for tileserver and pg-dump.
- `.env.local.example`: template for the gitignored `infra/.env.local` that direnv and `terraform/scripts/tf.sh` load.

How code reaches dev and prod, secrets, Terraform commands and state surgery, and Cloud Run debugging: [`docs/deploy.md`](../docs/deploy.md).
