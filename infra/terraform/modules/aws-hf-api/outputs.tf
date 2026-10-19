output "iam_user_name" {
  description = "AWS IAM user name for the API."
  value       = aws_iam_user.api.name
}

output "access_key_id" {
  description = "IAM access key ID for the API user (used as AWS_ACCESS_KEY_ID at runtime)."
  value       = aws_iam_access_key.api.id
}

output "secret_access_key" {
  description = "IAM secret access key for the API user (used as AWS_SECRET_ACCESS_KEY at runtime)."
  value       = aws_iam_access_key.api.secret
  sensitive   = true
}
