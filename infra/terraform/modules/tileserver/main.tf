module "tileserver" {
  source = "../cloud-run-service"

  project_id   = var.project_id
  region       = var.region
  environment  = var.environment
  name_prefix  = var.name_prefix
  service_name = var.service_name
  image        = var.image
  port         = var.port

  # If you want tiles stored in GCS, provide gcs_volume configuration.
  gcs_volume = var.gcs_volume

  allow_unauthenticated = var.allow_unauthenticated
  min_instances         = var.min_instances
  max_instances         = var.max_instances
  cpu                   = var.cpu
  memory                = var.memory
  # PORT is reserved by Cloud Run v2 and auto-set from container_port.
  env = var.env
}
