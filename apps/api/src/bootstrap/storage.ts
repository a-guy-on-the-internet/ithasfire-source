import type { Buffer } from "node:buffer";

import { S3FileStorageAdapter } from "@th/adapters/file-storage/s3";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";

export type FileStorageEnv = {
  S3_BUCKET: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_PUBLIC_BASE_URL?: string;
  S3_PUBLIC_READ?: string;
};

type AppWithPorts = {
  ports: Record<string, unknown> & { fileStorage?: FileStoragePort };
  logger: LoggerPort;
};

export const createS3FileStorage = (
  env: FileStorageEnv,
  logger: LoggerPort,
): FileStoragePort =>
  new S3FileStorageAdapter({
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    defaultPublic: env.S3_PUBLIC_READ === "true",
    logger,
    // Tighter than the adapter's 120 s defaults so a request that holds an
    // image strip slot (head + read + write, each bounded here) ends inside
    // Cloud Run's 300 s request limit: 45 + 45 + 45 = 135 s. `requestMs`
    // matches the deadlines because on handler 4.4 it caps each PUT attempt,
    // upload included (25 MB in 45 s is ~570 KB/s). Jobs and the transcoder
    // keep the defaults.
    timeouts: {
      readDeadlineMs: 45_000,
      writeDeadlineMs: 45_000,
      requestMs: 45_000,
    },
  });

export const registerFileStorage = <T extends AppWithPorts>(
  app: T,
  storage: FileStoragePort,
): T => {
  app.ports.fileStorage = storage;
  return app;
};

export const uploadTicketImage = async (
  storage: FileStoragePort,
  input: { ticketId: string; buffer: Buffer },
): Promise<void> => {
  await storage.putObject({
    key: `tickets/${input.ticketId}.png`,
    content: input.buffer,
    options: { public: true, contentType: "image/png" },
  });
};
