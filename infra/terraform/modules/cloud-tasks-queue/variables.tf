variable "project_id" {
  description = "GCP project that owns the queue."
  type        = string
}

variable "location" {
  description = "Cloud Tasks location (region) for the queue."
  type        = string
}

variable "name" {
  description = "Queue name. A deleted queue's name cannot be reused for about 7 days, so treat it as permanent."
  type        = string
}

variable "max_concurrent_dispatches" {
  description = "Most tasks Cloud Tasks will have in flight at once."
  type        = number
}

variable "max_dispatches_per_second" {
  description = "Dispatch rate cap. Null keeps the Cloud Tasks default."
  type        = number
  default     = null
}

variable "max_attempts" {
  description = "Attempts per task, the first one included (-1 = unlimited)."
  type        = number
}

variable "min_backoff" {
  description = "Shortest wait before a retry, as a duration string (e.g. \"60s\")."
  type        = string
}

variable "max_backoff" {
  description = "Longest wait before a retry, as a duration string (e.g. \"300s\")."
  type        = string
}

variable "enqueuer_service_accounts" {
  description = "Service accounts allowed to create tasks on this queue (roles/cloudtasks.enqueuer, queue-scoped). Keys must be static labels; values are emails."
  type        = map(string)
  default     = {}
}

variable "grant_enqueuers_act_as_oidc" {
  description = "Give each enqueuer roles/iam.serviceAccountUser on oidc_service_account_id, which Cloud Tasks requires to create a task carrying that account's OIDC token. A plain bool so for_each never depends on a computed value."
  type        = bool
  default     = false
}

variable "oidc_service_account_id" {
  description = "Full resource id (projects/<p>/serviceAccounts/<email>) of the service account whose OIDC token the tasks carry. Required when grant_enqueuers_act_as_oidc is true; may be unknown until apply."
  type        = string
  default     = null
}
