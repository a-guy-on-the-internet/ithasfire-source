import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { timingSafeEqual } from "node:crypto";
import { logAndAlert, logAndReport } from "@th/adapters/infra/discord-alerts";
import {
  APPLY_MIGRATIONS_HINT,
  buildMigrationDriftError,
  createMigrationDriftMonitor,
  listPendingMigrations,
  readAppliedMigrations,
  readExpectedMigrations,
  resolveMigrationsDir,
} from "@th/adapters/infra/migration-drift";
import { type AppErrorCode, fromLegacyCode, isAppError } from "@th/errors";
import type { RerunJobFromDlqResult } from "@th/ports/job-diagnostics";
import { isTriggeredJobName } from "@th/ports/job-trigger";

import { Sentry } from "./instrument";
import { buildContainer } from "./lib/container";
import {
  DEFAULT_CRON_TZ,
  describeCron,
  nextCronRun,
} from "./lib/cron-schedule";
import { resolveModerationCategoryThresholds } from "./lib/moderation-config";
import { allJobs, getJob } from "./jobs";
import {
  isScheduledTask,
  type JobContext,
  type JobMetadata,
} from "./lib/define-job";
import type { RunEntry } from "./lib/job-run-tracker";
import type { RedisJobDiagnosticsAdapter } from "@th/adapters/job-diagnostics/redis-dlq-adapter";
import { buildCloudLoggingUrl, fireDiscordAlert } from "./lib/discord-alerts";
import {
  DLQ_RERUN_CLAIM_HEADER,
  DLQ_RERUN_OF_HEADER,
  isDlqRerunNoAnswer,
} from "./lib/dlq-rerun";
import {
  DrainFlights,
  isDrainWakeUp,
  resultHasMore,
} from "./lib/drain-flights";

/**
 * Resolve the stable, machine-readable {@link AppErrorCode} for a failed job,
 * mirroring the request path's `resolveAppCode` (apps/api/src/plugins/trpc.ts)
 * so a job-failure log line and a tRPC error log line carry the SAME identifier
 * for the same underlying domain error (FR-010).
 *
 * Resolution order:
 *   1. Zod validation failures → `INVALID_INPUT` (the canonical category).
 *   2. `AppError` instances → their structured `.code`.
 *   3. Legacy `{ code, message }` use-case errors → `fromLegacyCode`,
 *      message-first (the request path resolves `data.appCode` from the
 *      snake_case message), then the `code` field as a fallback because the
 *      convention audit found domain codes sometimes sit in `code`.
 *
 * Returns `null` for unmapped / internal errors — the caller still logs the
 * raw `errorCode`/`errorMessage`, so nothing is lost.
 */
function resolveJobErrorCode(err: unknown): AppErrorCode | null {
  if (err instanceof ZodError) return "INVALID_INPUT";
  if (isAppError(err)) return err.code;
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.message === "string") {
      const fromMessage = fromLegacyCode(e.message);
      if (fromMessage) return fromMessage;
    }
    if (typeof e.code === "string") {
      const fromCode = fromLegacyCode(e.code);
      if (fromCode) return fromCode;
    }
  }
  return null;
}

/**
 * Log-safe view of a bookkeeping error (run tracker, DLQ). Never pass the raw
 * error to the logger: ioredis attaches `command.args` and `previousErrors`
 * (the zadd member, i.e. the run entry or the full request body) and pino's
 * default `err` serializer writes every enumerable property out.
 */
function logSafeError(err: unknown): { name: string; message: string } {
  return err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: "NonError", message: String(err) };
}

/**
 * `POST /dlq/:queue/:jobId/rerun` answers for a rerun that did not run. The
 * entry is kept in every case; `error` is the machine-readable code.
 */
const DLQ_RERUN_NOT_RUN: Record<
  Extract<RerunJobFromDlqResult, { outcome: "not_run" }>["reason"],
  { error: string; message: string }
> = {
  disabled: {
    error: "job_paused",
    message:
      "This job is disabled, so nothing ran and the entry was kept. Enable the job, then rerun the entry.",
  },
  coalesced: {
    error: "run_in_flight",
    message:
      "A run of this job was already in flight and took this request into its next pass, so the entry was kept. Rerun or delete it once that run has finished.",
  },
  unconfirmed: {
    error: "run_unconfirmed",
    message:
      "The jobs service did not confirm that the job ran, so the entry was kept.",
  },
  claimed: {
    error: "rerun_in_progress",
    message:
      "Someone else is rerunning this entry right now, so nothing ran and the entry was kept. Wait for that run to finish, then check the entry.",
  },
};

/** The adapter's `not_found`: the DLQ entry named in the URL does not exist. */
function isDlqEntryNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "JobDiagnosticsError" &&
    (err as { code?: unknown }).code === "not_found"
  );
}

function jobScheduleInfo(job: JobMetadata) {
  if (!isScheduledTask(job)) return null;
  const { schedule } = job;
  // Resolve the zone ONCE and feed it to all three fields, so the reported
  // `timezone`, the human description and the computed `nextRun` can never
  // disagree about which midnight is meant.
  const timezone = schedule.timezone ?? DEFAULT_CRON_TZ;
  return {
    cron: schedule.cron,
    timezone,
    enabled: schedule.enabled ?? true,
    cronDescription: describeCron(schedule.cron, timezone),
    nextRun: nextCronRun(schedule.cron, timezone),
  };
}

/**
 * Tag derived from Cloud Run's auto-injected K_SERVICE (e.g. `hf-dev-jobs` →
 * `[dev]`). Falls back to `[local]` when running outside Cloud Run.
 */
function envTag(): string {
  const k = process.env.K_SERVICE ?? "";
  const m = k.match(/^hf-([^-]+)-/);
  if (m && m[1]) return `[${m[1]}]`;
  return "[local]";
}

// Sentry org slug used to build issue deep-links in job-failure alerts.
// Mirrors apps/api/src/plugins/trpc.ts. `SENTRY_ORG` can override via env.
// Read straight off process.env (rather than the strict env module) so this
// module has no eager env-parse side effect at import time — app.ts is loaded
// in unit tests where DATABASE_URL et al. are intentionally absent.
const SENTRY_ORG = process.env.SENTRY_ORG ?? "hearth-fire";

/**
 * Build a Sentry issue-search URL for a captured event id. Returns `undefined`
 * when no org is configured so the alert simply omits the link. Best-effort:
 * never throws into the error-handling path.
 */
function sentryIssueUrl(eventId: string): string | undefined {
  if (!SENTRY_ORG) return undefined;
  return `https://${SENTRY_ORG}.sentry.io/organizations/${SENTRY_ORG}/issues/?query=${encodeURIComponent(
    eventId,
  )}`;
}

function createJobLifecycleAlert(
  jobName: string,
  phase: "started" | "completed" | "failed",
  runId: string,
  durationMs?: number,
) {
  const fields = [{ name: "Run ID", value: runId, inline: true }];

  if (durationMs !== undefined) {
    fields.unshift({
      name: "Duration",
      value: `${durationMs}ms`,
      inline: true,
    });
  }

  // Append a clickable Cloud Logging deep-link scoped to this exact run so an
  // operator jumps straight to the failing run's logs. Best-effort: the helper
  // returns null in local/unit-test (no GCP_PROJECT_ID), in which case we omit
  // the field entirely rather than render a broken/"null" link.
  if (phase === "failed" || phase === "completed") {
    const logsUrl = buildCloudLoggingUrl(runId);
    if (logsUrl) {
      fields.push({
        name: "Logs",
        value: `[View logs](${logsUrl})`,
        inline: false,
      });
    }
  }

  const tag = envTag();

  if (phase === "started") {
    return {
      send: fireDiscordAlert,
      payload: {
        title: `${tag} Job started: ${jobName}`,
        colour: "info" as const,
        fields,
      },
    };
  }

  return {
    send: fireDiscordAlert,
    payload: {
      title:
        phase === "completed"
          ? `${tag} Job completed: ${jobName}`
          : `${tag} Job failed: ${jobName}`,
      colour: phase === "completed" ? ("info" as const) : ("error" as const),
      description:
        phase === "completed"
          ? "A background job completed. Check structured logs for run details."
          : "A background job failed. Check structured logs for run details.",
      fields,
    },
  };
}

export async function createApp() {
  const container = await buildContainer();
  const logger = container.logger;
  const tracker = container.runTracker;
  const dlq: RedisJobDiagnosticsAdapter | null = container.diagnostics;

  // ─────────────────────────────────────────────────────────────────────────
  // Migration-drift guard
  //
  // Checked at boot; `/health` and `POST /jobs/:name` both serve the monitor's
  // verdict. Caching is ASYMMETRIC (see createMigrationDriftMonitor): `ok` is
  // permanent so neither path pays for a query, while `drift`/`unknown` are
  // re-queried on a short, single-flighted interval. Prod deploy #583 is why:
  // terraform runs concurrently with migrate_db (it provisions the secret
  // migrate_db reads, so the dependency would be circular), so this container
  // can legitimately boot mid-migration. Caching that `drift` verdict made all
  // 48 startup probes replay a 503 that had stopped being true after 2m16s.
  //
  // Jobs were the worst-hit victim of the stale-schema outages (Sentry
  // HEARTH-FIRE-WEB-17: ~208 of ~220 events, all `POST /jobs/:name`), and a
  // /health 503 alone does NOT fix that — Cloud Scheduler POSTs straight at
  // the run route, so cron traffic keeps hitting a stale schema and dying with
  // an opaque P2022. Hence the run-route short-circuit further down.
  //
  // Fail-safe rules are identical to the API's: only a CONFIRMED drift blocks,
  // and only when `shouldBlockOnDrift()` (Cloud Run / production). Every
  // indeterminate outcome — migrations dir absent, `_prisma_migrations`
  // missing, DB unreachable, query timeout — logs, reports to Sentry, and
  // resolves to HEALTHY. Detection and logging happen in every environment;
  // only enforcement is gated, because `scripts/human-dev.cjs:170` gates the
  // local stack on this service's /health returning 2xx-3xx too.
  const migrationDrift = await createMigrationDriftMonitor({
    listExpectedMigrations: () =>
      readExpectedMigrations(resolveMigrationsDir()),
    listAppliedMigrations: () => readAppliedMigrations(container.prisma),
    logger,
    reportError: container.reportError,
  });

  /**
   * One-shot latch so the run-route short-circuit reports to Sentry once per
   * process instead of once per cron tick. See the short-circuit for why.
   */
  let driftReported = false;

  /**
   * Job modules whose import failure has already been reported to Sentry, by
   * module id. Same one-shot discipline as `driftReported`, and for the same
   * reason.
   *
   * A handler module that will not import is almost always PERMANENT — a bad
   * barrel export, or a dependency lost to `pnpm deploy --legacy`'s re-resolve
   * (see apps/jobs/Dockerfile; that has bitten this image before). Since the
   * registry never imports a handler, such a build BOOTS: /health is 200, the
   * revision promotes, and only the owning job fails. A job on an
   * every-two-minute cron would then capture ~720 Sentry events a day for one
   * unchanging fault.
   *
   * Keyed by MODULE, not by job: two jobs in one file share one import, so one
   * broken file is one issue, not N. The un-cached retry in
   * `jobs/registry.ts` is deliberately left alone — a transient failure must
   * still get a fresh attempt; this only bounds the REPORTING.
   */
  const reportedModuleLoadFailures = new Set<string>();

  /**
   * One in-flight run per write-triggered drain per instance. A wake-up
   * (Pub/Sub push) that arrives while its drain is already running is acked
   * at once and folded into ONE follow-up pass of the running request, so a
   * burst of RSVPs is a handful of drain runs, not one per RSVP. See
   * lib/drain-flights.ts.
   */
  const drainFlights = new DrainFlights();

  /**
   * Why the blocked run route answers 503 (not 4xx, not 200):
   *
   *  - 5xx is the truthful class. The request is well-formed and the caller is
   *    blameless; the SERVER cannot service it. A 4xx would blame the caller,
   *    which is wrong. (Not a retry lever: Cloud Scheduler and Pub/Sub retry
   *    any non-2xx, 4xx included.)
   *  - No retry storm. The schedulers in `infra/terraform/generated-jobs.tf`
   *    retry twice (30s, then 60s; none for a manifest entry with
   *    `"retry": false`), so a blocked revision takes at most 3 attempts per
   *    tick, then the job waits for its next cron tick. That is the cadence
   *    we want: visible, bounded, self-resuming once the schema is fixed.
   *  - It stays visible. A failed attempt shows up in Cloud Scheduler's job
   *    status and Cloud Monitoring; answering 200 with `{skipped:true}` (the
   *    shape used for a DISABLED job) would hide a schema mismatch behind a
   *    success, which is how this class of bug stayed alive for 90 days.
   *  - It agrees with `/health`. Same condition, same code, so probe and
   *    traffic tell operators the same story.
   *  - `Retry-After: 300` is defence in depth. Cloud Scheduler follows its own
   *    `retry_config` backoff, not this header; it is here so that a manual or
   *    Pub/Sub caller that honours it cannot hot-loop a stuck revision.
   */

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  // Unwrapped Pub/Sub pushes (`no_wrapper` subscriptions in generated-jobs.tf,
  // the write-triggered drain wake-ups) deliver the message data as the raw
  // body, and Google does not promise `Content-Type: application/json` on
  // them. Fastify only parses application/json and text/plain out of the box
  // and answers anything else 415 BEFORE the route runs — Pub/Sub would retry
  // and drop it, and the drain would silently fall back to its safety-net
  // cron. This catch-all reads any other (or missing) content type as JSON;
  // an empty body is `{}`. application/json keeps Fastify's own parser, and
  // the catch-all delegates to that same parser (not a bare JSON.parse), so
  // it keeps Fastify's __proto__ / constructor-poisoning rejection and its
  // 400 on malformed JSON.
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser(
    "*",
    { parseAs: "string" },
    (request, body, done) => {
      const text = String(body ?? "");
      if (text.trim() === "") {
        done(null, {});
        return;
      }
      defaultJsonParser(request, text, done);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Auth — every route except /health requires one of:
  //
  //   1. X-Jobs-API-Key header matching JOBS_API_KEY (used by the API proxy)
  //   2. Authorization: Bearer <OIDC-JWT> (used by Cloud Scheduler + Pub/Sub
  //      push). Cloud Run IAM already verifies the OIDC token at the network
  //      layer; if the request reaches Fastify it is already authenticated.
  //      We detect this by checking for a 3-part JWT (xxxxx.xxxxx.xxxxx).
  //
  // In dev, when JOBS_API_KEY is unset, all requests are allowed so
  // `pnpm human:dev` keeps working without extra config.
  //
  // In production the two gates are:
  // - Cloud Run IAM (OIDC) — only allowed service accounts can reach this
  //   service at all.
  // - JOBS_API_KEY — defense-in-depth so a compromised SA alone isn't enough
  //   (for API proxy calls).
  // ─────────────────────────────────────────────────────────────────────────
  const apiKey = container.env.JOBS_API_KEY ?? null;

  /** Quick check: does the string look like a 3-segment JWT (Google OIDC)? */
  function looksLikeJwt(token: string): boolean {
    const parts = token.split(".");
    return parts.length === 3 && parts.every((p) => p.length > 0);
  }

  if (apiKey) {
    const expectedBuf = Buffer.from(apiKey);
    app.addHook("onRequest", async (request, reply) => {
      // /health is unauthenticated — load balancers and health checks need it.
      if (request.url === "/health") return;

      // Path 1: explicit API key header (used by API proxy / manual calls)
      const apiKeyHeader = request.headers["x-jobs-api-key"];
      if (
        typeof apiKeyHeader === "string" &&
        apiKeyHeader.length === apiKey.length
      ) {
        if (timingSafeEqual(Buffer.from(apiKeyHeader), expectedBuf)) return;
      }

      // Path 2: Google OIDC token in Authorization header (Cloud Scheduler,
      // Pub/Sub push). Cloud Run IAM already validated this at the network
      // layer, so if the request made it here the token is authentic.
      const authHeader = request.headers.authorization ?? "";
      const [scheme, token] = authHeader.split(" ");
      if (scheme?.toLowerCase() === "bearer" && token && looksLikeJwt(token)) {
        return; // Cloud Run IAM already verified — allow through
      }

      // Path 3: Bearer API key in Authorization header.
      if (
        scheme?.toLowerCase() === "bearer" &&
        token &&
        token.length === apiKey.length &&
        timingSafeEqual(Buffer.from(token), expectedBuf)
      ) {
        return;
      }

      logger.warn("auth_rejected", {
        url: request.url,
        method: request.method,
        hasApiKeyHeader: Boolean(apiKeyHeader),
        hasAuthHeader: Boolean(request.headers.authorization),
      });
      return reply.status(401).send({ error: "unauthorized" });
    });
    logger.info("auth_enabled", { mode: "api_key_or_oidc" });
  } else {
    logger.warn("auth_disabled", {
      hint: "Set JOBS_API_KEY to secure the jobs service. Required in production.",
    });
  }

  // Backstop for the drain single-flight: whatever path a request that opened
  // a flight takes out of the run route (including a throw from the enabled
  // read, which the route's own try does not cover), its flight closes once the
  // response is sent. Identity-checked, so it never closes a newer flight.
  const openedFlights = new WeakMap<
    object,
    { name: string; flight: import("./lib/drain-flights").DrainFlight }
  >();
  app.addHook("onResponse", async (request) => {
    const opened = openedFlights.get(request);
    if (opened) drainFlights.end(opened.name, opened.flight);
  });

  // Graceful shutdown
  app.addHook("onClose", async () => {
    await container.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Health check
  //
  // 503 ONLY on confirmed + enforced drift, so a Cloud Run revision deployed
  // onto a stale schema fails its startup probe and is never promoted. The
  // healthy shape stays `{ status: "ok" }` (NOT the API's `{ ok: true }`) —
  // scripts/human-dev.cjs:170 is the only consumer and reads the status code,
  // not the body, so there is no reason to churn the contract.
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/health", async (_request, reply) => {
    const drift = await migrationDrift.get();
    if (drift.status === "drift" && drift.enforced) {
      return reply.status(503).send({
        status: "migration_drift",
        error: "migration_drift",
        message:
          "Database is missing migrations this build requires. Apply them " +
          `(\`${APPLY_MIGRATIONS_HINT}\`), then redeploy.`,
        pendingCount: drift.pending.length,
        pendingMigrations: listPendingMigrations(drift.pending),
      });
    }
    return { status: "ok" };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // List all jobs (enriched with schedule, description, enabled status)
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/jobs", async () => {
    const jobs = await Promise.all(
      allJobs.map(async (job) => ({
        name: job.name,
        description: job.description ?? null,
        scheduled: isScheduledTask(job),
        schedule: jobScheduleInfo(job),
        enabled: await tracker.isEnabled(job.name),
      })),
    );
    return { jobs };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Aggregate status: every job + its latest run
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/jobs/status", async () => {
    const latestRuns = await tracker.latestAll();

    const jobs = await Promise.all(
      allJobs.map(async (job) => {
        const lastRun = latestRuns.get(job.name) ?? null;
        const enabled = await tracker.isEnabled(job.name);
        return {
          name: job.name,
          description: job.description ?? null,
          scheduled: isScheduledTask(job),
          schedule: jobScheduleInfo(job),
          enabled,
          lastRun,
        };
      }),
    );

    return { jobs };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Image-moderation configuration: which provider is LIVE, and the thresholds
  // it decides with.
  //
  // This lives here and NOT in apps/api because apps/api has no Azure adapter
  // and no AZURE_CONTENT_SAFETY_* / IMAGE_MODERATION_* env at all — answering
  // from there would render a confident lie. The jobs container is the process
  // that actually picked an adapter, so it is the only honest source.
  //
  // AUTH: no route-level guard, because there is nothing extra to add — this
  // route inherits EXACTLY what `/jobs/status` gets, and nothing more.
  //
  // Precisely: the `onRequest` hook above is installed only inside
  // `if (apiKey)`. When `JOBS_API_KEY` IS set (every deployed environment, and
  // the reason that branch also logs `auth_enabled`) the hook rejects
  // everything except `/health`, so this sits behind the same API-key /
  // Cloud Run OIDC gate as every other route here. When it is UNSET — the
  // documented local-dev default, which logs `auth_disabled` — no hook is
  // installed at all and the whole service is open, this route included. That
  // is the service's existing posture, not something this endpoint introduces,
  // and it is why `JOBS_API_KEY` is required in production.
  //
  // If that hook ever grows a second `/health`-style exemption, this route must
  // not be on it.
  //
  // The response carries the endpoint's THREE fields and nothing else. Never
  // add the Azure endpoint URL or the API key: "which provider" is an
  // operational fact, "where and with what credential" is a secret.
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/moderation/config", async () => {
    return {
      provider: container.moderationProvider,
      reviewThreshold: container.imageModerationReviewThreshold,
      // FULLY resolved: the container deliberately passes a partial override
      // map (an absent key must fall back to reviewThreshold, never to 0), so
      // reporting it raw would show blanks where an enforced number exists.
      // This mirrors `exceedsCategoryThreshold`'s per-category fallback.
      categoryThresholds: resolveModerationCategoryThresholds(
        container.imageModerationReviewThreshold,
        container.imageModerationCategoryThresholds,
      ),
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Run history for a specific job
  // ─────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
    "/jobs/:name/runs",
    async (request, reply) => {
      const { name } = request.params;
      const job = getJob(name);
      if (!job) return reply.status(404).send({ error: "job_not_found", name });

      const limit = Math.min(
        parseInt(request.query.limit ?? "25", 10) || 25,
        100,
      );
      const runs = await tracker.runs(name, limit);
      return { jobName: name, runs };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Toggle a job enabled/disabled
  // ─────────────────────────────────────────────────────────────────────────
  app.put<{ Params: { name: string }; Body: { enabled: boolean } }>(
    "/jobs/:name/enabled",
    async (request, reply) => {
      const { name } = request.params;
      const job = getJob(name);
      if (!job) return reply.status(404).send({ error: "job_not_found", name });

      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply
          .status(400)
          .send({
            error: "invalid_input",
            message: "enabled must be a boolean",
          });
      }

      await tracker.setEnabled(name, enabled);
      logger.info("job_toggle", { job: name, enabled });
      return { name, enabled };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Run a job: POST /jobs/:name
  // ─────────────────────────────────────────────────────────────────────────
  app.post<{
    Params: { name: string };
    Body: unknown;
    Querystring: { force?: string };
  }>("/jobs/:name", async (request, reply) => {
    const { name } = request.params;
    const job = getJob(name);

    if (!job) {
      logger.warn("job_not_found", { name });
      return reply.status(404).send({ error: "job_not_found", name });
    }

    // ───────────────────────────────────────────────────────────────────────
    // Migration-drift short-circuit.
    //
    // THIS is the part that stops the HEARTH-FIRE-WEB-17 pattern. Cloud
    // Scheduler POSTs here directly, so a /health 503 does not keep cron
    // traffic off a stale schema; without this, every tick runs the handler
    // and dies with an opaque Prisma P2022 deep inside a repo call.
    //
    // Placed AFTER the 404 (an unknown job name is answerable from the
    // in-memory registry and needs no database) and BEFORE the enabled check,
    // the run tracker, the DLQ and the lifecycle alerts — a blocked run is not
    // a run: it must not record a RunEntry, must not push to the DLQ, and must
    // not fire "job started"/"job failed" Discord alerts.
    //
    // Deliberately NOT gated on `?force=true`: forcing is for re-running a
    // disabled job, not for overriding a schema mismatch.
    //
    // Only fires on CONFIRMED + ENFORCED drift. Indeterminate verdicts
    // (`status: "unknown"`) never block — jobs keep running exactly as before.
    const drift = await migrationDrift.get();
    if (drift.status === "drift" && drift.enforced) {
      const driftError = buildMigrationDriftError(drift.pending);

      // Report to Sentry ONCE per process, then log every occurrence.
      // Reporting on every request would recreate the exact 208-events-in-one
      // -issue flood this guard exists to end, just with a nicer message; one
      // attributable issue plus per-tick Cloud Logging lines is the right
      // signal split. (Unlike the API, apps/jobs has no Sentry pino
      // integration, so `logger.error` here does NOT reach Sentry — the
      // explicit report is the only path, per CLAUDE.md.)
      if (!driftReported) {
        driftReported = true;
        try {
          container.reportError?.(driftError, {
            // `job` is deliberately NOT a tag: the latch fires once, so it
            // would record only whichever cron tick happened to arrive first
            // and read as "this job is affected" when in fact ALL of them are.
            // It lives in `extra` as the first-blocked sample instead.
            tags: { check: "migration_drift", phase: "job_blocked" },
            extra: {
              firstBlockedJob: name,
              pending: drift.pending,
              pendingCount: drift.pending.length,
            },
          });
        } catch {
          // Best-effort: a throwing reporter must never change the response.
        }
      }

      // Bounded name list: this fires on EVERY cron tick, and an empty
      // database would otherwise put ~100 names in every log line. The full
      // list is in the one-time `migration_drift_detected` boot log.
      logger.error("job_blocked_migration_drift", {
        job: name,
        pending: listPendingMigrations(drift.pending),
        pendingCount: drift.pending.length,
        hint: `Database is behind this build. Run \`${APPLY_MIGRATIONS_HINT}\`.`,
      });

      // 503 + Retry-After — rationale documented at `driftReported` in
      // createApp().
      return reply
        .status(503)
        .header("Retry-After", "300")
        .send({
          success: false,
          error: "migration_drift",
          job: name,
          message: driftError.message,
          pendingCount: drift.pending.length,
          pendingMigrations: listPendingMigrations(drift.pending),
        });
    }

    // A wake-up for a drain that is already running here: fold it into the
    // running request's follow-up pass and ack. Before the enabled check on
    // purpose — the running request already passed it, and a coalesced
    // wake-up should cost nothing, the database included.
    const wakeUp = isDrainWakeUp(name, request.body);
    if (wakeUp && drainFlights.coalesce(name)) {
      logger.info("job_coalesced", { job: name });
      return reply.send({ success: true, coalesced: true });
    }
    // Registered in the SAME synchronous step as the check above, before any
    // await: a burst of wake-ups arriving together must see this flight, or
    // they all slip past the check while the first one awaits the enabled
    // read (observed: 5 concurrent wake-ups, 5 runs). Every path below
    // releases it; `DrainFlights` also expires a flight older than any run
    // can live, so a missed release cannot swallow wake-ups for long.
    const flight = isTriggeredJobName(name) ? drainFlights.begin(name) : null;
    if (flight) openedFlights.set(request, { name, flight });

    // Check if disabled (allow manual trigger with ?force=true)
    const force = request.query.force === "true";
    if (!force) {
      const enabled = await tracker.isEnabled(name);
      if (!enabled) {
        if (flight) drainFlights.end(name, flight);
        logger.info("job_skipped_disabled", { job: name });
        return reply.send({
          success: false,
          skipped: true,
          reason: "disabled",
        });
      }
    }

    const jobLogger = logger.child({ job: name });
    const runId = randomUUID();
    const startedAt = new Date();
    if (job.notify) {
      await logAndAlert({
        logger: jobLogger,
        level: "info",
        message: "job_start",
        extra: { runId, payload: request.body },
        alert: createJobLifecycleAlert(name, "started", runId),
      });
    } else {
      jobLogger.info("job_start", { runId, payload: request.body });
    }

    // The error the request's input was rejected with, if it was (see
    // `parseInput` below).
    let inputRejection: unknown = null;
    try {
      // FIRST touch of this job's handler module. The registry carries metadata
      // only, so everything above — the 404, the drift short-circuit, the
      // enabled check, the start alert — ran without importing a single use
      // case. `load()` imports the owning module (once per process, memoized)
      // and hands back the real definition.
      //
      // Deliberately INSIDE the try: a module that cannot be imported raises a
      // typed JOB_MODULE_LOAD_FAILED, which the catch below records, DLQs,
      // reports to Sentry and answers 503 — for this job alone. The service
      // and every other job stay up.
      const definition = await job.load();

      // Every parse of REQUEST input goes through here, and a rejection is
      // remembered by identity. The catch below answers 400 `invalid_input`
      // for any ZodError, but a handler can throw one too (a use case that
      // ends in a raw output-schema `.parse` and meets one bad row), and that
      // is a failed run that must be reported, not a bad request. A flag set
      // "after the input was parsed" could not tell them apart: the payload of
      // a coalesced follow-up pass is parsed below, after the handler ran.
      const parseInput = (body: unknown) => {
        try {
          return definition.input.parse(body);
        } catch (parseErr) {
          inputRejection = parseErr;
          throw parseErr;
        }
      };

      const input = parseInput(request.body ?? {});

      const invoke = (parsed: unknown) =>
        (
          definition.handler as (args: {
            input: unknown;
            ctx: JobContext;
          }) => Promise<unknown>
        )({
          input: parsed,
          ctx: { ...container, logger: jobLogger, runId },
        });

      let result = await invoke(input);

      if (flight && isTriggeredJobName(name)) {
        // Wake-ups that arrived while this run was draining. Each follow-up
        // pass drains until empty again, so rows committed after this run's
        // last fetch are covered without a second request.
        //
        // Only a WAKE-UP request runs them. A scheduled (or manual) run is
        // held to Cloud Scheduler's attempt deadline and must stay one
        // pass-loop long, so any wake-ups it absorbed are handed to a fresh
        // request (`capped` → re-wake below) instead of lengthening it.
        const reruns = wakeUp
          ? await drainFlights.drainReruns(name, flight, (payload) =>
              invoke(parseInput(payload)),
            )
          : { results: [] as unknown[], capped: flight.rerun };
        drainFlights.end(name, flight);
        if (reruns.results.length > 0) {
          result = {
            first: result,
            coalescedReruns: reruns.results.length,
            last: reruns.results[reruns.results.length - 1],
          };
        }
        // Stopped on its time/pass budget, or still being woken when the
        // rerun cap hit: hand the rest to a FRESH request rather than holding
        // this one open or waiting for the scheduled safety net.
        const lastResult = reruns.results.length > 0
          ? reruns.results[reruns.results.length - 1]
          : (result as unknown);
        if (
          (resultHasMore(lastResult) || reruns.capped) &&
          container.jobTrigger
        ) {
          try {
            await container.jobTrigger.trigger(name);
            jobLogger.info("job_rekicked", { runId });
          } catch (kickErr) {
            // Deliberate swallow: the rows stay queued and the scheduled
            // safety-net run drains them. Reported so a broken re-kick path
            // is visible (CLAUDE.md reporter rule).
            jobLogger.error("job_rekick_failed", { runId, err: kickErr });
            try {
              container.reportError?.(kickErr, {
                tags: { area: "job-trigger", job: name, phase: "rekick" },
                extra: { runId },
              });
            } catch {
              // best-effort only
            }
          }
        }
      }

      const finishedAt = new Date();
      const entry: RunEntry = {
        id: runId,
        jobName: name,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        status: "success",
        resultSummary: JSON.stringify(result)?.slice(0, 500),
      };
      // Run history is BOOKKEEPING and must never decide the job's outcome.
      // This sits inside the same `try` as the handler, so before the Redis
      // client gained a 500ms `commandTimeout` (2026-09-14) a blip here just
      // sat in ioredis's offline queue and eventually landed. Bounded, it
      // rejects — and an unguarded rejection would jump to the catch below,
      // which relabels this ALREADY-SUCCESSFUL run as `status: "error"`, DLQs
      // it, and answers 5xx so the caller re-runs a job that already did its
      // work. For settlements that means re-issuing transfers.
      try {
        await tracker.record(entry);
      } catch (trackerErr) {
        // Deliberate swallow (bookkeeping never decides the outcome), so
        // reported: apps/jobs has no Sentry pino integration.
        jobLogger.error("job_run_record_failed", { runId, error: logSafeError(trackerErr) });
        try {
          container.reportError?.(trackerErr, {
            tags: { area: "job-run-tracker", job: name, phase: "success" },
            extra: { runId },
          });
        } catch {
          // best-effort only
        }
      }

      if (job.notify) {
        await logAndAlert({
          logger: jobLogger,
          level: "info",
          message: "job_complete",
          extra: { runId, durationMs: entry.durationMs, result },
          alert: createJobLifecycleAlert(
            name,
            "completed",
            runId,
            entry.durationMs,
          ),
        });
      } else {
        jobLogger.info("job_complete", {
          runId,
          durationMs: entry.durationMs,
          result,
        });
      }

      return reply.send({
        success: true,
        runId,
        durationMs: entry.durationMs,
        result,
      });
    } catch (err) {
      if (flight) drainFlights.end(name, flight);
      const finishedAt = new Date();
      const errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error";
      const errorCode =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as any).code)
          : undefined;
      // Stable, machine-readable code shared with the request path (FR-010), so
      // a job failure and an equivalent tRPC failure log the same identifier.
      // Logged alongside the raw `errorCode`; the wire/DLQ/run-history shapes are
      // intentionally left unchanged.
      const appCode = resolveJobErrorCode(err);

      const entry: RunEntry = {
        id: runId,
        jobName: name,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        status: "error",
        errorMessage,
        errorCode,
      };
      // Same reasoning as the success path, plus: a throw here would escape
      // the catch entirely and replace the REAL failure with a Redis error,
      // losing the diagnosis and skipping the DLQ push below.
      try {
        await tracker.record(entry);
      } catch (trackerErr) {
        // Deliberate swallow (bookkeeping never decides the outcome), so
        // reported: apps/jobs has no Sentry pino integration.
        jobLogger.error("job_run_record_failed", { runId, error: logSafeError(trackerErr) });
        try {
          container.reportError?.(trackerErr, {
            tags: { area: "job-run-tracker", job: name, phase: "error" },
            extra: { runId },
          });
        } catch {
          // best-effort only
        }
      }

      // A rerun from the DLQ names the entry it came from and carries the
      // claim token the rerun route holds on that entry. Its failure is
      // written onto THAT entry (a compare-and-swap, so a rewrite racing a
      // delete still leaves at most one), instead of being pushed as a second
      // entry. `false` means the entry is gone (deleted meanwhile, or the
      // header names nothing): then this run is pushed as a new entry below.
      // A failed run therefore always ends with at least one entry, and with
      // exactly one unless the rewrite threw (next comment).
      //
      // The entry is rewritten only when the token IS the live claim on it.
      // The rerun route lets one rerun per entry through at a time, and this
      // check holds a direct caller to the same rule: `X-Dlq-Rerun-Of` with no
      // token, a stale one or a wrong one is an ordinary failed run and gets
      // its own entry below.
      const rerunOfHeader = request.headers[DLQ_RERUN_OF_HEADER];
      const rerunOf =
        typeof rerunOfHeader === "string" && rerunOfHeader.length > 0
          ? rerunOfHeader
          : null;
      const rerunClaimHeader = request.headers[DLQ_RERUN_CLAIM_HEADER];
      const rerunClaim =
        typeof rerunClaimHeader === "string" && rerunClaimHeader.length > 0
          ? rerunClaimHeader
          : null;
      let holdsClaim = false;
      if (dlq && rerunOf && rerunClaim) {
        try {
          holdsClaim = await dlq.holdsRerunClaim({
            queue: name,
            jobId: rerunOf,
            token: rerunClaim,
          });
        } catch (claimErr) {
          // Deliberate swallow: without an answer the claim counts as not
          // held, and the plain push below still gives this failure an entry.
          // Reported for the same reason as `dlq_push_failed` (CLAUDE.md
          // reporter rule). The adapter's error is sanitised (op, key hash,
          // Redis error code) and the token is in neither line.
          jobLogger.error("dlq_rerun_claim_check_failed", {
            runId,
            error: logSafeError(claimErr),
          });
          try {
            container.reportError?.(claimErr, {
              tags: { area: "job-dlq", job: name, phase: "rerun-claim-check" },
              extra: { runId },
            });
          } catch {
            // best-effort only
          }
        }
      }
      if (dlq && rerunOf && !holdsClaim) {
        // Says why this run gets an entry of its own. The header's value is
        // the caller's text, so it is not logged.
        jobLogger.warn("dlq_rerun_claim_not_held", {
          runId,
          hasToken: rerunClaim !== null,
        });
      }
      let recordedOnEntry = false;
      if (dlq && rerunOf && holdsClaim) {
        try {
          recordedOnEntry = await dlq.recordRerunFailure({
            queue: name,
            jobId: rerunOf,
            runId,
            failedAt: finishedAt.toISOString(),
            error: { message: errorMessage, code: errorCode },
          });
        } catch (recordErr) {
          // Deliberate swallow: falls back to the plain push below, so the
          // failure still has an entry. If Redis applied the rewrite and only
          // its reply was lost, that push makes a second entry; too many
          // entries is the safe side of that doubt. Reported for the same
          // reason as `dlq_push_failed` (CLAUDE.md reporter rule). The adapter
          // throws sanitised errors here (op, key hash, Redis error code), so
          // neither the log line nor the report can carry an entry's payload.
          jobLogger.error("dlq_rerun_record_failed", {
            runId,
            error: logSafeError(recordErr),
          });
          try {
            container.reportError?.(recordErr, {
              tags: { area: "job-dlq", job: name, phase: "rerun-record" },
              extra: { runId },
            });
          } catch {
            // best-effort only
          }
        }
      }

      // Push to DLQ
      if (dlq && !recordedOnEntry) {
        try {
          await dlq.pushToDLQ({
            ref: { queue: name, id: runId },
            failedAt: finishedAt.toISOString(),
            payload: request.body,
            attempt: 1,
            error: { message: errorMessage, code: errorCode },
          });
        } catch (dlqErr) {
          // Deliberate swallow: the DLQ push must never replace the real job
          // failure handled below. Reported because apps/jobs has no Sentry
          // pino integration, so the log line alone never reaches Sentry and a
          // broken DLQ would lose failed jobs silently (CLAUDE.md reporter rule).
          jobLogger.error("dlq_push_failed", { runId, error: logSafeError(dlqErr) });
          try {
            container.reportError?.(dlqErr, {
              tags: { area: "job-dlq", job: name, phase: "push" },
              extra: { runId },
            });
          } catch {
            // best-effort only
          }
        }
      }

      if (err instanceof ZodError) {
        const issues = err.issues ?? [];
        if (err !== inputRejection) {
          // Not the request's input: the HANDLER threw this (see
          // `parseInput`). The status, the body and the warn line below stay
          // as they are for callers that read them, but a 400 and a warn reach
          // nobody, so a job failing this way every night would stay silent.
          // Count only at error level; the warn line carries the issues.
          jobLogger.error("job_handler_schema_error", {
            runId,
            issueCount: issues.length,
          });
          try {
            container.reportError?.(err, {
              tags: { area: "job-run", job: name, phase: "handler-zod-error" },
              extra: { runId },
            });
          } catch {
            // best-effort only
          }
        }
        if (job.notify) {
          await logAndAlert({
            logger: jobLogger,
            level: "warn",
            message: "job_invalid_input",
            extra: { runId, appCode, errors: issues },
            alert: createJobLifecycleAlert(
              name,
              "failed",
              runId,
              entry.durationMs,
            ),
          });
        } else {
          jobLogger.warn("job_invalid_input", { runId, appCode, errors: issues });
        }
        return reply
          .status(400)
          .send({ error: "invalid_input", runId, details: issues });
      }

      if (typeof err === "object" && err !== null && "code" in err) {
        const typed = err as { code: string; message?: string };

        // A repeating, permanent module-import failure must not flood Sentry.
        // Latch the CAPTURE per module (first tick reports, every tick still
        // logs); see `reportedModuleLoadFailures`. Every other typed error is
        // reported on every occurrence, exactly as before.
        const failedModule =
          typed.code === "JOB_MODULE_LOAD_FAILED"
            ? String(
                (err as { meta?: { module?: unknown } }).meta?.module ?? name,
              )
            : null;
        const suppressCapture =
          failedModule !== null && reportedModuleLoadFailures.has(failedModule);
        if (failedModule !== null) reportedModuleLoadFailures.add(failedModule);

        // Capture regardless of `job.notify` — an unhandled job error is
        // always incident-worthy. logAndReport logs, and captures when given a
        // `report`; the Discord alert stays gated on `job.notify`. Passing
        // buildSentryUrl appends a clickable "Sentry" link to the "Job failed"
        // embed.
        await logAndReport({
          logger: jobLogger,
          level: "error",
          message: "job_error",
          extra: {
            runId,
            appCode,
            code: typed.code,
            message: typed.message,
            // Makes the suppressed ticks self-explaining in Cloud Logging:
            // "already reported, this is not a new fault".
            ...(suppressCapture ? { captureSuppressed: true } : {}),
          },
          report: suppressCapture
            ? undefined
            : {
                captureException: Sentry.captureException,
                // Typed domain errors are usually PLAIN OBJECTS
                // `{ code, message }` (no stack) — passing them straight to
                // Sentry yields a low-signal "Non-Error exception captured"
                // event. Synthesize a real Error for a proper stack +
                // grouping; the raw code/message live in `extra`.
                // Mirrors apps/api/src/plugins/trpc.ts.
                error: new Error(typed.message ?? typed.code),
                context: {
                  tags: { job: name, runId, appCode: appCode ?? undefined },
                  extra: {
                    errorCode,
                    code: typed.code,
                    message: typed.message,
                    logsUrl: buildCloudLoggingUrl(runId) ?? undefined,
                  },
                },
                buildSentryUrl: sentryIssueUrl,
              },
          alert: job.notify
            ? createJobLifecycleAlert(name, "failed", runId, entry.durationMs)
            : undefined,
        });

        // Why a handler module that would not import answers 503, not 400:
        //
        //  - 5xx is the truthful class. The request is well-formed and the
        //    caller is blameless; the SERVER cannot service it.
        //  - It agrees with the migration-drift 503 above — same shape of
        //    fault (this build cannot run this job right now), same code.
        //  - It stays visible. A failed attempt shows in Cloud Scheduler's job
        //    status and Cloud Monitoring, distinguishable from a 400.
        //
        // It buys a bounded retry. As documented at the drift 503, the
        // generated schedulers retry at most twice (30s, then 60s), so a
        // broken module costs at most 3 attempts per tick, never a hot loop.
        // `Retry-After` is defence in depth for parity with that 503: it is
        // the correct hint to any caller that honours it.
        const isLoadFailure = typed.code === "JOB_MODULE_LOAD_FAILED";
        if (isLoadFailure) {
          return reply
            .status(503)
            .header("Retry-After", "60")
            .send({ error: typed.code, runId, message: typed.message });
        }
        // Cloud Scheduler retries this 400 too: it retries any non-2xx.
        return reply
          .status(400)
          .send({ error: typed.code, runId, message: typed.message });
      }

      // Genuine unhandled failure (DB down, Redis down, thrown Error, etc.).
      // Capture regardless of `job.notify` — these are always incident-worthy
      // and were previously invisible in Sentry (only auto-captured on an
      // unhandled crash, which this catch prevents). The Discord alert stays
      // gated on `job.notify`.
      await logAndReport({
        logger: jobLogger,
        level: "error",
        message: "job_failed",
        extra: { runId, appCode, errorMessage, errorCode, err },
        report: {
          captureException: Sentry.captureException,
          error: err,
          context: {
            tags: { job: name, runId, appCode: appCode ?? undefined },
            extra: {
              errorCode,
              logsUrl: buildCloudLoggingUrl(runId) ?? undefined,
            },
          },
          buildSentryUrl: sentryIssueUrl,
        },
        alert: job.notify
          ? createJobLifecycleAlert(name, "failed", runId, entry.durationMs)
          : undefined,
      });
      return reply.status(500).send({ error: "internal_error", runId });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DLQ endpoints
  // ─────────────────────────────────────────────────────────────────────────

  app.get<{ Params: { queue: string }; Querystring: { max?: string } }>(
    "/dlq/:queue",
    async (request, reply) => {
      if (!dlq) return reply.status(501).send({ error: "dlq_not_configured" });
      const { queue } = request.params;
      const max = Math.min(parseInt(request.query.max ?? "25", 10) || 25, 500);
      const items = await dlq.peekDLQ({ queue, max });
      return { queue, items, count: items.length };
    },
  );

  app.get<{ Params: { queue: string; jobId: string } }>(
    "/dlq/:queue/:jobId",
    async (request, reply) => {
      if (!dlq) return reply.status(501).send({ error: "dlq_not_configured" });
      const item = await dlq.getFromDLQ(request.params);
      if (!item) return reply.status(404).send({ error: "not_found" });
      return item;
    },
  );

  app.delete<{ Params: { queue: string; jobId: string } }>(
    "/dlq/:queue/:jobId",
    async (request, reply) => {
      if (!dlq) return reply.status(501).send({ error: "dlq_not_configured" });
      const deleted = await dlq.deleteFromDLQ(request.params);
      return { deleted };
    },
  );

  app.delete<{ Params: { queue: string } }>(
    "/dlq/:queue",
    async (request, reply) => {
      if (!dlq) return reply.status(501).send({ error: "dlq_not_configured" });
      const result = await dlq.purgeDLQ({ queue: request.params.queue });
      return result;
    },
  );

  app.post<{
    Params: { queue: string; jobId: string };
    Body: { payloadOverride?: unknown };
  }>("/dlq/:queue/:jobId/rerun", async (request, reply) => {
    if (!dlq) return reply.status(501).send({ error: "dlq_not_configured" });
    const { queue, jobId } = request.params;

    // The run route is the one authority on whether the job is paused: no
    // enabled check here, and a rerun is never forced. Logs name the entry and
    // the outcome, never the payload.
    let result: RerunJobFromDlqResult;
    try {
      result = await dlq.rerunFromDLQ({
        queue,
        jobId,
        payloadOverride: request.body?.payloadOverride,
      });
    } catch (err) {
      if (isDlqEntryNotFound(err)) {
        logger.warn("dlq_rerun", { queue, jobId, outcome: "not_found" });
        return reply.status(404).send({ error: "not_found" });
      }
      if (isDlqRerunNoAnswer(err)) {
        // A 5xx that is not the jobs service's own answer: a gateway gave up
        // on the request (Cloud Run's 504 past 300s, when `JOBS_SELF_URL`
        // points through it) while the run may still
        // be going. Not a refusal and not a failed run, so it is not worded as
        // either; the adapter kept the claim. Logged and reported here
        // because the backstop below only answers 500.
        logger.error("dlq_rerun_no_answer", {
          queue,
          jobId,
          status: err.runRouteStatus,
        });
        try {
          container.reportError?.(err, {
            tags: { area: "job-dlq", phase: "rerun-no-answer" },
            extra: { queue, jobId, status: err.runRouteStatus },
          });
        } catch {
          // best-effort only
        }
      }
      // The run route could not be reached, the request to it broke off, or
      // Redis failed while claiming the entry or looking it up, or a gateway
      // answered for the run route (above). The entry is untouched and the
      // Fastify backstop answers 500. This does NOT mean nothing ran: when the
      // request broke off after the run route accepted it, the run may still
      // be in progress.
      throw err;
    }

    if (result.outcome === "ran") {
      // `entryDeleted: false`: the job ran but its entry is still listed (the
      // adapter logged and reported why). Still a 200 `ran`, so nobody reruns
      // a job that already did its work.
      logger[result.entryDeleted ? "info" : "warn"]("dlq_rerun", {
        queue,
        jobId,
        outcome: result.outcome,
        runId: result.runId,
        entryDeleted: result.entryDeleted,
      });
      return reply.send({
        outcome: "ran",
        runId: result.runId,
        entryDeleted: result.entryDeleted,
      });
    }

    if (result.outcome === "not_run") {
      logger.warn("dlq_rerun", {
        queue,
        jobId,
        outcome: result.outcome,
        reason: result.reason,
      });
      return reply.status(409).send({
        outcome: "not_run",
        reason: result.reason,
        entryKept: true,
        ...DLQ_RERUN_NOT_RUN[result.reason],
      });
    }

    logger.warn("dlq_rerun", {
      queue,
      jobId,
      outcome: result.outcome,
      runId: result.runId,
      status: result.status,
      errorCode: result.error.code,
    });

    // No run id: the run route turned the request away before a run started
    // (401 on the self-call, a 500 from the enabled check), so its catch,
    // which reports a failed run, never ran. This answer goes back to the
    // console as data, so nothing downstream reports it either. Not for a 404
    // (the job no longer exists; the answer says so) and not for the
    // migration-drift 503, which the run route reports once per process.
    // A gateway's 5xx never arrives here: the rerun callback throws for it
    // (`DlqRerunNoAnswerError`, handled above), so `runId: null` here is the
    // jobs service's own answer, given before a run started.
    const refusedBeforeRun =
      result.runId === null &&
      result.status !== 404 &&
      !(result.status === 503 && result.error.code === "migration_drift");
    if (refusedBeforeRun) {
      logger.error("dlq_rerun_refused", {
        queue,
        jobId,
        status: result.status,
        errorCode: result.error.code,
      });
      try {
        container.reportError?.(
          new Error(`DLQ rerun refused before the run started: HTTP ${result.status}`),
          {
            tags: { area: "job-dlq", phase: "rerun-refused" },
            extra: { queue, jobId, status: result.status },
          },
        );
      } catch {
        // best-effort only
      }
    }

    return reply.status(409).send({
      outcome: "failed",
      error: "rerun_failed",
      runId: result.runId,
      status: result.status,
      runError: result.error,
      entryKept: true,
      message: "The rerun failed. The entry was kept.",
    });
  });

  return { app, container };
}
