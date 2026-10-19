output "secret_names" {
  description = "Fully qualified resource names for each logical secret key."
  value = {
    for key, secret in google_secret_manager_secret.secrets :
    key => secret.name
  }
}

output "secret_ids" {
  description = "Secret IDs (without project prefix) keyed by logical secret name."
  value = {
    for key, secret in google_secret_manager_secret.secrets :
    key => secret.secret_id
  }
}
