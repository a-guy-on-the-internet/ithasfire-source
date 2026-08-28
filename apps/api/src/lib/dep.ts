import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { POOL_TUNING } from "@th/db";
import pg from "pg";
import Redis from "ioredis";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";
import type {
  NotifyInput,
  NotifyOutput,
} from "@th/core/use-cases/comms/notify";
import type { AuthNPort } from "@th/ports/authn";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import { safeReporter } from "@th/ports/reporter";
import type { EmailDeliverabilityPort } from "@th/ports/comms/email-deliverability";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type {
  PlaceLayoutGeometryParserPort,
  PlaceLayoutStreamingPort,
} from "@th/ports/place-layouts";
import { CsvPlaceLayoutParser } from "@th/adapters/place-layouts/csv-place-layout-parser";
import { PlaceLayoutBlobStorage } from "@th/adapters/place-layouts/place-layout-blob-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  SearchPromptPort,
  SearchQueryPort,
  MultiSearchPort,
} from "@th/ports/search";
import { SearchPortError, err } from "@th/ports/search";
import { formatOrderCode } from "@th/types/order-identifier";
import { createPrismaRepos } from "@th/adapters/db/prisma-repos";
import { createPrismaEmailDeliverabilityAdapter } from "@th/adapters/db/prisma-email-deliverability-adapter";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { LoggerMetricsAdapter } from "@th/adapters/infra/logger-metrics";
import { initOpenTelemetry } from "@th/adapters/infra/otel-bootstrap";
import { withGuardedRepos } from "@th/adapters/decorators/with-dependency-guard";
import { withCachedPlatformSettings } from "@th/adapters/decorators/with-cached-platform-settings";
import { RedisIdempotency } from "@th/adapters/idempotency/redis-adapter";
import { RedisRateLimitAdapter } from "@th/adapters/rate-limit/redis-rate-limit-adapter";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createDbAuthZAdapter } from "@th/adapters/authz/db-authz-adapter";
import { createBetterAuthAuthNAdapter } from "@th/adapters/authn/better-auth-authn-adapter";
import { createProfanityContentFilterAdapter } from "@th/adapters/content-filter";
import { PrismaIdempotencyAdapter } from "@th/adapters/idempotency/prisma-adapter";
// Heavy SDK adapters are lazy-imported in `buildDeps()` so deployments
// without the matching env vars skip parsing them on boot:
//   • Stripe (`stripe` SDK)
//   • Meilisearch (single-index + multi-index)
//   • Wallet-pass (`passkit-generator` + Apple/Google adapters)
//   • Turnstile, ZipTax, Routing
// The lightweight stub/missing-port fallbacks stay statically imported so the
// "nothing configured" path still resolves without dynamic imports.
import {
  createMailerFromConfig,
  createFooterDefaultsCache,
} from "@th/adapters/comms/mail";
// Expo push adapter is intentionally statically imported (unlike Stripe /
// Meilisearch / wallet-pass): `expo-server-sdk` is a lightweight HTTP client
// with no heavy native deps, and the adapter needs no credentials — Expo's
// public push API is unauthenticated by default (EXPO_ACCESS_TOKEN only
// enables Expo's optional enhanced push security), so it is constructed
// unconditionally.
import { ExpoPushAdapter } from "@th/adapters/comms/push/expo-push";
import type { PushPort } from "@th/ports/comms/push";
import { createGeoAdapter } from "@th/adapters/geo/index";
import { createS3FileStorage } from "../bootstrap/storage";
import type { TrpcDeps } from "@th/trpc";
import type { TelemetryPort } from "@th/ports/telemetry";
import {
  createFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";

import { NoopTurnstileAdapter } from "@th/adapters/turnstile";
import type { TurnstilePort } from "@th/ports/turnstile";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";
import { createTzLookupAdapter } from "@th/adapters/timezone-lookup";
import type { MusicStatsPort } from "@th/ports/music-stats";
import type { RoutingPort } from "@th/ports/routing.port";
// Lazy-imported below: full wallet-pass module (passkit-generator pulls heavy
// native deps on require), so we only load it when wallet credentials are
// actually present. The stub stays statically imported because it's tiny.
import { createStubWalletPassAdapter } from "@th/adapters/wallet-pass/stub-adapter";
import type { WalletPassPort } from "@th/ports/wallet-pass.port";
import { createJoseVolunteerScanTokenAdapter } from "@th/adapters/volunteer-scan-token";
import type { VolunteerScanTokenPort } from "@th/ports/volunteer-scan-token";
import {
  createDiscordWebhookAlertSender,
  detectCloudRunEnvTag,
} from "@th/adapters/infra/discord-alerts";
import { env, forceConnectCapabilities } from "./env";
import { WebhookDlq } from "./webhook-dlq";
import { buildSettlementFailureAlerter } from "./settlement-failure-alert";
import { Sentry } from "../instrument";

const discordAlertLogger = createPinoLoggerAdapter().child({
  transport: "discord_alerts",
});

/**
 * Single shared Discord webhook sender for the API. Prefixes every alert
 * title with `[env]` so a dev failure can't be mistaken for prod.
 */
export const fireDiscordAlert = createDiscordWebhookAlertSender({
  webhookUrl: env.DISCORD_ALERTS_WEBHOOK,
  logger: discordAlertLogger,
  titlePrefix:
    detectCloudRunEnvTag() ??
    (process.env.NODE_ENV === "production" ? "prod" : "local"),
});

/**
 * Dedicated Discord sender for the support chat widget so support pings land in
 * their own channel (DISCORD_SUPPORT_WEBHOOK), separate from ops/agent noise.
 * No-ops when the webhook is unset — support alerts are always best-effort.
 */
export const fireSupportDiscordAlert = createDiscordWebhookAlertSender({
  webhookUrl: env.DISCORD_SUPPORT_WEBHOOK,
  logger: discordAlertLogger.child({ channel: "support" }),
  titlePrefix:
    detectCloudRunEnvTag() ??
    (process.env.NODE_ENV === "production" ? "prod" : "local"),
});

type NotifySupportInput = {
  reason: "new_thread" | "awaiting_human";
  threadId: string;
  // Nullable: an owner-less (GDPR/CCPA-erased) thread re-escalated by staff has
  // no human to reference — mirrors the core NotifySupportInput.
  humanId: string | null;
  eventId: string | null;
  orderId: string | null;
};

type NotifySupportFn = (input: NotifySupportInput) => Promise<void>;

/**
 * Adapts the generic Discord sender to the support use cases' `NotifySupportFn`
 * shape. The use cases inject this and wrap it defensively; the underlying
 * sender also no-ops/swallows on failure, so this is fail-safe end to end.
 *
 * A factory (rather than a module-level const) so it can resolve human-readable
 * labels via `repos` before posting: the alert shows the attendee's display
 * NAME (no email), the event TITLE and order REF instead of a wall of raw
 * UUIDs, plus a clickable deep-link into the operator inbox. Email and the
 * message body are intentionally NOT sent (data-minimization): the external
 * Discord processor must not receive attendee PII — staff get full identity and
 * the message body from the staff-only in-app inbox via the deep link. The
 * label lookup is strictly best-effort: ANY failure is logged and we fall back
 * to posting with raw IDs. The alert must never throw into the request path
 * (NFR-003).
 */
const createNotifySupport = (deps: {
  repos: Pick<Repos, "humans" | "events" | "orders">;
  logger: LoggerPort;
  publicWebUrl: string;
}): NotifySupportFn => {
  return async (input) => {
    const title =
      input.reason === "new_thread"
        ? "New support thread"
        : "Support thread escalated to human";

    // Best-effort label resolution. The three lookups are independent, so run
    // them concurrently. The whole batch is isolated: ANY failure degrades to
    // raw IDs rather than dropping the alert. We NEVER rethrow — posting a
    // less-rich alert is always better than posting none.
    let humanDisplayName: string | null = null;
    let eventTitle: string | null = null;
    let orderRef: string | null = null;

    try {
      const [human, event, order] = await Promise.all([
        // Owner-less threads (GDPR-erased) have no human to resolve.
        input.humanId
          ? deps.repos.humans.getByIdWithIdentity(input.humanId)
          : Promise.resolve(null),
        input.eventId
          ? deps.repos.events.getById(input.eventId)
          : Promise.resolve(null),
        input.orderId
          ? deps.repos.orders.getById(input.orderId)
          : Promise.resolve(null),
      ]);

      // Display NAME only — email is deliberately never read into the payload.
      humanDisplayName = human?.human.name ?? null;
      eventTitle = event?.title ?? null;
      // Mirror toStaffThreadRecord's orderRef: the single platform-wide order
      // code (the 8-hex tail of the order id, uppercased), so an alert quotes
      // the same code the operator inbox and admin search use.
      orderRef = order ? formatOrderCode(order.id) : null;
    } catch (error) {
      // Lookup failed (repo error, missing relation, etc.). Fall back to raw
      // IDs. Already email-free — no PII reaches structured logs.
      deps.logger.warn("support_alert_label_lookup_failed", {
        threadId: input.threadId,
        humanId: input.humanId,
        eventId: input.eventId,
        orderId: input.orderId,
        error,
      });
    }

    // Deep-link straight to the thread in the operator inbox. Uses the threadId
    // UUID only — never email or other PII in the URL.
    const threadUrl = `${deps.publicWebUrl}/platform/support?thread=${input.threadId}`;

    // Description is the deep link alone. The message body is intentionally NOT
    // included (data-minimization): staff read it in-app via this link.
    const description = `[Open thread](${threadUrl})`;

    // Human-readable primary field. Display name only — email is intentionally
    // omitted from the Discord payload (data-minimization).
    const humanValue =
      humanDisplayName ?? input.humanId ?? "(deleted attendee)";

    const fields: { name: string; value: string; inline?: boolean }[] = [
      { name: "From", value: humanValue, inline: false },
    ];
    if (input.eventId) {
      fields.push({
        name: "Event",
        value: eventTitle ?? input.eventId,
        inline: true,
      });
    }
    if (input.orderId) {
      fields.push({
        name: "Order",
        value: orderRef ?? input.orderId,
        inline: true,
      });
    }

    await fireSupportDiscordAlert({
      title,
      colour: input.reason === "awaiting_human" ? "warning" : "info",
      description,
      fields,
    });
  };
};

const logMissingOptionalIntegration = (
  logger: LoggerPort,
  msg: string,
  extra: Record<string, unknown>,
): void => {
  logger.log(
    process.env.NODE_ENV === "production" ? "warn" : "info",
    msg,
    extra,
  );
};

class NoopFileStorage implements FileStoragePort {
  private fail(operation: string): never {
    throw createFileStorageError(
      "dependency_failed",
      `file_storage_not_configured:${operation}`,
    );
  }

  putObject(): Promise<never> {
    return this.fail("putObject");
  }

  getObjectUrl(): Promise<never> {
    return this.fail("getObjectUrl");
  }

  deleteObject(): Promise<never> {
    return this.fail("deleteObject");
  }

  headObject(): Promise<never> {
    return this.fail("headObject");
  }

  getObject(): Promise<never> {
    return this.fail("getObject");
  }

  listObjects(): Promise<never> {
    return this.fail("listObjects");
  }

  presignPutObject(): Promise<never> {
    return this.fail("presignPutObject");
  }

  moveObject(): Promise<never> {
    return this.fail("moveObject");
  }
}

class MissingStripePaymentProcessor implements PaymentProcessorPort {
  constructor(private readonly logger: LoggerPort) {}

  private fail(operation: string): never {
    const error = new Error("Stripe secret key not configured");
    this.logger.error("stripe_payment_processor_not_configured", { operation });
    throw error;
  }

  async createPaymentIntent(
    _input: Parameters<PaymentProcessorPort["createPaymentIntent"]>[0],
  ): Promise<never> {
    return this.fail("createPaymentIntent");
  }

  async refundPaymentIntent(
    _input: Parameters<PaymentProcessorPort["refundPaymentIntent"]>[0],
  ): Promise<never> {
    return this.fail("refundPaymentIntent");
  }

  async cancelPaymentIntent(
    _input: Parameters<PaymentProcessorPort["cancelPaymentIntent"]>[0],
  ): Promise<never> {
    return this.fail("cancelPaymentIntent");
  }

  async getProcessingFeeForPaymentIntent(
    _input: Parameters<
      PaymentProcessorPort["getProcessingFeeForPaymentIntent"]
    >[0],
  ): Promise<never> {
    return this.fail("getProcessingFeeForPaymentIntent");
  }

  async createTransfer(
    _input: Parameters<PaymentProcessorPort["createTransfer"]>[0],
  ): Promise<never> {
    return this.fail("createTransfer");
  }

  async getChargeIdForPaymentIntent(
    _input: Parameters<PaymentProcessorPort["getChargeIdForPaymentIntent"]>[0],
  ): Promise<never> {
    return this.fail("getChargeIdForPaymentIntent");
  }

  async retrievePaymentIntent(
    _input: Parameters<PaymentProcessorPort["retrievePaymentIntent"]>[0],
  ): Promise<never> {
    return this.fail("retrievePaymentIntent");
  }

  async createConnectAccount(): Promise<never> {
    return this.fail("createConnectAccount");
  }

  async createAccountOnboardingLink(
    _input: Parameters<PaymentProcessorPort["createAccountOnboardingLink"]>[0],
  ): Promise<never> {
    return this.fail("createAccountOnboardingLink");
  }

  async createConnectLoginLink(
    _input: Parameters<PaymentProcessorPort["createConnectLoginLink"]>[0],
  ): Promise<never> {
    return this.fail("createConnectLoginLink");
  }

  async getConnectAccountStatus(
    _input: Parameters<PaymentProcessorPort["getConnectAccountStatus"]>[0],
  ): Promise<never> {
    return this.fail("getConnectAccountStatus");
  }

  async calculateTax(
    _input: Parameters<PaymentProcessorPort["calculateTax"]>[0],
  ): Promise<never> {
    return this.fail("calculateTax");
  }

  async getPaymentMethodType(
    _input: Parameters<PaymentProcessorPort["getPaymentMethodType"]>[0],
  ): Promise<never> {
    return this.fail("getPaymentMethodType");
  }

  async reverseTransfer(
    _input: Parameters<PaymentProcessorPort["reverseTransfer"]>[0],
  ): Promise<never> {
    return this.fail("reverseTransfer");
  }

  async getTransfer(
    _input: Parameters<PaymentProcessorPort["getTransfer"]>[0],
  ): Promise<never> {
    return this.fail("getTransfer");
  }

  async listTransferReversals(
    _input: Parameters<PaymentProcessorPort["listTransferReversals"]>[0],
  ): Promise<never> {
    return this.fail("listTransferReversals");
  }

  async createTerminalConnectionToken(
    _input: Parameters<
      PaymentProcessorPort["createTerminalConnectionToken"]
    >[0],
  ): Promise<never> {
    return this.fail("createTerminalConnectionToken");
  }

  async createTerminalLocation(
    _input: Parameters<PaymentProcessorPort["createTerminalLocation"]>[0],
  ): Promise<never> {
    return this.fail("createTerminalLocation");
  }

  async createCardPresentPaymentIntent(
    _input: Parameters<
      PaymentProcessorPort["createCardPresentPaymentIntent"]
    >[0],
  ): Promise<never> {
    return this.fail("createCardPresentPaymentIntent");
  }

  async registerTerminalReader(
    _input: Parameters<PaymentProcessorPort["registerTerminalReader"]>[0],
  ): Promise<never> {
    return this.fail("registerTerminalReader");
  }

  async getTerminalReader(
    _input: Parameters<PaymentProcessorPort["getTerminalReader"]>[0],
  ): Promise<never> {
    return this.fail("getTerminalReader");
  }

  async deleteTerminalReader(
    _input: Parameters<PaymentProcessorPort["deleteTerminalReader"]>[0],
  ): Promise<never> {
    return this.fail("deleteTerminalReader");
  }

  async processPaymentIntentOnReader(
    _input: Parameters<PaymentProcessorPort["processPaymentIntentOnReader"]>[0],
  ): Promise<never> {
    return this.fail("processPaymentIntentOnReader");
  }

  async cancelReaderAction(
    _input: Parameters<PaymentProcessorPort["cancelReaderAction"]>[0],
  ): Promise<never> {
    return this.fail("cancelReaderAction");
  }
}

class MissingAuthNAdapter implements AuthNPort {
  constructor(private readonly logger: LoggerPort) {}

  private fail(operation: string): never {
    const error = new Error("No auth provider configured");
    this.logger.error("auth_not_configured", { operation });
    throw error;
  }

  async ensureAuthedHuman(
    _input: Parameters<AuthNPort["ensureAuthedHuman"]>[0],
  ): Promise<never> {
    return this.fail("ensureAuthedHuman");
  }

  async ensureAuthedHumanFromApiKey(
    _input: Parameters<AuthNPort["ensureAuthedHumanFromApiKey"]>[0],
  ): Promise<never> {
    return this.fail("ensureAuthedHumanFromApiKey");
  }

  async getProviderUserId(
    _input: Parameters<AuthNPort["getProviderUserId"]>[0],
  ): Promise<never> {
    return this.fail("getProviderUserId");
  }
}

class MissingBetterAuthNAdapter implements AuthNPort {
  constructor(private readonly logger: LoggerPort) {}

  private fail(operation: string): never {
    const error = new Error("Better Auth JWKS URL not configured");
    this.logger.error("better_auth_not_configured", { operation });
    throw error;
  }

  async ensureAuthedHuman(
    _input: Parameters<AuthNPort["ensureAuthedHuman"]>[0],
  ): Promise<never> {
    return this.fail("ensureAuthedHuman");
  }

  async ensureAuthedHumanFromApiKey(
    _input: Parameters<AuthNPort["ensureAuthedHumanFromApiKey"]>[0],
  ): Promise<never> {
    return this.fail("ensureAuthedHumanFromApiKey");
  }

  async getProviderUserId(
    _input: Parameters<AuthNPort["getProviderUserId"]>[0],
  ): Promise<never> {
    return this.fail("getProviderUserId");
  }
}

class NoopPlaceLayoutStreaming implements PlaceLayoutStreamingPort {
  constructor(private readonly logger: LoggerPort) {}

  async publishPlaceLayoutReplaced(input: {
    placeId: string;
    checksum: string | null;
  }): Promise<void> {
    this.logger.warn("place_layout_streaming_not_configured", input);
  }
}

class UnconfiguredPlaceLayoutParser implements PlaceLayoutGeometryParserPort {
  constructor(private readonly logger: LoggerPort) {}

  async parse(
    _input: Parameters<PlaceLayoutGeometryParserPort["parse"]>[0],
  ): Promise<never> {
    const error = new Error("Place layout parser is not configured");
    this.logger.error("place_layout_parser_not_configured");
    throw error;
  }
}

class MissingSearchQueryPort implements SearchQueryPort {
  constructor(private readonly logger: LoggerPort) {}

  private fail(operation: string) {
    this.logger.error("search_query_port_not_configured", { operation });
    return err(
      new SearchPortError(
        "unimplemented",
        `SearchQueryPort.${operation} not configured`,
      ),
    );
  }

  async autocomplete(_input: Parameters<SearchQueryPort["autocomplete"]>[0]) {
    return this.fail("autocomplete");
  }

  async search(_input: Parameters<SearchQueryPort["search"]>[0]) {
    return this.fail("search");
  }

  async related(_input: Parameters<SearchQueryPort["related"]>[0]) {
    return this.fail("related");
  }
}

class MissingSearchPromptPort implements SearchPromptPort {
  constructor(private readonly logger: LoggerPort) {}

  async listPrompts(_input: Parameters<SearchPromptPort["listPrompts"]>[0]) {
    this.logger.error("search_prompt_port_not_configured");
    return err(
      new SearchPortError(
        "unimplemented",
        "SearchPromptPort.listPrompts not configured",
      ),
    );
  }
}

export type AppDeps = {
  prisma: PrismaClient;
  redis: Redis;
  trpc: TrpcDeps;
  logger: LoggerPort;
  mailer?: MailerPort;
  emailDeliverability: EmailDeliverabilityPort;
  telemetry?: TelemetryPort;
  close: () => Promise<void>;
};

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

const createNotify = (input: {
  repos: Repos;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  push: PushPort;
  logger: LoggerPort;
  /**
   * When present the notify() email channel actually sends (ctx.notifyWithEmail).
   * The default ctx.notify binding deliberately omits it — inline consumers
   * historically rely on the email channel skipping (`port_unavailable`) and
   * deliver email via dedicated mailers/outbox drains instead.
   */
  mailer?: MailerPort;
}): NotifyFn => {
  return async (payload) =>
    notifyUseCase(
      {
        repos: input.repos,
        clock: input.clock,
        idempotency: input.idempotency,
        push: input.push,
        ...(input.mailer ? { mailer: input.mailer } : {}),
        logger: input.logger,
      },
      payload,
    );
};

export async function buildDeps(): Promise<AppDeps> {
  // Prisma v7 can fail on startup if the generated client config is missing
  // certain path fields at runtime (e.g. `relativePath`). Using the Postgres
  // Driver Adapter + a small runtime override avoids that crash.
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ...POOL_TUNING,
  });
  const adapter = new PrismaPg(pool);

  const prisma = new PrismaClient({
    adapter,
    // Prisma's runtime resolves env paths like:
    //   resolve(e.dirname, e.relativeEnvPaths.rootEnvPath)
    //   resolve(e.dirname, e.relativeEnvPaths.schemaEnvPath)
    //   resolve(e.dirname, e.relativePath)
    // In some setups (notably monorepos), those fields can be undefined in the
    // generated client's baked-in config, which triggers ERR_INVALID_ARG_TYPE.
    // This internal override is the supported escape hatch used by Prisma
    // itself in tests and prevents startup crashes.
    __internal: {
      configOverride: (e: any) => ({
        ...e,
        dirname: e?.dirname ?? process.cwd(),
        relativePath: e?.relativePath ?? "apps/api",
        relativeEnvPaths: {
          rootEnvPath: e?.relativeEnvPaths?.rootEnvPath ?? ".env",
          schemaEnvPath: e?.relativeEnvPaths?.schemaEnvPath ?? ".env",
        },
      }),
    },
  } as any);
  await prisma.$connect();

  const logger = createPinoLoggerAdapter();

  // ── File storage (S3) ─────────────────────────────────────────────────
  // Created early so it can be injected into repos (placeLayoutBlobs) and
  // the place layout CSV parser.
  //
  // Fail loud at boot rather than silently degrading to NoopFileStorage,
  // which only surfaces — as a per-request 500 (file_storage_not_configured)
  // — the first time someone tries to upload. A half-set or (in a real
  // deployment) entirely-missing S3 config is always a deploy bug; catch it
  // at startup, not in production traffic.
  const requiredStorageVars = {
    S3_BUCKET: env.S3_BUCKET,
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  };
  const missingStorageVars = Object.entries(requiredStorageVars)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  const storageFullyConfigured = missingStorageVars.length === 0;
  const storagePartiallyConfigured =
    !storageFullyConfigured && missingStorageVars.length < 4;

  if (storagePartiallyConfigured) {
    // Some but not all S3 vars set — unambiguously a misconfiguration.
    throw new Error(
      `file_storage_misconfigured: S3 storage is half-configured; missing ` +
        `[${missingStorageVars.join(", ")}]. Refusing to boot rather than ` +
        `degrade to a no-op adapter that 500s on every upload.`,
    );
  }

  if (!storageFullyConfigured && process.env.NODE_ENV === "production") {
    // No S3 config at all in a real deployment. Uploads (event images/audio,
    // avatars, banners, place layouts, verification docs) cannot work — don't
    // boot blind.
    throw new Error(
      `file_storage_not_configured: no S3 storage configured but ` +
        `NODE_ENV=production. The API requires S3_BUCKET, S3_ENDPOINT, ` +
        `S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY for uploads.`,
    );
  }

  if (!storageFullyConfigured) {
    // Non-production with no storage (e.g. local dev). Allowed, but make it a
    // visible, captured signal at boot instead of a silent surprise later.
    logger.warn("file_storage_disabled", {
      reason: "no S3 storage configured; all upload operations will fail",
      nodeEnv: process.env.NODE_ENV ?? "undefined",
    });
  }

  const fileStorage = storageFullyConfigured
    ? createS3FileStorage(
        {
          S3_BUCKET: env.S3_BUCKET as string,
          S3_ENDPOINT: env.S3_ENDPOINT as string,
          S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID as string,
          S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY as string,
          S3_PUBLIC_BASE_URL: env.S3_PUBLIC_BASE_URL,
          S3_PUBLIC_READ: env.S3_PUBLIC_READ,
        },
        logger,
      )
    : new NoopFileStorage();

  // ── Place layout blob storage (non-Prisma repo injected into TxRepos) ─
  const placeLayoutBlobRepo = !(fileStorage instanceof NoopFileStorage)
    ? new PlaceLayoutBlobStorage({ storage: fileStorage, logger })
    : undefined;

  // ── Place layout parser ──────────────────────────────────────────────
  let placeLayoutParser: PlaceLayoutGeometryParserPort;
  placeLayoutParser = !(fileStorage instanceof NoopFileStorage)
    ? new CsvPlaceLayoutParser({ storage: fileStorage, logger })
    : new UnconfiguredPlaceLayoutParser(logger);

  const prismaRepos = createPrismaRepos(prisma, {
    ...(placeLayoutBlobRepo ? { placeLayoutBlobs: placeLayoutBlobRepo } : {}),
  });

  // Read-through cache in front of the platform-settings repo.
  //
  // `getAll()` is a full-table read and `getFeatureGates` calls it, which runs
  // from `features.*`, `events.*` and `ticket-types.*` — so a single batched
  // tRPC request hit it ~2x. Measured 2026-08-19: 37,700 full-table reads
  // against 18,950 requests over 7d (`docs/ops/resource-burn.md`).
  //
  // Applied HERE rather than inside `createPrismaRepos` so the caching is a
  // visible composition-root decision, like `withGuardedRepos` below — a repo
  // that silently caches is a nasty surprise when you go looking for stale
  // reads. Writes go through `upsert`, which invalidates this instance; the
  // TTL is the backstop for other instances.
  const cachedPlatformSettings = withCachedPlatformSettings(
    prismaRepos.platformSettings,
  );

  const reposBase = {
    ...prismaRepos,
    platformSettings: cachedPlatformSettings,
  };
  const repos = withGuardedRepos(reposBase, logger, {
    events: {
      classifyTransient: (error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        return /deadlock|serialization failure|ETIMEDOUT/i.test(message);
      },
    },
  });

  const redisUrl =
    env.REDIS_URL ??
    (process.env.NODE_ENV === "production"
      ? undefined
      : "redis://localhost:6379");
  if (!redisUrl) {
    throw new Error("REDIS_URL is required in production");
  }

  // `commandTimeout` + `maxRetriesPerRequest` are bounded so a
  // wedged/unreachable Redis connection fails fast instead of hanging (or
  // silently retrying for a long time via ioredis's default offline-queueing
  // behavior). This client now backs `defaultRateLimit`, applied to EVERY
  // tRPC procedure in the request path (2026-07-05 security-audit
  // follow-up) — a slow-to-fail Redis call there would add latency to the
  // whole API, not just the ~11 routers with their own rate limits. The
  // rate-limit middleware (`guard.ts`) fails open on any Redis error, so a
  // fast, bounded failure here is strictly better than the previous
  // unbounded default. Idempotency (`RedisIdempotency`, when
  // `IDEMPOTENCY_BACKEND=redis`) shares this same client; failing fast on a
  // wedged connection is an improvement there too — idempotency callers
  // shouldn't hang the request indefinitely either.
  const redis = new Redis(redisUrl, {
    commandTimeout: 500,
    maxRetriesPerRequest: 2,
  });
  redis.on("error", (err) => {
    logger.error("redis_error", { err });
  });

  const idempotency: IdempotencyPort =
    env.IDEMPOTENCY_BACKEND === "postgres"
      ? new PrismaIdempotencyAdapter(prisma, "api", logger)
      : new RedisIdempotency(redis, "api", logger);
  const emailDeliverability = createPrismaEmailDeliverabilityAdapter(prisma, {
    alert: fireDiscordAlert,
    logger,
  });
  const rateLimitAdapter = new RedisRateLimitAdapter(redis);
  const contentFilter = createProfanityContentFilterAdapter();
  const clock = createSystemClock();
  const authz = createDbAuthZAdapter({ repos });
  // Expo push (FR-006 platform push wiring). Constructed unconditionally —
  // Expo's public push API needs no credentials; EXPO_ACCESS_TOKEN is the
  // optional enhanced-security token. With no registered devices the notify()
  // push channel degrades to `skipped/no_devices`, so this is safe before any
  // client registers a token.
  const push: PushPort = new ExpoPushAdapter({
    repo: repos.pushDevices,
    receiptsRepo: repos.pushReceipts,
    logger,
    metrics: new LoggerMetricsAdapter(logger),
    accessToken: env.EXPO_ACCESS_TOKEN,
  });
  const notify = createNotify({ repos, clock, idempotency, push, logger });
  const notifySupport = createNotifySupport({
    repos,
    logger,
    publicWebUrl: env.PUBLIC_WEB_URL,
  });

  const authn: AuthNPort = env.BETTER_AUTH_JWKS_URL
    ? (() => {
        logger.info("auth_adapter_init", {
          jwksUrl: env.BETTER_AUTH_JWKS_URL,
          issuer: env.BETTER_AUTH_ISSUER,
          audience: env.BETTER_AUTH_AUDIENCE,
        });
        return createBetterAuthAuthNAdapter({
          repos,
          jwksUrl: env.BETTER_AUTH_JWKS_URL,
          issuer: env.BETTER_AUTH_ISSUER,
          audience: env.BETTER_AUTH_AUDIENCE,
        });
      })()
    : (() => {
        logger.warn("auth_adapter_missing", {
          jwksUrl: env.BETTER_AUTH_JWKS_URL,
          reason: "BETTER_AUTH_JWKS_URL not set",
        });
        return new MissingAuthNAdapter(logger);
      })();

  // One Stripe credential resolution shared by the payment processor and the
  // membership billing adapter, so a dev stack talking to stripe-mock (or a
  // real key) gets BOTH ports pointed at the same backend.
  const stripeConfig = await (async (): Promise<{
    apiKey: string;
    baseUrl?: string;
    apiVersion?: string;
  } | null> => {
    const stripeKey = env.STRIPE_SECRET_KEY;
    const stripeBaseUrl = env.STRIPE_BASE_URL;

    if (stripeKey) {
      logger.info("[Stripe] Initializing processor", {
        hasKey: true,
        baseUrl: stripeBaseUrl || "(empty)",
        mode: env.E2E_STRIPE_MODE,
        rawEnvBaseUrl: process.env.STRIPE_BASE_URL,
      });
      return {
        apiKey: stripeKey,
        apiVersion: env.STRIPE_API_VERSION,
        baseUrl: stripeBaseUrl,
      };
    }

    // Dev fallback: auto-detect stripe-mock on the default docker-compose port.
    if (process.env.NODE_ENV !== "production") {
      const mockUrl = "http://127.0.0.1:12111";
      try {
        const probe = await fetch(mockUrl, {
          method: "GET",
          signal: AbortSignal.timeout(500),
        });
        if (probe.ok || probe.status === 404) {
          logger.info(
            "[Stripe] Auto-detected stripe-mock, using it as payment processor",
            { baseUrl: mockUrl },
          );
          // Dummy key accepted by stripe-mock; never sent to real Stripe servers.
          return { apiKey: "sk_test_123", baseUrl: mockUrl };
        }
      } catch {
        // stripe-mock not reachable — fall through to missing processor.
      }
    }

    return null;
  })();

  const payments: PaymentProcessorPort = stripeConfig
    ? new (
        await import("@th/adapters/payment-processors/stripe/stripe-adapter")
      ).StripePaymentProcessor({
        apiKey: stripeConfig.apiKey,
        apiVersion: stripeConfig.apiVersion as any,
        baseUrl: stripeConfig.baseUrl,
      })
    : new MissingStripePaymentProcessor(logger);

  // Recurring membership billing (Stripe Billing). Null when Stripe is not
  // configured — the membership tRPC procedures then fail NOT_CONFIGURED
  // instead of pretending to bill.
  const membershipBilling = stripeConfig
    ? new (
        await import("@th/adapters/payment-processors/stripe/membership-billing-adapter")
      ).StripeMembershipBilling({
        apiKey: stripeConfig.apiKey,
        apiVersion: stripeConfig.apiVersion as any,
        baseUrl: stripeConfig.baseUrl,
      })
    : null;
  if (!stripeConfig) {
    logMissingOptionalIntegration(logger, "membership_billing_not_configured", {
      hint: "Set STRIPE_SECRET_KEY (or run stripe-mock) to enable membership billing.",
    });
  }

  const placeLayoutStreaming: PlaceLayoutStreamingPort =
    new NoopPlaceLayoutStreaming(logger);
  // In local/dev, default to the DB-backed geo adapter so the app can support nearbyEvents
  // without requiring PostGIS + `loc` columns to be set up.
  const geoBackendEnv =
    env.GEO_BACKEND ??
    (process.env.NODE_ENV === "production" ? "postgis" : "db");
  const geo = await createGeoAdapter({
    db: prisma,
    logger,
    backendEnv: geoBackendEnv,
  });

  // Platform-level email footer defaults (CAN-SPAM mailing address + contact +
  // brand). Resolved from PlatformSetting rows with env fallbacks, cached with a
  // TTL backstop and invalidated on settings writes (see platform router).
  const footerDefaultsCache = createFooterDefaultsCache({
    platformSettings: repos.platformSettings,
    fallback: {
      physicalAddress: env.SENDER_PHYSICAL_ADDRESS,
      brandName: env.PRODUCT_NAME,
    },
    logger,
  });

  const isPlaywrightE2E = process.env.PLAYWRIGHT_E2E === "1";
  const isPlainSmtp = isPlaywrightE2E || env.SMTP_SECURE === false;
  const mailer: MailerPort | undefined =
    createMailerFromConfig({
      resendApiKey: env.RESEND_API_KEY,
      defaultFromEmail: env.SMTP_DEFAULT_FROM_EMAIL,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      smtpUsername: env.SMTP_USERNAME,
      smtpPassword: env.SMTP_PASSWORD,
      appHeaderValue: env.SMTP_APP_HEADER,
      plainSmtp: isPlainSmtp,
      logger,
      idempotency,
      deliverability: emailDeliverability,
      footerDefaultsProvider: () => footerDefaultsCache.resolve(),
      // Never send to RFC-reserved test domains (seed fixtures use example.com).
      // Only affects the Resend path; local Mailpit still shows everything.
      blockReservedTestDomains: true,
    }) ?? undefined;

  // notify() with the mailer bound — email leg sends inline. Used by flows
  // whose email is part of the notify() call itself (booking-request-received,
  // FR-008) rather than a dedicated mailer/outbox drain. Kept separate from
  // `notify` above so the ~20 existing inline consumers don't silently start
  // emailing (their email channel skips with `port_unavailable` today).
  //
  // Degraded-binding guard: with no mailer configured, every notifyWithEmail
  // email leg quietly skips (`port_unavailable`) — in prod that would silently
  // no-op venue emails forever. `logger.error` is pino-captured into Sentry,
  // so a prod revision missing RESEND_API_KEY/SMTP_* is loud at startup.
  // Local dev / Playwright E2E without a mailer is a normal configuration.
  if (!mailer) {
    if (process.env.NODE_ENV === "production" && !isPlaywrightE2E) {
      logger.error("notify_with_email_mailer_missing", {
        hint: "Set RESEND_API_KEY or SMTP_* — notifyWithEmail email legs (booking-request-received) will skip with port_unavailable until then.",
      });
    } else {
      logMissingOptionalIntegration(
        logger,
        "notify_with_email_mailer_missing",
        {
          hint: "No mailer configured; notifyWithEmail email legs will skip with port_unavailable.",
        },
      );
    }
  }
  const notifyWithEmail = createNotify({
    repos,
    clock,
    idempotency,
    push,
    logger,
    ...(mailer ? { mailer } : {}),
  });

  const meiliSearchConfigured = !!(
    env.MEILISEARCH_HOST && env.MEILISEARCH_API_KEY
  );
  if (env.SEARCH_BACKEND === "meili" && !meiliSearchConfigured) {
    logger.warn("search_not_configured", {
      hint: "Set MEILISEARCH_HOST and MEILISEARCH_API_KEY to enable search. Run: cd infra/docker && docker compose up meilisearch -d",
    });
  }
  // Lazy-load search adapters only when their backend is selected/configured.
  const { searchQuery, multiSearch } = await (async (): Promise<{
    searchQuery: SearchQueryPort;
    multiSearch: MultiSearchPort | null;
  }> => {
    const searchQuery = meiliSearchConfigured
      ? new (
          await import("@th/adapters/search/meilisearch-adapter")
        ).MeilisearchAdapter({
          host: env.MEILISEARCH_HOST!,
          apiKey: env.MEILISEARCH_API_KEY!,
        })
      : new MissingSearchQueryPort(logger);

    if (env.SEARCH_BACKEND === "postgres") {
      const { MultiIndexPostgresAdapter } =
        await import("@th/adapters/search/multi-index-postgres-adapter");
      return {
        searchQuery,
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
      return { searchQuery, multiSearch: null };
    }

    const { MultiIndexMeilisearchAdapter } =
      await import("@th/adapters/search/multi-index-meilisearch-adapter");
    return {
      searchQuery,
      multiSearch: new MultiIndexMeilisearchAdapter({
        host: env.MEILISEARCH_HOST!,
        apiKey: env.MEILISEARCH_API_KEY!,
      }),
    };
  })();

  // Cloudflare Turnstile (bot protection for public embed checkout).
  // Turnstile fails CLOSED, so the adapter gets the Sentry-backed reporter:
  // a siteverify outage rejects 100% of embed guest checkouts and must not
  // be invisible (the use case maps `false` to a 4xx that never hits Sentry).
  // Throttling is handled inside the adapter (15-minute window per branch).
  const turnstile: TurnstilePort = env.TURNSTILE_SECRET_KEY
    ? new (await import("@th/adapters/turnstile")).CloudflareTurnstileAdapter({
        secretKey: env.TURNSTILE_SECRET_KEY,
        logger,
        reportError: safeReporter(Sentry.captureException),
      })
    : new NoopTurnstileAdapter();
  if (!env.TURNSTILE_SECRET_KEY) {
    // LOUD, not a shrug. `logMissingOptionalIntegration` downgrades to info
    // outside production and warn inside it — and warn is NOT captured by
    // Sentry's pino integration (CLAUDE.md), so the previous line meant a
    // deployment could run the ANONYMOUS application path
    // (`events.submitApplication`, spec Phase 3) with the Noop adapter and
    // therefore ZERO bot protection, with nothing failing and nothing visible.
    //
    // Anonymous applications write a queue row and fan out organizer
    // notifications, so an unprotected instance is a spam amplifier pointed at
    // organizers. Deliberately does NOT crash boot: dev/CI legitimately run
    // without a Cloudflare secret, and a hard failure here would take down
    // every other surface too. `logger.error` (Sentry-captured) + an explicit
    // report is the honest middle.
    const message =
      "turnstile_not_configured: the anonymous event-application and embed-checkout paths are reachable with NO bot protection";
    logger.error(message, {
      hint: "Set TURNSTILE_SECRET_KEY to enable Cloudflare Turnstile.",
      affects: ["events.submitApplication", "embeds.createBookingInquiry"],
    });
    try {
      Sentry.captureException(new Error(message), {
        tags: { integration: "turnstile", severity: "config" },
      });
    } catch {
      // Composition must never fail because the reporter is unavailable.
    }
  }

  // Timezone lookup (lat/lng → IANA zone; venue-hierarchy FR-004). A local
  // pure-JS library over packed boundary data — no env gate, no network, so
  // it is ALWAYS wired (unlike the provider-backed lookups below).
  const timezoneLookup: TimezoneLookupPort = createTzLookupAdapter();

  // Ziptax (US sales tax rate lookup)
  const taxRateLookup: TaxRateLookupPort | null = env.ZIPTAX_API_KEY
    ? (await import("@th/adapters/tax-rate-lookup")).createZiptaxAdapter(
        env.ZIPTAX_API_KEY,
      )
    : (() => {
        logMissingOptionalIntegration(logger, "ziptax_not_configured", {
          hint: "Set ZIPTAX_API_KEY to enable US sales tax rate lookups by postal code.",
        });
        return null;
      })();

  // Music-stats provider (public artist enrichment for musician EPKs). Spotify
  // is the one concrete adapter today; it fulfils the provider-agnostic
  // MusicStatsPort. Requires both the client id and secret; when either is
  // absent the port is null and the spotify.getArtist procedure returns
  // { configured: false, artist: null }.
  const musicStats: MusicStatsPort | null =
    env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET
      ? (await import("@th/adapters/spotify")).createSpotifyAdapter({
          clientId: env.SPOTIFY_CLIENT_ID,
          clientSecret: env.SPOTIFY_CLIENT_SECRET,
          clock,
        })
      : (() => {
          logMissingOptionalIntegration(logger, "spotify_not_configured", {
            hint: "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to enable Spotify artist enrichment on EPKs.",
          });
          return null;
        })();

  // Valhalla routing (A→B travel time)
  const routing: RoutingPort | null =
    env.ENABLE_TRAVEL_TIME && env.VALHALLA_URL
      ? (await import("@th/adapters/routing")).createRoutingAdapter({
          valhallaUrl: env.VALHALLA_URL,
          logger,
        })
      : (() => {
          if (!env.ENABLE_TRAVEL_TIME) {
            logger.info("routing_feature_disabled", {
              hint: "Set ENABLE_TRAVEL_TIME=true and VALHALLA_URL to enable A→B travel time.",
            });
          } else {
            logger.warn("routing_not_configured", {
              hint: "ENABLE_TRAVEL_TIME is on but VALHALLA_URL is not set. Travel time will be unavailable.",
            });
          }
          return null;
        })();

  // Wallet passes (Apple Wallet / Google Wallet)
  // Real adapters are created when credentials are present; falls back to stub.
  // The real adapters pull `passkit-generator` (heavy native deps) so we
  // dynamic-import them only when wallet config is actually present —
  // deployments without wallet creds skip that load entirely on boot.
  const walletPass: WalletPassPort = await (async () => {
    const appleConfigured =
      env.APPLE_PASS_CERTIFICATE_P12_BASE64 &&
      env.APPLE_PASS_CERTIFICATE_PASSWORD &&
      env.APPLE_TEAM_ID &&
      env.APPLE_PASS_TYPE_IDENTIFIER;

    // Google Wallet adapter signs JWTs via IAM Credentials using ADC — no
    // service-account JSON key needed. The runtime SA (Cloud Run-attached on
    // prod, gcloud user locally) signs as itself; that SA must have
    // `roles/iam.serviceAccountTokenCreator` on itself + Developer/Admin on
    // the Wallet issuer in the Pay & Wallet Console. Optional
    // `GOOGLE_WALLET_SIGNER_EMAIL` overrides the signer (e.g. when a
    // local-dev user wants to sign as the prod runtime SA).
    const googleConfigured = !!env.GOOGLE_WALLET_ISSUER_ID;

    if (!appleConfigured && !googleConfigured) {
      logger.info("wallet_pass_stub", {
        hint: "No wallet pass credentials configured — using stub adapter.",
      });
      return createStubWalletPassAdapter({ logger });
    }

    const [
      { AppleWalletAdapter },
      { GoogleWalletAdapter },
      { createWalletPassAdapter },
    ] = await Promise.all([
      import("@th/adapters/wallet-pass/apple-wallet-adapter"),
      import("@th/adapters/wallet-pass/google-wallet-adapter"),
      import("@th/adapters/wallet-pass/wallet-pass-adapter"),
    ]);

    const apple = appleConfigured
      ? new AppleWalletAdapter({
          certificateP12Base64: env.APPLE_PASS_CERTIFICATE_P12_BASE64!,
          certificatePassword: env.APPLE_PASS_CERTIFICATE_PASSWORD!,
          teamIdentifier: env.APPLE_TEAM_ID!,
          passTypeIdentifier: env.APPLE_PASS_TYPE_IDENTIFIER!,
          logger,
        })
      : undefined;

    const google = googleConfigured
      ? new GoogleWalletAdapter({
          issuerId: env.GOOGLE_WALLET_ISSUER_ID!,
          signerEmail: env.GOOGLE_WALLET_SIGNER_EMAIL ?? undefined,
          // Same-environment logo: Google fetches this URI at save time, so a
          // dev-minted pass must not point at prod's (possibly undeployed) asset.
          // Classes are insert-once under the SHARED issuer, and local API talks
          // to the shared dev-cloud DB — so a localhost (unfetchable) URI must
          // never be baked into a class other environments will reuse. Non-HTTPS
          // web URLs fall back to the adapter's prod default instead.
          logoUri: env.PUBLIC_WEB_URL.startsWith("https://")
            ? new URL(
                "/brand/ithasfire-wallet-logo-512.png",
                env.PUBLIC_WEB_URL,
              ).toString()
            : undefined,
          logger,
        })
      : undefined;

    logger.info("wallet_pass_configured", {
      apple: !!apple,
      google: !!google,
    });

    return createWalletPassAdapter({ apple, google, logger });
  })();

  // Volunteer scanner: signed QR tokens (FR-002 / FR-006). Optional secret;
  // when missing we leave the port `null` so the tRPC procedures fail fast
  // with a `not_configured` rather than silently signing with a placeholder.
  const volunteerScanToken: VolunteerScanTokenPort | null = (() => {
    const secret = env.VOLUNTEER_SCAN_TOKEN_SECRET;
    if (!secret) {
      logMissingOptionalIntegration(
        logger,
        "volunteer_scan_token_secret_missing",
        {
          hint: "Set VOLUNTEER_SCAN_TOKEN_SECRET to enable volunteer QR mint/resolve.",
        },
      );
      return null;
    }
    return createJoseVolunteerScanTokenAdapter({ secret });
  })();

  const trpc: TrpcDeps = {
    repos,
    fileStorage,
    payments,
    membershipBilling,
    authn,
    authz,
    logger,
    metrics: new LoggerMetricsAdapter(logger),
    // Best-effort error reporter for use cases that catch-and-swallow
    // operational failures (e.g. search backend errors that fall back to
    // empty/Postgres). Wired to Sentry so those stop being invisible.
    // `safeReporter` is what MAKES the "a throwing capture never changes
    // use-case behaviour" guarantee true — most call sites invoke this as a
    // bare `deps.reportError?.(err, …)` inside a catch, so an unwrapped
    // reporter that threw would escape the swallow branch and become the
    // caller's failure (observed on checkout as `dependency_failed`).
    reportError: safeReporter(Sentry.captureException),
    // Dev-only capability override for `Payee` syncs (always false in prod).
    forceConnectCapabilities,
    idempotency,
    rateLimit: rateLimitAdapter,
    contentFilter,
    clock,
    placeLayoutParser,
    placeLayoutStreaming,
    searchQuery,
    searchPrompts: new MissingSearchPromptPort(logger),
    multiSearch,
    geo,
    notify,
    notifyWithEmail,
    mailer,
    push,
    footerDefaultsCache,
    // Lets the platform router invalidate after `updatePlatformSetting`, which
    // writes through `repos.tx(...)` and so bypasses the cached instance.
    platformSettingsCache: cachedPlatformSettings,
    publicAppUrl: env.PUBLIC_WEB_URL,
    // Static venue-map images for comp-ticket (volunteer reward) emails —
    // mirrors the Stripe webhook's `env.TILESERVER_URL` for purchased tickets.
    tileServerUrl: env.TILESERVER_URL ?? null,
    unsubscribeSecret: env.UNSUBSCRIBE_SECRET ?? null,
    senderPhysicalAddress: env.SENDER_PHYSICAL_ADDRESS ?? null,
    // Fail-closed signal for CAN-SPAM opt-out enforcement in announcement
    // dispatch. Uses the same `NODE_ENV` distinction the rest of this file does.
    isProduction: process.env.NODE_ENV === "production",
    turnstile,
    taxRateLookup,
    timezoneLookup,
    musicStats,
    routing,
    walletPass,
    volunteerScanToken,
    volunteerScanTokenShortTtlHours: env.VOLUNTEER_QR_TTL_HOURS ?? null,
    scannerAppIosUrl: env.SCANNER_APP_IOS_URL ?? null,
    scannerAppAndroidUrl: env.SCANNER_APP_ANDROID_URL ?? null,
    jobsServiceUrl: env.JOBS_SERVICE_URL ?? "http://localhost:3002",
    enableCreateEvents: env.ENABLE_CREATE_EVENTS,
    enableBuyTickets: env.ENABLE_BUY_TICKETS,
    enableMaintenanceMode: env.ENABLE_MAINTENANCE_MODE,
    enableUnifiedScanResolver: env.ENABLE_UNIFIED_SCAN_RESOLVER,
    enableWaivers: env.ENABLE_WAIVERS,
    enableEntityPageEditor: env.ENABLE_ENTITY_PAGE_EDITOR,
    enableBroadcasts: env.ENABLE_BROADCASTS,
    enableResale: env.ENABLE_RESALE,
    enableHumanProfilesPublic: env.ENABLE_HUMAN_PROFILES_PUBLIC,
    enableWaitlists: env.ENABLE_WAITLISTS,
    discordAlert: fireDiscordAlert,
    notifySupport,
    supportRateLimits: {
      sendBurstMax: env.SUPPORT_SEND_BURST_MAX,
      sendBurstWindowS: env.SUPPORT_SEND_BURST_WINDOW_S,
      sendSustainedMax: env.SUPPORT_SEND_SUSTAINED_MAX,
      sendSustainedWindowS: env.SUPPORT_SEND_SUSTAINED_WINDOW_S,
      replyMax: env.SUPPORT_REPLY_MAX,
      replyWindowS: env.SUPPORT_REPLY_WINDOW_S,
    },
    webhookDlq: new WebhookDlq(redis),
    eventUnlockSecret: env.BETTER_AUTH_SECRET ?? null,
    // Fully credit-covered checkouts create settlements inline (no Stripe
    // webhook, hence no DLQ backstop). Reuse the same Discord + Sentry alerter
    // the webhook finalize path uses so a settlement-creation failure is loud
    // and operators can re-drive via settlements.createFromOrder.
    onSettlementFailure: buildSettlementFailureAlerter({
      logger,
      sendAlert: fireDiscordAlert,
      captureException: Sentry.captureException,
      message: "credit_checkout_settlement_creation_failed",
    }),
  };

  const otel = await initOpenTelemetry();

  const close = async () => {
    await prisma.$disconnect().catch((err) => {
      logger.error("prisma_disconnect_failed", { err });
    });

    await pool.end().catch((err) => {
      logger.error("pg_pool_end_failed", { err });
    });

    await redis.quit().catch((err) => {
      logger.error("redis_quit_failed", { err });
    });

    await otel.shutdown().catch((err) => {
      logger.error("otel_shutdown_failed", { err });
    });
  };

  return {
    prisma,
    redis,
    trpc,
    logger,
    mailer,
    emailDeliverability,
    telemetry: otel.telemetry,
    close,
  };
}
