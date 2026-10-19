import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readSchedulerOverrides } from "../scripts/scheduler-overrides";

/**
 * The Terraform override drift gate is only as good as this reader. Each
 * case below is a shape the previous regex-based reader got WRONG against
 * real or realistic tfvars — silently green on a missed override, or loudly
 * wrong on a comment — plus the committed env files as a fixture that the
 * manifest's `schedulerOverriddenIn` declarations are checked against.
 */

const ENVS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/terraform/envs",
);

function readEnv(env: string): string {
  return fs.readFileSync(path.join(ENVS_DIR, env, `${env}.tfvars`), "utf-8");
}

const PROD_BLOCK = `
jobs_scheduler_overrides = {
  "community.dispatch-rsvp-confirmations" = { cron = "*/5 * * * *" }
}
`;

describe("readSchedulerOverrides", () => {
  it("reads exactly the overrides the committed env files declare", () => {
    // Four in prod, one in dev — the set jobs.manifest.json's
    // `schedulerOverriddenIn` entries acknowledge. If this fails, either an
    // override was added without its declaration (the gate's job) or the
    // reader regressed (this test's job); `validate:manifest` tells which.
    // (The three outbox drains and the cart/hold reapers dropped their prod
    // overrides on 2026-09-30: the drains are write-triggered, and the reaper
    // cadence now lives in the manifest only.)
    expect([...readSchedulerOverrides(readEnv("prod"))].sort()).toEqual(
      [
        "events.address-reveal-notify",
        "places.recalculate-place-stats",
        "push.drain-receipts",
        "storage.drain-pending-deletions",
      ].sort(),
    );
    expect([...readSchedulerOverrides(readEnv("dev"))]).toEqual([
      "stripe-connect.reconcile-capabilities",
    ]);
  });

  it("sees an override whose cron follows a nested block", () => {
    // `labels = {…}` is NOT valid for Terraform's variable type (its object
    // has only cron / timezone / enabled / payload). Kept as a defensive case:
    // the reader must not depend on the type for correctness.
    const tfvars = `
jobs_scheduler_overrides = {
  "settlements.run-batch" = {
    labels = { team = "money" }
    cron = "0 3 * * *"
  }
}
`;
    expect([...readSchedulerOverrides(tfvars)]).toEqual([
      "settlements.run-batch",
    ]);
  });

  it("accepts HCL colon syntax for the entry", () => {
    const tfvars = `
jobs_scheduler_overrides = {
  "settlements.run-batch" : { cron = "0 3 * * *" }
}
`;
    expect([...readSchedulerOverrides(tfvars)]).toEqual([
      "settlements.run-batch",
    ]);
  });

  it("ignores a commented-out entry", () => {
    const tfvars = `
jobs_scheduler_overrides = {
  # "settlements.run-batch" = { cron = "0 3 * * *" }
  "push.drain-receipts" = { cron = "0 * * * *" }
}
`;
    expect([...readSchedulerOverrides(tfvars)]).toEqual([
      "push.drain-receipts",
    ]);
  });

  it("is not anchored by a # comment that mentions the variable above another map", () => {
    const tfvars = `
# See jobs_scheduler_overrides below for per-job cron changes.
audio_transcoder_env = {
  NODE_ENV = "production"
}
${PROD_BLOCK}
`;
    expect([...readSchedulerOverrides(tfvars)]).toEqual([
      "community.dispatch-rsvp-confirmations",
    ]);
  });

  it("returns nothing when the only mention is in a comment", () => {
    const tfvars = `
# jobs_scheduler_overrides is intentionally unset here.
audio_transcoder_env = {
  NODE_ENV = "production"
}
`;
    expect(readSchedulerOverrides(tfvars).size).toBe(0);
  });

  it("strips // line comments and /* */ block comments", () => {
    const tfvars = `
jobs_scheduler_overrides = {
  // "tickets.release-expired-holds" = { cron = "*/15 * * * *" }
  /* "tickets.release-expired-carts" = {
       cron = "0 3 * * *"
     } */
  "push.drain-receipts" = { cron = "0 * * * *" } // hourly
}
`;
    expect([...readSchedulerOverrides(tfvars)]).toEqual([
      "push.drain-receipts",
    ]);
  });

  it("does not let a } inside a string value end the block early", () => {
    const tfvars = `
jobs_scheduler_overrides = {
  "push.drain-receipts" = {
    payload = { note = "closes } here # and this is not a comment" }
    cron    = "0 * * * *"
  }
  "storage.drain-pending-deletions" = { cron = "0 * * * *" }
}
`;
    expect([...readSchedulerOverrides(tfvars)].sort()).toEqual([
      "push.drain-receipts",
      "storage.drain-pending-deletions",
    ]);
  });

  it("does not count a payload-only entry as a schedule override", () => {
    // `payload` is `optional(string)` in the variable type, so the valid form
    // is a JSON string. The first entry is that form; the other two use a
    // nested map the type rejects, kept as defensive cases.
    const tfvars = `
jobs_scheduler_overrides = {
  "analytics.event-daily-stats" = { payload = "{\\"limit\\":500}" }
  "push.drain-receipts" = { payload = { limit = 500 } }
  "storage.drain-pending-deletions" = { payload = { note = "cron = fake" } }
}
`;
    expect(readSchedulerOverrides(tfvars).size).toBe(0);
  });

  it("throws on an unbalanced override block instead of passing", () => {
    const tfvars = `
jobs_scheduler_overrides = {
  "settlements.run-batch" = { cron = "0 3 * * *"
`;
    // Reported by LINE of the original file — the `{` that never closes is
    // the block's own, on line 2 (line 1 is the leading newline).
    expect(() => readSchedulerOverrides(tfvars)).toThrow(
      /unbalanced `\{` opened on line 2/,
    );
  });

  it("reports an unterminated string literal by line", () => {
    const tfvars = `api_cpu = "1"
jobs_scheduler_overrides = {
  "settlements.run-batch" = { cron = "0 3 * * *
}
`;
    expect(() => readSchedulerOverrides(tfvars)).toThrow(
      /unterminated string literal opened on line 3/,
    );
  });

  it("throws when the variable is referenced but never assigned as a block", () => {
    const tfvars = `
locals_like = jobs_scheduler_overrides
`;
    expect(() => readSchedulerOverrides(tfvars)).toThrow(
      /no line-anchored/,
    );
  });

  it("returns an empty set for a file without the variable", () => {
    expect(readSchedulerOverrides(`api_cpu = "1"\n`).size).toBe(0);
    expect(readSchedulerOverrides("").size).toBe(0);
  });

  it("treats heredoc bodies as opaque", () => {
    const tfvars = `
banner = <<EOT
jobs_scheduler_overrides = { "settlements.run-batch" = { cron = "x" } }
EOT
${PROD_BLOCK}
`;
    expect([...readSchedulerOverrides(tfvars)]).toEqual([
      "community.dispatch-rsvp-confirmations",
    ]);
  });
});
