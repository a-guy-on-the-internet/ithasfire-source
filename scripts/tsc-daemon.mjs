#!/usr/bin/env node
// tsc-daemon — ONE warm `tsc --watch` per typecheck target, for the whole
// checkout, so that N concurrent sessions stop each spawning N x 6 cold
// compilers at 8GB apiece.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
//
// This reports the WORKING TREE. It cannot tell you whether your COMMIT will
// build. Those two disagree more often than feels reasonable on this repo: a
// spliced hunk that was never staged, and a generated Prisma client reflecting
// an uncommitted schema, each produced a green tree over a red commit on the
// same day. It is also a SHARED checkout — the errors it reports are every
// session's work-in-progress blended together (`pnpm tsc:status --mine`
// narrows that to your own dirty files).
//
// It is a fast working-tree signal. It is not a commit gate. `pnpm typecheck`
// and `pnpm typecheck:all` remain the gate, and CI remains the verdict.
// ---------------------------------------------------------------------------
//
// Usage:
//   node scripts/tsc-daemon.mjs                 start (foreground)
//   node scripts/tsc-daemon.mjs --targets=a,b   start a subset
//   node scripts/tsc-daemon.mjs --targets a,b   (same; both forms accepted)
//   node scripts/tsc-daemon.mjs stop            stop the running daemon
//   pnpm tsc:status                             read the result
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_DIR, TYPECHECK_TARGETS } from "./typecheck-targets.mjs";
import { createScanCache, watermarkFrom } from "./lib/tsc-source-scan.mjs";
import { classifyLine } from "./lib/tsc-watch-parse.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE = path.join(REPO_ROOT, CACHE_DIR);
const PID_FILE = path.join(CACHE, "daemon.pid");
const STATUS_FILE = path.join(CACHE, "status.json");
// The daemon keeps its build info SEPARATE from the one `pnpm typecheck:all`
// uses. A watcher rewrites its buildinfo every cycle; sharing it with ad-hoc
// CLI runs would have the two sides continuously invalidating each other.
const WATCH_CACHE = path.join(CACHE, "watch");

const STATUS_CAVEAT =
  "Working-tree signal, not a commit gate: this reflects uncommitted files " +
  "from every session sharing this checkout.";

// --- pidfile ---------------------------------------------------------------

/** Is `pid` a live tsc-daemon, or a stale entry from a crashed predecessor? */
function inspectPid(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // ESRCH: no such process — the predecessor crashed without cleaning up.
    if (err.code === "ESRCH") return { alive: false, reason: "no such process" };
    // EPERM means the PID exists but belongs to another user. That is NOT
    // enough to call it alive: PIDs get recycled, and a pidfile naming a
    // root-owned recycler (pid 1 being the easy case) would lock this checkout
    // out forever. Fall through and identify it like any other PID.
    if (err.code !== "EPERM") throw err;
  }
  // The PID exists — but a stale pidfile pointing at whatever reclaimed the
  // number must not block startup, so require the process to actually BE one.
  let command = "";
  try {
    command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    // `ps` exiting non-zero means "no such pid" — a corpse, safe to clear.
    // `ps` failing to EXEC at all (ENOENT on a stripped image) proves nothing,
    // and clearing the pidfile on that would evict a LIVE daemon. When we
    // cannot identify it, we defer to it.
    if (err && (err.code === "ENOENT" || err.code === "EACCES")) {
      return { alive: true, reason: `could not run ps (${err.code}); assuming alive` };
    }
    return { alive: false, reason: "process gone during inspection" };
  }
  if (!command) return { alive: false, reason: "process gone during inspection" };
  if (!command.includes("tsc-daemon")) {
    return { alive: false, reason: `pid recycled by: ${command.slice(0, 80)}` };
  }
  return { alive: true, reason: command.slice(0, 80) };
}

function readPidFile() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

function acquireLock() {
  fs.mkdirSync(CACHE, { recursive: true });
  const existing = readPidFile();
  if (existing && Number.isInteger(existing.pid)) {
    const state = inspectPid(existing.pid);
    if (state.alive) {
      console.error(
        `tsc-daemon is already running for this checkout (pid ${existing.pid}, started ${existing.startedAt}).\n` +
          `  ${state.reason}\n` +
          `Read it with:  pnpm tsc:status\n` +
          `Stop it with:  node scripts/tsc-daemon.mjs stop`,
      );
      process.exit(1);
    }
    console.error(
      `[tsc-daemon] clearing stale pidfile for pid ${existing.pid} (${state.reason})`,
    );
  }
  writePidFileExclusive();
}

/**
 * Create the pidfile with O_EXCL. read-then-write was a TOCTOU: with eight
 * sessions on one checkout, two starting in the same window both saw no live
 * pidfile, both proceeded, and the second one's pidfile orphaned the first
 * daemon permanently (`stop` could only ever find one of them).
 */
function writePidFileExclusive() {
  const payload = JSON.stringify(
    { pid: process.pid, startedAt: new Date().toISOString(), repoRoot: REPO_ROOT },
    null,
    2,
  );
  let fd;
  try {
    fd = fs.openSync(PID_FILE, "wx");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Somebody created it between our inspection and now. Whoever that is owns
    // the lock: re-inspect and either defer to them or clear a corpse and retry.
    const other = readPidFile();
    const state = other && Number.isInteger(other.pid) ? inspectPid(other.pid) : null;
    if (state && state.alive) {
      console.error(
        `tsc-daemon started in another process while this one was booting ` +
          `(pid ${other.pid}). Deferring to it.\n` +
          `Read it with:  pnpm tsc:status`,
      );
      process.exit(1);
    }
    fs.rmSync(PID_FILE, { force: true });
    fd = fs.openSync(PID_FILE, "wx");
  }
  try {
    fs.writeFileSync(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
}

function releaseLock() {
  const existing = readPidFile();
  if (existing && existing.pid === process.pid) {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* already gone */
    }
  }
}

// --- status file -----------------------------------------------------------

let statusSeq = 0;

/** Write status.json so a reader can NEVER observe a half-written file. */
function writeStatusAtomic(status) {
  fs.mkdirSync(CACHE, { recursive: true });
  const tmp = path.join(CACHE, `.status.${process.pid}.${statusSeq++}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  // rename(2) within one directory is atomic: readers see the old file or the
  // new one, never a partial.
  fs.renameSync(tmp, STATUS_FILE);
}

// --- tsc watch output parsing ----------------------------------------------

// Line classification lives in ./lib/tsc-watch-parse.mjs so it can be unit
// tested: it is the component whose silent failure looks like a clean tree.

function toRepoRelative(file, cwd) {
  const abs = path.resolve(cwd, file);
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

// --- the daemon ------------------------------------------------------------

/** `--targets=a,b` and `--targets a,b` both mean the same thing. */
function parseTargetsArg(argv) {
  const joined = argv.find((a) => a.startsWith("--targets="));
  if (joined) return splitKeys(joined.slice("--targets=".length));
  const index = argv.indexOf("--targets");
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith("-")) {
    return splitKeys(argv[index + 1]);
  }
  return null;
}

function splitKeys(value) {
  return value
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function main(argv) {
  if (argv.includes("stop")) return stop();

  // Both `--targets=a,b` and `--targets a,b` are accepted. Taking only the
  // `=` form meant the space form documented above parsed as `undefined` and
  // started ALL SIX cold compilers — the exact 8GB spike this script exists to
  // remove, triggered by following its own usage line.
  const wanted = parseTargetsArg(argv);
  const targets = wanted
    ? TYPECHECK_TARGETS.filter((t) => wanted.includes(t.key))
    : TYPECHECK_TARGETS;
  if (wanted) {
    const unknown = wanted.filter((k) => !TYPECHECK_TARGETS.some((t) => t.key === k));
    if (unknown.length > 0) {
      console.error(
        `Unknown target(s): ${unknown.join(", ")}\n` +
          `Known targets: ${TYPECHECK_TARGETS.map((t) => t.key).join(", ")}`,
      );
      process.exit(1);
    }
  }
  if (targets.length === 0) {
    console.error(
      `No targets matched --targets. Known: ${TYPECHECK_TARGETS.map((t) => t.key).join(", ")}`,
    );
    process.exit(1);
  }

  acquireLock();
  fs.mkdirSync(WATCH_CACHE, { recursive: true });

  const scan = createScanCache(REPO_ROOT, 500);
  const startedAt = new Date().toISOString();
  const state = new Map();
  for (const t of targets) {
    state.set(t.key, {
      name: t.name,
      project: t.project,
      state: "checking",
      diagnostics: [],
      errorCount: 0,
      cycleStartedAt: null,
      cycleFinishedAt: null,
      durationMs: null,
      watermark: null,
    });
  }

  const publish = () => {
    writeStatusAtomic({
      version: 1,
      caveat: STATUS_CAVEAT,
      pid: process.pid,
      repoRoot: REPO_ROOT,
      startedAt,
      updatedAt: new Date().toISOString(),
      targets: Object.fromEntries(state),
    });
  };
  publish();

  let shuttingDown = false;
  const children = [];

  const startWatcher = (target) => {
    const entry = state.get(target.key);
    let pending = [];
    let cycleStartMs = null;

    const child = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, "node_modules/typescript/bin/tsc"),
        "-p",
        target.project,
        "--noEmit",
        "--watch",
        "--pretty",
        "false",
        // Without this, watch mode rewrites the screen between cycles and we
        // can lose lines.
        "--preserveWatchOutput",
        "--incremental",
        "--tsBuildInfoFile",
        path.join(WATCH_CACHE, `${target.key}.tsbuildinfo`),
      ],
      {
        cwd: REPO_ROOT,
        // tsc pulls the whole transitive graph through the checker and dies on
        // the default heap at exit 134. Same budget scripts/typecheck-all.mjs
        // uses.
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);

    const handleLine = (raw) => {
      const event = classifyLine(raw);

      if (event.kind === "cycle-start") {
        cycleStartMs = Date.now();
        pending = [];
        entry.state = "checking";
        entry.cycleStartedAt = new Date(cycleStartMs).toISOString();
        // The watermark is taken when the cycle STARTS, not when it ends: a
        // file saved mid-compile may not be in this result, and reporting
        // stale is the safe direction to be wrong in. Clamped to the cycle
        // clock so a future-dated file cannot pin us "fresh" forever.
        entry.watermark = watermarkFrom(scan(target.sourceRoots), cycleStartMs);
        publish();
        return;
      }

      if (event.kind === "cycle-end") {
        entry.diagnostics = pending;
        entry.errorCount = pending.filter((d) => d.severity === "error").length;
        entry.cycleFinishedAt = new Date().toISOString();
        entry.durationMs = cycleStartMs ? Date.now() - cycleStartMs : null;
        // tsc's own count is the authority on whether this cycle was clean.
        // When our parse under-counts, the difference is recorded as
        // UNATTRIBUTED and `tsc:status` must refuse to call the target clean —
        // an error we failed to parse is still an error.
        entry.reportedErrorCount = event.errorCount;
        if (event.errorCount !== entry.errorCount) {
          entry.state = "errors";
          entry.parseWarning =
            `tsc reported ${event.errorCount} error(s); ${entry.errorCount} were ` +
            `parsed into structured records.`;
        } else {
          entry.state = entry.errorCount > 0 ? "errors" : "clean";
          delete entry.parseWarning;
        }
        publish();
        return;
      }

      if (event.kind === "diagnostic") {
        pending.push({
          ...event.record,
          file: event.record.file ? toRepoRelative(event.record.file, REPO_ROOT) : null,
        });
        return;
      }

      if (event.kind === "continuation" && pending.length > 0) {
        pending[pending.length - 1].message += ` ${event.text}`;
      }
    };

    // stdout and stderr get SEPARATE line buffers. Feeding both into one
    // buffer let a stderr write land between a partial stdout chunk and its
    // continuation, splicing two half-lines into one that matched no regex:
    // the diagnostic vanished while tsc's trailer still said the tree was red.
    const streamReader = () => {
      let buffer = "";
      return (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) handleLine(raw);
      };
    };

    child.stdout.on("data", streamReader());
    child.stderr.on("data", streamReader());
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      entry.state = "crashed";
      entry.exitCode = code;
      entry.signal = signal;
      entry.cycleFinishedAt = new Date().toISOString();
      publish();
      console.error(`[tsc-daemon] ${target.name} exited (code ${code}, signal ${signal})`);
    });

    console.error(`[tsc-daemon] watching ${target.name} (${target.project})`);
  };

  // Staggered, not a synchronous burst. Spawning all six 8GB compilers in one
  // loop makes daemon boot its own thundering herd — the spike this script
  // exists to remove. The timers are deliberately NOT unref'd: before the first
  // child exists there is nothing else holding the event loop open.
  const STAGGER_MS = 1500;
  targets.forEach((target, index) => {
    if (index === 0) {
      startWatcher(target);
      return;
    }
    setTimeout(() => {
      if (shuttingDown) return;
      startWatcher(target);
    }, index * STAGGER_MS);
  });

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`\n[tsc-daemon] ${signal} — stopping ${children.length} watcher(s)`);
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    releaseLock();
    setTimeout(() => {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      process.exit(0);
    }, 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", releaseLock);

  console.error(
    `[tsc-daemon] pid ${process.pid} — ${STATUS_CAVEAT}\n` +
      `[tsc-daemon] read with: pnpm tsc:status`,
  );
}

function stop() {
  const existing = readPidFile();
  if (!existing) {
    console.log("tsc-daemon is not running (no pidfile).");
    return;
  }
  const state = inspectPid(existing.pid);
  if (!state.alive) {
    fs.unlinkSync(PID_FILE);
    console.log(`Removed stale pidfile for pid ${existing.pid} (${state.reason}).`);
    return;
  }
  process.kill(existing.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  const poll = () => {
    if (!inspectPid(existing.pid).alive) {
      console.log(`Stopped tsc-daemon (pid ${existing.pid}).`);
      return;
    }
    if (Date.now() > deadline) {
      process.kill(existing.pid, "SIGKILL");
      console.log(`Force-killed tsc-daemon (pid ${existing.pid}).`);
      return;
    }
    setTimeout(poll, 200);
  };
  setTimeout(poll, 200);
}

main(process.argv.slice(2));
