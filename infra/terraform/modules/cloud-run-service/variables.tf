variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
}

variable "environment" {
  description = "Environment name (dev/stage/prod)."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names (e.g. th-dev)."
  type        = string
  default     = null
}

variable "service_name" {
  description = "Base service name (without environment prefix)."
  type        = string
}

variable "image" {
  description = "Container image reference."
  type        = string
}

variable "port" {
  description = "Container port (and PORT env var)."
  type        = number
  default     = 8080
}

variable "ingress" {
  description = "Cloud Run ingress setting."
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"
}

variable "cpu" {
  description = "CPU limit (e.g. '1')."
  type        = string
  default     = null
}

variable "memory" {
  description = "Memory limit (e.g. '512Mi')."
  type        = string
  default     = null
}

variable "min_instances" {
  description = "Minimum instances."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum instances."
  type        = number
  default     = 10
}

variable "startup_cpu_boost" {
  description = "Temporarily double CPU during container startup to reduce cold-start latency. Free — Cloud Run only bills for actual usage."
  type        = bool
  default     = true
}

variable "cpu_idle" {
  description = <<-EOT
    Request-based billing. true = CPU is allocated only while a request is in
    flight, so an alive-but-idle instance costs nothing. false = CPU is
    allocated for the whole instance lifetime and billed at the full rate even
    when the instance is doing nothing.

    MUST stay true unless a service does work AFTER it has sent its response
    (post-response async, in-process timers/intervals, background drains) —
    that work is starved of CPU under request-based billing.

    Defaults to true because the provider's own default is false, which is how
    hf-prod-api and hf-prod-web each billed a full vCPU 24/7 (~$96/mo combined)
    while serving almost no real traffic: two 300s uptime checks kept one
    instance permanently alive, and always-allocated CPU billed every second of
    that idleness. Keeping the instances warm is deliberate (no cold starts);
    paying active-CPU rates for the idle time was not.
  EOT
  type        = bool
  default     = true
}

variable "startup_probe_path" {
  description = "HTTP path for the startup probe (e.g. '/health'). Set to null to disable the startup probe."
  type        = string
  default     = null
}

variable "startup_probe_initial_delay" {
  description = "Seconds to wait before sending the first startup probe."
  type        = number
  default     = 0
}

variable "startup_probe_period_seconds" {
  description = "How often (in seconds) to perform the startup probe."
  type        = number
  default     = 5
}

variable "startup_probe_failure_threshold" {
  description = "Number of consecutive failures before the container is considered failed."
  type        = number
  # Default budget: 30 × period_seconds (5) = 150s, with 3s timeout per probe.
  # The API used to cold-boot in ~45s under tsx, and a 50s budget tipped over
  # once the import graph grew. It now runs a prebuilt bundle: dev measured
  # 32s from instance start to listening (2026-10-15). The budget stays
  # generous without masking a genuine startup hang — anything past ~120s in
  # practice means something is wrong, not just slow.
  default = 30
}

variable "startup_probe_timeout_seconds" {
  description = "Number of seconds after which the probe times out."
  type        = number
  default     = 3
}

variable "env" {
  description = "Additional env vars to inject."
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

variable "invoker_service_accounts" {
  description = "Service account emails that should have roles/run.invoker on this service. Keys are stable identifiers, values are SA emails."
  type        = map(string)
  default     = {}
}

variable "allow_unauthenticated" {
  description = "If true, allow unauthenticated (allUsers) access to the service."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Additional labels (merged into default labels)."
  type        = map(string)
  default     = {}
}

variable "gcs_volume" {
  description = "Optional GCS FUSE volume configuration for persistent storage."
  type = object({
    bucket_name = string
    mount_path  = string
    read_only   = optional(bool, false)
  })
  default = null
}

variable "execution_environment" {
  description = "Cloud Run execution environment (EXECUTION_ENVIRONMENT_GEN1 or EXECUTION_ENVIRONMENT_GEN2). Gen2 required for GCS FUSE."
  type        = string
  default     = null
}
