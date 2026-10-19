# ─────────────────────────────────────────────────────────────────────────────────
# Cloud Run domain mappings
#
# Cloudflare DNS CNAMEs (modules/cloudflare) point every host at
# ghs.googlehosted.com; these mappings tell Google's frontend which Cloud Run
# service owns each Host header. Previously created manually for the old
# domain — now Terraform-managed for ithasfire.com.
#
# PREREQUISITE: the domain must be verified (Search Console) by the identity
# running terraform apply, or mapping creation fails with a verification error.
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  dm_api_name   = coalesce(var.api_name, local.workspace_environment == "prod" ? "api" : "api-${local.workspace_environment}")
  dm_web_name   = coalesce(var.web_name, local.workspace_environment == "prod" ? "@" : "web-${local.workspace_environment}")
  dm_tiles_name = var.enable_tileserver ? coalesce(var.tileserver_name, "tiles-${local.workspace_environment}") : null

  dm_api_host   = "${local.dm_api_name}.${var.domain}"
  dm_web_host   = local.dm_web_name == "@" ? var.domain : "${local.dm_web_name}.${var.domain}"
  dm_tiles_host = local.dm_tiles_name != null ? "${local.dm_tiles_name}.${var.domain}" : null
}

resource "google_cloud_run_domain_mapping" "api" {
  count = var.api_image == null ? 0 : 1

  project  = var.project_id
  location = local.api_region
  name     = local.dm_api_host

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = module.api_service[0].service_name
  }
}

resource "google_cloud_run_domain_mapping" "web" {
  count = var.web_image == null ? 0 : 1

  project  = var.project_id
  location = local.web_region
  name     = local.dm_web_host

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = module.web_service[0].service_name
  }
}

# www serves the web app directly (no redirect at origin). The Cloudflare
# redirect ruleset 301s www → apex at the edge for everything EXCEPT
# /.well-known/* — Apple's AASA fetcher does not follow redirects, and the
# mobile app declares applinks:www.ithasfire.com.
resource "google_cloud_run_domain_mapping" "www" {
  count = local.workspace_environment == "prod" && var.web_image != null ? 1 : 0

  project  = var.project_id
  location = local.web_region
  name     = "www.${var.domain}"

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = module.web_service[0].service_name
  }
}

resource "google_cloud_run_domain_mapping" "tileserver" {
  count = var.enable_tileserver && var.tileserver_image != null ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = local.dm_tiles_host

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = module.tileserver[0].service_name
  }
}
