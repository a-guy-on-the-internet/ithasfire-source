locals {
  name_prefix = "hf-${var.environment}"

  labels = {
    application = "ithasfire"
    environment = var.environment
  }

  # Previously this stack derived ingress/GKE toggles. Those have been removed in
  # favor of Cloud Run services managed in the root module.
}
