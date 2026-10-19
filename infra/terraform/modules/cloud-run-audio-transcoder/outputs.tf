output "service_url" {
  description = "The URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.service.uri
}

output "service_name" {
  description = "The name of the Cloud Run service."
  value       = google_cloud_run_v2_service.service.name
}

output "service_account_email" {
  description = "The email of the runtime service account (caller-provided or module-created)."
  value       = local.runtime_sa_email
}

output "pubsub_push_service_account_email" {
  description = "The email of the Pub/Sub push service account."
  value       = google_service_account.pubsub_push.email
}

output "topic_id" {
  description = "The resource ID of the Pub/Sub topic."
  value       = google_pubsub_topic.audio_transcode.id
}

output "topic_name" {
  description = "The name of the Pub/Sub topic."
  value       = google_pubsub_topic.audio_transcode.name
}

output "dlq_topic_id" {
  description = "The resource ID of the dead letter topic."
  value       = google_pubsub_topic.audio_transcode_dlq.id
}

output "subscription_name" {
  description = "The name of the Pub/Sub push subscription."
  value       = google_pubsub_subscription.audio_transcode_push.name
}
