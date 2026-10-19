variable "enabled" {
  description = "Whether this module should create/manage Cloudflare DNS resources."
  type        = bool
  default     = true
}

variable "domain" {
  description = "Root zone domain (e.g., ithasfire.com)."
  type        = string
}

variable "api_name" {
  description = "Record name for the API within the zone (relative name). Use 'api' for api.<domain>, 'api-dev' for api-dev.<domain>, or '@' for the apex."
  type        = string
}

variable "web_name" {
  description = "Record name for the web app within the zone (relative name). Use 'web' for web.<domain>, 'web-dev' for web-dev.<domain>, or '@' for the apex."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Existing Cloudflare Zone ID for var.domain. If set, the module will not create a zone."
  type        = string
  default     = null
}

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID used to create the zone when cloudflare_zone_id is not provided."
  type        = string
  default     = null
}

variable "default_ttl" {
  description = "Default TTL to use for DNS records (in seconds). Cloudflare may restrict values when proxied=true."
  type        = number
  default     = 60
}

variable "proxied" {
  description = "Whether Cloudflare proxying should be enabled for the created records."
  type        = bool
  default     = false
}

variable "target_ipv4" {
  description = "If set, create A records that point at this IPv4 address (e.g., a GCP global LB address)."
  type        = string
  default     = null
}

variable "target_hostname" {
  description = "If set (and target_ipv4 is null), create CNAME records that point at this hostname."
  type        = string
  default     = null
}

variable "service_origin_hostnames" {
  description = "DEPRECATED — no longer used.  All service records share target_hostname (ghs.googlehosted.com).  Kept for backward-compatibility; will be removed in a future cleanup."
  type        = map(string)
  default     = {}
}

variable "additional_names" {
  description = "Additional record names to create in this zone, pointing at the same target as api/web. Example: ['www', 'tickethuntr', 'api-old']. Use '@' for apex."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for n in var.additional_names : trimspace(n) != ""])
    error_message = "additional_names entries must be non-empty strings."
  }
}

variable "origin_shared_secret" {
  description = "Shared secret stamped onto the x-origin-secret request header by the origin-secret Transform Rule (see enable_origin_secret_header). Must match ORIGIN_SHARED_SECRET on the API + Web Cloud Run services (apps/api/src/plugins/origin-guard.ts, apps/web/middleware.ts). When null/empty, the ruleset is not created."
  type        = string
  sensitive   = true
  default     = null
}

variable "enable_origin_secret_header" {
  description = <<-EOT
	If true (and origin_shared_secret is set), create a Cloudflare Transform
	Rule (http_request_late_transform phase) that sets x-origin-secret on requests
	to the api/web hostnames. This lets the origin (Cloud Run, which has no
	GCLB in front of it) distinguish traffic that transited Cloudflare from
	direct-to-origin requests that bypassed its WAF/rate limiting.

	Like the cache-settings ruleset in modules/cloudflare-cache, this is a
	per-zone-per-phase singleton — if dev and prod share a zone, enable this
	on only one environment (prod).
	EOT
  type        = bool
  default     = false
}

variable "additional_records" {
  description = <<-EOT
	Optional additional record definitions (names should be relative to the zone).

	Example:
	{
		"www" = { type = "CNAME", value = "web.dev" }
	}
	EOT
  type = map(object({
    type    = string
    value   = string
    ttl     = optional(number)
    proxied = optional(bool)
  }))
  default = {}
}
