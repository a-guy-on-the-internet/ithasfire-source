# ─────────────────────────────────────────────────────────────────────────────────
# Cloudflare edge security for the API: rate limiting on sign-up/sign-in, and
# a (default-OFF) Bot Fight Mode switch.
#
# Why this exists: on 2026-09-29 00:52–02:03 UTC an automated scanner running
# raw curl/7.88.1 went through Cloudflare to api.ithasfire.com, created 29
# throwaway accounts via POST /api/auth/sign-up/email in 35 minutes, signed in
# 38 times via POST /api/auth/sign-in/email, then made ~1,100 API calls. The
# app has its own Better Auth rate limiter, but it runs after the request has
# reached Cloud Run; this rule stops bursts at the edge.
#
# What it does NOT do: a 10s window (the Free-plan maximum) only stops bursts.
# An attacker pacing one sign-up every ~30s (roughly tonight's average) stays
# under it. Longer windows need the Pro plan (see var.zone_plan) or an
# app-level per-IP sign-up cap. Nor does it catch path variants: Cloudflare
# matches the normalized path but the origin gets the raw one, so a
# dot-segment path such as /api/auth/../api/authX/sign-in/email misses the
# prefix yet still reaches sign-in (apps/api/src/auth/atomic-rate-limit.ts
# covers that case in the app limiter).
#
# On Free the block is Cloudflare's default 429 page with no CORS header, so
# the web app's cross-origin fetch sees a network error, not a 429, for the
# 10s block.
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  # Per-plan limits. Free values are the ONLY values Cloudflare accepts on Free
  # (period and mitigation_timeout are fixed at 10s); anything else fails the
  # apply. Pro/business values are the target once the zone is upgraded.
  rate_limit_plan_settings = {
    free     = { period = 10, mitigation_timeout = 10, requests_per_period = 3 }
    pro      = { period = 60, mitigation_timeout = 3600, requests_per_period = 5 }
    business = { period = 60, mitigation_timeout = 3600, requests_per_period = 5 }
  }
  rate_limit = local.rate_limit_plan_settings[var.zone_plan]

  auth_path_expression = join(" or ", [
    for p in var.auth_rate_limit_path_prefixes : "starts_with(http.request.uri.path, \"${p}\")"
  ])

  # Free plan: rate-limit expressions may use only the path and verified-bot
  # fields, so http.host is omitted there (Cloudflare rejects it). The paths
  # only exist on the API hosts, so the unscoped rule covers api.ithasfire.com
  # AND api-dev.ithasfire.com, which share this zone.
  scope_by_host = var.zone_plan != "free" && length(var.auth_rate_limit_hosts) > 0
  auth_host_expression = local.scope_by_host ? "http.host in {${join(" ", [
    for h in var.auth_rate_limit_hosts : "\"${h}\""
  ])}}" : null

  auth_rate_limit_expression = local.scope_by_host ? "${local.auth_host_expression} and (${local.auth_path_expression})" : "(${local.auth_path_expression})"
}

# Zone-level http_ratelimit entrypoint ruleset. Cloudflare allows ONE ruleset
# per phase per zone, and dev + prod share ithasfire.com, so the caller must
# enable this from exactly one workspace (prod). If a ruleset for this phase
# was ever created by hand, the create fails; import it first
# (`terraform import 'module.cloudflare_security[0].cloudflare_ruleset.auth_rate_limit[0]' zone/<zone_id>/<ruleset_id>`).
#
# Counting is per client IP per Cloudflare data centre: ["ip.src",
# "cf.colo.id"] is the only characteristic set Free/Pro/Business accept.
resource "cloudflare_ruleset" "auth_rate_limit" {
  count = var.enable_auth_rate_limit ? 1 : 0

  zone_id     = var.zone_id
  name        = "ithasfire-auth-rate-limit"
  description = "Edge rate limit on Better Auth sign-up/sign-in (added after the 2026-09-29 scripted sign-up run)."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules {
    description = "Block IPs bursting sign-up/sign-in (${var.zone_plan} plan: ${coalesce(var.auth_rate_limit_requests_per_period, local.rate_limit.requests_per_period)} per ${local.rate_limit.period}s, block ${local.rate_limit.mitigation_timeout}s)"
    enabled     = true
    expression  = local.auth_rate_limit_expression
    action      = "block"

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = local.rate_limit.period
      requests_per_period = coalesce(var.auth_rate_limit_requests_per_period, local.rate_limit.requests_per_period)
      mitigation_timeout  = local.rate_limit.mitigation_timeout
    }
  }
}

# Bot Fight Mode — OFF by default, and it should stay off for this zone. See
# var.enable_bot_fight_mode: it is zone-wide, unskippable, and documented to
# challenge API and mobile-app traffic, which here means Stripe/Resend/SNS
# webhooks and the native scanner/mobile apps. Like the ruleset, bot settings
# are per-zone, so only one workspace may manage this.
# Turning it back off destroys this resource, which may not reset fight_mode
# on the zone in provider v4: confirm in the dashboard after disabling.
resource "cloudflare_bot_management" "this" {
  count = var.enable_bot_fight_mode ? 1 : 0

  zone_id    = var.zone_id
  fight_mode = true
}
