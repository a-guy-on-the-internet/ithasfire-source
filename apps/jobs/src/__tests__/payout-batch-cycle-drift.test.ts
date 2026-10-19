import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PAYOUT_BATCH_CRON_SOURCE,
  PAYOUT_BATCH_JOB_NAME,
  PAYOUT_BATCH_TIMEZONE,
} from "@th/core/use-cases/payouts/_shared/payout-batch-cycle";

import manifestJson from "../../jobs.manifest.json";
import { readSchedulerOverrides } from "../scripts/scheduler-overrides";

/**
 * The test-suite half of `validate-manifest.ts` §6. That script is top-level
 * code that calls `process.exit`, so nothing imports it and no test run ever
 * exercises it; it only runs as the pre-commit hook and the deploy workflows'
 * `manifest_drift_guard`. These assertions put the same three facts in the
 * suite, so drift also fails wherever `apps/jobs` tests run.
 *
 * Why the facts matter: `getOrgPayoutOverview.payoutOverdue` measures "how
 * long has this money waited" against `PAYOUT_BATCH_CYCLE_MS`, which was
 * derived from ONE schedule. If the batch runs on any other one, the verdict
 * tells organisers an on-schedule payout is overdue.
 *
 * Every value comes from its real source (the manifest JSON, the core module,
 * the committed tfvars). None is retyped here, so this file cannot become a
 * fourth copy of the schedule.
 */

const ENVS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/terraform/envs",
);

const manifest = manifestJson as {
  scheduled: Record<string, { cron?: string; timezone?: string }>;
};

describe(`${PAYOUT_BATCH_JOB_NAME} runs on the schedule the payout-overdue cycle assumes`, () => {
  it("the manifest's cron is PAYOUT_BATCH_CRON_SOURCE", () => {
    expect(manifest.scheduled[PAYOUT_BATCH_JOB_NAME]?.cron).toBe(
      PAYOUT_BATCH_CRON_SOURCE,
    );
  });

  it("the manifest's timezone is PAYOUT_BATCH_TIMEZONE", () => {
    expect(manifest.scheduled[PAYOUT_BATCH_JOB_NAME]?.timezone).toBe(
      PAYOUT_BATCH_TIMEZONE,
    );
  });

  it("no environment overrides it — Terraform would deploy the override instead", () => {
    const envs = fs
      .readdirSync(ENVS_DIR)
      .filter((env) =>
        fs.existsSync(path.join(ENVS_DIR, env, `${env}.tfvars`)),
      );
    // Guard against a vacuous pass: a moved directory would otherwise read
    // as "no environment overrides anything".
    expect(envs).toContain("prod");

    const overriding = envs.filter((env) =>
      readSchedulerOverrides(
        fs.readFileSync(path.join(ENVS_DIR, env, `${env}.tfvars`), "utf-8"),
      ).has(PAYOUT_BATCH_JOB_NAME),
    );
    expect(overriding).toEqual([]);
  });
});

