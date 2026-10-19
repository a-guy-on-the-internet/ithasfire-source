variable "name_prefix" {
  description = "Prefix for resource names (typically hf-<env>)."
  type        = string
}

variable "sms_inbound_subscribe" {
  description = "Whether to create the HTTPS subscription to the API. Must be known at plan time."
  type        = bool
  default     = false
}

variable "sms_inbound_endpoint" {
  description = "HTTPS URL of the API's /webhooks/aws/sms-inbound route. Required when sms_inbound_subscribe."
  type        = string
  default     = null
}

variable "sms_inbound_after" {
  description = "Ordering only: a value known once the API revision that holds the topic ARN is live. The subscription is created after it."
  type        = string
  default     = null
}

variable "sms_inbound_endpoint_auto_confirms" {
  description = "True because the API route confirms the subscription itself; Terraform then waits for the confirmation."
  type        = bool
  default     = true
}

variable "sms_inbound_confirmation_timeout_minutes" {
  description = "Minutes Terraform waits for the API to confirm the HTTPS subscription (only used when the endpoint auto-confirms)."
  type        = number
  default     = 5
}

variable "create_sms_preferences" {
  description = "Whether to configure account-level SNS SMS preferences (region-specific)."
  type        = bool
  default     = false
}

variable "sms_default_sms_type" {
  description = "Default SMS type (Transactional or Promotional)."
  type        = string
  default     = "Transactional"

  validation {
    condition     = contains(["Transactional", "Promotional"], var.sms_default_sms_type)
    error_message = "sms_default_sms_type must be either Transactional or Promotional."
  }
}

variable "sms_monthly_spend_limit" {
  description = "Monthly SMS spend limit in USD (account-level). Must not exceed the account's approved SMS spend quota or apply fails."
  type        = number
  default     = 1
}

variable "sms_delivery_status_iam_role_arn" {
  description = "Optional IAM role ARN used by SNS to write delivery statuses to CloudWatch. Null keeps delivery-status logging off."
  type        = string
  default     = null
}

variable "sms_delivery_status_success_sampling_rate" {
  description = "Optional sampling rate (0-100) for success statuses."
  type        = number
  default     = null
}
