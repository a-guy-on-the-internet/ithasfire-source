variable "project_id" {
  description = "GCP project ID where secrets will be created."
  type        = string
}

variable "environment" {
  description = "Environment label (dev|stage|prod) for tagging purposes."
  type        = string
}

variable "name_prefix" {
  description = "Prefix applied to every secret_id (e.g. th-dev)."
  type        = string
}

variable "secrets" {
  description = "Map of logical secret keys to metadata used to create Google Secret Manager secrets."
  type = map(object({
    description = string
    optional    = optional(bool, false)
    labels      = optional(map(string), {})
  }))
  default = {}
}

variable "include_optional" {
  description = "Whether optional secrets from the catalog should be created."
  type        = bool
  default     = true
}

variable "secret_iam_bindings" {
  description = "Map of logical secret keys to members that should receive secretAccessor bindings."
  type        = map(list(string))
  default     = {}
}

variable "default_labels" {
  description = "Additional labels applied to every secret resource."
  type        = map(string)
  default     = {}
}
