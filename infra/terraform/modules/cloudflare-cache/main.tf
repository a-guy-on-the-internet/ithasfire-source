terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

variable "zone_id" {
  description = "Cloudflare Zone ID."
  type        = string
}

variable "api_host" {
  description = "API hostname to apply cache bypass to (e.g. 'api.dev.example.com'). If null/empty, no rules are created."
  type        = string
  default     = null
}

variable "web_host" {
  description = "Web app hostname (e.g. 'ithasfire.com'). If null/empty, no web cache rules are created."
  type        = string
  default     = null
}

variable "tileserver_host" {
  description = "Tileserver hostname to apply aggressive edge caching to (e.g. 'tiles.dev.example.com'). If null/empty, no tile cache rules are created."
  type        = string
  default     = null
}

variable "api_origin_hostname" {
  description = "Cloud Run origin hostname for the API. Used in origin Host header rewrite rules (requires Cloudflare Business plan)."
  type        = string
  default     = null
}

variable "web_origin_hostname" {
  description = "Cloud Run origin hostname for the Web app. Used in origin Host header rewrite rules (requires Cloudflare Business plan)."
  type        = string
  default     = null
}

variable "tileserver_origin_hostname" {
  description = "Cloud Run origin hostname for the tileserver. Used in origin Host header rewrite rules (requires Cloudflare Business plan)."
  type        = string
  default     = null
}

variable "enable_origin_rules" {
  description = "If true, create the Cloudflare Origin Rules ruleset for Host header rewriting. Requires Cloudflare Business plan."
  type        = bool
  default     = false
}

variable "enable_cache_rules" {
  description = "If true, create the cache-settings ruleset. The ruleset is a per-zone-per-phase singleton; when dev and prod share a zone, only one env may own it (keep it on prod)."
  type        = bool
  default     = true
}

# Plan-known "is this service deployed in this workspace?" signals.
#
# These MUST be static (known at plan time). They gate resource cardinality
# (count / dynamic-for_each) for the origin ruleset. Do NOT derive these from a
# Cloud Run service_url — those are "known after apply" whenever the service is
# replaced (e.g. a region move: `location` is part of the resource identity, so
# changing it forces replacement and the URL becomes unknown at plan). Using an
# unknown value in count/for_each makes Terraform reject the plan with
# "Invalid count argument" / "cannot depend on values not known until apply".
#
# The corresponding *_origin_hostname values (which ARE derived from service
# URLs and may be unknown at plan) are still referenced in the rule BODIES
# below — resource attributes are allowed to be unknown at plan; only
# count/for_each may not be.
#
# Wire these in the root from static inputs, e.g.:
#   api_enabled        = var.api_image != null
#   web_enabled        = var.web_image != null
#   tileserver_enabled = var.enable_tileserver && var.tileserver_image != null
variable "api_enabled" {
  description = "True when the API Cloud Run service is deployed in this workspace. Plan-known proxy for 'api_origin_hostname will be populated'. Used to gate origin-rule cardinality."
  type        = bool
  default     = false
}

variable "web_enabled" {
  description = "True when the Web Cloud Run service is deployed in this workspace. Plan-known proxy for 'web_origin_hostname will be populated'. Used to gate origin-rule cardinality."
  type        = bool
  default     = false
}

variable "tileserver_enabled" {
  description = "True when the tileserver Cloud Run service is deployed in this workspace. Plan-known proxy for 'tileserver_origin_hostname will be populated'. Used to gate origin-rule cardinality."
  type        = bool
  default     = false
}

locals {
  api_host        = var.api_host == null ? null : trimspace(var.api_host)
  web_host        = var.web_host == null ? null : trimspace(var.web_host)
  tileserver_host = var.tileserver_host == null ? null : trimspace(var.tileserver_host)
  has_api_host    = local.api_host != null && local.api_host != ""
  has_web_host    = local.web_host != null && local.web_host != ""
  has_tile_host   = local.tileserver_host != null && local.tileserver_host != ""

  # Parent domain of the configured tile host — e.g. "tiles-prod.ithasfire.com"
  # → ".ithasfire.com". Used to scope the tiles-* cache match to this zone's
  # tile hosts (both dev + prod share the zone) without hardcoding the domain.
  tile_domain_suffix = local.has_tile_host ? replace(local.tileserver_host, "/^[^.]+/", "") : ""

  # The reader's language cookie, matched by exact name against the raw
  # `Cookie` header. Written this way because the zone is on the Free plan:
  # `http.request.cookies` needs Pro+ and the `matches` (regex) operator needs
  # Business+, so string functions over `http.cookie` are what is left. The
  # name is anchored to the start of the header or to a `;` separator, so an
  # unrelated `xth-locale=` cookie never matches. Name and default value mirror
  # LOCALE_COOKIE / DEFAULT_LOCALE in `apps/web/src/i18n/config.ts`.
  locale_cookie_present    = "(starts_with(http.cookie, \"th-locale=\") or http.cookie contains \";th-locale=\" or http.cookie contains \"; th-locale=\")"
  locale_cookie_is_default = "(http.cookie eq \"th-locale=en\" or starts_with(http.cookie, \"th-locale=en;\") or http.cookie contains \";th-locale=en;\" or http.cookie contains \"; th-locale=en;\" or ends_with(http.cookie, \";th-locale=en\") or ends_with(http.cookie, \"; th-locale=en\"))"
}

# ─────────────────────────────────────────────────────────────────────────────────
# Origin rules — rewrite Host header to Cloud Run *.run.app hostname.
#
# Cloud Run rejects requests where the Host header doesn't match its assigned
# hostname. When Cloudflare proxies, it forwards the custom domain as Host.
# These rules fix that by rewriting Host to the Cloud Run origin hostname.
# Requires Cloudflare Business plan (HostHeader override is not available on Pro or Free).
# Enable via enable_origin_rules = true when on Business+.
# ─────────────────────────────────────────────────────────────────────────────────

resource "cloudflare_ruleset" "origin_rules" {
  # Cardinality gates on PLAN-KNOWN signals only (has_*_host + *_enabled).
  # The *_origin_hostname values are derived from Cloud Run service URLs and go
  # "known after apply" when a service is replaced (e.g. region move), so they
  # must NOT appear in count/for_each — only in the rule bodies below.
  # api_enabled/web_enabled/tileserver_enabled are the static stand-in for the
  # old "*_origin_hostname != null" (service-exists) check.
  count = var.enable_origin_rules && ((local.has_api_host && var.api_enabled) || (local.has_web_host && var.web_enabled) || (local.has_tile_host && var.tileserver_enabled)) ? 1 : 0

  zone_id     = var.zone_id
  name        = "ithasfire-origin-rules"
  description = "Rewrite Host header to Cloud Run origin hostnames."
  kind        = "zone"
  phase       = "http_request_origin"

  dynamic "rules" {
    for_each = local.has_api_host && var.api_enabled ? [1] : []
    content {
      description = "Origin Host rewrite for ${local.api_host}"
      enabled     = true
      expression  = "http.host eq \"${local.api_host}\""
      action      = "route"
      action_parameters {
        host_header = var.api_origin_hostname
      }
    }
  }

  dynamic "rules" {
    for_each = local.has_web_host && var.web_enabled ? [1] : []
    content {
      description = "Origin Host rewrite for ${local.web_host}"
      enabled     = true
      expression  = "http.host eq \"${local.web_host}\""
      action      = "route"
      action_parameters {
        host_header = var.web_origin_hostname
      }
    }
  }

  dynamic "rules" {
    for_each = local.has_tile_host && var.tileserver_enabled ? [1] : []
    content {
      description = "Origin Host rewrite for ${local.tileserver_host}"
      enabled     = true
      expression  = "http.host eq \"${local.tileserver_host}\""
      action      = "route"
      action_parameters {
        host_header = var.tileserver_origin_hostname
      }
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────────
# Single cache-settings ruleset (Cloudflare allows only one per phase per zone).
#
# Rules within the ruleset:
#  1. Cache /_next/static/ for web app (immutable, 1 year)
#  2. Cache public web pages, respecting the origin's Cache-Control
#  3. Bypass cache for RSC router fetches (cache-poisoning guard)
#  4. Bypass cache for a reader who chose a non-default language
#  5. Bypass cache for API traffic (when api_host is set)
#  6. Aggressive 30-day edge / 7-day browser cache for tileserver (when enabled)
# ─────────────────────────────────────────────────────────────────────────────────

resource "cloudflare_ruleset" "cache_settings" {
  count = var.enable_cache_rules && (local.has_api_host || local.has_web_host || local.has_tile_host) ? 1 : 0

  zone_id     = var.zone_id
  name        = "hearthfire-cache-settings"
  description = "Cache settings for API bypass, web static assets, and tileserver CDN."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  # ── Web static assets (immutable, cache 1 year) ────────────────────────────
  dynamic "rules" {
    for_each = local.has_web_host ? [1] : []
    content {
      description = "Cache /_next/static/ for ${local.web_host} (immutable)"
      enabled     = true
      expression  = "http.host eq \"${local.web_host}\" and starts_with(http.request.uri.path, \"/_next/static/\")"
      action      = "set_cache_settings"

      action_parameters {
        cache = true

        edge_ttl {
          mode    = "override_origin"
          default = 31536000
        }

        browser_ttl {
          mode    = "override_origin"
          default = 31536000
        }
      }
    }
  }

  # ── Web pages — respect origin Cache-Control (s-maxage) ────────────────
  # Next.js sets s-maxage + stale-while-revalidate on public pages.
  # Tell Cloudflare to cache HTML responses and respect the origin TTL.
  # Excludes admin, platform, auth, API, ticket QR, and the two buyer payment
  # surfaces (/events/checkout, /events/resale).
  #
  # The payment exclusions are DEFENCE IN DEPTH. The authoritative control is
  # the origin: `apps/web/next.config.ts` narrows its `/events` cache-header
  # rule so those two routes never get `public, s-maxage`, and Cloudflare
  # honours the resulting `private, no-store` (BYPASS) even under `cache =
  # true`. Until 2026-09 this description claimed checkout was excluded while
  # the expression did not mention it, and production was observed serving
  # checkout HTML with `cf-cache-status: EXPIRED`.
  #
  # Prefixes are matched WITH the trailing slash (plus an exact-path clause for
  # the bare route) so an organiser slug that merely starts with "checkout" —
  # /events/checkout-collective/... — keeps its edge cache. Same segment
  # boundary the next.config lookahead uses.
  dynamic "rules" {
    for_each = local.has_web_host ? [1] : []
    content {
      description = "Cache public pages for ${local.web_host} (respect origin headers)"
      enabled     = true
      expression  = "http.host eq \"${local.web_host}\" and not starts_with(http.request.uri.path, \"/_next/\") and not starts_with(http.request.uri.path, \"/tickets/qr\") and not starts_with(http.request.uri.path, \"/admin\") and not starts_with(http.request.uri.path, \"/platform\") and not starts_with(http.request.uri.path, \"/api\") and not starts_with(http.request.uri.path, \"/sign-in\") and not starts_with(http.request.uri.path, \"/sign-up\") and not starts_with(http.request.uri.path, \"/forgot-password\") and not starts_with(http.request.uri.path, \"/reset-password\") and not starts_with(http.request.uri.path, \"/events/checkout/\") and http.request.uri.path ne \"/events/checkout\" and not starts_with(http.request.uri.path, \"/events/resale/\") and http.request.uri.path ne \"/events/resale\""
      action      = "set_cache_settings"

      action_parameters {
        cache = true

        edge_ttl {
          mode = "respect_origin"
        }

        browser_ttl {
          mode = "bypass"
        }
      }
    }
  }

  # ── RSC router fetches never enter the cache ────────────────────────────────
  #
  # Next answers a router fetch that arrives without its cache-busting search
  # param (`RSC: 1`, no `?_rsc=`) with a 307 to the `?_rsc=` form — a redirect it
  # issues specifically because CDNs ignore `Vary`. That 307 inherits whatever
  # Cache-Control the origin's header rules already stamped on the response, and
  # our cache key does not include the RSC header, so the redirect lands under
  # the PLAIN url's key and is then served to ordinary browsers. Reproduced on
  # production 2026-09-04: one unauthenticated `curl -H 'RSC: 1'` against an
  # event page put a 307 in the edge cache and every normal navigation to that
  # page got the redirect instead of the page until the entry aged out.
  #
  # The AUTHORITATIVE fix is at the origin — `apps/web/next.config.ts` now
  # carries `missing: [{ type: "header", key: "RSC" }]` on every rule that
  # stamps `public, s-maxage` on an app page, so an RSC-shaped request gets the
  # framework's `private, no-store` instead. This rule is DEFENCE IN DEPTH: it
  # keeps the hole shut if a new public prefix is ever added to next.config
  # without the guard. Same relationship the checkout/resale exclusions above
  # have with their origin counterpart — change both together.
  #
  # ORDER IS LOAD-BEARING. This must stay AFTER the "Cache public pages" rule.
  # `set_cache_settings` is a non-terminating action, so every matching rule in
  # the phase runs and "the last change made by rules in the same phase will
  # win" — a bypass placed before the caching rule would simply be overwritten.
  #
  # Matches `RSC: 1` exactly rather than mere presence: `isRSCRequestHeader`
  # accepts only the literal "1", so only that value can produce the 307 that
  # this rule exists to keep out of the cache.
  #
  # `/_next/` is excluded so this can never override rule 1's 1-year immutable
  # cache on hashed static chunks. Those are `<script src>` loads and never
  # carry an RSC header, but the exclusion makes that structural.
  #
  # Cost: RSC flight payloads for prefetch and client-side navigation stop being
  # edge-cacheable and go to the origin. Cold document loads, crawls and share
  # previews are untouched — they carry no RSC header and keep their edge cache.
  dynamic "rules" {
    for_each = local.has_web_host ? [1] : []
    content {
      description = "Bypass cache for RSC router fetches on ${local.web_host} (poisoning guard)"
      enabled     = true
      expression  = "http.host eq \"${local.web_host}\" and not starts_with(http.request.uri.path, \"/_next/\") and any(http.request.headers[\"rsc\"][*] == \"1\")"
      action      = "set_cache_settings"

      action_parameters {
        cache = false
      }
    }
  }

  # ── A reader's language choice never reads from or fills the cache ──────────
  #
  # The web app renders in the reader's chosen language: the `th-locale` cookie
  # wins over Accept-Language. The cache key is the URL alone, and cookies in a
  # custom cache key are Enterprise-only (this zone is on Free). Without this
  # rule a Spanish chooser who fills a colo's cache stores Spanish HTML that
  # English visitors then get: fresh for s-maxage (2 to 60 minutes), then
  # served stale while revalidating for up to stale-while-revalidate more
  # (5 minutes to 2 hours), so up to about 3 hours on the info pages. The same
  # chooser gets cached English on a hit, so the page flips language after
  # hydration. Owner ruling 2026-10-17: bypass the edge for a reader who chose
  # a non-default language.
  #
  # The AUTHORITATIVE half is at the origin: `apps/web/next.config.ts` carries
  # `sharedCacheGuards()` on every rule that stamps `public, s-maxage` on an
  # app page, so such a request gets the framework's `private, no-store` and
  # is never STORED. That half alone still lets the chooser READ a cached
  # English copy; this rule closes the lookup. Change both together.
  #
  # ORDER IS LOAD-BEARING, same as the RSC rule above: this must stay AFTER the
  # "Cache public pages" rule, because `set_cache_settings` is non-terminating
  # and the last matching rule in the phase wins.
  #
  # Matches "a `th-locale` pair whose value is not exactly `en`", so a new
  # locale needs no edit here, and garbage values over-cover harmlessly (an
  # origin render). One gap, with no regex on Free: a header carrying BOTH an
  # `en` and a non-default pair (`th-locale=en; th-locale=es`) reads as
  # default here. The app's single host-only writer cannot produce that; a
  # crafted request gets a cached English page, and the origin guard (which
  # matches any non-default pair) still keeps its render out of the cache.
  #
  # `/_next/` is excluded so this never overrides rule 1's immutable cache on
  # hashed static chunks, which do not vary by language.
  #
  # Cost: HTML for readers who chose Spanish always goes to the origin, and
  # each uncached web render makes its SSR tRPC calls to the API, so the load
  # lands on both services and the database. That is a small share of traffic
  # today. Signal to watch: in Cloudflare analytics for the web host, the
  # BYPASS share of cf-cache-status on HTML, against web and API Cloud Run
  # request counts.
  # If it grows, a locale path prefix would make the URL the cache key again.
  dynamic "rules" {
    for_each = local.has_web_host ? [1] : []
    content {
      description = "Bypass cache for a non-default language choice on ${local.web_host}"
      enabled     = true
      expression  = "http.host eq \"${local.web_host}\" and not starts_with(http.request.uri.path, \"/_next/\") and ${local.locale_cookie_present} and not ${local.locale_cookie_is_default}"
      action      = "set_cache_settings"

      action_parameters {
        cache = false
      }
    }
  }

  # ── API cache bypass ────────────────────────────────────────────────────────
  dynamic "rules" {
    for_each = local.has_api_host ? [1] : []
    content {
      description = "Bypass cache for ${local.api_host}"
      enabled     = true
      expression  = "http.host eq \"${local.api_host}\""
      action      = "set_cache_settings"

      action_parameters {
        cache = false
      }
    }
  }

  # ── Tileserver edge cache ───────────────────────────────────────────────────
  # Tiles + static images are immutable per dataset version.
  # 30-day edge TTL, 7-day browser TTL.
  #
  # Host match is a "tiles-*" prefix scoped to this zone's domain (not
  # eq ${local.tileserver_host}) on purpose: this cache ruleset is a
  # per-zone-per-phase singleton owned by prod, but dev + prod share the zone.
  # Matching only the prod host left dev tiles (tiles-dev.*) uncached
  # (cf-cache-status: DYNAMIC), so every map view hit the dev Cloud Run origin
  # and burst-429'd (surfacing in the browser as a bogus CORS error, since the
  # 429 drops the origin's ACAO header). Tiles are immutable and env-independent,
  # so caching every tiles-* host in the zone is safe and covers both dev + prod.
  # The ${local.tile_domain_suffix} guard keeps the match scoped to real tile
  # hosts on this zone rather than any future tiles-* label anywhere.
  dynamic "rules" {
    for_each = local.has_tile_host ? [1] : []
    content {
      description = "Cache tile responses from tiles-* hosts (dev + prod share the zone)"
      enabled     = true
      expression  = "starts_with(http.host, \"tiles-\") and ends_with(http.host, \"${local.tile_domain_suffix}\")"
      action      = "set_cache_settings"

      action_parameters {
        cache = true

        edge_ttl {
          mode    = "override_origin"
          default = 2592000 # 30 days
        }

        browser_ttl {
          mode    = "override_origin"
          default = 604800 # 7 days
        }
      }
    }
  }
}
