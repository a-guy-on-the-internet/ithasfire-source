variable "project_id" {
  type        = string
  description = "Cloud project identifier used across providers."
}

variable "region" {
  type        = string
  description = "Primary region for compute resources."
}

variable "domain" {
  type        = string
  description = "Root domain managed via Cloudflare."
}

variable "api_name" {
  description = "DNS record name for the API (relative to the zone). Example: 'api.dev', 'api'."
  type        = string
}

variable "web_name" {
  description = "DNS record name for the web app (relative to the zone). Example: 'web.stage', '@' (apex)."
  type        = string
}

variable "tileserver_name" {
  description = "DNS record name for the tileserver (relative to the zone). Example: 'tiles.dev'. If null, no tileserver cache rules or DNS records are created."
  type        = string
  default     = null
}

variable "tileserver_origin_hostname" {
  description = "Origin hostname (no scheme) for the tileserver Cloud Run service. Used to create a proxied CNAME for edge caching."
  type        = string
  default     = null
}

variable "additional_names" {
  description = "Additional DNS record names (relative to the zone) that should point at the same ingress target as api/web."
  type        = set(string)
  default     = []
}

variable "redirects" {
  description = "Cloudflare host-based redirects to manage via Rulesets."
  type = list(object({
    from_host             = string
    to_url                = string
    status_code           = number
    preserve_path_query   = optional(bool, true)
    exclude_path_prefixes = optional(list(string), [])
  }))
  default = []
}

variable "enable_cloudflare_dns" {
  description = "Whether Terraform should manage Cloudflare DNS records for this environment."
  type        = bool
  default     = true
}

variable "enable_origin_rules" {
  description = "If true, create Cloudflare Origin Rules to rewrite Host headers for Cloud Run. Requires Cloudflare Business plan."
  type        = bool
  default     = false
}

variable "enable_cache_rules" {
  description = "If true, create the cache-settings ruleset. Per-zone singleton; keep on prod when dev/prod share a zone."
  type        = bool
  default     = true
}

variable "origin_shared_secret" {
  description = "Shared secret stamped onto the x-origin-secret header by the Cloudflare Transform Rule (modules/cloudflare). Must match ORIGIN_SHARED_SECRET on the API + Web Cloud Run services."
  type        = string
  sensitive   = true
  default     = null
}

variable "enable_origin_secret_header" {
  description = "If true, create the Cloudflare Transform Rule that sets x-origin-secret on requests to api/web hosts. Per-zone-per-phase singleton like enable_cache_rules — keep on prod when dev/prod share a zone."
  type        = bool
  default     = false
}

variable "cloudflare_zone_id" {
  description = "Existing Cloudflare Zone ID for var.domain (preferred). If omitted, var.cloudflare_account_id must be set so the zone can be created."
  type        = string
  default     = null
}

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID used to create the zone when cloudflare_zone_id is not provided."
  type        = string
  default     = null
}

variable "ingress_target_ipv4" {
  description = "Optional override IPv4 address for DNS records (if you are pointing DNS at something outside this stack)."
  type        = string
  default     = null
}

variable "api_origin_hostname" {
  description = "Optional hostname (no scheme) that Cloudflare DNS should target for the API. Useful for Cloud Run service URLs (e.g. 'api-xyz-uc.a.run.app')."
  type        = string
  default     = null
}

variable "web_origin_hostname" {
  description = "Optional hostname (no scheme) that Cloudflare DNS should target for the Web app. Useful for Cloud Run service URLs (e.g. 'web-xyz-uc.a.run.app')."
  type        = string
  default     = null
}

# Plan-known "service deployed" signals for the cloudflare-cache origin ruleset.
# Wired in the root from static inputs (var.api_image != null, etc.) so the
# module's count/for_each never depend on a service_url-derived hostname, which
# goes unknown-at-plan when a Cloud Run service is replaced (e.g. region move).
variable "api_enabled" {
  description = "True when the API Cloud Run service is deployed in this workspace. Plan-known gate for the origin Host-rewrite rule."
  type        = bool
  default     = false
}

variable "web_enabled" {
  description = "True when the Web Cloud Run service is deployed in this workspace. Plan-known gate for the origin Host-rewrite rule."
  type        = bool
  default     = false
}

variable "tileserver_enabled" {
  description = "True when the tileserver Cloud Run service is deployed in this workspace. Plan-known gate for the origin Host-rewrite rule."
  type        = bool
  default     = false
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev/stage/prod)."

  validation {
    condition     = contains(["dev", "stage", "prod"], var.environment)
    error_message = "Environment must be one of dev, stage, or prod."
  }
}

variable "secret_catalog" {
  description = "Map of logical secrets to metadata for Secret Manager provisioning."
  type = map(object({
    description = string
    optional    = optional(bool, false)
    labels      = optional(map(string), {})
  }))
}

variable "include_optional_secrets" {
  description = "Whether optional secrets should be created in this environment."
  type        = bool
  default     = true
}

variable "secret_iam_bindings" {
  description = "Map of secret keys to IAM members granted secretAccessor."
  type        = map(list(string))
  default     = {}
}

variable "enable_aws" {
  description = "AWS for SMS (SNS / End User Messaging): IAM sender user, SMS preferences, inbound STOP topic."
  type        = bool
  default     = false
}

variable "enable_ses" {
  description = "SES email identity + SMTP user + DNS. Only takes effect with enable_aws. Off because mail goes via Resend."
  type        = bool
  default     = false
}

variable "aws_manage_sms_preferences" {
  description = "Whether this workspace owns the account-level SMS preferences (SMS type, spend limit). They are per AWS account and region, so if dev and prod share an account set this true in one workspace only, or the two applies overwrite each other."
  type        = bool
  default     = true
}

variable "aws_sms_monthly_spend_limit" {
  description = "Account-level SMS monthly spend limit in USD. Must not exceed the account's approved SMS spend quota or apply fails; raise after AWS approves the increase."
  type        = number
  default     = 1
}

variable "sms_inbound_subscribe" {
  description = "Whether to subscribe the API's inbound SMS webhook to the inbound topic. Must be known at plan time (false when no API service exists)."
  type        = bool
  default     = false
}

variable "sms_inbound_endpoint" {
  description = "HTTPS URL of the API's inbound SMS webhook (/webhooks/aws/sms-inbound)."
  type        = string
  default     = null
}

variable "sms_inbound_after" {
  description = "Ordering only: any value that is known once the API revision carrying AWS_SNS_SMS_INBOUND_TOPIC_ARN is live (its service URL). The subscription is created after it."
  type        = string
  default     = null
}

variable "aws_region" {
  description = "AWS region for SES/SNS."
  type        = string
  default     = "us-east-1"
}

variable "ses_from_email" {
  description = "The from-address that the SES SMTP user is allowed to send as."
  type        = string
  default     = "no-reply@ithasfire.com"
}

variable "enable_upstash" {
  description = "If true, provision Upstash Redis resources."
  type        = bool
  default     = false
}

variable "upstash_region" {
  description = "Upstash Redis region (or 'global' for multi-zone)."
  type        = string
  default     = "global"
}

variable "upstash_primary_region" {
  description = "Primary region for global Upstash Redis (e.g. us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "upstash_read_regions" {
  description = "Optional read regions for global Upstash Redis."
  type        = set(string)
  default     = []
}

variable "enable_neon" {
  description = "If true, provision Neon database resources."
  type        = bool
  default     = false
}

variable "neon_org_id" {
  description = "Neon Organization ID used when creating Neon projects."
  type        = string
  default     = null
}
