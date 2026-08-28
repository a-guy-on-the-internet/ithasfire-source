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
 *
 * Usage: pnpm -C apps/jobs validate:manifest
 * Also runs as a pre-commit hook.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, "../../jobs.manifest.json");
const JOBS_DIR = path.resolve(__dirname, "../jobs");

// ── Read manifest ──────────────────────────────────────────────────────────

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as {
  scheduled: Record<
    string,
    {
      noHandler?: boolean;
      description?: string;
      cron?: string;
      timezone?: string;
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
  if (!codeQueue.has(name)) {
    errors.push(`Manifest queue entry "${name}" has no handler`);
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
