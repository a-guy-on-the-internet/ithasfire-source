/**
 * Job Registry — metadata eagerly, handlers lazily.
 *
 * Every job is split in two:
 *
 *   - METADATA (name, description, notify, schedule) lives in
 *     `registry.generated.ts` as plain data and is loaded at boot. It is all
 *     `GET /jobs`, `GET /jobs/status` and the Cloud Scheduler wiring ever read.
 *   - The HANDLER (and its input schema) stays in its own job module and is
 *     imported on first dispatch, through `JOB_MODULE_LOADERS`.
 *
 * The old registry imported all 25 job modules to build one array, so booting
 * the dispatcher pulled every use case, adapter, the Prisma client and the
 * Stripe SDK into memory — ~167 MB of retained module graph against a Node
 * old-space of ~256 MB on a 512 MiB container, which is how the dev service
 * OOMed at boot (revision hf-dev-jobs-00027-f8h, Mark-Compact pinned at
 * 249.3 MB, exit 134).
 *
 * A job's module is loaded ONCE and cached; a module that fails to import
 * fails only THAT job's invocation, with a typed `JOB_MODULE_LOAD_FAILED`.
 * The registry itself cannot be taken down by a broken handler, because it
 * never imports one.
 */
import { AppError } from "@th/errors";

import type { AnyJobDefinition, JobMetadata } from "../lib/define-job";
import { JOB_MODULE_LOADERS, type JobModuleId } from "./modules";

/** One row of the eager metadata table in `registry.generated.ts`. */
export interface RegisteredJob extends JobMetadata {
  /** Which module defines this job's handler. */
  module: JobModuleId;
}

/**
 * What `getJob(name)` hands back: the eager metadata, plus the door to the
 * handler. Callers that only render or schedule a job never open it.
 */
export interface JobHandle extends RegisteredJob {
  /**
   * Import the owning module and return the real definition (input schema +
   * handler). Memoized — a job invoked on a 5-minute cron imports once per
   * process, not once per tick.
   *
   * @throws {AppError} `JOB_MODULE_LOAD_FAILED` when the module cannot be
   * imported, or imports but no longer defines this job.
   */
  load: () => Promise<AnyJobDefinition>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module id → in-flight-or-resolved import. Keyed by MODULE, not by job, so
 * two jobs in the same file share one import.
 *
 * Rejections are evicted rather than cached: a module that failed to load once
 * (a transient resolution failure, a dependency that was not ready) gets a
 * fresh attempt on the next invocation instead of a poisoned entry that
 * outlives the cause.
 *
 * The other half of that decision lives in `app.ts`: because the retry is
 * unbounded and most import failures are PERMANENT, the Sentry capture for
 * `JOB_MODULE_LOAD_FAILED` is latched once per module per process
 * (`reportedModuleLoadFailures`). Retry forever, report once — cron keeps
 * probing for recovery without filing an issue per tick.
 */
const moduleCache = new Map<JobModuleId, Promise<readonly AnyJobDefinition[]>>();

/**
 * Bumped by {@link resetJobRegistryCaches}. Handles memoize their resolved
 * definition independently of `moduleCache`, so clearing the map alone would
 * leave every existing handle still holding its old promise — a reset that
 * only appears to work because the test around it also reset the module
 * graph. Handles compare the generation they resolved at against this value
 * and re-resolve when it has moved.
 */
let cacheGeneration = 0;

function loadModule(
  module: JobModuleId,
): Promise<readonly AnyJobDefinition[]> {
  const cached = moduleCache.get(module);
  if (cached) return cached;

  const pending = JOB_MODULE_LOADERS[module]().catch((cause: unknown) => {
    moduleCache.delete(module);
    throw cause;
  });
  moduleCache.set(module, pending);
  return pending;
}

/**
 * Test seam: drop every cached module AND invalidate every handle's memoized
 * definition, so a spy can observe a genuinely fresh import.
 */
export function resetJobRegistryCaches(): void {
  moduleCache.clear();
  cacheGeneration += 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handles
// ─────────────────────────────────────────────────────────────────────────────

async function resolveDefinition(
  entry: RegisteredJob,
): Promise<AnyJobDefinition> {
  let definitions: readonly AnyJobDefinition[];
  try {
    definitions = await loadModule(entry.module);
  } catch (cause) {
    throw new AppError("JOB_MODULE_LOAD_FAILED", {
      message: `Job "${entry.name}" could not run: its handler module "${entry.module}" failed to import.`,
      meta: { job: entry.name, module: entry.module },
      cause,
    });
  }

  const definition = definitions.find((job) => job.name === entry.name);
  if (!definition) {
    // The generated table and the module disagree. The drift test catches this
    // in CI; this is the runtime backstop, and it must not be silent.
    throw new AppError("JOB_MODULE_LOAD_FAILED", {
      message: `Job "${entry.name}" is registered against module "${entry.module}", which no longer defines it. Run \`pnpm -C apps/jobs generate:registry\`.`,
      meta: { job: entry.name, module: entry.module },
    });
  }

  return definition;
}

/** Wrap one generated metadata row in a handle with a memoized `load()`. */
export function createJobHandle(entry: RegisteredJob): JobHandle {
  let resolved: Promise<AnyJobDefinition> | undefined;
  let resolvedAt = -1;

  return {
    ...entry,
    load: () => {
      if (!resolved || resolvedAt !== cacheGeneration) {
        resolvedAt = cacheGeneration;
        resolved = resolveDefinition(entry).catch((err: unknown) => {
          // Not cached: an import failure is retried on the next invocation
          // rather than poisoning this handle for the life of the process.
          // (The SENTRY report for a repeating failure is latched separately,
          // per module, in app.ts — see `reportedModuleLoadFailures`.)
          resolved = undefined;
          throw err;
        });
      }
      return resolved;
    },
  };
}
