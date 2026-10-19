Tileserver Cloud Run module

This module wraps the shared `cloud-run-service` module to deploy a TileServer GL
container to Cloud Run. It supports mounting PMTiles from a GCS bucket via the
`gcs_volume` option (GCS FUSE) or running with embedded tiles in the container
image.

Example usage (root module):

```hcl
module "tileserver" {
  source = "./modules/tileserver"

  project_id   = var.project_id
  region       = var.region
  environment  = var.environment
  service_name = "tileserver"
  image        = var.tileserver_image
  port         = 8080

  # Optional: mount GCS bucket containing openmaptiles.pmtiles
  gcs_volume = {
    bucket_name = var.tiles_bucket
    mount_path  = "/data/data"
    read_only   = true
  }

  allow_unauthenticated = true
}
```
