variable "name_prefix" {
  description = "Prefix for resource names (e.g. hf-dev)."
  type        = string
}

variable "environment" {
  description = "Environment name (dev/stage/prod)."
  type        = string
}

variable "domain" {
  description = "Root domain to verify in SES (e.g. ithasfire.com)."
  type        = string
}

variable "from_email" {
  description = "The from-address the SMTP user is allowed to send as (e.g. no-reply@ithasfire.com)."
  type        = string
}

variable "aws_region" {
  description = "AWS region for SES SMTP endpoint derivation."
  type        = string
  default     = "us-east-1"
}

variable "enable_configuration_set" {
  description = "When true, create an SES Configuration Set for per-email metrics in the SES Console."
  type        = bool
  default     = true
}
