output "service_name" {
  description = "Cloud Run service name for the tileserver."
  value       = module.tileserver.service_name
}

output "service_url" {
  description = "Cloud Run service URL for the tileserver."
  value       = module.tileserver.service_url
}

output "runtime_service_account_email" {
  description = "Runtime service account email for the tileserver."
  value       = module.tileserver.runtime_service_account_email
}
