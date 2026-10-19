# cloud-run-audio-transcoder

Terraform module for deploying the audio transcoder service to Cloud Run.

## Features

- Deploys a Cloud Run service with FFmpeg for audio transcoding
- Configures Pub/Sub topic and push subscription for async processing
- Sets up service accounts with minimal IAM permissions
- Integrates with S3-compatible storage (Cloudflare R2, MinIO, AWS S3, etc.)

## Invocation flow

1. Upload triggers publish to `audio-transcode` Pub/Sub topic
2. Pub/Sub push subscription invokes `POST /pubsub/push` on Cloud Run
3. Service downloads source MP3 from S3 storage, transcodes to HLS, uploads back
4. Service updates database with HLS playlist URL

## Usage

```hcl
module "audio_transcoder" {
  source = "./modules/cloud-run-audio-transcoder"

  project_id   = var.project_id
  region       = var.region
  environment  = "dev"
  image        = "gcr.io/my-project/audio-transcoder:latest"

  s3 = {
    bucket            = "my-bucket"
    endpoint          = "https://<account>.r2.cloudflarestorage.com"
    access_key_id     = var.s3_access_key_id
    secret_access_key = var.s3_secret_access_key
    public_base_url   = "https://files.example.com"
    public_read       = true
  }

  env = {
    DATABASE_URL = var.database_url
  }
}
```

## Inputs

| Name | Description | Type | Required |
|------|-------------|------|----------|
| project_id | GCP project ID | string | yes |
| region | GCP region | string | yes |
| environment | Environment name (dev/stage/prod) | string | yes |
| image | Container image reference | string | yes |
| s3 | S3-compatible storage configuration | object | yes |
| env | Additional environment variables | map(string) | no |

## Outputs

| Name | Description |
|------|-------------|
| service_url | Cloud Run service URL |
| topic_id | Pub/Sub topic resource ID |
| service_account_email | Runtime service account email |
