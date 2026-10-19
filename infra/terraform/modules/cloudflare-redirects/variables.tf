variable "zone_id" {
  description = "Cloudflare Zone ID to attach redirects to."
  type        = string
}

variable "redirects" {
  description = <<-EOT
  Simple host-based redirects.

  - from_host: host the client requests (e.g. "www.ithasfire.com")
  - to_url: absolute destination URL (e.g. "https://ithasfire.com")
  - status_code: HTTP status for redirect (301/302/307/308)
  - preserve_path_query: if true, appends the original path + query to to_url
  - exclude_path_prefixes: request paths starting with any of these are NOT
    redirected (e.g. ["/.well-known/"] so Apple's AASA fetcher, which does not
    follow redirects, gets a 200 from the origin)
  EOT

  type = list(object({
    from_host             = string
    to_url                = string
    status_code           = number
    preserve_path_query   = optional(bool, true)
    exclude_path_prefixes = optional(list(string), [])
  }))

  default = []
}

