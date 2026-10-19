# ─────────────────────────────────────────────────────────────────────────────────
# Cloudflare edge security (rate limiting + Bot Fight Mode switch).
# See modules/cloudflare-security/main.tf for the incident this answers and
# the Free-plan limits it is written against.
#
# Zone singleton: dev and prod share the ithasfire.com zone
# (ae9fe4278faf52acd2a4a6cc66b1a1c8 in both envs/*/*.tfvars), and Cloudflare
# allows one ruleset per phase per zone and one bot-management config per
# zone. Only the PROD workspace instantiates this module — same ownership rule
# as the cache-settings ruleset (enable_cloudflare_cache_rules) and the
# walletobjects project service. On Free the rule is not host-scoped, so it
# covers api-dev.ithasfire.com too without dev managing anything.
#
# Rollout: both variables default to false; envs/prod/prod.tfvars turns the
# rate limit on (owner 2026-10-14) and leaves Bot Fight Mode off. The
# Cloudflare token must carry "Zone WAF: Edit" (and "Bot Management: Edit" if
# Bot Fight Mode is ever turned on) before the prod apply runs with the flag
# true; otherwise the apply fails with a 403 and blocks deploy_prod.
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  cloudflare_security_owner = local.workspace_environment == "prod"

  # api.<domain> (prod) and api-dev.<domain> (dev) — the naming rule in
  # main.tf's module "environment" (api_name). Used only when the zone plan
  # allows http.host in rate-limit expressions (pro/business).
  cloudflare_auth_rate_limit_hosts = coalesce(
    var.cloudflare_auth_rate_limit_hosts,
    ["api.${var.domain}", "api-dev.${var.domain}"],
  )
}

module "cloudflare_security" {
  source = "./modules/cloudflare-security"
  count  = local.cloudflare_security_owner && var.enable_cloudflare_dns && var.cloudflare_zone_id != null ? 1 : 0

  zone_id   = var.cloudflare_zone_id
  zone_plan = var.cloudflare_zone_plan

  enable_auth_rate_limit              = var.enable_cloudflare_auth_rate_limit
  auth_rate_limit_hosts               = local.cloudflare_auth_rate_limit_hosts
  auth_rate_limit_requests_per_period = var.cloudflare_auth_rate_limit_requests_per_period

  enable_bot_fight_mode = var.enable_cloudflare_bot_fight_mode
}
