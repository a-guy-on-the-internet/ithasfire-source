output "database_id" {
  value = upstash_redis_database.primary.database_id
}

output "endpoint" {
  value     = upstash_redis_database.primary.endpoint
  sensitive = true
}

output "password" {
  value     = upstash_redis_database.primary.password
  sensitive = true
}

output "port" {
  value = upstash_redis_database.primary.port
}
// TODO: Output redis_endpoint, rest_url, and secret references.
