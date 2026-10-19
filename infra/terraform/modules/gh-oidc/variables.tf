variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "pool_id" {
  description = "Workload Identity Pool ID"
  type        = string
  default     = "github"
}

variable "provider_id" {
  description = "Workload Identity Provider ID"
  type        = string
  default     = "github"
}

variable "repository_name" {
  description = "GitHub repository name (owner/repo)"
  type        = string
}

variable "service_account_email" {
  description = "Service account email to allow impersonation for"
  type        = string
}
