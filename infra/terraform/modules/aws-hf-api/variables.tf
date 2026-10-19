variable "environment" {
  description = "Environment name (dev/stage/prod)."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix, typically hf-<env>."
  type        = string
}

variable "sms_region" {
  description = "AWS region used by the API when calling SNS Publish for SMS."
  type        = string
  default     = "us-east-1"
}
