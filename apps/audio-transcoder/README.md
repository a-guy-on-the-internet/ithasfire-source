# Audio Transcoder Service

A microservice that transcodes audio files (MP3) to HLS format for streaming playback.

## Overview

The audio transcoder is a dedicated Fastify service that:

1. Receives transcoding requests via Google Pub/Sub push delivery
2. Downloads the source MP3 from Cloudflare R2
3. Transcodes to HLS using FFmpeg (AAC-LC, 128kbps, 44.1kHz stereo, 6s segments)
4. Uploads HLS files (.m3u8 playlist + .ts segments) back to R2
5. Updates the `AudioUpload` database record with the playlist URL
6. Optionally deletes the source MP3 after successful transcoding

## Architecture

```
┌─────────────────┐    ┌─────────────┐    ┌───────────────────┐
│  Audio Upload   │───>│  Pub/Sub    │───>│ Audio Transcoder  │
│  (API triggers) │    │  Topic      │    │ (Cloud Run)       │
└─────────────────┘    └─────────────┘    └───────────────────┘
                                                    │
                                                    ▼
                                          ┌─────────────────┐
                                          │  FFmpeg         │
                                          │  (in container) │
                                          └─────────────────┘
                                                    │
                       ┌────────────────────────────┼────────────────────────────┐
                       ▼                            ▼                            ▼
              ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
              │  R2 (download)  │         │  R2 (upload)    │         │  Database       │
              │  Source MP3     │         │  HLS files      │         │  (update)       │
              └─────────────────┘         └─────────────────┘         └─────────────────┘
```

## HLS Output Specification

| Parameter        | Value                         |
| ---------------- | ----------------------------- |
| Container        | MPEG-2 Transport Stream (.ts) |
| Audio Codec      | AAC-LC                        |
| Bitrate          | 128 kbps                      |
| Sample Rate      | 44.1 kHz                      |
| Channels         | Stereo (2)                    |
| Segment Duration | 6 seconds                     |
| Playlist Type    | VOD (Video on Demand)         |

## API Endpoints

### `GET /health`

Health check endpoint. Returns FFmpeg availability status.

### `GET /health/detailed`

Detailed health check with FFmpeg version information.

### `POST /pubsub/push`

Pub/Sub push handler. Receives messages from the `audio-transcode` topic.

**Request body** (Pub/Sub envelope):

```json
{
  "message": {
    "data": "<base64-encoded-json>",
    "messageId": "...",
    "publishTime": "..."
  }
}
```

**Decoded message payload**:

```json
{
  "audioUploadId": "uuid",
  "eventId": "uuid",
  "sourceKey": "uploads/audio/{id}.mp3",
  "outputPrefix": "events/{eventId}/audio/{audioId}",
  "deleteSourceOnSuccess": true
}
```

### `POST /transcode`

Direct invocation endpoint for testing/debugging.

## Environment Variables

| Variable                | Required | Default           | Description                        |
| ----------------------- | -------- | ----------------- | ---------------------------------- |
| `DATABASE_URL`          | Yes      | -                 | PostgreSQL connection string       |
| `S3_BUCKET`             | Yes      | -                 | S3-compatible bucket name          |
| `S3_ENDPOINT`           | Yes      | -                 | S3-compatible endpoint             |
| `S3_ACCESS_KEY_ID`      | Yes      | -                 | S3 access key                      |
| `S3_SECRET_ACCESS_KEY`  | Yes      | -                 | S3 secret key                      |
| `S3_PUBLIC_BASE_URL`    | No       | -                 | Public URL prefix for HLS files    |
| `S3_PUBLIC_READ`        | No       | `false`           | Whether uploaded files are public  |
| `PORT`                  | No       | `8080`            | Server port                        |
| `HOST`                  | No       | `0.0.0.0`         | Server host                        |
| `FFMPEG_PATH`           | No       | `ffmpeg`          | Path to FFmpeg binary              |
| `TRANSCODE_TEMP_DIR`    | No       | `/tmp/transcoder` | Temp directory for processing      |
| `HLS_SEGMENT_DURATION`  | No       | `6`               | Segment duration in seconds        |
| `HLS_AUDIO_BITRATE`     | No       | `128000`          | Audio bitrate in bps               |
| `HLS_AUDIO_SAMPLE_RATE` | No       | `44100`           | Sample rate in Hz                  |
| `HLS_AUDIO_CHANNELS`    | No       | `2`               | Number of audio channels           |
| `REDIS_URL`             | No       | -                 | Optional Redis URL for idempotency |

## Local Development

### Prerequisites

- Node.js 22+
- FFmpeg installed (`brew install ffmpeg` on macOS)
- Docker (for database)

### Setup

```bash
# Start local infrastructure
cd infra/docker && docker compose up -d

# Install dependencies
pnpm install

# Create .env.local
cat > apps/audio-transcoder/.env.local <<EOF
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public
S3_BUCKET=th-dev
S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=xxx
S3_SECRET_ACCESS_KEY=xxx
S3_PUBLIC_BASE_URL=https://files-web-dev.ithasfire.com
S3_PUBLIC_READ=true
EOF

# Run development server
pnpm -C apps/audio-transcoder dev
```

### Testing

```bash
# Run unit tests
pnpm -C apps/audio-transcoder test

# Manual test via direct invoke
curl -X POST http://localhost:8080/transcode \
  -H 'Content-Type: application/json' \
  -d '{
    "audioUploadId": "...",
    "eventId": "...",
    "sourceKey": "uploads/audio/test.mp3",
    "outputPrefix": "events/test/audio/test",
    "deleteSourceOnSuccess": false
  }'

# Manual test via Pub/Sub envelope
curl -X POST http://localhost:8080/pubsub/push \
  -H 'Content-Type: application/json' \
  -d '{
    "message": {
      "data": "'$(echo -n '{"audioUploadId":"...","eventId":"...","sourceKey":"uploads/audio/test.mp3","outputPrefix":"events/test/audio/test","deleteSourceOnSuccess":false}' | base64)'"
    }
  }'
```

## Deployment

The service is deployed to Google Cloud Run via Terraform.

### Docker Build

```bash
# Build image
docker build -t audio-transcoder -f apps/audio-transcoder/Dockerfile .

# Run locally
docker run -p 8080:8080 --env-file apps/audio-transcoder/.env.local audio-transcoder
```

### Terraform

```bash
cd infra/terraform

# Set audio_transcoder_image variable
terraform plan -var="audio_transcoder_image=gcr.io/th-dev/audio-transcoder:latest"
terraform apply
```

## Idempotency

The service achieves idempotency through **path overwriting**:

1. Output HLS files are always written to the same deterministic paths based on `audioUploadId`
2. Retries overwrite existing files with identical content
3. The playlist URL remains stable across retries

This eliminates the need for explicit idempotency tracking (Redis/database) for the transcoding operation itself.

## Error Handling

### Retryable Errors

- Network failures downloading from R2
- Transient FFmpeg errors
- Temporary database unavailability

These return HTTP 500, causing Pub/Sub to retry with exponential backoff.

### Non-Retryable Errors

- Invalid message format (HTTP 400)
- Source file not found (HTTP 200 with `ok: false`)
- Unsupported audio format (HTTP 200 with `ok: false`)

Non-retryable errors return HTTP 200 to acknowledge the message and prevent infinite retry loops. Errors are logged for investigation.

### Dead Letter Queue

After 5 failed delivery attempts, messages are sent to the dead letter topic (`*-transcode-dlq`) for manual inspection.

## Monitoring

Key metrics to monitor:

- **Request latency**: p50, p95, p99 for `/pubsub/push`
- **Error rate**: 4xx/5xx responses
- **FFmpeg availability**: Health check status
- **Processing time**: Time from message receipt to HLS upload completion
- **Dead letter queue depth**: Messages that exceeded retry attempts

Structured logs include:

- `transcode_audio_start`: Processing began
- `downloading_source`: Downloading from R2
- `transcoding_start`: FFmpeg started
- `transcoding_complete`: FFmpeg finished
- `uploading_hls_files`: Uploading to R2
- `transcode_audio_complete`: Full success
- `transcode_job_failed`: Error occurred
