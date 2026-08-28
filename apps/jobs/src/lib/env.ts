import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3002),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().optional(),
  IDEMPOTENCY_BACKEND: z.enum(["redis", "postgres"]).default("redis"),
  JOB_TRACKER_BACKEND: z.enum(["redis", "postgres"]).default("redis"),
  /**
   * Shared secret that callers must send as `Authorization: Bearer <key>`.
   * When set, all routes except /health are gated. In production this MUST be
   * set; in dev it defaults to absent (open) for convenience.
   */
  JOBS_API_KEY: z.string().min(16).optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  /** ZipTax API key — US sales-tax rate lookups by postal code. */
  ZIPTAX_API_KEY: z.string().optional(),
  STRIPE_API_VERSION: z.string().optional(),
  STRIPE_BASE_URL: z.string().optional(),
  /**
   * Dev-only: force connected-account capabilities ON when the reconcile job
   * syncs a `Payee` row. Seeded Stripe Custom accounts never finish onboarding,
   * so without this a local run of `stripe-connect.reconcile-capabilities`
   * would flip every seeded payee to PENDING and make seeded paid events
   * unsellable. Mirrors the API's flag of the same name; always OFF in prod.
   */
  STRIPE_CONNECT_FORCE_CAPABILITIES: z.string().optional(),
  /**
   * URL of this jobs service (for self-enqueue / fan-out).
   * Defaults to http://localhost:PORT in dev.
   */
  JOBS_SELF_URL: z.string().url().optional(),
  /**
   * Meilisearch configuration for search indexing.
   */
  MEILISEARCH_HOST: z.string().url().optional(),
  MEILISEARCH_API_KEY: z.string().optional(),
  SEARCH_BACKEND: z.enum(["meili", "postgres"]).default("postgres"),
  SEARCH_W_FULLTEXT: z.coerce.number().default(1.0),
  SEARCH_W_PREFIX: z.coerce.number().default(0.7),
  SEARCH_W_FUZZY: z.coerce.number().default(0.5),
  SEARCH_W_POPULARITY: z.coerce.number().default(0.05),
  SEARCH_W_GEO: z.coerce.number().default(1.0),
  /**
   * S3-compatible object storage (optional — required for CSV exports).
   */
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  /**
   * Optional Discord webhook for operational alerts from jobs.
   */
  DISCORD_ALERTS_WEBHOOK: z.string().url().optional(),
  /**
   * SMTP configuration for sending emails (recovery, notifications).
   * Optional — jobs that require email will log instead of sending when not configured.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v === "true" || v === "1")),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_DEFAULT_FROM_EMAIL: z.string().email().optional(),
  RESEND_API_KEY: z.string().optional(),
  /** Brand name fallback for the email footer when no platform setting is set. */
  PRODUCT_NAME: z.string().default("Ithas Fire"),
  /** Physical mailing address fallback for the CAN-SPAM email footer. */
  SENDER_PHYSICAL_ADDRESS: z.string().optional(),
  /**
   * Public web URL for constructing email links (resume URLs, unsubscribe).
   */
  PUBLIC_WEB_URL: z.string().url().optional(),
  /**
   * HMAC secret for unsubscribe token generation.
   */
  UNSUBSCRIBE_SECRET: z.string().optional(),
  /**
   * AWS credentials + region used by the SNS SMS adapter (volunteer
   * shift reminders, recovery SMS, etc.). When unset, the jobs service
   * still boots but SMS-side dispatch silently falls back to "skip".
   */
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_SNS_SENDER_ID: z.string().optional(),
  /**
   * Expo push notifications. Expo's public push API needs no auth by
   * default; this is the optional "enhanced security" access token (Expo
   * dashboard → Access tokens). The push adapter is constructed
   * unconditionally either way.
   */
  EXPO_ACCESS_TOKEN: z.string().optional(),
  /**
   * Retention window (days) after a support thread is RESOLVED before the purge
   * job deletes it (and its messages). 365 ≈ the privacy policy's 12-month
   * window.
   */
  SUPPORT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  /**
   * Azure AI Content Safety endpoint + key for the image-moderation drain job.
   * Both optional: when EITHER is unset the jobs service falls back to the stub
   * moderation adapter (auto-approves), so local/dev flows aren't blocked. In
   * deployed envs these are sourced from GCP Secret Manager (NFR-004 — the key
   * never lands in the repo).
   */
  AZURE_CONTENT_SAFETY_ENDPOINT: z.string().url().optional(),
  AZURE_CONTENT_SAFETY_KEY: z.string().optional(),
  /**
   * Azure severity 0/2/4/6 (Azure four-severity scale) at/above which an image
   * is FLAGGED (held for human review) rather than auto-APPROVED. Default 4 =
   * flag "high"+, per FR-004.
   */
  IMAGE_MODERATION_REVIEW_THRESHOLD: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(4),

  /**
   * Per-category overrides for the threshold above. Each is OPTIONAL and falls
   * back to IMAGE_MODERATION_REVIEW_THRESHOLD, so an environment that sets none
   * of them behaves exactly as it did before these existed.
   *
   * Separate scalars rather than one JSON blob on purpose: when someone is
   * asking "why was this poster held", reading
   * IMAGE_MODERATION_THRESHOLD_SEXUAL=6 straight off the Cloud Run env tab beats
   * parsing a serialized map.
   *
   * Shipped values live in infra/terraform/envs/{dev,prod}/*.tfvars — plain
   * tfvars, NOT Secret Manager, so changing one is a terraform apply with no
   * secret-rotation hazard.
   */
  IMAGE_MODERATION_THRESHOLD_SEXUAL: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional(),
  IMAGE_MODERATION_THRESHOLD_VIOLENCE: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional(),
  IMAGE_MODERATION_THRESHOLD_HATE: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional(),
  IMAGE_MODERATION_THRESHOLD_SELF_HARM: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  return envSchema.parse(process.env);
}

export const env = loadEnv();

/**
 * Whether to force connected-account capabilities ON when syncing a `Payee`.
 *
 * Hard `false` in production — production must always trust Stripe. Defaults ON
 * elsewhere so a local reconcile run doesn't disable every seeded paid event;
 * set `STRIPE_CONNECT_FORCE_CAPABILITIES=false` to reproduce prod semantics.
 * Kept byte-identical in intent to `apps/api/src/lib/env.ts` — if these two
 * ever disagree, the push and pull paths disagree.
 */
export const forceConnectCapabilities =
  env.NODE_ENV !== "production" &&
  env.STRIPE_CONNECT_FORCE_CAPABILITIES !== "false";
