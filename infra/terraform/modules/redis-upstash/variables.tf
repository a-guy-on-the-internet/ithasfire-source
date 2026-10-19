variable "environment" {
  description = "Deployment environment (dev/stage/prod). Used for naming."
  type        = string
}

variable "region" {
  description = "Upstash Redis region ('global' for multi-zone databases)."
  type        = string
  default     = "global"
}

variable "primary_region" {
  description = "Primary region for global Upstash databases (e.g. us-east-1)."
  type        = string
  default     = null
}

variable "read_regions" {
  description = "Optional read regions for global Upstash databases."
  type        = set(string)
  default     = []
}

variable "database_name" {
  description = "Optional override for Upstash Redis database name."
  type        = string
  default     = null
}

variable "tls" {
  description = "Whether to require TLS for the Redis endpoint."
  type        = bool
  default     = true
}

