output "project_id" {
  value = neon_project.primary.id
}

output "project_name" {
  value = neon_project.primary.name
}

output "default_connection_uri" {
  description = "Default connection URI for the project's primary branch (contains credentials)."
  value       = neon_project.primary.connection_uri
  sensitive   = true
}

output "pooler_connection_uri" {
  description = "Connection URI using Neon's built-in PgBouncer connection pooler."
  value       = neon_project.primary.connection_uri_pooler
  sensitive   = true
}
// TODO: Output connection strings, role credentials, and secret ids.
