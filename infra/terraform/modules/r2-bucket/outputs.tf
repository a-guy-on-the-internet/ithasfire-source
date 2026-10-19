output "bucket_name" {
  description = "R2 bucket name."
  value       = var.enabled ? cloudflare_r2_bucket.this[0].name : null
}

output "endpoint" {
  description = "R2 endpoint (if provided)."
  value       = var.endpoint
}

output "access_key_id" {
  description = "R2 access key id (if provided)."
  value       = var.access_key_id
  sensitive   = true
}

output "secret_access_key" {
  description = "R2 secret access key (if provided)."
  value       = var.secret_access_key
  sensitive   = true
}

output "public_base_url" {
  description = "Public base URL (if provided)."
  value       = var.public_base_url
}

output "default_public" {
  description = "Whether the app should treat assets as public by default."
  value       = var.default_public
}
