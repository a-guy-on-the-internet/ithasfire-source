/**
 * Job Registry
 *
 * Central place that collects all jobs — as METADATA. Handlers are loaded on
 * demand, one module at a time, when a job is actually dispatched.
 *
 * Adding a job:
 *   1. define it in its module (or add a new module to `./modules.ts`)
 *   2. add its manifest entry (`apps/jobs/jobs.manifest.json`)
 *   3. run `pnpm -C apps/jobs generate:registry`
 *
 * Nothing in this file imports a job module, and nothing that imports this
 * file gets one for free. See `./registry.ts` for why that matters.
 */
import { isScheduledTask } from "../lib/define-job";
import { createJobHandle, type JobHandle } from "./registry";
import { REGISTERED_JOBS } from "./registry.generated";

// ─────────────────────────────────────────────────────────────────────────────
// All jobs in one flat array — metadata only, in manifest/endpoint order
// ─────────────────────────────────────────────────────────────────────────────
export const allJobs: readonly JobHandle[] =
  REGISTERED_JOBS.map(createJobHandle);

// ─────────────────────────────────────────────────────────────────────────────
// Lookup maps
// ─────────────────────────────────────────────────────────────────────────────
export const jobsByName = new Map(allJobs.map((job) => [job.name, job]));

/**
 * DEAD CODE, carried forward deliberately rather than silently.
 *
 * Zero consumers repo-wide (`grep -r scheduledTasks apps packages infra` finds
 * only this line). Cloud Scheduler is minted from `jobs.manifest.json` by
 * `infra/terraform/generated-jobs.tf`, not from this array — so nothing about
 * scheduling depends on it. It is kept because the metadata refactor should
 * not also delete an export, which would be a second, unrelated change riding
 * along; it costs one filter over 49 objects at boot. Delete it in a cleanup
 * pass, not here.
 */
export const scheduledTasks = allJobs.filter(isScheduledTask);

// ─────────────────────────────────────────────────────────────────────────────
// Helper to get a job by name
// ─────────────────────────────────────────────────────────────────────────────
export function getJob(name: string): JobHandle | undefined {
  return jobsByName.get(name);
}

export type { JobHandle } from "./registry";
