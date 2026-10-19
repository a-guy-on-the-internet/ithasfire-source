/**
 * Generate the eager job-metadata table.
 *
 * Imports every job module ONCE (here, in a script, where 170 MB of module
 * graph costs nothing) and writes each job's boot-time metadata out as plain
 * data. The running service then serves `GET /jobs` and `GET /jobs/status`
 * from that data without importing a single handler.
 *
 * The job module stays the source of truth: `description`, `notify` and
 * `schedule` are still authored next to the handler they describe. This file
 * only lifts them out so they can be read without paying for the handler.
 *
 * Usage:  pnpm -C apps/jobs generate:registry     (write)
 *         pnpm -C apps/jobs check:registry        (verify, exit 1 on drift)
 *
 * `check` deliberately does NOT lean on `git diff --quiet`: the generated file
 * can be untracked (a fresh checkout, a first commit), and `git diff` reports
 * no change for an untracked path, which would make the gate a silent no-op.
 * Comparing the rendered output to the file on disk is true in every state.
 *
 * Guard:  src/jobs/__tests__/registry-drift.test.ts fails if you forget.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Importing a job module pulls `lib/env.ts`, which PARSES process.env at module
// scope (it never connects to anything). A placeholder keeps codegen hermetic —
// no database, no .env.local — so this runs the same in CI as on a laptop.
process.env.DATABASE_URL ??= "postgresql://codegen@127.0.0.1:5432/codegen";

const { JOB_MODULE_IDS, JOB_MODULE_LOADERS } = await import("../jobs/modules");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "../jobs/registry.generated.ts");

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with \`pnpm -C apps/jobs generate:registry\`.
 * Source of truth is each job module's own \`defineJob\` /
 * \`defineScheduledTask\` call; this table only lifts the metadata out so the
 * service can serve it without importing a handler. See src/jobs/registry.ts.
 *
 * Drift is caught by src/jobs/__tests__/registry-drift.test.ts.
 */
import type { RegisteredJob } from "./registry";

export const REGISTERED_JOBS: readonly RegisteredJob[] = [
`;

/** Emit a TS string literal, escaping the four things that can break one. */
function lit(value: string): string {
  return JSON.stringify(value);
}

const lines: string[] = [];
let count = 0;

for (const moduleId of JOB_MODULE_IDS) {
  const definitions = await JOB_MODULE_LOADERS[moduleId]();

  for (const job of definitions) {
    count += 1;
    const fields: string[] = [
      `    module: ${lit(moduleId)},`,
      `    name: ${lit(job.name)},`,
    ];
    if (job.description !== undefined) {
      fields.push(`    description: ${lit(job.description)},`);
    }
    if (job.notify !== undefined) {
      fields.push(`    notify: ${String(job.notify)},`);
    }

    // `schedule` is emitted only for scheduled tasks: `"schedule" in job` is
    // what marks a job scheduled, so writing `schedule: undefined` for a queue
    // job would flip it to scheduled in the endpoint payload.
    const schedule = (job as { schedule?: Record<string, unknown> }).schedule;
    if (schedule) {
      const parts: string[] = [`cron: ${lit(String(schedule.cron))}`];
      if (schedule.timezone !== undefined) {
        parts.push(`timezone: ${lit(String(schedule.timezone))}`);
      }
      if (schedule.enabled !== undefined) {
        parts.push(`enabled: ${String(schedule.enabled)}`);
      }
      fields.push(`    schedule: { ${parts.join(", ")} },`);
    }

    lines.push(`  {\n${fields.join("\n")}\n  },`);
  }
}

const output = `${HEADER}${lines.join("\n")}\n];\n`;

const previous = fs.existsSync(OUT_PATH)
  ? fs.readFileSync(OUT_PATH, "utf-8")
  : null;

const relative = path.relative(process.cwd(), OUT_PATH);
const summary = `${count} jobs across ${JOB_MODULE_IDS.length} modules`;
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  if (previous === output) {
    console.log(`${relative} is up to date (${summary})`);
  } else {
    console.error(
      `${relative} is STALE — a job's name, description, notify flag or schedule ` +
        `changed without regenerating.\n\nRun \`pnpm -C apps/jobs generate:registry\` and commit the result.`,
    );
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT_PATH, output, "utf-8");
  console.log(
    `${previous === output ? "unchanged" : "wrote"} ${relative} (${summary})`,
  );
}
