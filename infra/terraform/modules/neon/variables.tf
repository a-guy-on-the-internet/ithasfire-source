variable "environment" {
  description = "Deployment environment (dev/stage/prod). Used for naming."
  type        = string
}

variable "org_id" {
  description = "Neon Organization ID. Required when creating projects."
  type        = string
  default     = null
}

variable "project_name" {
  description = "Optional override for the Neon project name."
  type        = string
  default     = null
}

variable "pg_version" {
  description = "Postgres major version for the Neon project."
  type        = number
  default     = 16
}

variable "region_id" {
  description = "Neon region id (e.g. aws-us-east-1). GCP us-central1 workloads may benefit from aws-us-east-2 (Ohio) for lower latency vs the default aws-us-east-1 (Virginia)."
  type        = string
  default     = "aws-us-east-1"
}

variable "history_retention_seconds" {
  description = "Neon history retention in seconds (max varies by plan)."
  type        = number
  default     = 21600
}
