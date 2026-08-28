/**
 * Jobs Manifest
 *
 * Typed access to jobs.manifest.json — the single source of truth for
 * job infrastructure (cron schedules, Pub/Sub topics).
 *
 * Terraform reads the same JSON file directly via jsondecode(file(...)).
 */
import manifestJson from "../../jobs.manifest.json";

export interface ScheduleEntry {
  cron: string;
  timezone: string;
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
  return { cron: entry.cron, timezone: entry.timezone };
}
