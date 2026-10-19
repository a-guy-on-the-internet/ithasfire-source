import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

/**
 * Migration-drift guard — the last line of defense against serving traffic on
 * a database that is missing migrations the running image was built from.
 *
 * Seven times in 90 days a revision was promoted onto a stale schema and the
 * homepage broke with Prisma `P2022` ("column X does not exist"). In every case
 * the migration existed in the repo but had never been applied to that
 * environment. CI gating was supposed to catch it and is a single point of
 * failure that repeatedly failed, so this check moves the guard into the
 * process itself: when drift is confirmed, `/health` returns 503 and Cloud Run
 * never promotes the revision to serve traffic.
 *
 * Lives in `@th/adapters/infra` — alongside `logger`, `clock`, `otel-bootstrap`
 * and `discord-alerts` — because BOTH deployed services need it and both
 * already depend on `@th/adapters`. `apps/jobs` was in fact the worst-hit
 * victim: Sentry HEARTH-FIRE-WEB-17 logged ~208 of ~220 events from
 * `POST /jobs/:name` running on a cron cadence against a stale schema
 * (`Event.recurrence_schedule`, `public.PushReceipt`, `public.RsvpNotice`,
 * `Event.instructional_admission`). A `/health` 503 alone does NOT stop that —
 * Cloud Scheduler POSTs directly — so the jobs app also short-circuits the run
 * route on confirmed, enforced drift.
 *
 * Design constraints, in priority order:
 *
 *  1. NEVER wedge the service on an inconclusive check. A false positive here
 *     takes down the whole API, which is strictly worse than the bug being
 *     fixed. "Confirmed drift" (image has a migration the DB has not finished
 *     applying) blocks; anything we could not determine — missing migrations
 *     directory, missing `_prisma_migrations` table, unreachable/slow DB —
 *     reports to Sentry and stays healthy.
 *  2. Fail visibly. Both the confirmed-drift branch and the "could not
 *     determine" swallow branch report through `reportError?: ReporterPort`
 *     (guarded), and every `logger.error` carries an `err` field so Sentry's
 *     pino integration links a real exception rather than a bare log line.
 *  3. No manifest file. The expected migration list is read from the real
 *     migrations directory shipped in the image, so it cannot go stale the way
 *     a generated/committed manifest can.
 *  4. BLOCK only where blocking buys something. Detection is always on and
 *     always loud; the 503 is gated to deployed environments (see
 *     `shouldBlockOnDrift`). On a dev laptop the same 503 would take down the
 *     whole local stack — `scripts/human-dev.cjs` gates API, jobs, Stripe and
 *     web on `/health` returning 2xx-3xx and hard-exits on timeout (90s for
 *     the API, 60s for jobs) — which is constraint #1 displaced onto the
 *     developer.
 *  5. There is always a way out. `MIGRATION_DRIFT_ENFORCE=false` is the
 *     documented break-glass: it disables BLOCKING only, never detection,
 *     logging or Sentry reporting, and announces itself at `error` on every
 *     boot so it cannot be left on by accident. It exists because the deploy
 *     pipeline's `skip-migrate` incident path and a multi-day drift window
 *     (which would otherwise halt `settlements.*` and the payout crons) are
 *     both cases where an operator must be able to overrule this guard
 *     explicitly. See `migrationDriftEnforcementOverride`.
 */

/** The command a human runs to fix confirmed drift. Surfaced in logs + the 503. */
export const APPLY_MIGRATIONS_HINT = "pnpm db:migrate:deploy";

/**
 * How many migration names go into human-facing strings (Sentry messages, HTTP
 * bodies, per-request logs). The realistic incident is 1-3 pending migrations
 * and those are always listed in full. The pathological case — a completely
 * empty database — is ~100 names, which would blow up every 503 body and every
 * cron-tick log line, and would overflow Sentry's message truncation and wreck
 * issue grouping. The full list is still available in the structured boot log.
 */
export const MAX_LISTED_PENDING_MIGRATIONS = 10;

/** `a, b, c` — or `a, …, j (+90 more)` past MAX_LISTED_PENDING_MIGRATIONS. */
export function formatPendingMigrations(pending: string[]): string {
  const listed = pending.slice(0, MAX_LISTED_PENDING_MIGRATIONS);
  const remaining = pending.length - listed.length;
  return remaining > 0
    ? `${listed.join(", ")} (+${remaining} more)`
    : listed.join(", ");
}

/** The bounded name list to put in an HTTP body. Pair with `pendingCount`. */
export function listPendingMigrations(pending: string[]): string[] {
  return pending.slice(0, MAX_LISTED_PENDING_MIGRATIONS);
}

/**
 * Builds the canonical drift `Error`. Shared by the boot check and by the jobs
 * run-route short-circuit so both group under one Sentry issue with the same
 * wording, and so the pending migration names are always in the message (not
 * just in `extra`, which Sentry's issue list does not show).
 */
export function buildMigrationDriftError(pending: string[]): Error {
  return new Error(
    `migration_drift_detected: database is missing ${pending.length} ` +
      `migration(s) this build requires: ${formatPendingMigrations(pending)}. ` +
      `Apply them with \`${APPLY_MIGRATIONS_HINT}\`.`,
  );
}

export type MigrationDriftResult =
  | { status: "ok" }
  /**
   * Image contains migrations the database has not finished applying.
   * `enforced` decides whether `/health` turns this into a 503 — detection and
   * enforcement are deliberately separate so local dev still gets the loud log
   * without the stack-killing probe failure.
   */
  | { status: "drift"; pending: string[]; enforced: boolean }
  /** Check could not be completed — service stays healthy. */
  | { status: "unknown"; reason: MigrationDriftUnknownReason };

export type MigrationDriftUnknownReason =
  /** Migrations directory not present (or unreadable) in this image/checkout. */
  | "migrations_dir_missing"
  /** `_prisma_migrations` does not exist — fresh/bootstrap database. */
  | "migrations_table_missing"
  /** Any other failure: DB unreachable, timed out, permission denied, etc. */
  | "query_failed";

export type MigrationDriftDeps = {
  /**
   * Migration directory names baked into the running image, e.g.
   * `["20260101120000_init", ...]`. Throws when the directory is absent.
   */
  listExpectedMigrations: () => string[];
  /**
   * Migration names the database reports as APPLIED — Prisma only considers a
   * migration applied once `finished_at IS NOT NULL`, so partially-applied /
   * in-flight rows must be excluded by the implementation.
   */
  listAppliedMigrations: () => Promise<string[]>;
  logger: LoggerPort;
  reportError?: ReporterPort;
  /**
   * Whether confirmed drift should make `/health` fail. Detection, logging and
   * Sentry reporting happen either way. Defaults to `shouldBlockOnDrift()`.
   */
  enforce?: boolean;
  /**
   * Upper bound on the `_prisma_migrations` query. See
   * `DEFAULT_QUERY_TIMEOUT_MS` for how the value is chosen. A timeout lands in
   * the `query_failed` branch: healthy + reported.
   */
  queryTimeoutMs?: number;
  /**
   * Gate for the log + Sentry side effects, evaluated once the verdict is
   * known. Returning `false` suppresses BOTH. Defaults to "always notify".
   *
   * This exists for `createMigrationDriftMonitor`, which re-queries on a timer
   * and must log/report on STATE TRANSITIONS rather than on every poll —
   * otherwise a re-checking container emits an identical error line and Sentry
   * event every few seconds. Direct callers get the original always-notify
   * behaviour.
   */
  shouldNotify?: (result: MigrationDriftResult) => boolean;
};

/**
 * 25 seconds — deliberately generous, and sized against the Cloud Run startup
 * budget rather than against "a healthy query".
 *
 * This timeout has exactly ONE job: stop a BLACK-HOLED database (packets
 * dropped rather than refused) from hanging boot forever. It is not a latency
 * SLO, and making it tight is actively dangerous, because every timeout fails
 * the guard OPEN (`query_failed` → `unknown` → no blocking).
 *
 * Why not 5s, which is what this started at: the `_prisma_migrations` lookup is
 * plausibly the process's FIRST real round-trip. Neither composition root sets
 * `connectionTimeoutMillis` on its pg Pool (`apps/api/src/lib/dep.ts`,
 * `apps/jobs/src/lib/container.ts`), and `$connect()` under the pg driver
 * adapter does not necessarily open a socket — so this query is the call that
 * has to WAKE a scale-to-zero Neon compute. A 5s cap would routinely lose that
 * race on the exact cold-boot path the guard exists to protect: prod jobs
 * sits at 0 instances overnight, the 03:00 Cloud Scheduler POST cold-starts
 * it, Neon resume + first round-trip blows the cap, the check degrades to
 * "unknown", the revision reports healthy, and cron runs against the stale
 * schema — the original outage, verbatim, with the guard installed and
 * silently inert. It would also emit a `migration_drift_check_indeterminate`
 * Sentry event on every cold start, training operators to ignore the one
 * signal that matters.
 *
 * Why 25s is safe: Cloud Run's startup probe budget is
 * `failure_threshold (30) × period_seconds (5)` = 150s
 * (infra/terraform/modules/cloud-run-service/variables.tf), against an
 * observed ~45s cold boot for the API under tsx. 45 + 25 = 70s leaves ~80s of
 * headroom, so a worst-case slow wake still lands well inside the probe budget
 * while a genuinely black-holed DB still fails fast enough to be diagnosable.
 *
 * One shared value for both services on purpose: they have the same Neon
 * backend, the same probe budget, and jobs actually boots LIGHTER than the API
 * (fewer adapters), so it has strictly more headroom — a separate, larger
 * jobs-specific override would add a knob without adding safety.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 25_000;

/**
 * Break-glass env var. See `migrationDriftEnforcementOverride`.
 *
 * `MIGRATION_DRIFT_ENFORCE=false` — enforcement OFF: detection, logging and
 * Sentry reporting all continue, but nothing 503s. This is the documented
 * incident tool for the cases where blocking is worse than drifting:
 *
 *  - The deploy pipeline's `skip-migrate` break-glass (see
 *    `.github/workflows/deploy-dev.yml`, "proceed against the current,
 *    possibly stale schema") exists for a wedged database. With a startup
 *    probe on `/health`, a drifted revision never becomes Ready, so
 *    `skip-migrate` alone can no longer roll — an unrelated hotfix would be
 *    unshippable.
 *  - A multi-day drift window would otherwise halt EVERY job, including
 *    `settlements.*` and the payout crons. Money flows are usually worth more
 *    than the schema guarantee for the duration of an incident; that is an
 *    operator's call to make explicitly, not a decision this module should
 *    make for them.
 *
 * Before this existed the only escape was reverse-engineering
 * `PRISMA_MIGRATIONS_DIR=/nonexistent` to force the `migrations_dir_missing`
 * path — an undocumented trick that also blinds detection. This var never
 * blinds detection.
 *
 * `MIGRATION_DRIFT_ENFORCE=true` forces enforcement ON where it would
 * otherwise be off (e.g. rehearsing the guard locally before an incident).
 */
export const MIGRATION_DRIFT_ENFORCE_ENV = "MIGRATION_DRIFT_ENFORCE";

export type MigrationDriftEnforcementOverride = "forced_on" | "forced_off";

/**
 * Reads the explicit `MIGRATION_DRIFT_ENFORCE` override, or `null` for the
 * default automatic behaviour. Accepts `false`/`0`/`off` and `true`/`1`/`on`,
 * case-insensitively; anything else is ignored (a typo must not silently
 * disable the guard — it falls back to the automatic gate).
 */
export function migrationDriftEnforcementOverride(
  processEnv: Record<string, string | undefined> = process.env,
): MigrationDriftEnforcementOverride | null {
  const raw = processEnv[MIGRATION_DRIFT_ENFORCE_ENV]?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off") return "forced_off";
  if (raw === "true" || raw === "1" || raw === "on") return "forced_on";
  return null;
}

/**
 * Whether a confirmed drift should BLOCK (503) rather than only log+report.
 *
 * Blocking exists to stop Cloud Run promoting a revision onto a stale schema.
 * Anywhere else — a developer's laptop, a `pnpm dev` stack — the 503 buys
 * nothing and costs everything: `scripts/human-dev.cjs` accepts only 200-399
 * from each service's `/health` (`waitForApi`, 90s budget; `waitForJobs`, 60s)
 * and tears the whole stack down on timeout, discarding the 503 body that named
 * the missing migration. `seed:dev` does not apply migrations and runs after
 * that gate anyway, so there is no local self-heal.
 *
 * `K_SERVICE` is Cloud Run's auto-injected service name (same signal
 * `packages/adapters/src/infra/discord-alerts.ts` and `apps/jobs/src/app.ts`
 * use to detect Cloud Run); `NODE_ENV === "production"` is the repo-wide
 * "deployed" convention used by the apps' env modules and
 * `apps/api/src/plugins/origin-guard.ts`. Either one is enough — no new
 * environment convention is introduced.
 *
 * `MIGRATION_DRIFT_ENFORCE` (break-glass) wins over both.
 */
export function shouldBlockOnDrift(
  // Plain record rather than `NodeJS.ProcessEnv`: this module lives in a shared
  // package that should not depend on the NodeJS global namespace, and it makes
  // the function trivially callable with a literal in tests.
  processEnv: Record<string, string | undefined> = process.env,
): boolean {
  const override = migrationDriftEnforcementOverride(processEnv);
  if (override) return override === "forced_on";

  return (
    Boolean(processEnv.K_SERVICE) || processEnv.NODE_ENV === "production"
  );
}

/**
 * Rejects with `message` if `promise` has not settled within `ms`.
 *
 * The timer is deliberately left REF'd. `unref()` looks like the safer choice
 * ("a pending check must never hold the event loop open"), but that property is
 * already guaranteed by the `clearTimeout` in `finally`: the timer exists only
 * for the duration of a race that boot is already awaiting, so it can never
 * outlive the check or delay shutdown. Meanwhile `unref()` actively breaks the
 * guarantee this function exists to provide — it was observed doing so:
 *
 *   Warning: Detected unsettled top-level await at verify-health.tmp.mts:74
 *
 * With an unref'd timer and a promise that never settles, if nothing else holds
 * the loop open the timeout NEVER FIRES, `checkMigrationDrift` never resolves,
 * `createApp()` never returns and the process exits without listening — which
 * Cloud Run reports as "container failed to start and listen on PORT": exactly
 * the crash-loop-with-a-useless-message outcome this timeout was added to
 * prevent. A ref'd timer always fires, always lands in `query_failed`, and is
 * always cleared.
 *
 * `Promise.race` keeps a handler attached to `promise`, so a late rejection
 * from the losing side is still handled and cannot become an unhandled
 * rejection.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Postgres `undefined_table`. Raised when `_prisma_migrations` is absent. */
const PG_UNDEFINED_TABLE = "42P01";

/**
 * Recognises "the `_prisma_migrations` table does not exist" across the layers
 * this error can surface from. With the pg driver adapter a raw-query failure
 * can arrive as the raw `pg` error (`code: "42P01"`), or wrapped by Prisma
 * (`P2010` with the driver code in `meta`), so both the structured code and the
 * message text are checked.
 */
export function isMissingMigrationsTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
  };

  if (candidate.code === PG_UNDEFINED_TABLE) return true;
  if (candidate.meta?.code === PG_UNDEFINED_TABLE) return true;

  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (message.includes(PG_UNDEFINED_TABLE)) return true;

  return /relation ".*_prisma_migrations" does not exist/i.test(message);
}

/**
 * Compares the migrations shipped in the image against those the database has
 * finished applying. Pure orchestration — all I/O is injected so this is fully
 * unit-testable without a live database.
 */
export async function checkMigrationDrift(
  deps: MigrationDriftDeps,
): Promise<MigrationDriftResult> {
  const enforce = deps.enforce ?? shouldBlockOnDrift();
  // Only consult the env override when the caller did not pin `enforce`.
  const override =
    deps.enforce === undefined ? migrationDriftEnforcementOverride() : null;

  /** Best-effort Sentry report. Never lets a throwing reporter change flow. */
  const capture = (
    error: unknown,
    tags: Record<string, string | undefined>,
    extra: Record<string, unknown>,
  ): void => {
    try {
      deps.reportError?.(error, { tags, extra });
    } catch {
      // Reporting is always best-effort.
    }
  };

  // The break-glass must never be a QUIET mode. Announce it on every boot,
  // whether or not there is drift, at `error` + Sentry — an operator who
  // leaves `MIGRATION_DRIFT_ENFORCE=false` set after an incident has silently
  // removed the guard, and that has to be impossible to miss. Detection,
  // logging and reporting all continue below regardless.
  if (override === "forced_off") {
    const disabledError = new Error(
      `migration_drift_enforcement_disabled: ${MIGRATION_DRIFT_ENFORCE_ENV}=false ` +
        `is set, so confirmed migration drift will NOT block this service. ` +
        `Detection stays on. Unset it once the incident is over.`,
    );
    capture(
      disabledError,
      { check: "migration_drift", reason: "enforcement_disabled" },
      { env: MIGRATION_DRIFT_ENFORCE_ENV },
    );
    deps.logger.error("migration_drift_enforcement_disabled", {
      err: disabledError,
      env: MIGRATION_DRIFT_ENFORCE_ENV,
      hint: "Break-glass is active — drift will be detected and reported but will not 503. Unset once the incident is over.",
    });
  }

  const notify = (result: MigrationDriftResult): boolean =>
    deps.shouldNotify ? deps.shouldNotify(result) : true;

  const report = (
    error: unknown,
    reason: MigrationDriftUnknownReason,
  ): MigrationDriftResult => {
    const result: MigrationDriftResult = { status: "unknown", reason };
    if (!notify(result)) return result;

    // Deliberate swallow: we degrade to "healthy but undetermined" rather than
    // throwing, so this must be reported. Guarded so a throwing reporter can
    // never change the outcome (a reporter blowing up must not take down the
    // service the check exists to protect).
    capture(error, { check: "migration_drift", reason }, { reason });
    // `logger.error` (not `warn`) — warn is not captured by Sentry's pino
    // integration. `err` is the field the pino integration links a real
    // exception from (see instrument.ts), so pass the error under that key.
    deps.logger.error("migration_drift_check_indeterminate", {
      err: error,
      reason,
    });
    return result;
  };

  let expected: string[];
  try {
    expected = deps.listExpectedMigrations();
  } catch (error) {
    return report(error, "migrations_dir_missing");
  }

  let applied: string[];
  try {
    applied = await withTimeout(
      deps.listAppliedMigrations(),
      deps.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      "migration_drift_query_timeout: _prisma_migrations lookup did not " +
        "complete in time; skipping the drift check rather than hanging boot.",
    );
  } catch (error) {
    return report(
      error,
      isMissingMigrationsTableError(error)
        ? "migrations_table_missing"
        : "query_failed",
    );
  }

  const appliedSet = new Set(applied);
  const pending = expected.filter((name) => !appliedSet.has(name)).sort();

  if (pending.length > 0) {
    const driftResult: MigrationDriftResult = {
      status: "drift",
      pending,
      enforced: enforce,
    };
    if (!notify(driftResult)) return driftResult;

    // A real Error so this reaches Sentry as an issue with a stack, not just a
    // Cloud Logging line plus an opaque probe failure. The terminal state of
    // this feature — a container refusing to serve — has to be at least as
    // visible as the indeterminate case.
    const driftError = buildMigrationDriftError(pending);

    capture(
      driftError,
      {
        check: "migration_drift",
        reason: "drift",
        enforced: String(enforce),
        ...(override ? { enforcementOverride: override } : {}),
      },
      {
        pending,
        pendingCount: pending.length,
        enforced: enforce,
        enforcementOverride: override,
      },
    );

    // Always loud, in EVERY environment — a developer whose local database is
    // behind needs the migration names and the fix command even though
    // `/health` will keep returning 200 for them.
    deps.logger.error("migration_drift_detected", {
      err: driftError,
      pending,
      pendingCount: pending.length,
      expectedCount: expected.length,
      appliedCount: applied.length,
      enforced: enforce,
      enforcementOverride: override,
      hint:
        `Database is behind this build. Run \`${APPLY_MIGRATIONS_HINT}\`.` +
        (enforce
          ? " /health is returning 503 until it is applied."
          : override === "forced_off"
            ? ` NOT blocking: ${MIGRATION_DRIFT_ENFORCE_ENV}=false is set.`
            : ""),
    });

    return driftResult;
  }

  const okResult: MigrationDriftResult = { status: "ok" };
  if (!notify(okResult)) return okResult;

  deps.logger.info("migration_drift_check_ok", {
    expectedCount: expected.length,
    appliedCount: applied.length,
  });
  return okResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor — asymmetric caching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Time between re-queries while the verdict is not `ok`. 3 seconds.
 *
 * Chosen to sit strictly BELOW Cloud Run's startup-probe period
 * (`startup_probe_period_seconds = 5`,
 * infra/terraform/modules/cloud-run-service/variables.tf) so that EVERY probe
 * gets a freshly-computed answer. Matching 5s exactly would be a coin flip:
 * `now - lastCheckedAt` would land right on the boundary and jitter would
 * decide whether a probe re-queried or replayed the stale verdict — which is
 * the bug this whole mechanism exists to remove.
 *
 * The floor still matters: probes can arrive in bursts and several can be in
 * flight at once, so without it a drifted container would query per request.
 * Combined with single-flighting, the worst case is one small indexed read per
 * 3s per process, and only while the verdict is non-`ok`.
 */
export const DEFAULT_RECHECK_INTERVAL_MS = 3_000;

/**
 * Upper bound on a RE-query (as opposed to the boot query). 3 seconds.
 *
 * Deliberately much tighter than `DEFAULT_QUERY_TIMEOUT_MS` (25s), because the
 * two are bounding different things. The boot query may have to wake a
 * scale-to-zero Neon compute, and boot has the whole 150-240s startup budget to
 * play with. A re-query happens inside a live request whose caller is Cloud
 * Run's probe, and that probe gives up after `startup_probe_timeout_seconds = 3`
 * — waiting 25s to answer a request that was abandoned at 3s is pure waste.
 *
 * A re-query that times out is NOT dangerous here: it yields `unknown`, and the
 * monitor's merge rule refuses to let `unknown` weaken a previously-confirmed
 * `drift`. So a slow database can delay recovery but can never unblock a
 * genuinely drifted container.
 */
export const DEFAULT_RECHECK_TIMEOUT_MS = 3_000;

export type MigrationDriftMonitor = {
  /**
   * The verdict as of the last check, without querying. Useful for logging at
   * boot; request paths should use `get()`.
   */
  peek: () => MigrationDriftResult;
  /**
   * The current verdict, re-querying when the cached one is refreshable and the
   * re-check interval has elapsed. Single-flighted.
   */
  get: () => Promise<MigrationDriftResult>;
};

export type MigrationDriftMonitorDeps = MigrationDriftDeps & {
  /** Time between re-queries. Defaults to `DEFAULT_RECHECK_INTERVAL_MS`. */
  recheckIntervalMs?: number;
  /** Timeout for a re-query. Defaults to `DEFAULT_RECHECK_TIMEOUT_MS`. */
  recheckTimeoutMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/** Stable identity of a verdict, used to log/report on transitions only. */
function driftResultSignature(result: MigrationDriftResult): string {
  switch (result.status) {
    case "ok":
      return "ok";
    case "drift":
      return `drift:${result.enforced}:${result.pending.join(",")}`;
    case "unknown":
      return `unknown:${result.reason}`;
  }
}

/**
 * Merges a re-check into the cached verdict.
 *
 * The one rule that matters: **a confirmed `drift` is only ever cleared by a
 * definitive `ok`.** An `unknown` re-check (DB briefly unreachable, re-query
 * timed out) must NOT downgrade a known-drifted container to healthy — that
 * would turn a slow database into an unblock, which is precisely backwards.
 * `unknown` → `drift` is allowed, because that is new, stronger information.
 */
function mergeDriftResults(
  previous: MigrationDriftResult,
  next: MigrationDriftResult,
): MigrationDriftResult {
  if (next.status === "unknown" && previous.status === "drift") {
    return previous;
  }
  return next;
}

/**
 * Boot-time check plus asymmetric caching for the request path.
 *
 * WHY THIS EXISTS (prod deploy #583, revision `hf-prod-jobs-00003-4v9`):
 * `deploy-prod.yml` runs `terraform_apply` concurrently with `migrate_db` —
 * deliberately, because terraform provisions the Secret Manager entry that
 * `migrate_db` reads, so making terraform depend on it would deadlock. That
 * race meant terraform created the jobs revision while 16 migrations were still
 * being applied. The container booted, computed `drift` with 16 pending, and
 * CACHED it. Migrations finished at 2m16s, but `/health` never re-queried, so
 * all 48 startup probes replayed the same stale 503 until the budget expired
 * and the roll was skipped. The pipeline cannot be reordered, so the fix
 * belongs here.
 *
 * The caching is therefore asymmetric:
 *
 *  - `ok`   → cached PERMANENTLY. It is the overwhelmingly common case, it keeps
 *             `/health` free (no DB work on the hot path), and it is sound:
 *             migrations only move forward, so a schema that is current at boot
 *             cannot silently become stale.
 *  - `drift`→ re-queried. A container that booted into a transient mid-deploy
 *             window self-heals the instant migrations land, instead of burning
 *             its whole startup budget on a verdict that stopped being true.
 *  - `unknown` → re-queried. See the decision note below.
 *
 * `unknown` DECISION: re-query, do not cache permanently. `unknown` fails OPEN
 * (healthy + reported), so caching it for the life of the container means one
 * transient DB blip during boot silently disables the guard until the next
 * deploy — for a jobs revision that can be days. That is the same
 * "installed but inert" failure mode that made the 5s query timeout a bug, only
 * worse because it is unbounded in time rather than per-boot. Re-querying costs
 * at most one small read per interval, converges to the permanent `ok` cache as
 * soon as the database answers, and cannot make anything less safe: the merge
 * rule already prevents `unknown` from clearing a confirmed `drift`. The one
 * genuinely immutable `unknown` (`migrations_dir_missing` — the image's
 * filesystem cannot change) does re-run, but it fails in `listExpectedMigrations`
 * before any DB round-trip, so the cost is a failed `existsSync`; not worth a
 * special case and a branch to keep correct.
 *
 * Logging/reporting is gated on TRANSITIONS (`shouldNotify`), so a re-checking
 * container does not emit an identical error line and Sentry event every few
 * seconds — while a verdict that genuinely changes (drift clears, pending set
 * shrinks, DB starts failing) is still surfaced immediately.
 */
export async function createMigrationDriftMonitor(
  deps: MigrationDriftMonitorDeps,
): Promise<MigrationDriftMonitor> {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS;
  const recheckTimeoutMs = deps.recheckTimeoutMs ?? DEFAULT_RECHECK_TIMEOUT_MS;

  let lastNotifiedSignature: string | null = null;

  // The boot check notifies unconditionally and leaves `enforce` unset so the
  // `MIGRATION_DRIFT_ENFORCE` break-glass announcement fires exactly once.
  let cached = await checkMigrationDrift(deps);
  lastNotifiedSignature = driftResultSignature(cached);
  let lastCheckedAt = now();

  // Re-checks pin `enforce` to the value the env implies, so the break-glass
  // announcement is not repeated on every poll while the decision stays
  // identical to the boot check's.
  const enforceOnRecheck = deps.enforce ?? shouldBlockOnDrift();

  let inFlight: Promise<MigrationDriftResult> | null = null;

  const runCheck = async (): Promise<MigrationDriftResult> => {
    const fresh = await checkMigrationDrift({
      ...deps,
      enforce: enforceOnRecheck,
      queryTimeoutMs: recheckTimeoutMs,
      shouldNotify: (result) =>
        driftResultSignature(mergeDriftResults(cached, result)) !==
        lastNotifiedSignature,
    });

    cached = mergeDriftResults(cached, fresh);
    lastNotifiedSignature = driftResultSignature(cached);
    lastCheckedAt = now();
    return cached;
  };

  const get = async (): Promise<MigrationDriftResult> => {
    // `ok` is terminal — never query again.
    if (cached.status === "ok") return cached;

    // Single-flight: a burst of concurrent probes shares one query rather than
    // stampeding the database.
    if (inFlight) return inFlight;

    if (now() - lastCheckedAt < intervalMs) return cached;

    inFlight = runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return { peek: () => cached, get };
}

/**
 * A monitor with a fixed verdict and no database behind it. For tests and for
 * call sites that already hold a verdict.
 */
export function staticMigrationDriftMonitor(
  result: MigrationDriftResult,
): MigrationDriftMonitor {
  return { peek: () => result, get: async () => result };
}

/** Directory of this module — the fallback search root. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Locates the Prisma migrations directory for the running process. Two layouts
 * must work:
 *
 *  - container: both Dockerfiles copy `packages/db/prisma/migrations` into
 *    `<WORKDIR>/prisma/migrations`, and WORKDIR is `/app` for api and jobs.
 *  - repo checkout: `<repo>/packages/db/prisma/migrations`.
 *
 * Search roots are `process.cwd()` FIRST, then this module's directory, each
 * walked upward. `process.cwd()` leads because it is the one location that is
 * stable across both images: this file now lives in `@th/adapters`, so in a
 * `pnpm deploy` bundle its real path is somewhere under
 * `node_modules/@th/adapters/src/infra` (and Node resolves symlinks, so
 * `import.meta.url` could even point back into the pnpm store). Anchoring on
 * the WORKDIR sidesteps all of that; the module-dir walk remains as a fallback
 * for odd layouts (e.g. `dist/` builds run from a different cwd).
 *
 * `PRISMA_MIGRATIONS_DIR` overrides everything. Returns `null` when nothing is
 * found, which the caller turns into a `migrations_dir_missing` "unknown" — a
 * safe no-op, never a false alarm.
 */
export function resolveMigrationsDir(
  ...searchRoots: string[]
): string | null {
  const override = process.env.PRISMA_MIGRATIONS_DIR;
  if (override) {
    return existsSync(override) ? override : null;
  }

  const roots =
    searchRoots.length > 0 ? searchRoots : [process.cwd(), MODULE_DIR];

  for (const root of roots) {
    // Walk up from each root looking for either layout. Bounded so a weird
    // deployment can't turn this into an unbounded filesystem scan.
    let dir = root;
    for (let depth = 0; depth < 10; depth += 1) {
      for (const relative of [
        "prisma/migrations",
        "packages/db/prisma/migrations",
      ]) {
        const candidate = resolve(dir, relative);
        if (existsSync(candidate)) return candidate;
      }

      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

/**
 * Reads the migration directory names shipped with this image. Throws when the
 * directory is missing so the caller classifies it as "could not determine"
 * rather than as an empty expected-set (which would silently pass forever).
 *
 * A subdirectory only counts as a migration when it actually contains a
 * `migration.sql` — the same file `prisma migrate deploy` requires. Without
 * that check a stray directory (an editor temp dir, an aborted `migrate dev`
 * scaffold) would become permanently "pending": `migrate deploy` would never
 * apply it, so it could never clear, and the service would 503 forever. Other
 * files inside a migration directory (e.g. the `down.sql` next to
 * `20260512_search_documents/migration.sql`) are correctly ignored.
 */
export function readExpectedMigrations(dir: string | null): string[] {
  if (!dir) {
    throw new Error(
      "prisma_migrations_dir_not_found: could not locate the migrations " +
        "directory shipped with this image (set PRISMA_MIGRATIONS_DIR to " +
        "point at it). Migration-drift checking is disabled.",
    );
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(dir, name, "migration.sql")));
}

type AppliedMigrationRow = { migration_name: string };

/** Minimal shape of the Prisma client this check needs. */
export type MigrationQueryClient = {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

/**
 * Reads APPLIED migrations from Prisma's own bookkeeping table.
 *
 * `finished_at IS NOT NULL` is the applied condition — a row with a null
 * `finished_at` is a migration that started and never completed, which must
 * count as PENDING (that is exactly the half-migrated state this guard exists
 * to catch).
 *
 * `rolled_back_at IS NULL` is defence against a hand-`prisma migrate resolve
 * --rolled-back` row: `migrate resolve` can leave `finished_at` set on a
 * migration that was subsequently marked rolled back, and whose SQL is
 * therefore NOT in the database. Treating that as applied would make the guard
 * miss the one thing it is looking for.
 */
export async function readAppliedMigrations(
  prisma: MigrationQueryClient,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<AppliedMigrationRow[]>`
    SELECT migration_name
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL
      AND rolled_back_at IS NULL
  `;

  return rows.map((row) => row.migration_name);
}
