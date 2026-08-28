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
  fileStorage: FileStoragePort;
  searchIndex: SearchIndexPort;
  /** Multi-entity search index (events, humans, places) - null if not configured */
  multiSearch: MultiSearchPort | null;
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
 * Check if a job definition is a scheduled task.
 */
export function isScheduledTask<T, O>(
  job: JobDefinition<T, O>,
): job is JobDefinition<T, O> & {
  schedule: ScheduledTaskDefinition<T, O>["schedule"];
} {
  return "schedule" in job;
}
