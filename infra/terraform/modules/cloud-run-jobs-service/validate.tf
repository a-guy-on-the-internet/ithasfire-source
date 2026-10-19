// Intentionally empty.
//
// This file used to instantiate this module as `module "self" { source = "./" }`
// so that running `terraform validate` directly within this module directory would
// have a root module.
//
// Unfortunately, when this module is consumed by a parent configuration, that
// pattern causes recursive module expansion (and on macOS can hit file name too
// long errors under .terraform/modules).
