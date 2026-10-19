output "service_name" {
  description = "Cloud Run service name."
  value       = google_cloud_run_v2_service.service.name
}

output "service_url" {
  description = "Base URL for the Cloud Run service."
  value       = google_cloud_run_v2_service.service.uri
}

output "runtime_service_account_email" {
  description = "Service account email used as the execution identity for the Cloud Run service."
  value       = google_service_account.runtime.email
}
