resource "cloudflare_r2_bucket" "this" {
  count      = var.enabled ? 1 : 0
  account_id = var.account_id
  name       = var.name

  # Some Cloudflare R2 locations are account-scoped; keep this optional.
  location = var.location
}
