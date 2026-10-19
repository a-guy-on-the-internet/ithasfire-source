variable "zone_id" {
  description = "Cloudflare zone id the security rules attach to (ithasfire.com; shared by dev and prod)."
  type        = string
}

variable "zone_plan" {
  description = <<-EOT
  Cloudflare plan of the zone. Drives what the rate-limit rule may contain,
  because Cloudflare REJECTS a ruleset that exceeds the plan (the apply fails):

  - free: 1 rule; expression may use only the path and verified-bot fields
    (no http.host); period and mitigation_timeout fixed at 10s; counting by IP.
  - pro: 2 rules; host/URI/path fields; period up to 60s; timeout up to 1h.
  - business: 5 rules; period up to 10min; timeout up to 1 day.

  ithasfire.com was "Free Website" when this was written (zone read via the
  Cloudflare API on 2026-09-29). Change this only after upgrading the zone.
  EOT
  type        = string
  default     = "free"

  validation {
    condition     = contains(["free", "pro", "business"], var.zone_plan)
    error_message = "zone_plan must be one of: free, pro, business."
  }
}

variable "enable_auth_rate_limit" {
  description = "If true, create the zone's http_ratelimit ruleset (edge rate limit on sign-up/sign-in). The ruleset is a per-zone-per-phase singleton, so exactly one workspace may set this."
  type        = bool
  default     = false
}

variable "auth_rate_limit_path_prefixes" {
  description = "Request path prefixes the auth rate limit counts. Better Auth mounts sign-up/sign-in under /api/auth on the API (apps/api); the web app calls it directly from the browser, so every count is keyed on a real client IP."
  type        = list(string)
  default     = ["/api/auth/sign-up", "/api/auth/sign-in"]

  validation {
    condition     = length(var.auth_rate_limit_path_prefixes) > 0 && alltrue([for p in var.auth_rate_limit_path_prefixes : startswith(p, "/")])
    error_message = "auth_rate_limit_path_prefixes must be a non-empty list of paths starting with \"/\"."
  }
}

variable "auth_rate_limit_hosts" {
  description = "Hosts the auth rate limit is scoped to. Only applied on pro/business: the Free plan does not allow http.host in a rate-limit expression, so on Free the rule matches the path on EVERY host in the zone (which, for these paths, is only the API hosts in practice — the web app's /api/auth route is a 501 stub)."
  type        = list(string)
  default     = []
}

variable "auth_rate_limit_requests_per_period" {
  description = "Override for the number of matching requests per IP per period before blocking. Null uses the plan default (free: 3 per 10s; pro/business: 5 per 60s)."
  type        = number
  default     = null
}

variable "enable_bot_fight_mode" {
  description = <<-EOT
  If true, turn on Bot Fight Mode for the WHOLE zone. Defaults to false and
  should stay false for ithasfire.com: Bot Fight Mode cannot be scoped by path
  or host and cannot be skipped by WAF custom rules (it does not run on the
  Ruleset Engine), and Cloudflare documents that it "may challenge API or
  mobile app traffic". api.ithasfire.com receives Stripe, Resend and AWS SNS
  webhooks and native calls from the Expo scanner/mobile apps, and the web
  app's Cloud Run server calls it server-to-server. None of those can solve a
  challenge; a challenged Stripe webhook is a payments outage. Revisit only
  with Super Bot Fight Mode (Pro+, supports Skip rules) plus skips for
  /webhooks/* and the native clients.
  EOT
  type        = bool
  default     = false
}
