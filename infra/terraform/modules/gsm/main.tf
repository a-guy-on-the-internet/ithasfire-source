locals {
  base_labels = merge(
    {
      application = "ithasfire"
      environment = var.environment
      managed_by  = "terraform"
    },
    var.default_labels
  )

  processed_secrets = {
    for key, cfg in var.secrets :
    key => {
      optional  = lookup(cfg, "optional", false)
      labels    = merge(local.base_labels, lookup(cfg, "labels", {}))
      secret_id = format("%s-%s", var.name_prefix, trim(replace(lower(key), "/[^a-z0-9]+/", "-"), "-"))
    }
    if !lookup(cfg, "optional", false) || var.include_optional
  }

  iam_members = flatten([
    for key, members in var.secret_iam_bindings : [
      for member in distinct(members) : {
        key    = key
        member = member
      }
    ] if contains(keys(local.processed_secrets), key)
  ])

}

resource "google_secret_manager_secret" "secrets" {
  for_each = local.processed_secrets

  project   = var.project_id
  secret_id = each.value.secret_id

  replication {
    auto {}
  }

  labels = each.value.labels
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each = {
    for entry in local.iam_members :
    format("%s|%s", entry.key, entry.member) => entry
  }

  project   = var.project_id
  secret_id = google_secret_manager_secret.secrets[each.value.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}
