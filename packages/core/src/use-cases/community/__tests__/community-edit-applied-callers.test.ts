import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * THE DRIFT GUARD for the community-edit post-commit dispatch.
 *
 * `recordCommunityEditApplied` runs inside the caller's transaction, so the
 * search reindex it owns cannot fire there — indexing a row the tx may still
 * roll back publishes an edit that never happened, and a slow search backend
 * inside a tx holds row locks. It therefore returns a `postCommit` closure the
 * caller dispatches once `repos.tx` resolves.
 *
 * That shape already makes skipping the dispatch very hard: the closure's
 * return value is the FR-018 settlement result, which is the ONLY way to get
 * the booking-hold notification intents a caller owes on its output. This test
 * closes the last gap — a third edit path that happens not to want those
 * intents, drops the closure on the floor, and silently stops telling search
 * that a live listing's venue moved. That failure has no error, no red test
 * and no Sentry event; it is only visible as search serving the old venue.
 *
 * So: every file that applies a community edit must also dispatch its
 * post-commit half. If you are here because you added a caller, dispatch
 * `postCommit(...)` after your transaction — do not add an exemption.
 */

const USE_CASES_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** The shared unit itself defines both halves; it is not a caller. */
const SHARED_UNIT = join(
  USE_CASES_DIR,
  "community",
  "_shared",
  "community-edit-applied.ts",
);

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...walkSourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/** Every non-test source file under `use-cases` that applies a community edit. */
const CALLERS = walkSourceFiles(USE_CASES_DIR).filter(
  (file) =>
    file !== SHARED_UNIT &&
    readFileSync(file, "utf8").includes("recordCommunityEditApplied("),
);

describe("every community-edit caller dispatches its post-commit half", () => {
  it("finds the two known edit paths (so the scan itself cannot rot to zero)", () => {
    expect(
      CALLERS.map((file) => file.slice(USE_CASES_DIR.length)).sort(),
    ).toEqual([
      "community/review-event-edit-suggestion.ts",
      "community/update-community-listing.ts",
    ]);
  });

  // Driven off the scan, not off a list, so a third path added tomorrow is
  // checked without anyone remembering to touch this file.
  it.each(CALLERS)("%s dispatches postCommit after its transaction", (file) => {
    const source = readFileSync(file, "utf8");
    expect(
      source.includes("postCommit("),
      `${file} calls recordCommunityEditApplied but never dispatches postCommit(...) — ` +
        "the edit would commit without reindexing search.",
    ).toBe(true);
  });
});
