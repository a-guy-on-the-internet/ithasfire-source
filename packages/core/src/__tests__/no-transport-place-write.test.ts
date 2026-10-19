import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * GATE — no transport calls the unauthorised Place write.
 *
 * `writePlaceInTx` (packages/core/src/use-cases/places/upsert-place.ts) does
 * no authorisation of its own: its callers authorise first (upsertPlace,
 * publishPageDraft, the community-place use cases). It is importable from
 * anywhere through `@th/core`'s "./*" export, so this test makes sure no
 * tRPC router (anything under packages/transport) and no app
 * (apps/<name>/src) reaches for it.
 *
 * If this fails: call a use case from the transport instead.
 */

const PACKAGES_DIR = path.resolve(__dirname, "..", "..", "..");
const APPS_DIR = path.join(PACKAGES_DIR, "..", "apps");
const SCANNED_ROOTS = [
  path.join(PACKAGES_DIR, "transport"),
  ...readdirSync(APPS_DIR)
    .map((app) => path.join(APPS_DIR, app, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    }),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Prose may name it ("never call writePlaceInTx here"); code may not. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const FILES = SCANNED_ROOTS.flatMap(walk);

describe("writePlaceInTx is never called from a transport", () => {
  it("scans a non-trivial number of files — a silently empty scan is not a gate", () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("no file under packages/transport or apps/*/src references writePlaceInTx", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [i, line] of code.split("\n").entries()) {
        if (/\bwritePlaceInTx\b/.test(line)) {
          offenders.push(
            `${path.relative(PACKAGES_DIR, file)}:${i + 1}: ${line.trim()}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
