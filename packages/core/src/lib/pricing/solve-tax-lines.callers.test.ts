import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Drift guard: no PRODUCTION file prices tax through the single-rate
 * `solveTaxAndProcessorFee`. It survives only so the pinned 2392f1fc literals
 * keep running unchanged against the generalised solve; a money site that holds
 * one rate and one base is exactly how a local imposition (a city amusement
 * tax) gets silently dropped from a quote while the charge includes it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const ROOTS = [
  "packages/core/src",
  "packages/transport",
  "apps/web/src",
  "apps/api/src",
  "apps/jobs/src",
];
const ALLOWED = new Set([
  "packages/core/src/lib/pricing/solve-tax-and-processor-fee.ts",
]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "__fixtures__"]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield full;
    }
  }
}

describe("single-rate solver has no production callers", () => {
  it("every money site uses solveTaxLinesAndProcessorFee", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const file of walk(join(REPO, root))) {
        scanned += 1;
        const rel = relative(REPO, file);
        if (ALLOWED.has(rel)) continue;
        if (/\bsolveTaxAndProcessorFee\b/.test(readFileSync(file, "utf8"))) {
          offenders.push(rel);
        }
      }
    }
    // Negative control: the walk actually found the tree.
    expect(scanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});
