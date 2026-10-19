locals {
  # Physical Upstash DB name — pinned to the original "hearthfire-*" identity.
  # database_name is ForceNew + prevent_destroy; renaming it for the rebrand
  # would destroy the live DB and rotate its endpoint/connection string.
  database_name = coalesce(var.database_name, "hearthfire-${var.environment}")
}

terraform {
  required_providers {
    upstash = {
      source = "upstash/upstash"
    }
  }
}

resource "upstash_redis_database" "primary" {
  database_name  = local.database_name
  region         = var.region
  primary_region = var.primary_region
  read_regions   = var.read_regions
  tls            = tostring(var.tls)

  lifecycle {
    prevent_destroy = true
  }
}
