variable "enabled" {
  description = "Whether to create/manage the R2 bucket resources."
  type        = bool
  default     = true
}

variable "account_id" {
  description = "Cloudflare account id that owns the R2 bucket."
  type        = string
}

variable "name" {
  description = "R2 bucket name."
  type        = string
}

variable "location" {
  description = "Optional location hint for the bucket (provider/model dependent)."
  type        = string
  default     = null
}

variable "public_base_url" {
  description = "Optional public base URL for reads (e.g. a custom domain or R2 public URL)."
  type        = string
  default     = null
}

variable "default_public" {
  description = "Whether objects should be treated as public by default (application-level behavior)."
  type        = bool
  default     = false
}

# NOTE: Access keys are NOT created here.
# They should be managed via Cloudflare UI or Secrets Manager and injected at runtime.
variable "access_key_id" {
  description = "R2 access key id (optional, usually injected from Secret Manager)."
  type        = string
  sensitive   = true
  default     = null
}

variable "secret_access_key" {
  description = "R2 secret access key (optional, usually injected from Secret Manager)."
  type        = string
  sensitive   = true
  default     = null
}

variable "endpoint" {
  description = "R2 S3-compatible endpoint (optional, usually computed outside Terraform)."
  type        = string
  default     = null
}

# Internal: allows `terraform validate` inside this module directory without
# causing recursive module expansion when used as a dependency.
variable "__module_validate" {
  description = "Internal. Only used by validate.tf when validating this module in isolation."
  type        = bool
  default     = false
}
