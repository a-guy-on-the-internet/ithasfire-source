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

import { Sentry } from "./instrument";
import { buildContainer } from "./lib/container";
import { allJobs, getJob } from "./jobs";
import {
  isScheduledTask,
  type JobContext,
  type ScheduledTaskDefinition,
} from "./lib/define-job";
import type { RunEntry } from "./lib/job-run-tracker";
import type { RedisJobDiagnosticsAdapter } from "@th/adapters/job-diagnostics/redis-dlq-adapter";
import { buildCloudLoggingUrl, fireDiscordAlert } from "./lib/discord-alerts";

// ─────────────────────────────────────────────────────────────────────────────
// Cron helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable label for a cron expression. */
function describeCron(cron: string): string {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  if (
    min?.startsWith("*/") &&
    hour === "*" &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Every ${min.slice(2)} minutes`;
  }
  if (
    min !== "*" &&
    hour === "*" &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `At minute ${min} of every hour`;
  }
  if (
    min !== "*" &&
    hour !== "*" &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Daily at ${hour!.padStart(2, "0")}:${min!.padStart(2, "0")}`;
  }
  if (hour?.startsWith("*/")) {
    return `Every ${hour.slice(2)} hours at minute ${min}`;
  }
  return cron;
}

/** Compute the next occurrence of a cron expression (approximate). */
function nextCronRun(cron: string, _timezone?: string): string | null {
  try {
    const now = new Date();
    const parts = cron.split(/\s+/);
    if (parts.length !== 5) return null;
    const [minPart, hourPart] = parts;

    // "*/N * * * *" (every N minutes)
    if (minPart?.startsWith("*/")) {
      const interval = parseInt(minPart.slice(2), 10);
      if (!interval || interval <= 0) return null;
      const currentMin = now.getMinutes();
      const nextMin = Math.ceil((currentMin + 1) / interval) * interval;
      const next = new Date(now);
      next.setSeconds(0, 0);
      next.setMinutes(nextMin);
      if (next <= now) next.setMinutes(next.getMinutes() + interval);
      return next.toISOString();
    }

    // "M H * * *" (daily at H:M)
    if (
      minPart &&
      hourPart &&
      !minPart.includes("*") &&
      !hourPart.includes("*") &&
      !hourPart.includes("/")
    ) {
      const m = parseInt(minPart, 10);
      const h = parseInt(hourPart, 10);
      const next = new Date(now);
      next.setHours(h, m, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }

    // "M * * * *" (hourly at minute M)
    if (minPart && !minPart.includes("*") && hourPart === "*") {
      const m = parseInt(minPart, 10);
      const next = new Date(now);
      next.setMinutes(m, 0, 0);
      if (next <= now) next.setHours(next.getHours() + 1);
      return next.toISOString();
    }

    return null;
  } catch {
    return null;
  }
}

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

function jobScheduleInfo(job: { name: string; description?: string }) {
  const scheduled = isScheduledTask(job as any);
  if (!scheduled) return null;
  const def = job as unknown as ScheduledTaskDefinition;
  return {
    cron: def.schedule.cron,
    timezone: def.schedule.timezone ?? "Etc/UTC",
    enabled: def.schedule.enabled ?? true,
    cronDescription: describeCron(def.schedule.cron),
    nextRun: nextCronRun(def.schedule.cron, def.schedule.timezone),
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
   * Why the blocked run route answers 503 (not 4xx, not 200):
   *
   *  - 5xx is the truthful class. The request is well-formed and the caller is
   *    blameless; the SERVER cannot service it. A 4xx would tell Cloud
   *    Scheduler / Pub-Sub the message is permanently undeliverable and is
   *    simply wrong.
   *  - No retry storm. `infra/terraform/generated-jobs.tf:143` declares the
   *    schedulers with NO `retry_config`, so Cloud Scheduler's default
   *    `retryCount = 0` applies: the attempt is recorded as failed and the job
   *    waits for its next cron tick. That is exactly the cadence we want —
   *    visible, bounded, self-resuming once the schema is fixed.
   *  - It stays visible. A failed attempt shows up in Cloud Scheduler's job
   *    status and Cloud Monitoring; answering 200 with `{skipped:true}` (the
   *    shape used for a DISABLED job) would hide a schema mismatch behind a
   *    success, which is how this class of bug stayed alive for 90 days.
   *  - It agrees with `/health`. Same condition, same code, so probe and
   *    traffic tell operators the same story.
   *  - `Retry-After: 300` is defence in depth, not a fix for a retry policy
   *    that exists today. No scheduler currently reaching this route has one
   *    (the `db-backup` module's `retry_count = 1` targets the Cloud Run Admin
   *    API, not `POST /jobs/:name`). It is here so that if a `retry_config` is
   *    ever added to `generated-jobs.tf`, or a manual/Pub-Sub caller retries, a
   *    stuck revision cannot be hot-looped.
   */

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

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
        scheduled: isScheduledTask(job as any),
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
          scheduled: isScheduledTask(job as any),
          schedule: jobScheduleInfo(job),
          enabled,
          lastRun,
        };
      }),
    );

    return { jobs };
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

    // Check if disabled (allow manual trigger with ?force=true)
    const force = request.query.force === "true";
    if (!force) {
      const enabled = await tracker.isEnabled(name);
      if (!enabled) {
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

    try {
      const input = job.input.parse(request.body ?? {});

      const result = await (
        job.handler as (args: {
          input: unknown;
          ctx: JobContext;
        }) => Promise<unknown>
      )({
        input,
        ctx: { ...container, logger: jobLogger, runId },
      });

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
      await tracker.record(entry);

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
      await tracker.record(entry);

      // Push to DLQ
      if (dlq) {
        try {
          await dlq.pushToDLQ({
            ref: { queue: name, id: runId },
            failedAt: finishedAt.toISOString(),
            payload: request.body,
            attempt: 1,
            error: { message: errorMessage, code: errorCode },
          });
        } catch (dlqErr) {
          jobLogger.error("dlq_push_failed", { dlqErr });
        }
      }

      if (err instanceof ZodError) {
        const issues = err.issues ?? [];
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
        // Capture regardless of `job.notify` — an unhandled job error is
        // always incident-worthy. logAndReport always logs + captures; the
        // Discord alert stays gated on `job.notify`. Passing buildSentryUrl
        // appends a clickable "Sentry" link to the "Job failed" embed.
        await logAndReport({
          logger: jobLogger,
          level: "error",
          message: "job_error",
          extra: { runId, appCode, code: typed.code, message: typed.message },
          report: {
            captureException: Sentry.captureException,
            // Typed domain errors are usually PLAIN OBJECTS `{ code, message }`
            // (no stack) — passing them straight to Sentry yields a low-signal
            // "Non-Error exception captured" event. Synthesize a real Error for
            // a proper stack + grouping; the raw code/message live in `extra`.
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
    const result = await dlq.rerunFromDLQ({
      queue: request.params.queue,
      jobId: request.params.jobId,
      payloadOverride: request.body?.payloadOverride,
    });
    return result;
  });

  return { app, container };
}
