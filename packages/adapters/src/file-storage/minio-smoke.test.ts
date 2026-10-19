/**
 * Smoke test: verifies S3FileStorageAdapter works against local MinIO.
 *
 * Prerequisites:
 *   cd infra/docker && docker compose up -d minio minio-init
 *
 * Run:
 *   pnpm -C packages/adapters vitest --run minio-smoke
 *
 * This test is skipped when MinIO isn't reachable (CI, no Docker, etc.).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { S3FileStorageAdapter } from "./s3/s3-adapter";

const MINIO_ENDPOINT = "http://localhost:9000";
const MINIO_BUCKET = "th-dev";
const MINIO_ACCESS_KEY = "minioadmin";
const MINIO_SECRET_KEY = "minioadmin";

async function minioReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MINIO_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe.skipIf(process.env.CI === "true")(
  "S3FileStorageAdapter → MinIO integration",
  async () => {
    let reachable = false;
    let adapter: S3FileStorageAdapter;

    beforeAll(async () => {
      reachable = await minioReachable();
      if (!reachable) return;

      adapter = new S3FileStorageAdapter({
        bucket: MINIO_BUCKET,
        endpoint: MINIO_ENDPOINT,
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
        publicBaseUrl: `${MINIO_ENDPOINT}/${MINIO_BUCKET}`,
      });
    });

    it.skipIf(!process.env.TEST_MINIO)(
      "put + head + getObjectUrl + delete round-trip",
      async () => {
        if (!reachable) return;

        const key = `test/smoke-${Date.now()}.txt`;
        const content = Buffer.from("hello from vitest");

        // PUT
        const putResult = await adapter.putObject({
          key,
          content,
          options: { contentType: "text/plain", public: true },
        });
        expect(putResult.url).toContain(key);
        expect(putResult.size).toBe(content.byteLength);

        // HEAD
        const head = await adapter.headObject({ key });
        expect(head.exists).toBe(true);
        if (head.exists) {
          expect(head.size).toBe(content.byteLength);
          expect(head.contentType).toBe("text/plain");
        }

        // GET URL (signed)
        const getResult = await adapter.getObjectUrl({
          key,
          options: { expiresSec: 300 },
        });
        expect(getResult.url).toContain(key);

        // Fetch the signed URL to verify content
        const res = await fetch(getResult.url);
        expect(res.ok).toBe(true);
        const body = await res.text();
        expect(body).toBe("hello from vitest");

        // LIST
        const listResult = await adapter.listObjects({
          prefix: "test/",
          limit: 100,
        });
        const found = listResult.keys.some((k) => k.key === key);
        expect(found).toBe(true);

        // DELETE
        const delResult = await adapter.deleteObject({ key });
        expect(delResult.ok).toBe(true);

        // Confirm gone
        const headAfter = await adapter.headObject({ key });
        expect(headAfter.exists).toBe(false);
      },
    );

    it.skipIf(!process.env.TEST_MINIO)(
      "presignPutObject returns a valid upload URL",
      async () => {
        if (!reachable) return;

        const key = `test/presign-${Date.now()}.txt`;

        const presign = await adapter.presignPutObject({
          key,
          contentType: "text/plain",
          sizeBytes: 5,
          options: { expiresSec: 300 },
        });
        expect(presign.uploadUrl).toContain(key);

        // Use the presigned URL to upload
        const uploadRes = await fetch(presign.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: "12345",
        });
        expect(uploadRes.ok).toBe(true);

        // Verify it landed
        const head = await adapter.headObject({ key });
        expect(head.exists).toBe(true);

        // Cleanup
        await adapter.deleteObject({ key });
      },
    );

    it.skipIf(!process.env.TEST_MINIO)("moveObject works", async () => {
      if (!reachable) return;

      const fromKey = `test/move-src-${Date.now()}.txt`;
      const toKey = `test/move-dst-${Date.now()}.txt`;

      await adapter.putObject({
        key: fromKey,
        content: Buffer.from("moveme"),
        options: { contentType: "text/plain", public: true },
      });

      const moveResult = await adapter.moveObject({
        fromKey,
        toKey,
        options: {},
      });
      expect(moveResult.ok).toBe(true);

      // Source gone, destination present
      const headSrc = await adapter.headObject({ key: fromKey });
      expect(headSrc.exists).toBe(false);

      const headDst = await adapter.headObject({ key: toKey });
      expect(headDst.exists).toBe(true);

      // Cleanup
      await adapter.deleteObject({ key: toKey });
    });
  },
);
