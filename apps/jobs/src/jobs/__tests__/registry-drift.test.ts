import { beforeAll, describe, expect, it, vi } from "vitest";

// This is the ONE test that deliberately imports every job module — that is the
// whole point of it. `lib/env.ts` parses process.env at module scope (it never
// connects), so it needs a DATABASE_URL present before the hoisted imports run.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
});

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AnyJobDefinition } from "../../lib/define-job";
import { JOB_MODULE_IDS, JOB_MODULE_LOADERS } from "../modules";
import { REGISTERED_JOBS } from "../registry.generated";
import manifest from "../../../jobs.manifest.json";

/**
 * Drift guard for the eager metadata table.
 *
 * `registry.generated.ts` is what the service boots with; the job modules are
 * where the metadata is authored. Everything else in the suite runs against the
 * generated table, so if the two drift, `GET /jobs` quietly serves a stale
 * description or — much worse — a stale cron, and nothing else notices.
 *
 * Regenerate with `pnpm -C apps/jobs generate:registry` when this fails.
 */
describe("job registry / generated metadata", () => {
  /** Every job its module actually exports, in module order. */
  const live: Array<{ module: string; definition: AnyJobDefinition }> = [];

  // Importing 25 job modules is ~170 MB and several seconds cold — the cost
  // this whole refactor exists to keep OFF the boot path. Pay it once here,
  // with a timeout that does not depend on CI's `--testTimeout` flag.
  beforeAll(async () => {
    for (const moduleId of JOB_MODULE_IDS) {
      const definitions = await JOB_MODULE_LOADERS[moduleId]();
      for (const definition of definitions) {
        live.push({ module: moduleId, definition });
      }
    }
  }, 120_000);

  it("registers every job every module defines, in the same order", () => {
    expect(REGISTERED_JOBS.map((job) => job.name)).toEqual(
      live.map((entry) => entry.definition.name),
    );
    expect(REGISTERED_JOBS.map((job) => job.module)).toEqual(
      live.map((entry) => entry.module),
    );
  });

  it("carries the same description, notify flag and schedule as the handler", () => {
    const fromModules = live.map(({ module, definition }) => {
      const schedule = (
        definition as { schedule?: Record<string, unknown> }
      ).schedule;
      return {
        module,
        name: definition.name,
        description: definition.description,
        notify: definition.notify,
        // `schedule` is compared by PRESENCE as well as value: an entry that
        // gained the key would flip a queue job to `scheduled: true` in the
        // endpoint payload and get a Cloud Scheduler job it never asked for.
        schedule: schedule ?? undefined,
      };
    });

    const fromTable = REGISTERED_JOBS.map((job) => ({
      module: job.module,
      name: job.name,
      description: job.description,
      notify: job.notify,
      schedule: job.schedule ?? undefined,
    }));

    expect(fromTable).toEqual(fromModules);
  });

  /**
   * Independent oracles for "is this job registered at all?".
   *
   * The two tests above walk `JOB_MODULE_IDS`, so they are structurally blind
   * to a job module that was never added to `modules.ts`: the file exists,
   * `validate-manifest.ts` scans the directory as TEXT and goes green, the
   * generator walks the same map and produces no diff, and Terraform mints a
   * Cloud Scheduler job off the manifest that 404s `job_not_found` on every
   * tick, forever. That is the refactor's version of the old "forgot the
   * import and the spread" slip, and it needs a guard that does not start
   * from `modules.ts`.
   *
   * Two sources that cannot see `modules.ts` are used instead: the jobs
   * DIRECTORY (scanned the same way `validate-manifest.ts` scans it) and
   * `jobs.manifest.json` (which Terraform reads). Both are zero-import, so
   * they also give a cheap forgot-to-regenerate check.
   */
  describe("registration cannot be skipped", () => {
    const JOBS_DIR = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );

    /** Same regexes `src/scripts/validate-manifest.ts` uses, same directory. */
    function scanDirectoryForJobNames(): Set<string> {
      const names = new Set<string>();
      const files = fs
        .readdirSync(JOBS_DIR)
        .filter(
          (f) =>
            f.endsWith(".ts") &&
            f !== "index.ts" &&
            f !== "modules.ts" &&
            f !== "registry.ts" &&
            f !== "registry.generated.ts",
        );

      for (const file of files) {
        const source = fs.readFileSync(path.join(JOBS_DIR, file), "utf-8");
        for (const m of source.matchAll(
          /defineScheduledTask\(\{[\s\S]*?name:\s*"([^"]+)"/g,
        )) {
          names.add(m[1]!);
        }
        for (const m of source.matchAll(
          /defineJob\(\{[\s\S]*?name:\s*"([^"]+)"/g,
        )) {
          names.add(m[1]!);
        }
      }
      return names;
    }

    it("registers every job defined anywhere in src/jobs, including in modules the loader map has never heard of", () => {
      const onDisk = [...scanDirectoryForJobNames()].sort();
      const registered = REGISTERED_JOBS.map((job) => job.name).sort();

      // A mismatch here means one of: a new job module was never added to
      // `modules.ts`, a new job was added to a registered module without
      // rerunning `pnpm -C apps/jobs generate:registry`, or a job was deleted
      // and the generated table still lists it.
      expect(registered).toEqual(onDisk);
    });

    it("registers exactly the handler-backed jobs the manifest declares", () => {
      // The manifest is what Terraform mints Cloud Scheduler jobs and Pub/Sub
      // topics from. A name here with no registry entry 404s on every tick; a
      // name in the registry with no manifest entry never gets scheduled.
      const declared = [
        ...Object.entries(manifest.scheduled as Record<string, unknown>),
        ...Object.entries(manifest.queue as Record<string, unknown>),
      ]
        .filter(([, entry]) => !(entry as { noHandler?: boolean })?.noHandler)
        .map(([name]) => name)
        .sort();

      expect(REGISTERED_JOBS.map((job) => job.name).sort()).toEqual(declared);
    });

    it("agrees with the manifest on which jobs are scheduled vs queue-triggered", () => {
      const scheduledInManifest = Object.keys(manifest.scheduled).sort();
      const scheduledInRegistry = REGISTERED_JOBS.filter(
        (job) => job.schedule != null,
      )
        .map((job) => job.name)
        .sort();

      expect(scheduledInRegistry).toEqual(scheduledInManifest);
    });
  });

  it("names every job exactly once", () => {
    const names = REGISTERED_JOBS.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("points every entry at a module the loader map knows", () => {
    const known = new Set<string>(JOB_MODULE_IDS);
    for (const job of REGISTERED_JOBS) {
      expect(known).toContain(job.module);
    }
  });
});
