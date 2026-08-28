import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * NFR-005 — sign-out purges EVERY local artifact.
 *
 * ## Why this test reads source text instead of running SQL
 *
 * `local-db.ts` imports `expo-sqlite`, which does not exist outside a native
 * runtime, and this app has no device-test harness. So the choice is between a
 * source-level guard and no guard at all — and the failure mode being guarded
 * is a purely textual one that has already happened once in this file's life:
 * someone adds a `CREATE TABLE` to `migrate()` and does not add the matching
 * `DELETE` to `clearAll()`. FR-010's `dropped_scans` holds ticket codes and
 * client keys (bearer credentials) for an operator who is signing out, on a
 * device another operator will pick up.
 *
 * It is a lint, honestly labelled. It cannot prove the DELETE executes; it can
 * prove nobody forgot to write it, which is the whole of the observed bug
 * class. A device pass (build-order step 6) covers the rest.
 */

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "local-db.ts"),
  "utf8",
);

const block = (name: string): string => {
  const start = SRC.indexOf(`export function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  // Function bodies in this file are separated by top-level `export`s.
  const next = SRC.indexOf("\nexport ", start + 1);
  return SRC.slice(start, next === -1 ? SRC.length : next);
};

/** Ordinary tables `migrate()` creates. FTS5 virtual tables are separate. */
const createdTables = (): string[] =>
  [...SRC.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]!);

describe("clearAll covers every table migrate() creates", () => {
  it("finds the tables at all (guards the guard)", () => {
    const tables = createdTables();
    // If the regex stops matching, this test would otherwise pass vacuously.
    expect(tables).toContain("tickets");
    expect(tables).toContain("scan_queue");
    expect(tables).toContain("recent_scans");
    expect(tables).toContain("dropped_scans");
    expect(tables.length).toBeGreaterThanOrEqual(6);
  });

  it("deletes from each one on sign-out", () => {
    const purge = block("clearAll");
    for (const table of createdTables()) {
      // `_fts_probe` is created and dropped inside `probeFts5` in the same
      // statement; it never outlives the probe.
      if (table === "_fts_probe") continue;
      expect(
        new RegExp(`DELETE FROM ${table}\\b`).test(purge),
        `clearAll() does not purge \`${table}\` — a sign-out would leave it on a shared device`,
      ).toBe(true);
    }
  });

  it("purges the FTS index too", () => {
    expect(block("clearAll")).toContain("DELETE FROM people_fts");
  });
});

describe("dropped_scans keeps the column the retry depends on", () => {
  it("stores client_key", () => {
    // FR-010's acceptance criterion is that a retry replays with the ORIGINAL
    // key. Dropping this column would make that impossible while every test
    // above still passed.
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS dropped_scans[\s\S]*?\)/);
    const table = /CREATE TABLE IF NOT EXISTS dropped_scans\(?([\s\S]*?)\);/.exec(
      SRC,
    );
    expect(table?.[1]).toContain("client_key");
  });
});
