import { z, type ZodType } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ModerationPort } from "@th/ports/moderation";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { SearchIndexPort } from "@th/ports/search";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

/**
 * Define a job handler. This is the simplest building block.
 *
 * A job is just:
 * - A name (used for routing: POST /jobs/{name})
 * - An input schema (validated before handler runs)
 * - A handler function
 */
export interface JobDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  /** Human-readable description shown in the admin dashboard. */
  description?: string;
  /**
   * When true, fires Discord alerts on job start, success, and failure.
   * Only set on important/infrequent jobs — do not use for high-frequency crons.
   */
  notify?: boolean;
  input: ZodType<TInput>;
  handler: (args: { input: TInput; ctx: JobContext }) => Promise<TOutput>;
}

/**
 * Context available to all job handlers.
 * Mirrors what use-cases need from the hexagonal architecture.
 */
export interface JobContext {
  repos: Repos;
  logger: LoggerPort;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  payments: PaymentProcessorPort;
  /**
   * Whether `payments` is a REAL processor.
   *
   * With no `STRIPE_SECRET_KEY` the container still hands out a
   * `PaymentProcessorPort` — a stub whose every method throws. That is fine
   * for a job that should blow up, and wrong for one whose contract is "no
   * processor means refuse safely" (`releaseExpiredCarts`), which would
   * otherwise read a thrown stub as a Stripe outage and retry forever. Check
   * this flag and pass `undefined` instead of the stub.
   */
  paymentsConfigured: boolean;
  fileStorage: FileStoragePort;
  searchIndex: SearchIndexPort;
  /** Multi-entity search index (events, humans, places) - null if not configured */
  multiSearch: MultiSearchPort | null;
  /**
   * Delayed search-reindex drain scheduling (`search.drain-reindex-pending`
   * reschedules itself while rows remain). Absent/null = no scheduler wired:
   * leftover marks wait for the next edit's drain or the nightly full reindex.
   */
  searchReindexDrain?:
    | import("@th/core/use-cases/search/search-reindex-marks").SearchReindexDrainTrigger
    | null;
  /**
   * Delayed scheduling for the NEXT hop of a lineup-notice sweep chain, on the
   * dedicated lineup-sweep Cloud Tasks queue (never the search drain's — see
   * infra/terraform/lineup-notice-sweep.tf). The composition root already
   * resolves the pre-queue fallback, so a job reads this and nothing else.
   * Absent/null = no scheduler wired: an unfinished sweep is reported and its
   * leftover rows wait for a future publish of the event.
   */
  lineupSweepContinuation?:
    | import("@th/core/use-cases/event-humans/_shared/lineup-sweep-continuation").LineupSweepContinuation
    | null;
  /**
   * The API's idempotency store (same backend, namespace "api"), where the
   * lineup notices keep their 10-year OWED/SENT ledger. `idempotency` above
   * is namespaced "jobs" and cannot see it. Read by
   * `lineup-notices.continue-sweep`, and by `events.sweep-open-calls` for
   * the open-call notice ledger the API's notifier writes in the same store.
   * Absent = both jobs refuse.
   */
  lineupNoticeLedger?: IdempotencyPort;
  /**
   * Fixed-window limiter on the shared Redis (same keys as the API's), for
   * the lineup notices' per-recipient daily caps. Absent = no caps.
   */
  rateLimit?: import("@th/ports/rate-limit").RateLimitPort | null;
  /** Mailer for sending transactional emails - null if SMTP not configured */
  mailer: MailerPort | null;
  /** SMS sender - null if AWS SNS isn't configured. */
  sms: import("@th/ports/comms/sms").SMSPort | null;
  /**
   * Push sender (Expo). Always constructed — Expo's push API needs no
   * credentials — but typed nullable to mirror mailer/sms so notify() deps
   * assembly stays uniform (`push: ctx.push ?? undefined`).
   */
  push: import("@th/ports/comms/push").PushPort | null;
  /**
   * Image moderation provider (Azure AI Content Safety when configured, else a
   * stub that auto-approves). Consumed by the moderation.drain-image-moderations
   * job via the moderate-image use case.
   */
  moderation: ModerationPort;
  /**
   * US sales-tax rate lookup (ZipTax). Null when unconfigured — the tax
   * refresh job SKIPS in that case rather than treating an absent provider as
   * evidence that every jurisdiction stopped taxing.
   */
  taxRateLookup: import("@th/ports/tax-rate-lookup").TaxRateLookupPort | null;
  /**
   * lat/lng → IANA timezone resolver (venue-hierarchy FR-004). Local pure-JS
   * adapter — always constructed (no credentials, no network), typed
   * non-null. Any job that upserts places threads it into `upsertPlace` so
   * `Place.timezone` derives on the same lifecycle as the API path.
   */
  timezoneLookup: import("@th/ports/timezone-lookup").TimezoneLookupPort;
  /**
   * Stripe Billing. Null when Stripe is unconfigured — the tax-refresh job
   * refuses to run rather than skipping the subscription migration silently.
   */
  membershipBilling:
    | import("@th/ports/membership-billing-port").MembershipBillingPort
    | null;
  /**
   * FALLBACK severity 0/2/4/6 (Azure four-severity scale) at/above which a
   * moderated image is FLAGGED rather than auto-APPROVED
   * (IMAGE_MODERATION_REVIEW_THRESHOLD, default 4 = flag "high"+). Used for any
   * category without an entry in `imageModerationCategoryThresholds`.
   */
  imageModerationReviewThreshold: number;
  /**
   * Per-category overrides (IMAGE_MODERATION_THRESHOLD_*). SEXUAL and VIOLENCE
   * sit high because this catalogue generates them honestly — metal, burlesque,
   * drag and horror-themed gig posters — while HATE and SELF_HARM sit low
   * because nothing legitimate scores there. Empty object = uniform behaviour.
   */
  imageModerationCategoryThresholds: Partial<
    Record<
      import("@th/types/repos/image-moderation-records").ImageModerationCategory,
      number
    >
  >;
  /**
   * Best-effort error reporter for use cases that catch-and-swallow operational
   * failures (fail-closed moderation degrades, drain exhaustion, hold-notify
   * failures). Wired to `Sentry.captureException`; a throwing/no-op capture
   * never changes use-case behaviour. Mirrors the API's `TrpcDeps.reportError`.
   */
  reportError: ReporterPort;
  /**
   * Dev-only capability override for `Payee` syncs (always false in prod).
   * See `forceConnectCapabilities` in `apps/jobs/src/lib/env.ts`.
   */
  forceConnectCapabilities: boolean;
  /** Public web origin (PUBLIC_WEB_URL). Used to compose user-facing URLs in transactional emails. */
  appBaseUrl: string;
  /**
   * HMAC secret (UNSUBSCRIBE_SECRET) for signing/verifying one-click
   * unsubscribe tokens in transactional/marketing emails (e.g. the weekly
   * attendee review digest). Null when unconfigured — a sender that needs it
   * skips its send rather than shipping an unsubscribe-less email.
   */
  unsubscribeSecret: string | null;
  /**
   * Open-call status-link token key, HKDF-derived from UNSUBSCRIBE_SECRET
   * exactly as the API derives it (core lib/security/open-call-status-token-key),
   * so a guest's status link built here matches the one the API resolves.
   * Step 8 passes it as `statusTokenSecret` to `makeOpenCallNotices` when it
   * builds the jobs notifier (guest backstop / pulled notices). Null when the
   * root is missing or short: guest emails then fail and are reported.
   */
  openCallStatusTokenSecret: string | null;
  /**
   * Renders a registered email template to subject / html / text.
   * Injected so handlers don't have to import `@th/ui-email` directly.
   */
  renderEmailTemplate: <K extends import("@th/ui-email").TemplateId>(input: {
    templateId: K;
    props: import("@th/ui-email").TemplateProps<K>;
  }) => Promise<{ subject: string; html: string; text: string }>;
  /**
   * Enqueue another job. Used when one job needs to fan out to others.
   * In Cloud Run, this POSTs to the jobs service itself.
   */
  enqueue: <T>(jobName: string, payload: T) => Promise<void>;
  /**
   * Wakes a write-triggered outbox drain (Pub/Sub when deployed). Null when
   * unconfigured. app.ts uses it to hand a drain that stopped on its time
   * budget (`hasMore`) to a fresh request.
   */
  jobTrigger: import("@th/ports/job-trigger").JobTriggerPort | null;
  /**
   * UUID generated by the dispatcher (`app.ts`) when this handler was
   * invoked. Same value is bound to `logger` as a `runId` field and is
   * what operators use to grep Cloud Logging when an alert fires.
   */
  runId: string;
  /**
   * Run-history store. Already present at runtime — `app.ts` spreads the whole
   * container into ctx — but previously undeclared, so handlers could not
   * reach it.
   *
   * Needed by `jobs.prune-run-history`, which trims `JobRun` on a schedule so
   * `record()` no longer prunes on every write.
   */
  runTracker: import("./job-run-tracker").JobRunTracker;
}

/**
 * Helper to define a job with full type inference.
 */
export function defineJob<TInput, TOutput>(
  def: JobDefinition<TInput, TOutput>,
): JobDefinition<TInput, TOutput> {
  return def;
}

/**
 * A scheduled task is just a job with additional scheduler metadata.
 */
export interface ScheduledTaskDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends JobDefinition<TInput, TOutput> {
  schedule: {
    /**
     * Cron expression (Cloud Scheduler format).
     * @example "0 * * * *" (every hour)
     */
    cron: string;
    /**
     * IANA timezone.
     * @default "Etc/UTC"
     */
    timezone?: string;
    /**
     * Whether enabled by default (can be overridden per-env in Terraform).
     * @default true
     */
    enabled?: boolean;
  };
}

export function defineScheduledTask<TInput, TOutput>(
  def: ScheduledTaskDefinition<TInput, TOutput>,
): ScheduledTaskDefinition<TInput, TOutput> {
  return def;
}

/**
 * A job definition whose input/output shapes are not known to the caller.
 *
 * The registry deals in jobs generically — it stores, looks up and dispatches
 * them without knowing any one job's payload type — and `JobDefinition`'s
 * `handler` is a function-typed PROPERTY, so under `strictFunctionTypes` a
 * concrete `JobDefinition<{ limit: number }>` is not assignable to
 * `JobDefinition<unknown>`. `any` here is the erasure that lets one array hold
 * all of them; `app.ts` re-narrows at the single dispatch call site, which is
 * the only place a handler is ever invoked.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDefinition = JobDefinition<any, any>;

/** The Cloud Scheduler metadata block a scheduled task carries. */
export type JobSchedule = ScheduledTaskDefinition["schedule"];

/**
 * Everything `GET /jobs` and `GET /jobs/status` serve, and everything the
 * Cloud Scheduler wiring needs — with no handler and no input schema.
 *
 * This is the half of a job definition the registry keeps EAGERLY. Handlers
 * drag their whole transitive graph (use cases, adapters, Prisma, the Stripe
 * SDK); metadata is a string and a cron expression. Splitting them is what
 * stops booting the dispatcher from loading the entire application — see
 * `src/jobs/registry.ts`.
 */
export interface JobMetadata {
  name: string;
  description?: string;
  notify?: boolean;
  /** Present only on scheduled tasks; absent on queue-triggered jobs. */
  schedule?: JobSchedule;
}

/**
 * Check whether a job (definition OR registry metadata) is a scheduled task.
 *
 * Accepts anything carrying an optional `schedule`, so the `/jobs` endpoints
 * can ask it about a metadata-only registry entry without loading a handler.
 */
export function isScheduledTask<T extends { schedule?: JobSchedule }>(
  job: T,
): job is T & { schedule: JobSchedule } {
  return job.schedule != null;
}
