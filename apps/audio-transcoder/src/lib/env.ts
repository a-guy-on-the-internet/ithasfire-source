import { z } from "zod";

const envSchema = z.object({
  // Server
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_URL: z.string().min(1),

  // Redis (for idempotency, if needed)
  REDIS_URL: z.string().optional(),
  IDEMPOTENCY_BACKEND: z
    .enum(["auto", "redis", "postgres", "noop"])
    .default("auto"),

  // Search backend parity with API/jobs.
  SEARCH_BACKEND: z.enum(["meili", "postgres"]).default("postgres"),
  SEARCH_W_FULLTEXT: z.coerce.number().default(1.0),
  SEARCH_W_PREFIX: z.coerce.number().default(0.7),
  SEARCH_W_FUZZY: z.coerce.number().default(0.5),
  SEARCH_W_POPULARITY: z.coerce.number().default(0.05),
  SEARCH_W_GEO: z.coerce.number().default(1.0),

  // S3-compatible Storage
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  S3_PUBLIC_READ: z.string().optional(),

  // Transcoding
  FFMPEG_PATH: z.string().default("ffmpeg"),
  TRANSCODE_TEMP_DIR: z.string().default("/tmp/transcoder"),

  // HLS Configuration (with sensible defaults per spec)
  HLS_SEGMENT_DURATION: z.coerce.number().int().positive().default(6),
  HLS_AUDIO_BITRATE: z.coerce.number().int().positive().default(128000), // 128kbps
  HLS_AUDIO_SAMPLE_RATE: z.coerce.number().int().positive().default(44100), // 44.1kHz
  HLS_AUDIO_CHANNELS: z.coerce.number().int().min(1).max(2).default(2), // stereo
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.format();
  console.error("❌ Invalid environment variables:", formatted);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;

export type Env = typeof env;
