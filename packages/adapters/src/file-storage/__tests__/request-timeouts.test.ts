import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CloudflareR2Adapter } from "../cloudflare-r2/r2-adapter";
import { S3FileStorageAdapter } from "../s3/s3-adapter";
import {
  DEFAULT_FILE_STORAGE_REQUEST_TIMEOUTS,
  resolveRequestTimeouts,
  s3RequestHandlerOptions,
} from "../request-timeouts";

/**
 * Hung storage calls must fail. Each scenario is a local HTTP server that
 * misbehaves one way; the adapters run with PRODUCTION timeouts (connect 5 s,
 * idle/headers 60 s) and only the hard deadline shortened, so the test proves
 * the deadline (not an SDK timer, which at ≥ 6 s is deferred and then dropped
 * once headers arrive) is what ends the call.
 */
describe("file-storage hard deadlines", () => {
  let server: Server;
  let endpoint: string;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url?.includes("stall-body")) {
        // Headers promptly, a first chunk, then the body stalls forever.
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "content-length": String(25 * 1024 * 1024),
        });
        res.write(Buffer.alloc(64 * 1024));
        return;
      }
      if (req.method === "PUT" && req.url?.includes("no-answer")) {
        // Takes the upload, never answers.
        req.resume();
        return;
      }
      // Anything else: never answer at all.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const DEADLINE_MS = 1_500;
  const options = () => ({
    bucket: "b",
    endpoint,
    accessKeyId: "k",
    secretAccessKey: "s",
    publicBaseUrl: "https://cdn.example",
    // Production connect/idle values; only the hard deadlines are short.
    timeouts: { readDeadlineMs: DEADLINE_MS, writeDeadlineMs: DEADLINE_MS },
  });

  const adapters = [
    ["R2", () => new CloudflareR2Adapter(options())],
    ["S3/MinIO", () => new S3FileStorageAdapter(options())],
  ] as const;

  it.each(adapters)(
    "%s getObject: headers arrive, the body stalls → fails transient at the deadline",
    async (_label, make) => {
      const started = Date.now();
      const failure = await make()
        .getObject({ key: "events/e/images/stall-body.jpg" })
        .then(
          () => null,
          (err: unknown) => err,
        );
      const elapsed = Date.now() - started;

      expect(failure).toEqual({ code: "transient", message: "getObject_deadline_exceeded" });
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000);
    },
    20_000,
  );

  it.each(adapters)(
    "%s putObject: the server never answers → fails transient at the deadline",
    async (_label, make) => {
      const started = Date.now();
      const failure = await make()
        .putObject({
          key: "events/e/images/no-answer.jpg",
          content: Buffer.alloc(256 * 1024, 1),
          options: { contentType: "image/jpeg", public: true },
        })
        .then(
          () => null,
          (err: unknown) => err,
        );
      const elapsed = Date.now() - started;

      expect(failure).toEqual({ code: "transient", message: "putObject_deadline_exceeded" });
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000);
    },
    20_000,
  );

  it.each(adapters)(
    "%s headObject: the server never answers → fails transient at the deadline",
    async (_label, make) => {
      const started = Date.now();
      const failure = await make()
        .headObject({ key: "events/e/images/no-head.jpg" })
        .then(
          () => null,
          (err: unknown) => err,
        );
      const elapsed = Date.now() - started;

      expect(failure).toEqual({ code: "transient", message: "headObject_deadline_exceeded" });
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000);
    },
    20_000,
  );

  // S3/MinIO only: the R2 client keeps the SDK's default flexible checksums,
  // which refuse an unknown-length stream before any request is sent
  // (`x-amz-decoded-content-length` undefined), so no deadline is involved.
  // Every production caller passes a Buffer.
  it.each([adapters[1]])(
    "%s putObject from a stream: at the deadline the caller's source stream is torn down too",
    async (_label, make) => {
      // A source that never ends, like an upload relayed from a stalled client.
      const source = new PassThrough();
      source.write(Buffer.alloc(64 * 1024, 1));
      const sourceError = new Promise<unknown>((resolve) => source.once("error", resolve));

      const failure = await make()
        .putObject({
          key: "events/e/images/no-answer-stream.jpg",
          content: source,
          options: { contentType: "image/jpeg", public: true },
        })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(failure).toEqual({ code: "transient", message: "putObject_deadline_exceeded" });
      expect(source.destroyed).toBe(true);
      expect(await sourceError).toMatchObject({ message: "putObject_deadline_exceeded" });
    },
    20_000,
  );

  it("defaults: every call has a hard deadline; the SDK timers are set for both handler versions", () => {
    expect(DEFAULT_FILE_STORAGE_REQUEST_TIMEOUTS).toEqual({
      connectionMs: 5_000,
      requestMs: 60_000,
      readDeadlineMs: 120_000,
      writeDeadlineMs: 120_000,
    });
    expect(s3RequestHandlerOptions()).toEqual({
      connectionTimeout: 5_000,
      requestTimeout: 60_000,
      socketTimeout: 60_000,
      throwOnRequestTimeout: true,
    });
    // A partial override keeps the other defaults (the deadlines included).
    expect(resolveRequestTimeouts({ readDeadlineMs: 1 })).toEqual({
      ...DEFAULT_FILE_STORAGE_REQUEST_TIMEOUTS,
      readDeadlineMs: 1,
    });
  });

  it("raising only the write deadline raises the per-attempt request cap with it", () => {
    // On handler 4.4 `requestMs` caps each PUT attempt, upload included, so a
    // longer write deadline alone would change nothing.
    expect(resolveRequestTimeouts({ writeDeadlineMs: 300_000 })).toEqual({
      ...DEFAULT_FILE_STORAGE_REQUEST_TIMEOUTS,
      writeDeadlineMs: 300_000,
      requestMs: 300_000,
    });
    // An explicit requestMs is the caller's call and is kept.
    expect(resolveRequestTimeouts({ writeDeadlineMs: 300_000, requestMs: 90_000 }).requestMs).toBe(90_000);
    // A tighter write deadline never lowers it.
    expect(resolveRequestTimeouts({ writeDeadlineMs: 45_000 }).requestMs).toBe(60_000);
  });
});
