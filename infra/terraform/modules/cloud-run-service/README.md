# cloud-run-service

Opinionated Terraform module for a single Cloud Run v2 service:

- Creates a dedicated runtime service account.
- Deploys a Cloud Run v2 service.
- Optionally grants `roles/run.invoker` to a list of invoker service accounts.

This module intentionally does **not** manage Secret Manager bindings; prefer wiring those explicitly in root infra once the secret catalog is finalized.
