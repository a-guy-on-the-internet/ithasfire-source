#!/usr/bin/env node
// pnpm tsc:status — read what scripts/tsc-daemon.mjs last worked out.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
//
// This reports the WORKING TREE, not your commit. A green here has coexisted
// with a red commit on this repo (a spliced hunk that was never staged; a
// Prisma client generated from an uncommitted schema).
//
// `--mine` does NOT mean "errors you caused". There is no reliable per-session
// signal in a shared worktree, so it intersects the diagnostics with
// `git status --porcelain` — the union of EVERY session's uncommitted work.
// It is wrong in both directions:
//   - a peer's broken WIP is listed as "yours";
//   - an error your edit caused that LANDS in a file you did not touch is not
//     listed at all. Diagnostics are attributed by where an error surfaces,
//     never by what caused it.
// So `--mine` narrows what is PRINTED. It never narrows the verdict: the exit
// code always reflects the whole checkout.
//
// A fast signal, not a gate. `pnpm typecheck` / `pnpm typecheck:all` are the
// gate; CI is the verdict.
// ---------------------------------------------------------------------------
//
// Usage:
//   pnpm tsc:status [--mine] [-v|--verbose]
//   node scripts/tsc-status.mjs --selftest
//
// Exit codes:
//   0  fresh, clean, nothing unknown
//   1  errors somewhere in the checkout (INCLUDING errors tsc counted but we
//      could not parse — an unparsed error is still an error)
//   2  no status file / daemon never ran
//   3  STALE — sources changed after the result was computed
//   4  no verdict — a target is still checking, crashed, or unknown
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_DIR, TYPECHECK_TARGETS } from "./typecheck-targets.mjs";
import { createScanCache, newerThan, watermarkFrom } from "./lib/tsc-source-scan.mjs";
import { classifyLine } from "./lib/tsc-watch-parse.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE = path.join(REPO_ROOT, CACHE_DIR);
const STATUS_FILE = path.join(CACHE, "status.json");
const PID_FILE = path.join(CACHE, "daemon.pid");

const MINE_CAVEAT =
  "--mine intersects with `git status` (ALL sessions' dirt). Errors your edit " +
  "caused in files you did not touch do NOT appear here.";

// --- pure core (exercised by --selftest) -----------------------------------

/**
 * Parse `git status --porcelain -z`.
 * NUL-delimited because paths with spaces or unicode come back quoted
 * otherwise, and a rename is two records.
 * An untracked DIRECTORY arrives as a single `dir/` entry standing in for its
 * whole subtree, so those become prefixes rather than exact matches.
 */
export function parsePorcelain(out) {
  const records = out.split("\0");
  const exact = new Set();
  const prefixes = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    // `R`/`C` are followed by a second NUL-separated record: the old path.
    if (status[0] === "R" || status[0] === "C") i++;
    if (!file) continue;
    if (file.endsWith("/")) prefixes.push(file);
    else exact.add(file);
  }
  return { exact, prefixes };
}

export function isMine(file, dirty) {
  if (!file || !dirty) return false;
  if (dirty.exact.has(file)) return true;
  return dirty.prefixes.some((p) => file.startsWith(p));
}

/**
 * Turn one target's stored result into a verdict.
 *
 * `staleFiles === null` means staleness could not be determined.
 *
 * The load-bearing rule: `red` counts errors tsc REPORTED, not errors we
 * managed to parse, and `--mine` never reduces it. A cycle where tsc said
 * "Found 3 errors" and our parser produced none used to render `ok ... clean`
 * and exit 0.
 */
export function assessTarget(entry, { mine = false, dirty = null, staleFiles = [] } = {}) {
  const all = (entry.diagnostics ?? []).filter((d) => d.severity === "error");
  const shown = mine ? all.filter((d) => isMine(d.file, dirty)) : all;

  // tsc's own trailer is the authority. Anything it counted that we did not
  // turn into a record is unattributed: it has no file, so it can be neither
  // displayed nor filtered — only counted.
  const unattributed = Math.max(0, (entry.reportedErrorCount ?? 0) - (entry.errorCount ?? 0));
  const watermarkMissing = entry.state !== "checking" && !entry.watermark;

  let kind;
  if (entry.state === "crashed") kind = "crashed";
  else if (entry.state === "checking") kind = "checking";
  else if (unattributed > 0 || watermarkMissing) kind = "unknown";
  else if (all.length > 0) kind = "errors";
  else kind = "clean";

  return {
    kind,
    all,
    shown,
    unattributed,
    watermarkMissing,
    // Drives the exit code. Never narrowed by --mine.
    red: all.length + unattributed,
    staleCount: staleFiles ? staleFiles.length : 0,
    staleUnknown: staleFiles === null,
  };
}

/** The single place an exit code is decided. */
export function computeExit({ hasStatus, red, anyStale, anyUnresolved }) {
  if (!hasStatus) return 2;
  if (red > 0) return 1;
  if (anyStale) return 3;
  if (anyUnresolved) return 4;
  return 0;
}

// --- reading ---------------------------------------------------------------

function dirtyPaths() {
  try {
    return parsePorcelain(
      execFileSync("git", ["status", "--porcelain", "-z"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
  } catch (err) {
    console.error(`Could not read git status: ${err.message}`);
    return { exact: new Set(), prefixes: [] };
  }
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    console.error(`status.json is unreadable (${err.message}).`);
    return null;
  }
}

function daemonState() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
  } catch {
    return { running: false, detail: "no pidfile" };
  }
  try {
    process.kill(info.pid, 0);
  } catch (err) {
    if (err.code === "ESRCH") return { running: false, detail: `pid ${info.pid} is gone` };
  }
  let command = "";
  try {
    command = execFileSync("ps", ["-o", "command=", "-p", String(info.pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { running: false, detail: `pid ${info.pid} is gone` };
  }
  if (!command.includes("tsc-daemon")) {
    return { running: false, detail: `pid ${info.pid} was recycled` };
  }
  return { running: true, detail: `pid ${info.pid}, since ${info.startedAt}` };
}

function ago(iso) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

// --- report ----------------------------------------------------------------

function main(argv) {
  const MINE = argv.includes("--mine");
  const VERBOSE = argv.includes("--verbose") || argv.includes("-v");

  const status = readStatus();
  const daemon = daemonState();

  if (!status) {
    console.error("tsc-daemon has no result for this checkout.");
    console.error(`  expected: ${path.relative(REPO_ROOT, STATUS_FILE)}`);
    console.error("  start it: node scripts/tsc-daemon.mjs");
    process.exit(computeExit({ hasStatus: false }));
  }

  const scan = createScanCache(REPO_ROOT, 2000);
  const dirty = MINE ? dirtyPaths() : null;

  let anyStale = false;
  let anyUnresolved = false;
  let red = 0;
  let shownTotal = 0;
  const lines = [];

  for (const target of TYPECHECK_TARGETS) {
    const entry = status.targets?.[target.key];
    if (!entry) {
      lines.push(`  ?? ${target.name.padEnd(30)} not watched by this daemon`);
      anyUnresolved = true;
      continue;
    }

    // Staleness needs a watermark; without one it is UNKNOWN, not fresh.
    const staleFiles =
      entry.watermark && entry.state !== "checking"
        ? newerThan(scan(target.sourceRoots), entry.watermark.mtimeMs)
        : null;

    const verdict = assessTarget(entry, { mine: MINE, dirty, staleFiles });
    red += verdict.red;
    shownTotal += verdict.shown.length;
    if (verdict.staleCount > 0) anyStale = true;
    if (verdict.kind === "checking" || verdict.kind === "crashed" || verdict.kind === "unknown") {
      anyUnresolved = true;
    }

    const scopeNote = MINE ? ` (${verdict.shown.length} shown of ${verdict.all.length})` : "";
    const mark = {
      crashed: "!!",
      checking: "..",
      unknown: "??",
      errors: "XX",
      clean: "ok",
    }[verdict.kind];
    const summary = {
      crashed: `CRASHED (exit ${entry.exitCode})`,
      checking: "checking...",
      unknown: "UNKNOWN",
      errors: `${verdict.all.length} error${verdict.all.length === 1 ? "" : "s"}${scopeNote}`,
      clean: `clean${scopeNote}`,
    }[verdict.kind];

    lines.push(
      `  ${mark} ${target.name.padEnd(30)} ${summary.padEnd(26)} ${ago(entry.cycleFinishedAt)}`,
    );

    if (verdict.unattributed > 0) {
      lines.push(
        `     UNKNOWN: tsc counted ${entry.reportedErrorCount} error(s); ` +
          `${verdict.unattributed} could not be parsed and are NOT listed below. ` +
          `Run \`pnpm typecheck:all\` — this target cannot be called clean.`,
      );
    }
    if (verdict.watermarkMissing) {
      lines.push("     UNKNOWN: no watermark recorded — freshness cannot be established.");
    }
    if (verdict.staleCount > 0) {
      const names = staleFiles.slice(0, 3).map((f) => f.path);
      lines.push(
        `     STALE: ${verdict.staleCount} file${verdict.staleCount === 1 ? "" : "s"} changed since this result — ${names.join(", ")}${verdict.staleCount > 3 ? ", ..." : ""}`,
      );
    }
    if (entry.watermark?.clampedFrom) {
      lines.push(
        `     NOTE: ${entry.watermark.file} is dated in the FUTURE; the watermark was clamped, so it reads as permanently stale.`,
      );
    }

    const show = VERBOSE ? verdict.shown : verdict.shown.slice(0, 10);
    for (const d of show) {
      lines.push(`       ${d.file ?? "<no file>"}:${d.line ?? "?"} ${d.code} ${d.message}`);
    }
    if (!VERBOSE && verdict.shown.length > show.length) {
      lines.push(`       ... ${verdict.shown.length - show.length} more (-v for all)`);
    }
  }

  console.log(`tsc-daemon: ${daemon.running ? "running" : "NOT RUNNING"} (${daemon.detail})`);
  console.log(`last update: ${ago(status.updatedAt)}${MINE ? "   scope: --mine" : ""}`);
  if (MINE) console.log(`note: ${MINE_CAVEAT}`);
  console.log(lines.join("\n"));
  console.log(
    "\nWorking tree only. This is NOT a commit gate — it sees uncommitted files\n" +
      "from every session sharing this checkout, and has read green over a red\n" +
      "commit before. Gate with `pnpm typecheck:all`; CI is the verdict.",
  );

  const code = computeExit({ hasStatus: true, red, anyStale, anyUnresolved });
  if (red > 0) {
    if (MINE && shownTotal === 0) {
      console.log(
        `\n${red} error(s) in the checkout, none of them in files you have dirty.\n` +
          `Not calling that green: ${MINE_CAVEAT}`,
      );
    } else if (MINE) {
      console.log(`\n${shownTotal} error(s) shown; ${red} in the checkout overall.`);
    } else {
      console.log(`\n${red} error(s).`);
    }
  } else if (code === 3) {
    console.log("\nSTALE — sources changed after these results. Nothing here is trustworthy.");
  } else if (code === 4) {
    console.log("\nNo verdict yet — a target is still checking, crashed, or is UNKNOWN.");
  } else {
    console.log("\nNo errors, and the results are fresh.");
  }
  process.exit(code);
}

// --- selftest --------------------------------------------------------------
//
// A green status can mean "the parser broke", not "the tree is clean". These
// pin the components whose silent failure produces a confident wrong answer.
// Mirrors the `--selftest` convention in apps/web/scripts/lint-css-colors.mjs.

function selftest() {
  let failures = 0;
  const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
      console.log(`  ok  ${name}`);
    } else {
      failures++;
      console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
    }
  };

  console.log("classifyLine:");
  check(
    "file diagnostic",
    classifyLine("src/a.ts(3,5): error TS2322: Type 'string' is not assignable."),
    {
      kind: "diagnostic",
      record: {
        file: "src/a.ts",
        line: 3,
        column: 5,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable.",
      },
    },
  );
  check("config diagnostic (no file)", classifyLine("error TS5083: Cannot read file."), {
    kind: "diagnostic",
    record: {
      file: null,
      line: null,
      column: null,
      severity: "error",
      code: "TS5083",
      message: "Cannot read file.",
    },
  });
  check("cycle end count", classifyLine("[3:04:20 PM] Found 3 errors. Watching for file changes."), {
    kind: "cycle-end",
    errorCount: 3,
  });
  check("cycle end singular", classifyLine("[3:04:20 PM] Found 1 error. Watching for file changes."), {
    kind: "cycle-end",
    errorCount: 1,
  });
  check("cycle start (watch mode)", classifyLine("[3:04:12 PM] Starting compilation in watch mode...").kind, "cycle-start");
  check("cycle start (incremental)", classifyLine("[3:04:12 PM] File change detected. Starting incremental compilation...").kind, "cycle-start");
  check("continuation", classifyLine("  Type 'undefined' is not assignable."), {
    kind: "continuation",
    text: "Type 'undefined' is not assignable.",
  });
  check(
    "ANSI escapes stripped",
    classifyLine("\u001b[96msrc/a.ts\u001b[0m(1,2): error TS1: x").record?.file,
    "src/a.ts",
  );
  check("a spliced half-line is NOT silently a diagnostic", classifyLine("src/a.ts(3,5): erro").kind, "other");

  console.log("parsePorcelain / isMine:");
  const dirty = parsePorcelain(
    [" M packages/core/src/a.ts", "?? scratch/", "R  apps/web/new.ts", "apps/web/old.ts", "?? a b/c d.ts"].join("\0"),
  );
  check("modified file is dirty", isMine("packages/core/src/a.ts", dirty), true);
  check("untracked DIRECTORY covers its subtree", isMine("scratch/deep/x.ts", dirty), true);
  check("rename: new path is dirty", isMine("apps/web/new.ts", dirty), true);
  check("rename: old path is NOT read as a status record", dirty.exact.has("apps/web/old.ts"), false);
  check("path with spaces survives -z", isMine("a b/c d.ts", dirty), true);
  check("clean file is not mine", isMine("apps/web/untouched.ts", dirty), false);
  check("a null file is never mine", isMine(null, dirty), false);

  console.log("newerThan:");
  const scan = { files: [{ path: "a", mtimeMs: 100 }, { path: "b", mtimeMs: 200 }], newest: { path: "b", mtimeMs: 200 }, count: 2 };
  check("strictly newer only", newerThan(scan, 100).map((f) => f.path), ["b"]);
  check("nothing newer than the max", newerThan(scan, 200).length, 0);

  console.log("watermarkFrom:");
  check("clamped to the cycle clock", watermarkFrom({ newest: { path: "f", mtimeMs: 9_000 }, count: 1 }, 5_000).mtimeMs, 5_000);
  check("records what it clamped from", watermarkFrom({ newest: { path: "f", mtimeMs: 9_000 }, count: 1 }, 5_000).clampedFrom, 9_000);
  check("normal mtime untouched", watermarkFrom({ newest: { path: "f", mtimeMs: 3_000 }, count: 1 }, 5_000).mtimeMs, 3_000);

  console.log("assessTarget — the false greens:");
  const unparsed = { state: "errors", diagnostics: [], errorCount: 0, reportedErrorCount: 3, watermark: { mtimeMs: 1 } };
  check("reported 3 / parsed 0 is UNKNOWN", assessTarget(unparsed).kind, "unknown");
  check("reported 3 / parsed 0 counts red", assessTarget(unparsed).red, 3);
  check(
    "--mine cannot filter away an unparsed error",
    assessTarget(unparsed, { mine: true, dirty: parsePorcelain("") }).red,
    3,
  );
  const noWatermark = { state: "clean", diagnostics: [], errorCount: 0, reportedErrorCount: 0, watermark: null };
  check("missing watermark is UNKNOWN, not fresh", assessTarget(noWatermark).kind, "unknown");
  const clean = { state: "clean", diagnostics: [], errorCount: 0, reportedErrorCount: 0, watermark: { mtimeMs: 1 } };
  check("a genuinely clean target is clean", assessTarget(clean).kind, "clean");
  check("a genuinely clean target is not red", assessTarget(clean).red, 0);
  const peerErrors = {
    state: "errors",
    diagnostics: [{ severity: "error", file: "apps/web/untouched.ts", line: 1, code: "TS1", message: "x" }],
    errorCount: 1,
    reportedErrorCount: 1,
    watermark: { mtimeMs: 1 },
  };
  const narrowed = assessTarget(peerErrors, { mine: true, dirty });
  check("--mine narrows what is shown", narrowed.shown.length, 0);
  check("--mine does NOT narrow the verdict", narrowed.red, 1);

  console.log("computeExit:");
  check("missing status", computeExit({ hasStatus: false }), 2);
  check("red beats everything", computeExit({ hasStatus: true, red: 3, anyStale: true, anyUnresolved: true }), 1);
  check("stale", computeExit({ hasStatus: true, red: 0, anyStale: true, anyUnresolved: false }), 3);
  check("unresolved", computeExit({ hasStatus: true, red: 0, anyStale: false, anyUnresolved: true }), 4);
  check("clean and fresh", computeExit({ hasStatus: true, red: 0, anyStale: false, anyUnresolved: false }), 0);
  check(
    "an unparsed error can never reach exit 0",
    computeExit({ hasStatus: true, red: assessTarget(unparsed).red, anyStale: false, anyUnresolved: true }),
    1,
  );

  if (failures > 0) {
    console.error(`\n${failures} selftest failure(s).`);
    process.exit(1);
  }
  console.log("\nselftest passed.");
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) selftest();
else main(argv);
