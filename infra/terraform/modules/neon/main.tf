locals {
  project_name = coalesce(var.project_name, "ithasfire-${var.environment}")
}

terraform {
  required_providers {
    neon = {
      source = "kislerdm/neon"
    }
  }
}

# Neon docs strongly recommend setting org_id to avoid cross-org surprises.
resource "neon_project" "primary" {
  name                      = local.project_name
  pg_version                = var.pg_version
  region_id                 = var.region_id
  history_retention_seconds = var.history_retention_seconds

  org_id = var.org_id

  lifecycle {
    prevent_destroy = true
    # The Neon API rejects every PATCH on the free/dev plan with
    # "editing maintenance window preferences is not allowed for this
    # account", even when we only intend to update name/pg_version —
    # the provider sends maintenance_window settings on every update.
    # Skip updates entirely; the project is provisioned and stable, and
    # drift on these attributes gets reconciled by tracking the resource
    # ID only. Re-enable specific attrs once Neon plan supports them.
    ignore_changes = all
  }
}
