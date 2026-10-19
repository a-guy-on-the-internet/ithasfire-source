variable "project_id" {
  type        = string
  description = "GCP project ID."
}

variable "region" {
  type        = string
  description = "GCP region for the Cloud Run service."
}

variable "environment" {
  type        = string
  description = "Environment name (dev/stage/prod). Used for naming/labels."
}

variable "service_name" {
  type        = string
  description = "Base name for the Cloud Run service (without environment prefix)."
  default     = "audio-transcoder"
}

variable "name_prefix" {
  type        = string
  description = "Optional name prefix (e.g. 'th-dev'). If null, defaults to 'th-<environment>'."
  default     = null
}

variable "image" {
  type        = string
  description = "Container image ref (e.g. gcr.io/<project>/<image>:<tag> or artifact registry)."
}

variable "port" {
  type        = number
  description = "Container port the service listens on."
  default     = 8080
}

variable "env" {
  description = "Extra environment variables to pass to the container (non-secret)."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Map of env var name → Secret Manager reference. Rendered as value_source.secret_key_ref on the container."
  type = map(object({
    secret  = string
    version = optional(string, "latest")
  }))
  default = {}
}

variable "s3" {
  description = "S3-compatible storage configuration (Cloudflare R2, MinIO, AWS S3, etc.)."
  type = object({
    bucket            = string
    endpoint          = string
    access_key_id     = string
    secret_access_key = string
    public_base_url   = optional(string)
    public_read       = optional(bool)
  })
  sensitive = true
}

variable "invoker_service_accounts" {
  description = "Map of stable keys to service account emails that should be granted roles/run.invoker on the service."
  type        = map(string)
  default     = {}
}

variable "labels" {
  description = "Extra labels to apply to resources (merged with module defaults)."
  type        = map(string)
  default     = {}
}

# ─────────────────────────────────────────────────────────────────────────────
# Cloud Run scaling configuration
# ─────────────────────────────────────────────────────────────────────────────

variable "min_instances" {
  type        = number
  description = "Minimum number of Cloud Run instances."
  default     = 0
}

variable "max_instances" {
  type        = number
  description = "Maximum number of Cloud Run instances."
  default     = 5
}

variable "cpu" {
  type        = string
  description = "CPU allocation for each container instance."
  default     = "1"
}

variable "memory" {
  type        = string
  description = "Memory allocation for each container instance."
  default     = "1Gi"
}

variable "timeout_seconds" {
  type        = number
  description = "Request timeout in seconds. Audio transcoding can take time."
  default     = 900 # 15 minutes
}

variable "concurrency" {
  type        = number
  description = "Maximum concurrent requests per container instance."
  default     = 1 # Transcoding is CPU-intensive, process one at a time
}

# ─────────────────────────────────────────────────────────────────────────────
# Pub/Sub configuration
# ─────────────────────────────────────────────────────────────────────────────

variable "pubsub_ack_deadline_seconds" {
  type        = number
  description = "Pub/Sub acknowledgement deadline in seconds."
  default     = 600 # 10 minutes
}

variable "pubsub_message_retention_duration" {
  type        = string
  description = "How long to retain unacked messages."
  default     = "604800s" # 7 days
}

variable "pubsub_dead_letter_max_delivery_attempts" {
  type        = number
  description = "Maximum delivery attempts before sending to dead letter topic."
  default     = 5
}

# Runtime service account, created by the CALLER (root) so the caller's secret
# IAM binding can depend on the real SA without pulling this whole module into
# its dependency graph (which cycles once the module also waits on the secret
# IAM time_sleep). If null, the module falls back to creating its own SA —
# only used for standalone `terraform validate`.
variable "runtime_service_account_email" {
  description = "Email of the externally-created runtime service account. If null, the module creates its own (standalone/validate only)."
  type        = string
  default     = null
}

# External resources the Cloud Run *service* (and only the service) must wait
# for before its template is applied — e.g. Secret Manager IAM propagation.
# Gating only the service keeps the graph acyclic.
variable "service_depends_on" {
  description = "Resources the Cloud Run service must wait on (e.g. secret IAM propagation). Applied only to the service."
  type        = list(any)
  default     = []
}

# Internal: allows `terraform validate` inside this module directory
variable "__module_validate" {
  description = "Internal. Only used by validate.tf when validating this module in isolation."
  type        = bool
  default     = false
}
