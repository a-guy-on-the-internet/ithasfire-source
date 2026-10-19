output "smtp_username" {
  description = "SMTP username for SES (IAM access key ID)."
  value       = aws_iam_access_key.smtp.id
}

output "smtp_password" {
  description = "SMTP password for SES (derived from IAM secret via SES signing algorithm)."
  value       = aws_iam_access_key.smtp.ses_smtp_password_v4
  sensitive   = true
}

output "smtp_host" {
  description = "SES SMTP endpoint for the configured region."
  value       = "email-smtp.${var.aws_region}.amazonaws.com"
}

output "dkim_tokens" {
  description = "List of DKIM tokens. Create CNAME records: <token>._domainkey.<domain> → <token>.dkim.amazonses.com"
  value       = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
}

output "domain_identity_arn" {
  description = "ARN of the SES domain identity."
  value       = aws_sesv2_email_identity.domain.arn
}

output "mail_from_domain" {
  description = "The MAIL FROM subdomain (e.g. mail.ithasfire.com). Needs MX + TXT records."
  value       = local.mail_from_domain
}

output "verification_status" {
  description = "Current verification status of the domain identity."
  value       = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].status
}

output "configuration_set_name" {
  description = "Name of the SES Configuration Set (null when disabled)."
  value       = var.enable_configuration_set ? aws_sesv2_configuration_set.default[0].configuration_set_name : null
}
