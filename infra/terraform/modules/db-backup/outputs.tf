output "bucket_name" {
  description = "GCS bucket holding the database backups."
  value       = google_storage_bucket.backups.name
}

output "kms_crypto_key_id" {
  description = "CMEK key encrypting all backup objects."
  value       = google_kms_crypto_key.db_backups.id
}

output "service_account_email" {
  description = "Runtime SA the backup jobs execute as."
  value       = google_service_account.pg_dump.email
}

output "scheduler_service_account_email" {
  description = "SA Cloud Scheduler uses to invoke the backup jobs."
  value       = google_service_account.scheduler.email
}

output "backup_events_topic" {
  description = "Pub/Sub topic receiving backup manifest events."
  value       = google_pubsub_topic.backup_events.name
}

output "job_names" {
  description = "Cloud Run Job names keyed by purpose (empty until an image is pinned)."
  value       = { for k, j in google_cloud_run_v2_job.backup : k => j.name }
}

output "scheduler_job_names" {
  description = "Cloud Scheduler trigger names keyed by purpose (empty until an image is pinned)."
  value       = { for k, s in google_cloud_scheduler_job.backup : k => s.name }
}
