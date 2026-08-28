import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { POOL_TUNING } from "@th/db";
import pg from "pg";
import Redis from "ioredis";

import type { ClockPort } from "@th/ports/clock";
import {
  createFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ModerationPort } from "@th/ports/moderation";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import { safeReporter, type ReporterPort } from "@th/ports/reporter";
import type { SearchIndexPort } from "@th/ports/search";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { createPrismaRepos } from "@th/adapters/db/prisma-repos";
import { createPrismaEmailDeliverabilityAdapter } from "@th/adapters/db/prisma-email-deliverability-adapter";
import {
  createAzureContentSafetyModerationAdapter,
  createFailClosedModerationAdapter,
  createStubModerationAdapter,
} from "@th/adapters/moderation";
import { createZiptaxAdapter } from "@th/adapters/tax-rate-lookup";
import { createTzLookupAdapter } from "@th/adapters/timezone-lookup";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { createSystemClock } from "@th/adapters/infra/clock";
import { PrismaIdempotencyAdapter } from "@th/adapters/idempotency/prisma-adapter";
import { RedisIdempotency } from "@th/adapters/idempotency/redis-adapter";
import {
  createMailerFromConfig,
  createFooterDefaultsCache,
} from "@th/adapters/comms/mail";
import { SnsSmsAdapter } from "@th/adapters/comms/sns-sms";
// Statically imported on purpose (unlike Stripe/Meilisearch/S3):
// `expo-server-sdk` is a lightweight HTTP client and the adapter needs no
// credentials, so there is no env-gate to lazy-load behind.
import { ExpoPushAdapter } from "@th/adapters/comms/push/expo-push";
import { LoggerMetricsAdapter } from "@th/adapters/infra/logger-metrics";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { PushPort } from "@th/ports/comms/push";
import type { SMSPort } from "@th/ports/comms/sms";
import { render as renderEmailTemplate } from "@th/ui-email";
import { RedisJobDiagnosticsAdapter } from "@th/adapters/job-diagnostics/redis-dlq-adapter";
// `StripePaymentProcessor`, `MeilisearchAdapter`, and `S3FileStorageAdapter`
// are lazy-imported below — they each pull a large vendor SDK (`stripe`,
// `meilisearch`, `@aws-sdk/client-s3`) and we want services without those
// envs configured to skip the load entirely on boot.

import { Sentry } from "../instrument";

import type { JobContext } from "./define-job";
import { createJobRunTracker, type JobRunTracker } from "./job-run-tracker";
import { PostgresJobRunTracker } from "./postgres-job-run-tracker";
import { env, forceConnectCapabilities } from "./env";

// ─────────────────────────────────────────────────────────────────────────────
// Stub implementations for unconfigured dependencies
// ─────────────────────────────────────────────────────────────────────────────

class NoopFileStorage implements FileStoragePort {
  private fail(operation: string): never {
    throw createFileStorageError(
      "dependency_failed",
      `file_storage_not_configured:${operation}`,
    );
  }
  putObject = () => this.fail("putObject");
  getObjectUrl = () => this.fail("getObjectUrl");
  deleteObject = () => this.fail("deleteObject");
  headObject = () => this.fail("headObject");
  getObject = () => this.fail("getObject");
  listObjects = () => this.fail("listObjects");
  presignPutObject = () => this.fail("presignPutObject");
  moveObject = () => this.fail("moveObject");
}

class MissingStripePaymentProcessor implements PaymentProcessorPort {
  constructor(private readonly logger: LoggerPort) {}
  private fail(operation: string): never {
    this.logger.error("stripe_not_configured", { operation });
    throw new Error("Stripe secret key not configured");
  }
  createPaymentIntent = () => this.fail("createPaymentIntent");
  refundPaymentIntent = () => this.fail("refundPaymentIntent");
  cancelPaymentIntent = () => this.fail("cancelPaymentIntent");
  getProcessingFeeForPaymentIntent = () =>
    this.fail("getProcessingFeeForPaymentIntent");
  getChargeIdForPaymentIntent = () => this.fail("getChargeIdForPaymentIntent");
  createTransfer = () => this.fail("createTransfer");
  reverseTransfer = () => this.fail("reverseTransfer");
  getTransfer = () => this.fail("getTransfer");
  listTransferReversals = () => this.fail("listTransferReversals");
  retrievePaymentIntent = () => this.fail("retrievePaymentIntent");
  createConnectAccount = () => this.fail("createConnectAccount");
  createAccountOnboardingLink = () => this.fail("createAccountOnboardingLink");
  createConnectLoginLink = () => this.fail("createConnectLoginLink");
  getConnectAccountStatus = () => this.fail("getConnectAccountStatus");
  calculateTax = () => this.fail("calculateTax");
  getPaymentMethodType = () => this.fail("getPaymentMethodType");
  createTerminalConnectionToken = () =>
    this.fail("createTerminalConnectionToken");
  createTerminalLocation = () => this.fail("createTerminalLocation");
  createCardPresentPaymentIntent = () =>
    this.fail("createCardPresentPaymentIntent");
  registerTerminalReader = () => this.fail("registerTerminalReader");
  getTerminalReader = () => this.fail("getTerminalReader");
  deleteTerminalReader = () => this.fail("deleteTerminalReader");
  processPaymentIntentOnReader = () =>
    this.fail("processPaymentIntentOnReader");
  cancelReaderAction = () => this.fail("cancelReaderAction");
}

class MissingSearchIndexPort implements SearchIndexPort {
  constructor(private readonly logger: LoggerPort) {}
  private fail(operation: string): never {
    this.logger.error("search_index_not_configured", { operation });
    throw new Error("Meilisearch not configured");
  }
  upsertDocuments = () => this.fail("upsertDocuments");
  deleteDocuments = () => this.fail("deleteDocuments");
  refreshIndexes = () => this.fail("refreshIndexes");
}

// ─────────────────────────────────────────────────────────────────────────────
// Container
// ─────────────────────────────────────────────────────────────────────────────

// The container is built once at startup; `runId` is minted by the dispatcher
// (app.ts) per invocation and merged onto the JobContext at handler call time.
export interface JobsContainer extends Omit<JobContext, "runId"> {
  env: import("./env").Env;
  /**
   * Raw Prisma client, exposed ONLY for the boot-time migration-drift guard in
   * app.ts, which needs a raw `_prisma_migrations` query (no repo/port models
   * that table). Mirrors `AppDeps.prisma` in apps/api/src/lib/dep.ts. Job
   * handlers must keep going through `repos` — this is not a general escape
   * hatch out of the ports layer.
   */
  prisma: PrismaClient;
  runTracker: JobRunTracker;
  diagnostics: RedisJobDiagnosticsAdapter | null;
  close: () => Promise<void>;
}

export async function buildContainer(): Promise<JobsContainer> {
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
        relativePath: e?.relativePath ?? "apps/jobs",
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

  // Redis
  const redisUrl = env.REDIS_URL ?? "redis://localhost:6379";
  const redis = new Redis(redisUrl);
  redis.on("error", (err) => logger.error("redis_error", { err }));

  const idempotency: IdempotencyPort =
    env.IDEMPOTENCY_BACKEND === "postgres"
      ? new PrismaIdempotencyAdapter(prisma, "jobs", logger)
      : new RedisIdempotency(redis, "jobs", logger);

  // Payments
  const payments: PaymentProcessorPort = env.STRIPE_SECRET_KEY
    ? new (
        await import("@th/adapters/payment-processors/stripe/stripe-adapter")
      ).StripePaymentProcessor({
        apiKey: env.STRIPE_SECRET_KEY,
        apiVersion: env.STRIPE_API_VERSION as any,
        baseUrl: env.STRIPE_BASE_URL,
      })
    : new MissingStripePaymentProcessor(logger);

  // Recurring membership billing (Stripe Billing). Null when Stripe is not
  // configured. The tax-jurisdiction refresh job REQUIRES it — a rate change
  // must migrate every live subscription off the archived Stripe TaxRate, and
  // a scheduled job that silently skipped that step would bill the old rate
  // forever with nobody watching. The job wrapper therefore refuses to run
  // rather than degrading. Mirrors apps/api/src/lib/dep.ts.
  const membershipBilling: MembershipBillingPort | null = env.STRIPE_SECRET_KEY
    ? new (
        await import("@th/adapters/payment-processors/stripe/membership-billing-adapter")
      ).StripeMembershipBilling({
        apiKey: env.STRIPE_SECRET_KEY,
        apiVersion: env.STRIPE_API_VERSION as any,
        baseUrl: env.STRIPE_BASE_URL,
      })
    : null;

  // File Storage (S3 when configured, noop otherwise)
  const s3Configured = !!(
    env.S3_BUCKET &&
    env.S3_ENDPOINT &&
    env.S3_ACCESS_KEY_ID &&
    env.S3_SECRET_ACCESS_KEY
  );
  if (!s3Configured) {
    logger.warn("file_storage_not_configured", {
      hint: "Set S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY to enable file storage (required for CSV exports).",
    });
  }
  const fileStorage: FileStoragePort = s3Configured
    ? new (await import("@th/adapters/file-storage/s3")).S3FileStorageAdapter({
        bucket: env.S3_BUCKET!,
        endpoint: env.S3_ENDPOINT!,
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
        publicBaseUrl: env.S3_PUBLIC_BASE_URL,
        logger,
      })
    : new NoopFileStorage();

  // Search Index (single-entity + multi-entity). Both lazy-loaded together so
  // we only pay for the meilisearch SDK once and only when it's wired.
  const meiliSearchConfigured = !!(
    env.MEILISEARCH_HOST && env.MEILISEARCH_API_KEY
  );
  if (env.SEARCH_BACKEND === "meili" && !meiliSearchConfigured) {
    logger.warn("search_not_configured", {
      hint: "Set MEILISEARCH_HOST and MEILISEARCH_API_KEY to enable search indexing. Run: cd infra/docker && docker compose up meilisearch -d",
    });
  }
  const { searchIndex, multiSearch } = await (async (): Promise<{
    searchIndex: SearchIndexPort;
    multiSearch: MultiSearchPort | null;
  }> => {
    const searchIndex = meiliSearchConfigured
      ? new (
          await import("@th/adapters/search/meilisearch-adapter")
        ).MeilisearchAdapter({
          host: env.MEILISEARCH_HOST!,
          apiKey: env.MEILISEARCH_API_KEY!,
        })
      : new MissingSearchIndexPort(logger);

    if (env.SEARCH_BACKEND === "postgres") {
      const { MultiIndexPostgresAdapter } =
        await import("@th/adapters/search/multi-index-postgres-adapter");
      return {
        searchIndex,
        multiSearch: new MultiIndexPostgresAdapter({
          prisma,
          weights: {
            fulltext: env.SEARCH_W_FULLTEXT,
            prefix: env.SEARCH_W_PREFIX,
            fuzzy: env.SEARCH_W_FUZZY,
            popularity: env.SEARCH_W_POPULARITY,
            geo: env.SEARCH_W_GEO,
          },
        }),
      };
    }

    if (!meiliSearchConfigured) {
      return { searchIndex, multiSearch: null };
    }

    const { MultiIndexMeilisearchAdapter } =
      await import("@th/adapters/search/multi-index-meilisearch-adapter");
    return {
      searchIndex,
      multiSearch: new MultiIndexMeilisearchAdapter({
        host: env.MEILISEARCH_HOST!,
        apiKey: env.MEILISEARCH_API_KEY!,
      }),
    };
  })();

  // Platform-level email footer defaults (CAN-SPAM). The jobs process never
  // writes settings, so it relies solely on the TTL backstop to self-heal.
  const footerDefaultsCache = createFooterDefaultsCache({
    platformSettings: repos.platformSettings,
    fallback: {
      physicalAddress: env.SENDER_PHYSICAL_ADDRESS,
      brandName: env.PRODUCT_NAME,
    },
    logger,
  });

  // Mailer (optional — Resend when configured, otherwise SMTP)
  const isPlainSmtp = env.SMTP_SECURE === false;
  const mailer: MailerPort | null = createMailerFromConfig({
    resendApiKey: env.RESEND_API_KEY,
    defaultFromEmail: env.SMTP_DEFAULT_FROM_EMAIL,
    smtpHost: env.SMTP_HOST,
    smtpPort: env.SMTP_PORT,
    smtpSecure: env.SMTP_SECURE,
    smtpUsername: env.SMTP_USERNAME,
    smtpPassword: env.SMTP_PASSWORD,
    plainSmtp: isPlainSmtp,
    logger,
    // Mirror the api container: bind the idempotency port so per-send
    // idempotency keys (e.g. notify()'s) actually dedupe email dispatch
    // instead of being silently ignored.
    idempotency,
    deliverability: createPrismaEmailDeliverabilityAdapter(prisma),
    footerDefaultsProvider: () => footerDefaultsCache.resolve(),
    // The jobs worker sends volunteer shift reminders etc. to seeded
    // recipients (example.com) — the main source of Resend hard bounces.
    // Skip reserved test domains on the Resend path; local Mailpit is unaffected.
    blockReservedTestDomains: true,
  });
  const mailerConfigured = mailer !== null;
  if (!mailerConfigured) {
    logger.warn("mailer_not_configured", {
      hint: "Set RESEND_API_KEY and SMTP_DEFAULT_FROM_EMAIL, or SMTP_HOST, SMTP_PORT, and SMTP_DEFAULT_FROM_EMAIL, to enable email sending from jobs.",
    });
  }

  // SMS (optional — AWS SNS). Only wired when AWS creds are configured.
  // The SnsSmsAdapter respects `Transactional` type by default so we
  // don't accidentally drop volunteer reminders to spam category.
  let sms: SMSPort | null = null;
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    const { SNSClient } = await import("@aws-sdk/client-sns");
    const snsClient = new SNSClient({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
    sms = new SnsSmsAdapter({
      client: snsClient,
      logger,
      defaultSmsType: "Transactional",
      defaultSenderId: env.AWS_SNS_SENDER_ID,
    });
  } else {
    logger.warn("sms_not_configured", {
      hint: "Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (and optionally AWS_SNS_SENDER_ID) to enable SMS dispatch from jobs.",
    });
  }

  // Push (Expo). Constructed unconditionally — Expo's public push API needs
  // no credentials (EXPO_ACCESS_TOKEN is the optional enhanced-security
  // token). notify()'s push channel degrades per-recipient to
  // `skipped/no_devices` until clients register device tokens.
  const push: PushPort = new ExpoPushAdapter({
    repo: repos.pushDevices,
    receiptsRepo: repos.pushReceipts,
    logger,
    metrics: new LoggerMetricsAdapter(logger),
    accessToken: env.EXPO_ACCESS_TOKEN,
  });

  // Best-effort error reporter. Wired to Sentry (which itself only ships events
  // when SENTRY_DSN is set — see instrument.ts). Mirrors the API's
  // `reportError: safeReporter(Sentry.captureException)` in apps/api/src/lib/dep.ts.
  // The `safeReporter` wrapper is load-bearing, not decoration: call sites
  // invoke this as a bare `deps.reportError?.(err, …)` inside catch blocks, so
  // an unwrapped reporter that threw would escape the swallow branch and fail
  // the job it was only meant to observe.
  const reportError: ReporterPort = safeReporter(Sentry.captureException);

  // Timezone lookup (lat/lng → IANA zone; venue-hierarchy FR-004). Local
  // pure-JS adapter — always wired (no credentials, no network). Mirrors
  // apps/api/src/lib/dep.ts.
  const timezoneLookup: TimezoneLookupPort = createTzLookupAdapter();

  // ZipTax (US sales-tax rate lookup). Null when unconfigured — the tax
  // refresh job then SKIPS rather than treating an absent provider as
  // "every rate is now zero", which would archive live rates wholesale.
  const taxRateLookup: TaxRateLookupPort | null = env.ZIPTAX_API_KEY
    ? createZiptaxAdapter(env.ZIPTAX_API_KEY)
    : null;
  if (!taxRateLookup) {
    logger.warn("ziptax_not_configured", {
      hint: "Set ZIPTAX_API_KEY to enable membership tax-jurisdiction refresh.",
    });
  }

  // Image moderation. Azure AI Content Safety when both endpoint + key are
  // configured. Otherwise the fallback depends on the environment: in
  // PRODUCTION a missing secret must FAIL CLOSED (hold every image FLAGGED for
  // human review — never auto-approve un-analyzed content), while non-prod uses
  // a deterministic stub that auto-approves so local/dev and CI flows aren't
  // blocked. Composition-root selection per the spec.
  const azureConfigured = !!(
    env.AZURE_CONTENT_SAFETY_ENDPOINT && env.AZURE_CONTENT_SAFETY_KEY
  );
  const isProduction = env.NODE_ENV === "production";
  const moderation: ModerationPort = azureConfigured
    ? createAzureContentSafetyModerationAdapter({
        endpoint: env.AZURE_CONTENT_SAFETY_ENDPOINT!,
        apiKey: env.AZURE_CONTENT_SAFETY_KEY!,
        reportError,
        logger,
      })
    : isProduction
      ? createFailClosedModerationAdapter()
      : createStubModerationAdapter();
  if (!azureConfigured) {
    logger.warn("image_moderation_unconfigured", {
      mode: isProduction ? "fail-closed" : "stub",
      hint: isProduction
        ? "AZURE_CONTENT_SAFETY_ENDPOINT + AZURE_CONTENT_SAFETY_KEY are not both set — image moderation is FAILING CLOSED (every image is held FLAGGED for human review). Set both to enable real Azure AI Content Safety scanning."
        : "AZURE_CONTENT_SAFETY_ENDPOINT + AZURE_CONTENT_SAFETY_KEY are not both set — image moderation runs in STUB mode (auto-approves every image). Set both to enable real Azure AI Content Safety scanning.",
    });
    // A logger.warn is NOT Sentry-captured (CLAUDE.md), so in production also
    // report the misconfiguration so a cleared/omitted secret (tfvars omitted /
    // secret cleared) is loud in Sentry. We do NOT hard-fail the boot — that
    // would break prod deploys before the Azure secrets are provisioned;
    // failing closed is the safe fallback. Guarded so a throwing reporter never
    // crashes boot.
    if (isProduction) {
      try {
        reportError(new Error("image_moderation_unconfigured_in_production"), {
          tags: { area: "image-moderation" },
        });
      } catch {
        // best-effort only
      }
    }
  }

  const appBaseUrl = env.PUBLIC_WEB_URL ?? "http://localhost:3000";

  // Self-enqueue function (for job fan-out)
  const selfUrl = env.JOBS_SELF_URL ?? `http://localhost:${env.PORT}`;
  const enqueue = async <T>(jobName: string, payload: T): Promise<void> => {
    const url = `${selfUrl}/jobs/${jobName}`;
    logger.info("enqueue_job", { jobName, url });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (env.JOBS_API_KEY) {
      headers["Authorization"] = `Bearer ${env.JOBS_API_KEY}`;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Failed to enqueue job ${jobName}: ${res.status} ${text}`,
      );
    }
  };

  const runTracker: JobRunTracker =
    env.JOB_TRACKER_BACKEND === "postgres"
      ? new PostgresJobRunTracker(prisma)
      : createJobRunTracker(redis);

  // DLQ Diagnostics (Redis-backed, rerun via self-enqueue)
  const diagnostics: RedisJobDiagnosticsAdapter =
    new RedisJobDiagnosticsAdapter({
      redis,
      rerunJob: async (queue, payload) => {
        await enqueue(queue, payload);
        const { randomUUID } = await import("node:crypto");
        return randomUUID();
      },
    });

  const close = async () => {
    await prisma
      .$disconnect()
      .catch((err) => logger.error("prisma_disconnect_failed", { err }));
    await pool
      .end()
      .catch((err) => logger.error("pg_pool_end_failed", { err }));
    await redis
      .quit()
      .catch((err) => logger.error("redis_quit_failed", { err }));
  };

  return {
    env,
    // Exposed for the boot-time migration-drift guard in app.ts, which needs a
    // raw `_prisma_migrations` query (no repo/port models that table). Mirrors
    // `AppDeps.prisma` in apps/api/src/lib/dep.ts. Not for general use — job
    // handlers go through `repos`.
    prisma,
    repos,
    logger,
    clock,
    idempotency,
    payments,
    fileStorage,
    searchIndex,
    multiSearch,
    mailer,
    sms,
    push,
    moderation,
    taxRateLookup,
    timezoneLookup,
    membershipBilling,
    imageModerationReviewThreshold: env.IMAGE_MODERATION_REVIEW_THRESHOLD,
    // Only categories with an explicit override are included — an absent key
    // falls back to imageModerationReviewThreshold inside the use case, so a
    // half-configured environment degrades to the old uniform behaviour rather
    // than to zero (which would flag everything).
    imageModerationCategoryThresholds: {
      ...(env.IMAGE_MODERATION_THRESHOLD_SEXUAL !== undefined && {
        SEXUAL: env.IMAGE_MODERATION_THRESHOLD_SEXUAL,
      }),
      ...(env.IMAGE_MODERATION_THRESHOLD_VIOLENCE !== undefined && {
        VIOLENCE: env.IMAGE_MODERATION_THRESHOLD_VIOLENCE,
      }),
      ...(env.IMAGE_MODERATION_THRESHOLD_HATE !== undefined && {
        HATE: env.IMAGE_MODERATION_THRESHOLD_HATE,
      }),
      ...(env.IMAGE_MODERATION_THRESHOLD_SELF_HARM !== undefined && {
        SELF_HARM: env.IMAGE_MODERATION_THRESHOLD_SELF_HARM,
      }),
    },
    reportError,
    forceConnectCapabilities,
    appBaseUrl,
    unsubscribeSecret: env.UNSUBSCRIBE_SECRET ?? null,
    renderEmailTemplate,
    enqueue,
    runTracker,
    diagnostics,
    close,
  };
}
