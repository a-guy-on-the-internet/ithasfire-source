output "auth_rate_limit_ruleset_id" {
  description = "Id of the http_ratelimit ruleset, or null when disabled in this workspace."
  value       = try(cloudflare_ruleset.auth_rate_limit[0].id, null)
}

output "auth_rate_limit_expression" {
  description = "The expression the auth rate-limit rule matches (useful to eyeball in plan output)."
  value       = local.auth_rate_limit_expression
}
