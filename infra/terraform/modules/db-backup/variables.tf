variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Region for the backup bucket, KMS key ring, Cloud Run Jobs, and Scheduler triggers. Keep in the same region as Cloud Run / Neon peering region to avoid egress."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev/stage/prod). Dev and prod share one GCP project, so every resource name derives from this."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix including the environment (e.g. 'hf-prod')."
  type        = string
}

variable "image" {
  description = "Container image for the pg-dump job (built from infra/docker/pg-dump). When null, only the storage layer (bucket, CMEK, SA, topic) is provisioned — Cloud Run Jobs + Scheduler triggers are skipped. Pin to a versioned tag (e.g. ':v1' or a git SHA), never ':latest'."
  type        = string
  default     = null
}

variable "database_url_secret_id" {
  description = "Secret Manager secret id holding the DIRECT (non-pooler) Postgres connection string (e.g. 'hf-prod-direct-database-url'). pg_dump needs session state, so the pooler endpoint must NOT be used."
  type        = string
}

variable "alert_webhook_secret_id" {
  description = "Optional Secret Manager secret id holding a Discord webhook URL for failure alerts (e.g. 'hf-prod-discord-alerts-webhook'). Null disables webhook alerting; failures still surface as failed Cloud Run Job executions."
  type        = string
  default     = null
}

variable "dump_schedule" {
  description = "Cron schedule (UTC) for the nightly dump."
  type        = string
  default     = "0 3 * * *" # 03:00 UTC = 10pm CDT, low-traffic window
}

variable "promote_schedule" {
  description = "Cron schedule (UTC) for the monthly/yearly tier promotion. Must run AFTER the daily dump on the 1st of the month."
  type        = string
  default     = "30 4 1 * *" # 1st of month, 90 min after the daily dump
}

variable "cpu" {
  description = "CPU limit for the dump job container."
  type        = string
  default     = "2"
}

variable "memory" {
  description = "Memory limit for the dump job container. Note: Cloud Run /tmp is tmpfs (counts against memory) — the entrypoint streams pg_dump into zstd so only the COMPRESSED dump lands on /tmp. Size this at ~2x the compressed dump size."
  type        = string
  default     = "4Gi"
}

variable "timeout_seconds" {
  description = "Per-execution timeout for the Cloud Run Jobs."
  type        = number
  default     = 1800 # 30 min
}

variable "max_retries" {
  description = "Cloud Run Job max retries per execution."
  type        = number
  default     = 1
}

variable "object_retention_seconds" {
  description = "Bucket retention policy period (immutability window — operators cannot delete/overwrite objects younger than this). Defense against ransomware / fat-fingered deletes."
  type        = number
  default     = 604800 # 7 days
}

variable "lock_retention_policy" {
  description = "Permanently lock the bucket retention policy (GCS Bucket Lock). IRREVERSIBLE: once locked the retention period can never be reduced or removed, and the bucket cannot be deleted while it holds objects under retention. Keep false until the first smoke-tested backup lands, then flip."
  type        = bool
  default     = false
}

variable "daily_retention_days" {
  description = "Days to keep nightly dumps under daily/."
  type        = number
  default     = 30
}

variable "monthly_retention_days" {
  description = "Days to keep monthly snapshots under monthly/ (~12 months)."
  type        = number
  default     = 365
}

variable "yearly_retention_days" {
  description = "Days to keep yearly snapshots under yearly/ (~7 years, audit retention floor)."
  type        = number
  default     = 2555
}

variable "kms_rotation_period" {
  description = "CMEK rotation period for the backup encryption key."
  type        = string
  default     = "7776000s" # 90 days
}

variable "labels" {
  description = "Extra labels merged onto every resource."
  type        = map(string)
  default     = {}
}
