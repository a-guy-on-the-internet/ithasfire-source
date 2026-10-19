output "zone_id" {
  description = "Cloudflare Zone ID for var.domain."
  value       = coalesce(var.cloudflare_zone_id, try(cloudflare_zone.this[0].id, null))
}

output "service_records" {
  description = "Map of service => record metadata for the created <service>.<env> records."
  value = {
    for k, rec in cloudflare_record.service :
    k => {
      id      = rec.id
      name    = rec.name
      type    = rec.type
      content = rec.content
      proxied = rec.proxied
    }
  }
}

output "additional_record_ids" {
  description = "Map of additional record name => record id."
  value       = { for k, rec in cloudflare_record.additional : k => rec.id }
}
