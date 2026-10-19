/**
 * Jobs Manifest
 *
 * Typed access to jobs.manifest.json — the single source of truth for
 * job infrastructure (cron schedules, Pub/Sub topics).
 *
 * Terraform reads the same JSON file directly via jsondecode(file(...)).
 * Some fields are Terraform-only and deliberately absent from ScheduleEntry
 * (`attemptDeadline`, `triggerTopic`, `payload`, `retry`); the full key list
 * and its checks live in `scripts/scheduled-entry-fields.ts`.
 */
import manifestJson from "../../jobs.manifest.json";

export interface ScheduleEntry {
  cron: string;
  timezone: string;
  /**
   * Manifest-level default for the Cloud Scheduler job. Absent means ON.
   * Distinct from the RUNTIME pause staff set from /platform/jobs, which the
   * run tracker holds and `GET /jobs/status` reports as the top-level
   * `enabled` — this one is `schedule.enabled` in that payload.
   */
  enabled?: boolean;
}

/**
 * Get the schedule config for a scheduled task.
 * Throws at startup if the job name isn't in the manifest.
 */
export function getSchedule(jobName: string): ScheduleEntry {
  const entry = (
    manifestJson.scheduled as Record<string, ScheduleEntry | undefined>
  )[jobName];
  if (!entry) {
    throw new Error(
      `Job "${jobName}" is not in jobs.manifest.json — add it before defining the handler.`,
    );
  }
  // `enabled` is spread in ONLY when the manifest sets it, so entries without
  // the key produce a `schedule` object byte-identical to what
  // `registry.generated.ts` carries — the registry drift test compares them by
  // deep equality, and an `enabled: undefined` key would fail it.
  return {
    cron: entry.cron,
    timezone: entry.timezone,
    ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
  };
}
