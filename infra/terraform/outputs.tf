output "environment" {
  description = "Active environment resolved from the Terraform workspace."
  value       = local.workspace_environment
}

output "state_prefix" {
  description = "Prefix used within the remote state bucket for this environment."
  value       = "state/${local.workspace_environment}"
}

##############################################################################
# Google OAuth outputs
# Useful for bootstrapping infra/.env.local or updating the GCP console with
# the correct redirect URIs after a fresh `terraform apply`.
##############################################################################

output "google_oauth_client_id" {
  description = "Google OAuth web client ID managed by Terraform (null when enable_google_oauth = false)."
  value       = try(google_iam_oauth_client.hearthfire_web[0].name, null)
  sensitive   = false
}

output "google_oauth_client_secret" {
  description = "Google OAuth web client secret managed by Terraform (null when enable_google_oauth = false). Retrieve with: terraform output -raw google_oauth_client_secret"
  value       = try(google_iam_oauth_client_credential.hearthfire_web[0].client_secret, null)
  sensitive   = true
}



output "jobs_service_url" {
  description = "Base URL for the Jobs Cloud Run service (null when jobs_image is not set)."
  value       = var.jobs_image == null ? null : module.jobs_service[0].service_url
}

# NOTE: jobs_pubsub_topics and jobs_scheduler_jobs outputs are now in generated-jobs.tf

output "storage_s3_bucket_name" {
  description = "S3 bucket name provisioned for app storage — shared by API, jobs, audio transcoder (null when not configured)."
  value       = (var.jobs_image == null || var.storage_s3_bucket_name == null || var.cloudflare_account_id == null) ? null : module.storage_r2[0].bucket_name
}

output "api_s3_bucket_name" {
  description = "S3 bucket name intended for the API service (defaults to storage bucket when unset)."
  value       = var.api_s3_bucket_name != null ? var.api_s3_bucket_name : var.storage_s3_bucket_name
}

output "api_service_url" {
  description = "Cloud Run URL for the API service (if provisioned)."
  value       = try(module.api_service[0].service_url, null)
}

output "web_service_url" {
  description = "Cloud Run URL for the Web service (if provisioned)."
  value       = try(module.web_service[0].service_url, null)
}


output "api_image" {
  description = "Current API image reference (as configured in Terraform)."
  value       = var.api_image
}

output "web_image" {
  description = "Current Web image reference (as configured in Terraform)."
  value       = var.web_image
}

output "jobs_image" {
  description = "Current Jobs image reference (as configured in Terraform)."
  value       = var.jobs_image
}

output "meilisearch_service_url" {
  description = "Cloud Run URL for the Meilisearch service (if provisioned)."
  value       = try(module.meilisearch[0].service_url, null)
}

output "meilisearch_bucket_name" {
  description = "GCS bucket name for Meilisearch data persistence."
  value       = try(google_storage_bucket.meilisearch_data[0].name, null)
}

output "tileserver_bucket_name" {
  description = "GCS bucket name for tileserver PMTiles data."
  value       = try(google_storage_bucket.tileserver_data[0].name, null)
}

output "tileserver_service_url" {
  description = "Cloud Run URL for the Tileserver service (if provisioned)."
  value       = try(module.tileserver[0].service_url, null)
}

output "tileserver_cdn_url" {
  description = "Cloudflare-fronted URL for the Tileserver (CDN-cached). This is the URL apps should use."
  value       = local.tileserver_cdn_url
}

output "valhalla_service_url" {
  description = "Cloud Run URL for the Valhalla routing service (if provisioned). Null when disabled or using an external URL."
  value       = try(module.valhalla[0].service_url, null)
}

output "google_wallet_signer_sa_email" {
  description = "SA email that signs Google Wallet JWTs (the api-runtime SA). Authorize this in the Google Pay & Wallet console → Users tab as Developer/Admin."
  value       = var.enable_google_wallet && length(module.api_service) > 0 ? module.api_service[0].runtime_service_account_email : null
}

output "aws_sms_inbound_topic_arn" {
  description = "ARN of the inbound SMS (STOP/START) SNS topic, or null when enable_aws=false. The owner links the origination number's two-way channel to it once: aws pinpoint-sms-voice-v2 update-phone-number --phone-number-id <id> --two-way-enabled --two-way-channel-arn <this ARN>."
  value       = module.environment.aws_sms_inbound_topic_arn
}
