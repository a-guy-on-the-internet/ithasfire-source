output "redis_endpoint" {
  description = "Upstash Redis endpoint (null when disabled)."
  value       = var.enable_upstash ? module.redis[0].endpoint : null
  sensitive   = true
}

output "redis_port" {
  description = "Upstash Redis port (null when disabled)."
  value       = var.enable_upstash ? module.redis[0].port : null
}

output "redis_password" {
  description = "Upstash Redis password (null when disabled)."
  value       = var.enable_upstash ? module.redis[0].password : null
  sensitive   = true
}

output "redis_url" {
  description = "Upstash Redis connection URL (rediss)."
  value = var.enable_upstash ? format(
    "rediss://:%s@%s:%s",
    module.redis[0].password,
    module.redis[0].endpoint,
    module.redis[0].port
  ) : null
  sensitive = true
}

output "neon_connection_uri" {
  description = "Neon Postgres connection URI (null when disabled)."
  value       = var.enable_neon ? module.neon[0].default_connection_uri : null
  sensitive   = true
}

output "neon_pooler_connection_uri" {
  description = "Neon Postgres pooler connection URI (null when disabled)."
  value       = var.enable_neon ? module.neon[0].pooler_connection_uri : null
  sensitive   = true
}

# ── SES outputs ──────────────────────────────────────────────────────────────────

output "ses_smtp_username" {
  description = "SES SMTP username (IAM access key ID for the SMTP user)."
  value       = length(module.ses) > 0 ? module.ses[0].smtp_username : null
}

output "ses_smtp_password" {
  description = "SES SMTP password (derived from IAM secret via SES signing algorithm)."
  value       = length(module.ses) > 0 ? module.ses[0].smtp_password : null
  sensitive   = true
}

output "ses_smtp_host" {
  description = "SES SMTP endpoint hostname."
  value       = length(module.ses) > 0 ? module.ses[0].smtp_host : null
}

output "ses_dkim_tokens" {
  description = "DKIM tokens for DNS CNAME records."
  value       = length(module.ses) > 0 ? module.ses[0].dkim_tokens : []
}

output "ses_mail_from_domain" {
  description = "MAIL FROM subdomain that needs MX + TXT records."
  value       = length(module.ses) > 0 ? module.ses[0].mail_from_domain : null
}

output "ses_configuration_set_name" {
  description = "SES Configuration Set name for the X-SES-CONFIGURATION-SET header (null when disabled)."
  value       = length(module.ses) > 0 ? module.ses[0].configuration_set_name : null
}

# ── AWS API credentials (SNS SMS) ───────────────────────────────────────────────

output "aws_sms_inbound_topic_arn" {
  description = "ARN of the inbound SMS (STOP/START) topic, or null when enable_aws=false."
  # Index the output directly: `length(module.sns)` would reference the whole
  # module and wait on the subscription, which itself waits on the API service
  # that consumes this ARN (a cycle).
  value = var.enable_aws ? module.sns[0].sms_inbound_topic_arn : null
}

output "aws_api_access_key_id" {
  description = "IAM access key ID for the API user (SNS SMS sending)."
  value       = length(module.aws_hf_api) > 0 ? module.aws_hf_api[0].access_key_id : null
}

output "aws_api_secret_access_key" {
  description = "IAM secret access key for the API user (SNS SMS sending)."
  value       = length(module.aws_hf_api) > 0 ? module.aws_hf_api[0].secret_access_key : null
  sensitive   = true
}
