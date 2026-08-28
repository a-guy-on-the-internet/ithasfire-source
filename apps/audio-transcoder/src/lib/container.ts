import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { POOL_TUNING } from "@th/db";
import pg from "pg";
import Redis from "ioredis";

import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { TranscoderPort } from "@th/ports/transcoder";

import { createPrismaRepos } from "@th/adapters/db/prisma-repos";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { createSystemClock } from "@th/adapters/infra/clock";
import { PrismaIdempotencyAdapter } from "@th/adapters/idempotency/prisma-adapter";
import { RedisIdempotency } from "@th/adapters/idempotency/redis-adapter";
import { S3FileStorageAdapter } from "@th/adapters/file-storage/s3";
import { FfmpegTranscoder } from "@th/adapters/transcoder/ffmpeg";

import { env } from "./env";

// ─────────────────────────────────────────────────────────────────────────────
// Stub implementations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NoopIdempotency - always allows processing (no idempotency check)
 * Used when Redis is not configured - relies on R2 path overwriting for idempotency
 */
class NoopIdempotency implements IdempotencyPort {
  async begin(_key: string, _ttlSec?: number): Promise<boolean> {
    return true; // Always allow processing
  }
  async commit<T>(_key: string, _result: T, _keepSec?: number): Promise<void> {
    // No-op
  }
  async fail(_key: string, _error?: string, _keepSec?: number): Promise<void> {
    // No-op
  }
  /** Nothing is ever held, so an owner-checked release always "succeeds". */
  async release(_key: string, _ownerToken: string): Promise<boolean> {
    return true;
  }
  async get<T>(_key: string): Promise<T | null> {
    return null; // No cached result
  }
  async run<T>(
    _key: string,
    _ttlSec: number,
    fn: () => Promise<T>,
    _keepSec?: number,
  ): Promise<{ fresh: boolean; result: T }> {
    return { fresh: true, result: await fn() };
  }
  /** Nothing is ever stored, so there is nothing to reclaim. */
  async purgeExpired(): Promise<number> {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Container
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscoderContainer {
  repos: Repos;
  logger: LoggerPort;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  fileStorage: FileStoragePort;
  transcoder: TranscoderPort;
  close: () => Promise<void>;
}

export async function buildContainer(): Promise<TranscoderContainer> {
  // Database
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    ...POOL_TUNING,
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({
    adapter,
    __internal: {
      configOverride: (e: any) => ({
        ...e,
        dirname: e?.dirname ?? process.cwd(),
        relativePath: e?.relativePath ?? "apps/audio-transcoder",
        relativeEnvPaths: {
          rootEnvPath: e?.relativeEnvPaths?.rootEnvPath ?? ".env",
          schemaEnvPath: e?.relativeEnvPaths?.schemaEnvPath ?? ".env",
        },
      }),
    },
  } as any);
  await prisma.$connect();

  const logger = createPinoLoggerAdapter();
  const repos: Repos = createPrismaRepos(prisma);
  const clock: ClockPort = createSystemClock();

  // Redis (optional - only for idempotency if needed)
  let redis: Redis | null = null;
  let idempotency: IdempotencyPort;

  if (env.IDEMPOTENCY_BACKEND === "postgres") {
    idempotency = new PrismaIdempotencyAdapter(
      prisma,
      "audio-transcoder",
      logger,
    );
  } else if (env.IDEMPOTENCY_BACKEND === "noop") {
    idempotency = new NoopIdempotency();
  } else if (env.IDEMPOTENCY_BACKEND === "redis") {
    if (!env.REDIS_URL) {
      throw new Error("REDIS_URL is required when IDEMPOTENCY_BACKEND=redis");
    }
    redis = new Redis(env.REDIS_URL);
    redis.on("error", (err) => logger.error("redis_error", { err }));
    idempotency = new RedisIdempotency(redis, "audio-transcoder", logger);
  } else if (env.REDIS_URL) {
    redis = new Redis(env.REDIS_URL);
    redis.on("error", (err) => logger.error("redis_error", { err }));
    idempotency = new RedisIdempotency(redis, "audio-transcoder", logger);
  } else {
    // Use noop - we rely on S3 path overwriting for idempotency
    idempotency = new NoopIdempotency();
  }

  // File Storage (S3)
  const fileStorage: FileStoragePort = new S3FileStorageAdapter({
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    defaultPublic: env.S3_PUBLIC_READ === "true",
    logger,
  });

  // Transcoder (FFmpeg)
  const transcoder: TranscoderPort = new FfmpegTranscoder({
    ffmpegPath: env.FFMPEG_PATH,
    tempDir: env.TRANSCODE_TEMP_DIR,
    hlsSegmentDuration: env.HLS_SEGMENT_DURATION,
    audioBitrate: env.HLS_AUDIO_BITRATE,
    audioSampleRate: env.HLS_AUDIO_SAMPLE_RATE,
    audioChannels: env.HLS_AUDIO_CHANNELS,
    logger,
  });

  const close = async () => {
    await prisma
      .$disconnect()
      .catch((err) => logger.error("prisma_disconnect_failed", { err }));
    await pool
      .end()
      .catch((err) => logger.error("pg_pool_end_failed", { err }));
    if (redis) {
      await redis
        .quit()
        .catch((err) => logger.error("redis_quit_failed", { err }));
    }
  };

  return {
    repos,
    logger,
    clock,
    idempotency,
    fileStorage,
    transcoder,
    close,
  };
}
