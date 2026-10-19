locals {
  zone_id = coalesce(
    var.cloudflare_zone_id,
    try(cloudflare_zone.this[0].id, null)
  )

  record_kind  = var.target_ipv4 != null ? "A" : "CNAME"
  record_value = var.target_ipv4 != null ? var.target_ipv4 : var.target_hostname

  service_record_names = {
    api = var.api_name
    web = var.web_name
  }

  # All service records share the same CNAME target (target_hostname).
  # Google's domain mapping frontend (ghs.googlehosted.com) routes based
  # on Host header, so per-service overrides are not needed.
  service_record_values = {
    for key, name in local.service_record_names : key => local.record_value
  }

  additional_record_names = toset([
    for n in var.additional_names : trimspace(n)
    if trimspace(n) != "" && !contains(values(local.service_record_names), trimspace(n))
  ])

  # FQDNs for the origin-secret Transform Rule below. "@" means the zone apex.
  api_fqdn = var.api_name == "@" ? var.domain : "${var.api_name}.${var.domain}"
  web_fqdn = var.web_name == "@" ? var.domain : "${var.web_name}.${var.domain}"

  # Every host that reaches api/web gets the header, including additional
  # names like www (it serves /.well-known/* from web): with
  # enforce_origin_secret on, an unstamped host is a 403.
  origin_secret_hosts = distinct(concat(
    [local.api_fqdn, local.web_fqdn],
    [for n in local.additional_record_names : n == "@" ? var.domain : "${n}.${var.domain}"],
  ))

  origin_secret_trimmed = var.origin_shared_secret == null ? "" : trimspace(var.origin_shared_secret)
  has_origin_secret     = local.origin_secret_trimmed != ""
}

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

resource "cloudflare_zone" "this" {
  count = var.enabled && var.cloudflare_zone_id == null ? 1 : 0

  account_id = var.cloudflare_account_id
  zone       = var.domain
}

resource "cloudflare_record" "service" {
  for_each = var.enabled ? local.service_record_names : {}

  zone_id = local.zone_id
  name    = each.value
  type    = local.record_kind
  content = local.service_record_values[each.key]
  ttl     = var.proxied ? 1 : var.default_ttl
  proxied = var.proxied

  lifecycle {
    precondition {
      condition     = local.zone_id != null
      error_message = "cloudflare_zone_id must be provided, or cloudflare_account_id must be set so the module can create the zone."
    }

    precondition {
      condition     = alltrue([for _, v in local.service_record_names : v != null && trimspace(v) != ""])
      error_message = "api_name and web_name are required and must be non-empty. Use '@' for the zone apex."
    }
  }
}

resource "cloudflare_zone_settings_override" "security_defaults" {
  count = var.enabled ? 1 : 0

  zone_id = local.zone_id

  settings {
    # "full" encrypts CF→origin but doesn't verify the origin cert hostname.
    # Google's ghs.googlehosted.com frontend presents a *.googlehosted.com cert,
    # which won't match our custom domains.  "strict" would reject that.
    # Client-facing TLS is handled by CF Universal SSL regardless.
    ssl              = "full"
    always_use_https = "on"
    brotli           = "on"
    min_tls_version  = "1.2"
    # "on" enables TLS 1.3 without bundling 0-RTT ("zrt" would also enable
    # 0-RTT which carries replay-attack risk on payment POST endpoints).
    tls_1_3     = "on"
    early_hints = "on"
    http3       = "on"

    # HSTS with preload — this is intentionally set.
    # WARNING: once submitted to hstspreload.org, removal takes months/years.
    # All subdomains must be HTTPS-only before using this in production.
    # Reviewed and accepted: https://hstspreload.org/removal/
    security_header {
      enabled            = true
      max_age            = 31536000
      include_subdomains = true
      preload            = true
      nosniff            = true
    }
  }
}

resource "cloudflare_record" "additional" {
  # Same rationale: keep keys static; value fields may be unknown.
  for_each = var.enabled ? var.additional_records : {}

  zone_id = local.zone_id
  name    = each.key
  type    = upper(each.value.type)
  content = each.value.value
  proxied = coalesce(try(each.value.proxied, null), var.proxied)
  ttl     = coalesce(try(each.value.proxied, null), var.proxied) ? 1 : coalesce(try(each.value.ttl, null), var.default_ttl)

  lifecycle {
    precondition {
      condition     = local.zone_id != null
      error_message = "cloudflare_zone_id must be provided, or cloudflare_account_id must be set so the module can create the zone."
    }
  }
}


# ─────────────────────────────────────────────────────────────────────────────────
# Origin-secret header — interim mitigation for the "direct-to-Cloud-Run
# origin bypass" documented in apps/api/src/app.ts (trustProxy note). Cloud
# Run has public ingress and no GCLB in front of it, so a request that skips
# Cloudflare and hits the *.run.app origin directly also skips Cloudflare's
# WAF + rate limiting (CF-Connecting-IP-keyed).
#
# This Transform Rule stamps `x-origin-secret` onto every request forwarded
# to the api/web hostnames. apps/api/src/plugins/origin-guard.ts and
# apps/web/middleware.ts compare it (constant-time) against
# ORIGIN_SHARED_SECRET; requests missing/mismatching it either get logged
# (default) or rejected with 403 once ENFORCE_ORIGIN_SECRET=true.
#
# Per-zone-per-phase singleton (same caveat as the cache-settings ruleset in
# modules/cloudflare-cache) — if dev and prod share a zone, only one env
# should set enable_origin_secret_header = true.
# ─────────────────────────────────────────────────────────────────────────────────

resource "cloudflare_ruleset" "origin_secret_header" {
  count = var.enabled && var.enable_origin_secret_header && local.has_origin_secret ? 1 : 0

  zone_id     = local.zone_id
  name        = "ithasfire-origin-secret-header"
  description = "Stamp x-origin-secret on requests to api/web so the origin can detect direct-to-Cloud-Run traffic that bypassed Cloudflare."
  kind        = "zone"
  # Request-header rewrites live in the LATE transform phase. Cloudflare rejects
  # them in http_request_transform (URL rewrites only) with error 20086, which
  # failed deploy-prod 37379912040.
  phase = "http_request_late_transform"

  rules {
    description = "Set x-origin-secret for ${join(", ", local.origin_secret_hosts)}"
    enabled     = true
    expression  = "http.host in {${join(" ", [for h in local.origin_secret_hosts : "\"${h}\""])}}"
    action      = "rewrite"

    action_parameters {
      headers {
        name      = "x-origin-secret"
        operation = "set"
        value     = local.origin_secret_trimmed
      }
    }
  }
}

resource "cloudflare_record" "additional_name" {
  # Same rationale: keep keys static; record_value may be unknown.
  for_each = var.enabled ? local.additional_record_names : []

  zone_id = local.zone_id
  name    = each.value
  type    = local.record_kind
  content = local.record_value
  # Cloudflare requires ttl=1 (auto) on proxied records — same rule the
  # primary record above already applies.
  ttl     = var.proxied ? 1 : var.default_ttl
  proxied = var.proxied

  lifecycle {
    precondition {
      condition     = local.zone_id != null
      error_message = "cloudflare_zone_id must be provided, or cloudflare_account_id must be set so the module can create the zone."
    }
  }
}
