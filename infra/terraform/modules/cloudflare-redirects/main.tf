locals {
  redirects = [
    for r in var.redirects : {
      from_host           = trimspace(r.from_host)
      to_url              = trimspace(r.to_url)
      status_code         = r.status_code
      preserve_path_query = try(r.preserve_path_query, true)
      expression = join(" and ", concat(
        ["http.host eq \"${trimspace(r.from_host)}\""],
        [for p in try(r.exclude_path_prefixes, []) : "not starts_with(http.request.uri.path, \"${p}\")"]
      ))
    }
  ]
}

resource "cloudflare_ruleset" "http_request_redirects" {
  count = length(local.redirects) == 0 ? 0 : 1

  zone_id     = var.zone_id
  name        = "ithasfire-redirects"
  description = "Managed redirects for Ithas Fire"
  kind        = "zone"
  # Single (dynamic) redirects use this phase at zone level;
  # "http_request_redirect" is the account-level Bulk Redirects phase and
  # is rejected with `phase not allowed at zone level`.
  phase = "http_request_dynamic_redirect"

  dynamic "rules" {
    for_each = local.redirects
    content {
      description = "Redirect ${rules.value.from_host}"
      enabled     = true
      expression  = rules.value.expression
      action      = "redirect"

      action_parameters {
        from_value {
          preserve_query_string = rules.value.preserve_path_query
          status_code           = rules.value.status_code

          # A static target_url drops the request path; build it dynamically
          # when preserve_path_query is set so deep links survive the redirect.
          dynamic "target_url" {
            for_each = rules.value.preserve_path_query ? [1] : []
            content {
              expression = "concat(\"${trimsuffix(rules.value.to_url, "/")}\", http.request.uri.path)"
            }
          }

          dynamic "target_url" {
            for_each = rules.value.preserve_path_query ? [] : [1]
            content {
              value = rules.value.to_url
            }
          }
        }
      }
    }
  }
}
