# S3 File Storage Adapter

This adapter implements the `FileStoragePort` using the **S3 protocol**. It works with any
S3-compatible object store: [Cloudflare R2](https://developers.cloudflare.com/r2/),
[MinIO](https://min.io/), AWS S3, DigitalOcean Spaces, Backblaze B2, etc.

Under the hood it uses `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, which is the
officially recommended SDK for all S3-compatible backends (including Cloudflare R2).

## Prerequisites

1. **Create a bucket** in your S3-compatible provider. Note the bucket name and endpoint.
2. **Generate credentials** (access key + secret key) with read/write permissions on the bucket.
3. **Configure a public bucket policy** if you want anonymous reads when `public: true`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": "*",
         "Action": ["s3:GetObject"],
         "Resource": ["arn:aws:s3:::<bucket-name>/*"]
       }
     ]
   }
   ```

4. (Optional) **Front the bucket with a CDN** (e.g. Cloudflare Worker, CloudFront). Point it at the public endpoint.

## Environment variables

The API's env schema (`apps/api/src/lib/env.ts`) treats these as optional in development. In production, setting `S3_BUCKET` makes `S3_PUBLIC_BASE_URL` mandatory at boot.

| Name                   | Description                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `S3_ENDPOINT`          | S3-compatible endpoint, e.g. `https://<account-id>.r2.cloudflarestorage.com` or `http://localhost:9000` for MinIO. |
| `S3_BUCKET`            | Target bucket name.                                                                                                |
| `S3_ACCESS_KEY_ID`     | Access key for the S3-compatible API.                                                                              |
| `S3_SECRET_ACCESS_KEY` | Secret key for the API.                                                                                            |
| `S3_PUBLIC_BASE_URL`   | CDN/public URL prefix, e.g. `https://cdn.ithasfire.com`. Required when storing public objects.              |
| `S3_PUBLIC_READ`       | `"true"` or `"false"` (defaults to `"false"`). When `"true"`, objects default to public URLs.                      |

## Wiring the adapter

```ts
import { S3FileStorageAdapter } from "@th/adapters/file-storage/s3";
import type { LoggerPort } from "@th/ports/logger";

type Env = {
  S3_BUCKET: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_PUBLIC_BASE_URL?: string;
  S3_PUBLIC_READ?: string;
};

export function createFileStorage(env: Env, logger: LoggerPort) {
  return new S3FileStorageAdapter({
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    defaultPublic: env.S3_PUBLIC_READ === "true",
    logger,
  });
}
```

## API usage example

`apps/api/src/bootstrap/storage.ts` is the real wiring: `createS3FileStorage(env, logger)` builds the adapter (with 45 s read, write and request timeouts, tighter than the adapter's defaults of 120 s read and write deadlines and a 60 s per-attempt `requestMs`; `../request-timeouts.ts`), `registerFileStorage(app, storage)` attaches it to `app.ports.fileStorage`, and `uploadTicketImage` is a sample helper:

```ts
import { createS3FileStorage, registerFileStorage } from "./storage";

// inside your bootstrap:
registerFileStorage(app, createS3FileStorage(env, app.logger));

// somewhere in a use case
await app.ports.fileStorage.putObject({
  key: `tickets/${ticketId}.png`,
  content: imageBuffer,
  options: { public: true, contentType: "image/png" },
});
```

## Security notes

- Keys are normalized to avoid directory traversal. Use predictable prefixes such as `org/<orgId>` or `human/<humanId>` to keep tenant data separated.
- Public URLs always use `publicBaseUrl`; the internal S3 endpoint never leaks to callers.
- Private `getObjectUrl` calls must pass `expiresSec`; there is no default (`invalid_input` otherwise). Presigned upload URLs default to 900 seconds when `expiresSec` is omitted.
