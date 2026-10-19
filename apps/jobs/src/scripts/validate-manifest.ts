/**
 * Validate Jobs Manifest
 *
 * Ensures jobs.manifest.json stays in sync with handler code.
 * Checks:
 *   1. Every defineScheduledTask handler has a manifest.scheduled entry
 *   2. Every defineJob handler has a manifest.queue entry
 *   3. Every manifest entry (except noHandler:true) has a handler
 *   4. Every scheduled entry's description, cron and timezone are ones Cloud
 *      Scheduler will accept — those are validated at CREATE time only, so
 *      without this they fail mid-`terraform apply` and block the code roll
 *   5. Terraform per-environment schedule overrides are declared in the entry
 *   6. `settlements.run-batch` still runs on the schedule that @th/core's
 *      payout-cycle constant was derived from
 *   7. Every write-triggered drain's `triggerTopic` matches DRAIN_TRIGGERS in
 *      @th/ports/job-trigger (what the API/jobs processes publish to); queue
 *      entries' `triggerTopic`s are well-formed, have handlers, and no topic
 *      name repeats; every `hf-trigger-*` literal in .github/workflows is one
 *      the manifest declares
 *   8. `tickets.release-expired-carts` still runs on the schedule @th/core's
 *      capacity window was derived from, and no env overrides it
 *   Also: every scheduled entry uses only known keys, and `retry` is a
 *   boolean when present (scheduled-entry-fields.ts)
 *
 * Usage: pnpm -C apps/jobs validate:manifest
 * Also runs as a pre-commit hook.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// THE DEPENDENCY ARROW IS THE POINT. `packages/core` cannot import from
// `apps/jobs`, so a core read model that needs to know how often the payout
// batch runs has to record it as a constant. This script CAN import core, so
// the recorded value gets checked against the manifest here — the one place
// where both sources of truth are reachable at once. (It is a leaf module with
// no imports of its own, deliberately: a gate must not be able to fail because
// a business rule's transitive import blew up.)
import {
  PAYOUT_BATCH_CRON_SOURCE,
  PAYOUT_BATCH_JOB_NAME,
  PAYOUT_BATCH_TIMEZONE,
} from "@th/core/use-cases/payouts/_shared/payout-batch-cycle";

import {
  CART_REAPER_CRON_SOURCE,
  CART_REAPER_JOB_NAME,
} from "@th/core/use-cases/orders/_shared/cart-reaper-cycle";
import { DRAIN_TRIGGERS } from "@th/ports/job-trigger";

import { checkScheduledEntryFields } from "./scheduled-entry-fields";
import { readSchedulerOverrides } from "./scheduler-overrides";

/** For the failure message — the file an engineer has to open. */
const PAYOUT_BATCH_CYCLE_MODULE =
  "packages/core/src/use-cases/payouts/_shared/payout-batch-cycle.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, "../../jobs.manifest.json");
const JOBS_DIR = path.resolve(__dirname, "../jobs");
const WORKFLOWS_DIR = path.resolve(__dirname, "../../../../.github/workflows");

// ── Read manifest ──────────────────────────────────────────────────────────

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as {
  scheduled: Record<
    string,
    {
      noHandler?: boolean;
      description?: string;
      cron?: string;
      timezone?: string;
      /**
       * Environments whose tfvars override this job's cron / timezone /
       * enabled. Declaring it acknowledges that `GET /jobs/status` — and so
       * `/platform/jobs` and the `/platform/settlements` payout clock — reports
       * the MANIFEST value, which is not what runs there. Checked both ways by
       * the drift gate below.
       */
      schedulerOverriddenIn?: string[];
      /**
       * Pub/Sub topic suffix that wakes this job after a committed outbox
       * write (Terraform creates `<env>-<topic>` + a push subscription to
       * `POST /jobs/<name>`). Must match DRAIN_TRIGGERS — checked in §7.
       */
      triggerTopic?: string;
      /**
       * Cloud Scheduler HTTP attempt deadline, e.g. "300s" (generated-jobs.tf
       * passes it through; absent = the 180s default). Checked in §4.
       */
      attemptDeadline?: string;
      /** JSON body Cloud Scheduler sends (generated-jobs.tf default "{}"). */
      payload?: string;
      /**
       * Cloud Scheduler retry_config on/off (generated-jobs.tf; absent =
       * true). `false` on jobs unsafe as two concurrent copies. Checked in
       * scheduled-entry-fields.ts.
       */
      retry?: boolean;
    }
  >;
  queue: Record<string, unknown>;
  legacy: Record<string, unknown>;
};

/**
 * Cloud Scheduler caps `description` at 499 characters — the API rejects a
 * longer one with `Error 400: ... must match the RE2 regular expression
 * "^.{1,499}$"`. `generated-jobs.tf` wires each scheduled entry's description
 * straight onto `google_cloud_scheduler_job`, so the manifest is the only
 * place this can be caught before Terraform is mid-apply.
 *
 * It is worth catching here because of WHERE it surfaces otherwise. Nothing
 * about a long string fails a build, a test or a plan; the field is only
 * validated when the job is CREATED, which means the first environment to
 * apply it fails, `Deploy prod (roll Cloud Run)` is skipped for a `needs`
 * failure, and prod does not roll at all. That is exactly how a 527-character
 * description on `stripe-connect.reconcile-capabilities` blocked a prod deploy
 * on 2026-08-08 while every build, migration and image promotion was green.
 *
 * Only `scheduled` descriptions are checked: queue descriptions are read into
 * a Terraform local but never land on a resource field (Pub/Sub topics and
 * subscriptions here carry labels, not descriptions), so they are documentation
 * and have no limit to violate.
 */
const SCHEDULER_DESCRIPTION_MAX = 499;

const manifestScheduled = new Set(Object.keys(manifest.scheduled));
const manifestQueue = new Set(Object.keys(manifest.queue));

// ── Scan handler source files ──────────────────────────────────────────────

const codeScheduled = new Set<string>();
const codeQueue = new Set<string>();

const jobFiles = fs
  .readdirSync(JOBS_DIR)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts");

for (const file of jobFiles) {
  const source = fs.readFileSync(path.join(JOBS_DIR, file), "utf-8");

  // Match defineScheduledTask calls and extract job names
  for (const m of source.matchAll(
    /defineScheduledTask\(\{[\s\S]*?name:\s*"([^"]+)"/g,
  )) {
    codeScheduled.add(m[1]!);
  }

  // Match defineJob calls (not defineScheduledTask) and extract job names
  for (const m of source.matchAll(/defineJob\(\{[\s\S]*?name:\s*"([^"]+)"/g)) {
    codeQueue.add(m[1]!);
  }
}

// ── Compare ────────────────────────────────────────────────────────────────

const errors: string[] = [];

// Handlers without manifest entries
for (const name of codeScheduled) {
  if (!manifestScheduled.has(name)) {
    errors.push(
      `Handler "${name}" (scheduled) has no entry in jobs.manifest.json`,
    );
  }
}
for (const name of codeQueue) {
  if (!manifestQueue.has(name)) {
    errors.push(`Handler "${name}" (queue) has no entry in jobs.manifest.json`);
  }
}

// Manifest entries without handlers (skip noHandler: true)
for (const name of manifestScheduled) {
  if (
    !codeScheduled.has(name) &&
    !(manifest.scheduled[name] as { noHandler?: boolean })?.noHandler
  ) {
    errors.push(
      `Manifest scheduled entry "${name}" has no handler (add noHandler:true if intentional)`,
    );
  }
}
for (const name of manifestQueue) {
  if (
    !codeQueue.has(name) &&
    !(manifest.queue[name] as { noHandler?: boolean })?.noHandler
  ) {
    errors.push(
      `Manifest queue entry "${name}" has no handler (add noHandler:true if intentional)`,
    );
  }
}

// ── Fields Cloud Scheduler only validates at CREATE time ───────────────────
//
// Everything below is a value this repo authors and Google validates, with no
// gate in between: it survives lint, typecheck, every test and `terraform
// plan`, and is first rejected while `terraform apply` is running against a
// real environment. Because the deploy workflows gate the code roll on that
// apply, a bad value here does not degrade a deploy — it stops it, after the
// images are already built and pushed.
for (const name of manifestScheduled) {
  const entry = manifest.scheduled[name];
  errors.push(...checkScheduledEntryFields(name, entry));
  if (!entry || entry.noHandler) continue;

  const description = entry.description ?? "";
  if (description.length > SCHEDULER_DESCRIPTION_MAX) {
    errors.push(
      `Manifest scheduled entry "${name}" has a ${description.length}-character ` +
        `description; Cloud Scheduler rejects anything over ${SCHEDULER_DESCRIPTION_MAX} ` +
        `(trim ${description.length - SCHEDULER_DESCRIPTION_MAX} characters)`,
    );
  }

  // Deliberately a shape check, not a cron parser. The realistic mistake is a
  // dropped or duplicated field, and a strict hand-rolled parser that rejects
  // valid syntax (ranges, steps, lists, names) would be worse than no check at
  // all — a gate that fails on correct input gets disabled, and then guards
  // nothing.
  const cron = entry.cron ?? "";
  const fields = cron.trim().split(/\s+/);
  if (!cron || fields.length !== 5) {
    errors.push(
      `Manifest scheduled entry "${name}" has cron "${cron}" — expected 5 ` +
        `whitespace-separated fields (minute hour day-of-month month day-of-week), got ${cron ? fields.length : 0}`,
    );
  } else if (!fields.every((f) => /^[0-9A-Za-z*,/#?-]+$/.test(f))) {
    errors.push(
      `Manifest scheduled entry "${name}" has cron "${cron}" containing characters no cron field accepts`,
    );
  }

  // Cloud Scheduler accepts 15s..30m for an HTTP target, and only as
  // "<seconds>s"; anything else fails at CREATE/UPDATE time mid-apply.
  if (entry.attemptDeadline !== undefined) {
    const m = /^(\d+)s$/.exec(entry.attemptDeadline);
    const secs = m ? Number(m[1]) : NaN;
    if (!m || secs < 15 || secs > 1800) {
      errors.push(
        `Manifest scheduled entry "${name}" has attemptDeadline "${entry.attemptDeadline}" — ` +
          `use "<seconds>s" between "15s" and "1800s"`,
      );
    }
  }

  // Exact, not a list to maintain: the runtime is the same ICU database, so
  // asking it is both simpler and truer than any table checked in here.
  const timezone = entry.timezone ?? "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    errors.push(
      `Manifest scheduled entry "${name}" has timezone "${timezone}", which is not a valid IANA zone`,
    );
  }
}

// ── 5. Terraform override drift ────────────────────────────────────────────
//
// `GET /jobs/status` reports the MANIFEST's cron, timezone and enabled flag.
// Terraform resolves the DEPLOYED schedule as
// `coalesce(try(var.jobs_scheduler_overrides[key].<field>, null), task.<field>)`
// (`infra/terraform/generated-jobs.tf`), so any per-environment override makes
// the staff console state something that is not true in that environment —
// silently, with every test still green.
//
// That matters more since /platform/settlements grew a payout clock reading
// this same payload: it tells staff when money leaves the platform.
// `settlements.run-batch` carries no override today, so the clock is right —
// but right by ABSENCE, which nothing was guarding.
//
// The guard therefore lives with the data: an override must be DECLARED in the
// manifest entry as `"schedulerOverriddenIn": ["prod"]`. Adding a new override
// then fails this gate until someone consciously acknowledges that the console
// will misreport it. The check is bidirectional — a declaration with no
// matching override is stale and also fails, so the list cannot rot.
const ENVS_DIR = path.resolve(__dirname, "../../../../infra/terraform/envs");

const overridesByEnv = new Map<string, Set<string>>();
/**
 * Envs whose tfvars could not be parsed. Kept so the stale-declaration loop
 * below skips them: an env absent from `overridesByEnv` would otherwise read
 * as "no overrides here" and produce one bogus "stale, remove it" error per
 * manifest entry declaring it (nine for prod) on top of the real one.
 */
const failedEnvs = new Set<string>();
if (fs.existsSync(ENVS_DIR)) {
  for (const env of fs.readdirSync(ENVS_DIR)) {
    const file = path.join(ENVS_DIR, env, `${env}.tfvars`);
    if (!fs.existsSync(file)) continue;
    // The parser THROWS on an override block it cannot read (mentioned but not
    // assigned, or brace-unbalanced). That is a gate failure, not a pass: a
    // block this check cannot see is exactly the block it exists to catch.
    try {
      overridesByEnv.set(
        env,
        readSchedulerOverrides(fs.readFileSync(file, "utf-8")),
      );
    } catch (err) {
      failedEnvs.add(env);
      errors.push(
        `Could not parse jobs_scheduler_overrides in infra/terraform/envs/${env}/${env}.tfvars: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

for (const [env, keys] of overridesByEnv) {
  for (const key of keys) {
    const entry = manifest.scheduled[key];
    if (!entry) {
      errors.push(
        `Terraform env "${env}" overrides the schedule of "${key}", which has no manifest.scheduled entry`,
      );
      continue;
    }
    const declared = entry.schedulerOverriddenIn ?? [];
    if (!declared.includes(env)) {
      errors.push(
        `Terraform env "${env}" overrides the schedule of "${key}", but the manifest entry does not declare it. ` +
          `/jobs/status reports the MANIFEST value, so the staff console will misreport this job in ${env}. ` +
          `Add "schedulerOverriddenIn": ${JSON.stringify([...declared, env].sort())} to the entry to acknowledge that.`,
      );
    }
  }
}

for (const [name, entry] of Object.entries(manifest.scheduled)) {
  for (const env of entry.schedulerOverriddenIn ?? []) {
    if (failedEnvs.has(env)) continue;
    if (!overridesByEnv.get(env)?.has(name)) {
      errors.push(
        `Manifest scheduled entry "${name}" declares schedulerOverriddenIn "${env}", but no such override exists in infra/terraform/envs/${env}/${env}.tfvars — stale declaration, remove it`,
      );
    }
  }
}

// ── 6. Payout-batch cycle drift (manifest ↔ @th/core) ──────────────────────
//
// `getOrgPayoutOverview.payoutOverdue` tells an organiser their money should
// already have been sent. It can only say that by knowing how long one batch
// cycle is, and that length is a constant in core because core cannot read
// this manifest. Reschedule the batch without revisiting the constant and the
// verdict quietly starts firing on a schedule it no longer describes — at
// worst accusing the platform of losing money that is simply not due yet.
//
// A STRING COMPARISON, NOT A CRON PARSER. §4 above is explicit that this
// script does not parse cron, and that ruling holds here: deriving an interval
// from an arbitrary expression is a parser, and it would be wrong for the
// first non-trivial schedule anyone writes. Equality catches EVERY change,
// including the ones a parser would mis-read — and the right response to a
// change is a human deciding the new interval, not a machine guessing it.
//
// THREE COPIES OF THE SCHEDULE, AND THE THIRD ONE IS WHAT RUNS. The manifest
// holds the default, core holds the recorded assumption, and Terraform deploys
// `coalesce(try(var.jobs_scheduler_overrides[key].cron, null), task.cron)` —
// timezone and enabled the same way (`infra/terraform/generated-jobs.tf`). An
// env override therefore REPLACES what this section compares, and §5 alone
// would wave one through the moment the entry declares `schedulerOverriddenIn`.
// So the payout batch may not be overridden per environment AT ALL: the
// overdue verdict is one global constant and can only describe one global
// schedule. That includes an `enabled`-only override — the reader below
// reports keys, not fields — and failing there is right too: with the batch
// off, "overdue" becomes true for every paid org in that environment, which is
// a decision to make on purpose, not a line in a tfvars file.
{
  const entry = manifest.scheduled[PAYOUT_BATCH_JOB_NAME];
  if (!entry) {
    errors.push(
      `Manifest has no scheduled entry "${PAYOUT_BATCH_JOB_NAME}", but ${PAYOUT_BATCH_CYCLE_MODULE} ` +
        `derives the payout-overdue cycle from its schedule. Restore the entry, or update that module ` +
        `(and everything reading PAYOUT_BATCH_CYCLE_MS) if the batch is really gone.`,
    );
  } else {
    if (entry.cron !== PAYOUT_BATCH_CRON_SOURCE) {
      errors.push(
        `"${PAYOUT_BATCH_JOB_NAME}" cron drifted from the payout-overdue cycle constant: ` +
          `jobs.manifest.json says "${entry.cron ?? "(missing)"}", ` +
          `${PAYOUT_BATCH_CYCLE_MODULE} says PAYOUT_BATCH_CRON_SOURCE = "${PAYOUT_BATCH_CRON_SOURCE}". ` +
          `Open ${PAYOUT_BATCH_CYCLE_MODULE}, work out what PAYOUT_BATCH_CYCLE_MS should be for the new ` +
          `schedule, and update PAYOUT_BATCH_CRON_SOURCE to match. It decides whether organisers are told ` +
          `their payout is overdue, so do not just sync the string. Then update ` +
          `packages/core/src/use-cases/payouts/_shared/next-payout-batch-run.ts, which names the date of the ` +
          `next run on the payouts page and only knows "0 0 * * *".`,
      );
    }
    if (entry.timezone !== PAYOUT_BATCH_TIMEZONE) {
      errors.push(
        `"${PAYOUT_BATCH_JOB_NAME}" timezone drifted from the payout-overdue cycle constant: ` +
          `jobs.manifest.json says "${entry.timezone ?? "(missing)"}", ` +
          `${PAYOUT_BATCH_CYCLE_MODULE} says PAYOUT_BATCH_TIMEZONE = "${PAYOUT_BATCH_TIMEZONE}". ` +
          `The zone sets the worst-case gap between two runs (a DST fall-back day is 25 hours, not 24), ` +
          `which is half the reasoning behind PAYOUT_BATCH_CYCLE_MS. Update that module.`,
      );
    }
  }

  // Reuses §5's parse. An env whose tfvars failed to parse is absent from
  // `overridesByEnv` and has ALREADY failed the gate there, so it cannot slip
  // through here as "no override".
  const overridingEnvs = [...overridesByEnv]
    .filter(([, keys]) => keys.has(PAYOUT_BATCH_JOB_NAME))
    .map(([env]) => env)
    .sort();
  if (overridingEnvs.length > 0) {
    const files = overridingEnvs
      .map((env) => `infra/terraform/envs/${env}/${env}.tfvars`)
      .join(", ");
    errors.push(
      `"${PAYOUT_BATCH_JOB_NAME}" is overridden in jobs_scheduler_overrides for ` +
        `${overridingEnvs.map((env) => `"${env}"`).join(", ")} (${files}). Terraform deploys the ` +
        `override in place of the manifest's cron / timezone / enabled, but the payout-overdue verdict ` +
        `in ${PAYOUT_BATCH_CYCLE_MODULE} assumes ONE global schedule ` +
        `(PAYOUT_BATCH_CRON_SOURCE = "${PAYOUT_BATCH_CRON_SOURCE}", ${PAYOUT_BATCH_TIMEZONE}), so this job ` +
        `must not be overridden per environment. A changed cron or timezone makes PAYOUT_BATCH_CYCLE_MS ` +
        `wrong there and tells organisers an on-schedule payout is overdue; an enabled = false override ` +
        `stops payouts, and the verdict would then (correctly) report every paid org there as overdue. ` +
        `Remove the override. To change the schedule everywhere, edit jobs.manifest.json and ` +
        `${PAYOUT_BATCH_CYCLE_MODULE} together.`,
    );
  }
}

// ── 7. Write-triggered drains (manifest ↔ @th/ports) ───────────────────────
//
// Terraform creates each wake-up topic from the manifest's `triggerTopic`; the
// API and jobs processes publish to the topic named in DRAIN_TRIGGERS (they
// cannot read this file at runtime). If the two disagree, every publish 404s,
// each one is reported, and the drain silently falls back to its safety-net
// cron. Checked both ways.
{
  const declared = new Map<string, string>();
  for (const [name, entry] of Object.entries(manifest.scheduled)) {
    if (entry.triggerTopic !== undefined) declared.set(name, entry.triggerTopic);
  }
  const expected = new Map<string, string>(
    Object.entries(DRAIN_TRIGGERS).map(([name, cfg]) => [name, cfg.topic]),
  );
  for (const [name, topic] of expected) {
    const got = declared.get(name);
    if (got === undefined) {
      errors.push(
        `DRAIN_TRIGGERS (packages/ports/src/job-trigger.ts) publishes wake-ups for "${name}" to "${topic}", ` +
          `but its manifest.scheduled entry has no "triggerTopic", so Terraform never creates the topic. ` +
          `Add "triggerTopic": "${topic}" to the entry.`,
      );
    } else if (got !== topic) {
      errors.push(
        `"${name}" triggerTopic is "${got}" in jobs.manifest.json but "${topic}" in DRAIN_TRIGGERS ` +
          `(packages/ports/src/job-trigger.ts). Publishes would go to a topic Terraform did not create.`,
      );
    }
  }
  for (const [name, topic] of declared) {
    if (!expected.has(name)) {
      errors.push(
        `Manifest scheduled entry "${name}" declares triggerTopic "${topic}", but DRAIN_TRIGGERS ` +
          `(packages/ports/src/job-trigger.ts) has no entry for it, so nothing ever publishes there.`,
      );
    }
    if (!/^[a-z][a-z0-9-]{2,200}$/.test(topic)) {
      errors.push(
        `Manifest scheduled entry "${name}" has triggerTopic "${topic}" — use lowercase letters, digits and dashes.`,
      );
    }

    const entry = manifest.scheduled[name]!;
    // One triggered run may take ~270s (drain-loop budget + coalesced
    // follow-ups); Cloud Scheduler's default 180s attempt deadline would mark
    // a healthy long run failed.
    const deadline = /^(\d+)s$/.exec(entry.attemptDeadline ?? "");
    if (!deadline || Number(deadline[1]) < 300) {
      errors.push(
        `Write-triggered "${name}" needs "attemptDeadline" of at least "300s" (has ${JSON.stringify(entry.attemptDeadline ?? null)}): ` +
          `one run may take ~270s, past Cloud Scheduler's 180s default.`,
      );
    }

    // The scheduled body must NOT be the wake-up body, or apps/jobs treats the
    // safety-net run as a wake-up (it would coalesce and run follow-ups, and
    // the RSVP / event-change nets would skip retries). The convention is
    // "payload": "{\"origin\":\"schedule\"}".
    const wake = (DRAIN_TRIGGERS as Record<string, { payload: unknown }>)[name]
      ?.payload;
    let scheduledBody: unknown = null;
    try {
      scheduledBody = JSON.parse(entry.payload ?? "{}");
    } catch {
      scheduledBody = null;
    }
    const canon = (v: unknown): string =>
      JSON.stringify(
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            )
          : v,
      );
    if (wake !== undefined && canon(scheduledBody) === canon(wake)) {
      errors.push(
        `Write-triggered "${name}" is scheduled with the same body as its wake-up (${canon(wake)}), so the jobs ` +
          `service cannot tell the safety-net run from a wake-up. Add "payload": "{\\"origin\\":\\"schedule\\"}".`,
      );
    }
  }
}

// ── 7b. Queue-entry trigger topics (manifest ↔ generated-jobs.tf) ──────────
//
// A QUEUE entry may also declare `triggerTopic` (e.g. `search.ensure-format`,
// which the deploy workflows publish to after jobs rolls). generated-jobs.tf
// merges scheduled and queue triggers into ONE map keyed by job name and
// creates `<env>-<triggerTopic>` + `<env>-<triggerTopic>-push` for each. Queue
// entries are not in DRAIN_TRIGGERS (the API and jobs processes do not publish
// them) and have no Cloud Scheduler job, so neither the DRAIN_TRIGGERS match
// nor the attemptDeadline rule above applies. What can still break: a
// malformed name, a job name in both sections (the merge silently keeps one
// trigger and drops the other), a trigger on a noHandler entry, two resources
// wanting the same topic name, or a workflow publishing to an undeclared one.
{
  const queueTriggers = new Map<string, string>();
  for (const [name, entry] of Object.entries(manifest.queue)) {
    const topic = (entry as { triggerTopic?: unknown } | null)?.triggerTopic;
    if (topic === undefined) continue;
    if (typeof topic !== "string" || !/^[a-z][a-z0-9-]{2,200}$/.test(topic)) {
      errors.push(
        `Manifest queue entry "${name}" has triggerTopic ${JSON.stringify(topic)} — use lowercase letters, digits and dashes.`,
      );
      continue;
    }
    if (manifestScheduled.has(name)) {
      errors.push(
        `"${name}" is both a scheduled and a queue entry and the queue entry declares triggerTopic; ` +
          `generated-jobs.tf keys trigger topics by job name, so one of the two triggers would be dropped.`,
      );
    }
    // The push subscription POSTs /jobs/<name>; with no handler every publish
    // 404s and Pub/Sub retries it until retention runs out.
    if ((entry as { noHandler?: unknown } | null)?.noHandler === true) {
      errors.push(
        `Manifest queue entry "${name}" declares triggerTopic "${topic}" but is noHandler:true; ` +
          `every trigger would 404 at /jobs/${name}. Drop the triggerTopic or add the handler.`,
      );
    }
    queueTriggers.set(name, topic);
  }

  // Every Pub/Sub topic suffix Terraform creates, with who wants it. Trigger
  // topics and plain queue topics share the `<env>-` namespace, and their
  // subscriptions share the `-push` suffix, so any repeat is a 409 mid-apply.
  const owners = new Map<string, string[]>();
  const claim = (topic: string, owner: string) =>
    owners.set(topic, [...(owners.get(topic) ?? []), owner]);
  for (const [name, entry] of Object.entries(manifest.scheduled)) {
    if (entry.triggerTopic !== undefined) {
      claim(entry.triggerTopic, `scheduled "${name}" triggerTopic`);
    }
  }
  for (const [name, topic] of queueTriggers) {
    claim(topic, `queue "${name}" triggerTopic`);
  }
  for (const section of ["queue", "legacy_queue"] as const) {
    const entries = (manifest as unknown as Record<string, unknown>)[section];
    if (!entries || typeof entries !== "object") continue;
    for (const [name, entry] of Object.entries(entries)) {
      const topic = (entry as { topic?: unknown } | null)?.topic;
      if (typeof topic === "string") claim(topic, `${section} "${name}" topic`);
    }
  }
  for (const [topic, who] of owners) {
    if (who.length > 1 && who.some((w) => w.endsWith("triggerTopic"))) {
      errors.push(
        `Pub/Sub topic suffix "${topic}" is claimed more than once (${who.join(", ")}); ` +
          `Terraform would create two topics named "<env>-${topic}".`,
      );
    }
  }

  // Workflows publish to trigger topics by literal name (e.g. the deploy
  // workflows' `<env>-hf-trigger-search-ensure-format`). A literal with no
  // matching manifest triggerTopic publishes to a topic Terraform never
  // created; the step is non-fatal, so it would only ever show as a warning.
  // Read as text on purpose: the names sit inside shell strings.
  const triggerTopics = new Set<string>([
    ...queueTriggers.values(),
    ...Object.values(manifest.scheduled).flatMap((e) =>
      e.triggerTopic !== undefined ? [e.triggerTopic] : [],
    ),
  ]);
  let workflowFiles: string[] = [];
  try {
    workflowFiles = fs
      .readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch (err) {
    errors.push(
      `Could not read ${WORKFLOWS_DIR} to check workflow trigger-topic literals: ${String(err)}`,
    );
  }
  for (const file of workflowFiles) {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf-8");
    for (const m of text.matchAll(/hf-trigger-[a-z0-9-]*[a-z0-9]/g)) {
      if (!triggerTopics.has(m[0])) {
        errors.push(
          `.github/workflows/${file} references trigger topic "${m[0]}", which no jobs.manifest.json ` +
            `triggerTopic declares, so Terraform never creates it.`,
        );
      }
    }
  }
}

// ── 8. Cart reaper cadence (manifest ↔ @th/core) ───────────────────────────
//
// `CAPACITY_HELD_WINDOW_SECONDS` keeps an open cart's tickets reserved for
// TTL + 2 reaper periods, because the PaymentIntent stays confirmable until
// the reaper cancels it. If the reaper runs less often than core believes, the
// reservation lapses while the charge can still land, and the same ticket can
// be sold twice. Exactly that drift existed until 2026-09-30 (core said 5 min,
// prod.tfvars said 15). Same shape as §6: string equality on the manifest, and
// no per-env override at all.
{
  const entry = manifest.scheduled[CART_REAPER_JOB_NAME];
  const cycleModule =
    "packages/core/src/use-cases/orders/_shared/cart-reaper-cycle.ts";
  if (!entry) {
    errors.push(
      `Manifest has no scheduled entry "${CART_REAPER_JOB_NAME}", but ${cycleModule} derives the ` +
        `checkout capacity window from its schedule.`,
    );
  } else if (entry.cron !== CART_REAPER_CRON_SOURCE) {
    errors.push(
      `"${CART_REAPER_JOB_NAME}" cron drifted from the capacity-window constant: jobs.manifest.json says ` +
        `"${entry.cron ?? "(missing)"}", ${cycleModule} says CART_REAPER_CRON_SOURCE = "${CART_REAPER_CRON_SOURCE}". ` +
        `Update CART_REAPER_PERIOD_SECONDS there to the new longest gap between runs, then the cron string. ` +
        `It decides how long a cart's tickets stay reserved while its charge can still land.`,
    );
  }
  const overridingEnvs = [...overridesByEnv]
    .filter(([, keys]) => keys.has(CART_REAPER_JOB_NAME))
    .map(([env]) => env)
    .sort();
  if (overridingEnvs.length > 0) {
    errors.push(
      `"${CART_REAPER_JOB_NAME}" is overridden in jobs_scheduler_overrides for ` +
        `${overridingEnvs.map((env) => `"${env}"`).join(", ")}. Terraform deploys the override in place of ` +
        `the manifest cron, but ${cycleModule} sizes the capacity window from ONE global period. Remove the ` +
        `override; change the cadence everywhere by editing the manifest and that module together.`,
    );
  }
}

// ── 9. Volunteer reminder cadence (manifest ↔ @th/core) ───────────────────
//
// Each reminder window (DEFAULT_BAND_MS in
// packages/core/src/use-cases/volunteering/send-volunteer-shift-reminders.ts)
// is sized against the job's manifest cron: a window narrower than the gap
// between two runs silently drops the reminder for every shift that starts
// in the gap. apps/jobs/src/__tests__/volunteer-reminder-coverage.test.ts
// checks the cron against the windows; an env override would replace the
// cron in Terraform behind both, so none is allowed. Same shape as §8.
{
  const VOLUNTEER_REMINDER_JOB_NAMES = [
    "volunteers.reminders-24h",
    "volunteers.reminders-1h",
  ];
  for (const name of VOLUNTEER_REMINDER_JOB_NAMES) {
    const overridingEnvs = [...overridesByEnv]
      .filter(([, keys]) => keys.has(name))
      .map(([env]) => env)
      .sort();
    if (overridingEnvs.length > 0) {
      errors.push(
        `"${name}" is overridden in jobs_scheduler_overrides for ` +
          `${overridingEnvs.map((env) => `"${env}"`).join(", ")}. Terraform deploys the override in place of ` +
          `the manifest cron, but DEFAULT_BAND_MS in send-volunteer-shift-reminders.ts sizes each reminder ` +
          `window against that cron, so a slower override silently drops reminders for shifts between ticks. ` +
          `Remove the override; change the cadence by editing the manifest and DEFAULT_BAND_MS together.`,
      );
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error("jobs.manifest.json is out of sync:\n");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error(`\nEdit apps/jobs/jobs.manifest.json to fix.`);
  process.exit(1);
} else {
  console.log(
    `jobs.manifest.json OK (${codeScheduled.size} scheduled, ${codeQueue.size} queue)`,
  );
}
