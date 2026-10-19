import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_BAND_MS } from "@th/core/use-cases/volunteering/send-volunteer-shift-reminders";

import {
  volunteersReminders1h,
  volunteersReminders24h,
} from "../jobs/volunteers";
import { nextCronRun } from "../lib/cron-schedule";
import { readSchedulerOverrides } from "../scripts/scheduler-overrides";

/**
 * Each volunteer reminder window (DEFAULT_BAND_MS in core) must be wider than
 * the longest gap between two runs of its job, or a shift that starts
 * between ticks is in no window and its reminder is silently lost. Core sizes
 * the windows; the manifest owns the cron. Nothing else ties the two, so this
 * reads the cron the job ACTUALLY carries (the generated registry, from the
 * manifest) and checks it against the window.
 *
 * An env override would replace that cron in Terraform without touching
 * either file, so no env may override these jobs (validate-manifest §9
 * refuses one too; this checks the tfvars it reads).
 */

const ENVS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/terraform/envs",
);

/** Lateness a tick must be able to absorb without dropping a shift. */
const SCHEDULER_JITTER_MS = 60_000;

function longestGapMs(cron: string, timezone: string | undefined): number {
  let at = new Date("2026-10-08T00:00:00.000Z");
  let longest = 0;
  // Two days of runs for anything sub-hourly; enough to see every gap.
  for (let i = 0; i < 200; i += 1) {
    const next = nextCronRun(cron, timezone, at);
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    if (i > 0) longest = Math.max(longest, nextDate.getTime() - at.getTime());
    at = nextDate;
  }
  return longest;
}

const CASES = [
  ["REMINDER_24H", volunteersReminders24h],
  ["REMINDER_1H", volunteersReminders1h],
] as const;

describe("volunteer reminder windows cover their real cron", () => {
  it.each(CASES)(
    "%s: window width >= the longest gap between two runs of the manifest cron",
    (kind, job) => {
      const schedule = (
        job as unknown as { schedule?: { cron: string; timezone?: string } }
      ).schedule;
      expect(schedule?.cron).toBeTruthy();
      const gap = longestGapMs(schedule!.cron, schedule!.timezone);
      const width = 2 * DEFAULT_BAND_MS[kind].halfWidthMs;
      expect(gap).toBeGreaterThan(0);
      // Strictly wider, by at least a minute: a window exactly as wide as the
      // gap has zero overlap, so a tick that fires a few seconds late (Cloud
      // Scheduler jitter, a cold start) skips the shifts that start in those
      // seconds. That is how the old 24h window (±15m on a */30 tick) failed.
      expect(width).toBeGreaterThanOrEqual(gap + SCHEDULER_JITTER_MS);
    },
  );

  it("no environment overrides either reminder job's schedule", () => {
    const envs = fs
      .readdirSync(ENVS_DIR)
      .filter((env) =>
        fs.existsSync(path.join(ENVS_DIR, env, `${env}.tfvars`)),
      );
    // Guard the guard: an empty list would make the loop below vacuous.
    expect(envs).toContain("prod");
    for (const env of envs) {
      const overrides = readSchedulerOverrides(
        fs.readFileSync(path.join(ENVS_DIR, env, `${env}.tfvars`), "utf-8"),
      );
      expect(overrides.has("volunteers.reminders-24h")).toBe(false);
      expect(overrides.has("volunteers.reminders-1h")).toBe(false);
    }
  });
});
