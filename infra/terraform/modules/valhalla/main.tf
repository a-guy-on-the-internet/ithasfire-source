module "valhalla" {
  source = "../cloud-run-service"

  project_id   = var.project_id
  region       = var.region
  environment  = var.environment
  name_prefix  = var.name_prefix
  service_name = var.service_name
  image        = var.image
  port         = var.port

  # Valhalla is an internal service called only by the API.
  # No public access, no GCS volume.
  ingress                  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  allow_unauthenticated    = false
  invoker_service_accounts = var.invoker_service_accounts

  min_instances = var.min_instances
  max_instances = var.max_instances
  cpu           = var.cpu
  memory        = var.memory

  env = var.env
}
