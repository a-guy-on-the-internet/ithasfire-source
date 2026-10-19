locals {
  release_channel          = "REGULAR"
  default_min_node_count   = 1
  default_max_node_count   = 3
  certificate_renewal_days = 30
}

module "gsm" {
  source = "../modules/gsm"

  project_id          = var.project_id
  environment         = var.environment
  name_prefix         = local.name_prefix
  secrets             = var.secret_catalog
  include_optional    = var.include_optional_secrets
  secret_iam_bindings = var.secret_iam_bindings
  default_labels      = local.labels
}

module "redis" {
  source = "../modules/redis-upstash"

  count = var.enable_upstash ? 1 : 0

  environment    = var.environment
  region         = var.upstash_region
  primary_region = var.upstash_primary_region
  read_regions   = var.upstash_read_regions
}

module "neon" {
  source = "../modules/neon"

  count = var.enable_neon ? 1 : 0

  environment = var.environment
  org_id      = var.neon_org_id
}

module "cloudflare" {
  source = "../modules/cloudflare"

  enabled               = var.enable_cloudflare_dns
  domain                = var.domain
  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id

  api_name = var.api_name
  web_name = var.web_name

  additional_names = var.additional_names

  # Tileserver: proxied CNAME → ghs.googlehosted.com (domain mapping handles routing).
  additional_records = var.tileserver_name != null ? {
    (var.tileserver_name) = {
      type    = "CNAME"
      value   = "ghs.googlehosted.com"
      proxied = true
    }
  } : {}

  # Cloud Run owns service ingress; this stack no longer provisions a shared GKE ingress.
  # Provide ingress_target_ipv4 if you want Terraform-managed DNS pointed at some target.
  target_ipv4 = var.ingress_target_ipv4
  # Cloud Run domain mappings require CNAME → ghs.googlehosted.com.
  target_hostname = "ghs.googlehosted.com"

  # All service records CNAME → ghs.googlehosted.com. Google's domain mapping
  # frontend routes based on the Host header, so origin rules (Host rewrite)
  # are NOT needed. This works with Cloudflare Pro — Business plan not required.

  # Cloudflare Pro: proxy all traffic through Cloudflare's edge for
  # DDoS protection, HTTP/3, Brotli, and cache rules.
  #
  # CLIENT-IP / INGRESS TRUST CHAIN — READ BEFORE ADDING A LOAD BALANCER.
  # proxied=true is load-bearing for client-IP trust, not just perf. Path today:
  # client → Cloudflare (orange cloud) → Cloud Run domain mapping (CNAME
  # ghs.googlehosted.com, Host-header routed) → container. There is NO GCLB, and
  # the api Cloud Run service runs ingress=INGRESS_TRAFFIC_ALL (see
  # module "api_service" in infra/terraform/main.tf). The app trusts the
  # CF-Connecting-IP header to identify the client for rate-limiting / abuse
  # caps (packages/transport/trpc/src/context.ts `extractClientIp`). That header
  # is only unforgeable while traffic CANNOT bypass Cloudflare and hit the Cloud
  # Run origin directly.
  #
  # WHEN WE INTRODUCE A LOAD BALANCER (GCLB): switch the api Cloud Run ingress to
  # "internal-and-cloud-load-balancing", front the GCLB with Cloudflare (and/or
  # enable Cloudflare Authenticated Origin Pulls / mTLS), and RE-VERIFY the
  # client-IP header trust chain + `trustProxy` assumptions in
  # packages/transport/trpc/src/context.ts. Keep this note and the code note in
  # sync — they point at each other.
  proxied = true

  # Origin-secret guard — see the module-level comment in
  # modules/cloudflare/main.tf for the ruleset itself.
  origin_shared_secret        = var.origin_shared_secret
  enable_origin_secret_header = var.enable_origin_secret_header
}

module "cloudflare_redirects" {
  source = "../modules/cloudflare-redirects"

  zone_id   = var.enable_cloudflare_dns ? module.cloudflare.zone_id : "disabled"
  redirects = var.enable_cloudflare_dns ? var.redirects : []
}

module "cloudflare_cache" {
  source = "../modules/cloudflare-cache"

  zone_id = var.enable_cloudflare_dns ? module.cloudflare.zone_id : "disabled"

  api_host        = var.enable_cloudflare_dns ? "${var.api_name}.${var.domain}" : null
  web_host        = var.enable_cloudflare_dns ? (var.web_name == "@" ? var.domain : "${var.web_name}.${var.domain}") : null
  tileserver_host = var.enable_cloudflare_dns && var.tileserver_name != null ? "${var.tileserver_name}.${var.domain}" : null

  api_origin_hostname        = var.api_origin_hostname
  web_origin_hostname        = var.web_origin_hostname
  tileserver_origin_hostname = var.tileserver_origin_hostname
  enable_origin_rules        = var.enable_origin_rules
  enable_cache_rules         = var.enable_cache_rules

  # Plan-known "service deployed" signals used to gate origin-rule cardinality.
  # The *_origin_hostname values above are derived from Cloud Run service URLs
  # and go unknown-at-plan when a service is replaced (region move); these
  # booleans stand in for the old "*_origin_hostname != null" service-exists
  # check so count/for_each never depend on an unknown value.
  api_enabled        = var.api_enabled
  web_enabled        = var.web_enabled
  tileserver_enabled = var.tileserver_enabled
}

# AWS. enable_aws turns on SMS: the aws-hf-api IAM sender user, account SMS
# preferences and the inbound STOP/START topic (modules/sns). SES is gated
# separately on enable_ses because mail goes via Resend; it stays off unless
# both flags are true.
module "ses" {
  source = "../modules/ses"

  count = var.enable_aws && var.enable_ses ? 1 : 0

  name_prefix = local.name_prefix
  environment = var.environment
  domain      = var.domain
  from_email  = var.ses_from_email
  aws_region  = var.aws_region
}

module "sns" {
  source = "../modules/sns"

  count = var.enable_aws ? 1 : 0

  name_prefix           = local.name_prefix
  sms_inbound_subscribe = var.sms_inbound_subscribe
  sms_inbound_endpoint  = var.sms_inbound_endpoint
  sms_inbound_after     = var.sms_inbound_after

  create_sms_preferences  = var.aws_manage_sms_preferences
  sms_default_sms_type    = "Transactional"
  sms_monthly_spend_limit = var.aws_sms_monthly_spend_limit
}

module "aws_hf_api" {
  source = "../modules/aws-hf-api"

  count = var.enable_aws ? 1 : 0

  environment = var.environment
  name_prefix = local.name_prefix
  sms_region  = var.aws_region
}
