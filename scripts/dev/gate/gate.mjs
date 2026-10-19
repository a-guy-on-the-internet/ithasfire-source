// Machine-wide gate: a counting semaphore that queues tests, e2e, builds and
// typecheck so ~20 sessions sharing one Mac cannot stack them (2026-10-14: the
// Docker VM hit load ~60 on 12 CPUs and the dev Postgres crash-looped for hours).
// Spec: docs/specs/2026-10-14/queued-testing.spec.yaml.
//
// Slots: 1 heavy + 3 light (+ 4 session, below), as files in
// /tmp/tickethunter-gate (NOT $TMPDIR, which differs per process on macOS):
// heavy-0, light-0, light-1, light-2, session-0..3.
//
// - A slot is a SYMLINK whose target is the payload
//   "<pid> <start-ms> {json: weight, cwd, cmd}". `symlink(2)` is atomic and
//   carries the holder in the same step, so there is no window with a held slot
//   but no owner. macOS has no flock.
// - The holder heartbeats by touching the link's own mtime (lutimes) every few
//   seconds, so a slow run that is still alive is never taken over.
// - The pools are independent: heavy waits only for the heavy slot and does not
//   consume a light one, so at most 1 + 3 = 4 gated runs execute at once and a
//   heavy run never waits behind a stream of light ones (no starvation). Under
//   memory pressure they share one budget (see Memory below).
// - Fair within a pool: each waiter writes waiters/<weight>.<pid>.json and
//   refreshes its mtime every poll; a waiter only tries for a slot when fewer
//   live waiters queued before it than there are free slots (FIFO). A waiter
//   whose PID is gone, or whose heartbeat is older than WAITER_STALE_MS, is
//   ignored, so a crashed (even SIGKILLed) waiter cannot wedge the queue.
// - Stale slot, taken over loudly by the next waiter:
//     * holder PID gone (immediately);
//     * holder PID alive but started AFTER the slot was taken: the PID was
//       reused after a SIGKILL (checked with `ps -o lstart=` only once the
//       heartbeat is late, so a healthy holder costs no `ps`);
//     * no heartbeat for GATE_HEARTBEAT_STALE_SECS (120): hung or stopped;
//     * held longer than GATE_MAX_AGE_SECS (3 h; sessions 8 h), heartbeat or not.
//   Takeover renames the slot aside (atomic, one winner) and re-checks the
//   payload; a slot that changed in between is put back. A narrow race can let
//   two holders share a slot: it costs throughput, never an exit code, and the
//   next takeover heals it.
// - Re-entrant: GATE_LOCK_HELD=<pid>, where <pid> is alive and holds a slot of
//   the requested weight or heavier, means an ancestor already holds the budget
//   for this work: run without a slot (nested gates such as `pnpm typecheck:all`
//   → `pnpm typecheck`, or a pre-push test section → its vitest runs, cannot
//   deadlock on their parent). This path trusts the env var with no ancestry
//   check: a real nested child wrongly denied would wait for the slot its own
//   parent holds, a true deadlock, so a detached process carrying the var (e.g.
//   from a vitest run) also runs slotless while that holder lives. A LIGHT
//   holder's child asking for HEAVY takes a heavy slot, but spends its parent's
//   budget: see "priority inheritance" under Memory (it skips the heavy FIFO
//   and the memory rule; only there is ancestry checked).
// - Bypass: CI=true/1 or GATE_LOCK=0.
// - Memory (2026-10-15: pressure sat at "warn" for hours with swap 18.5/19.4 GB
//   full, and the slot rule still let 4 runs stack on the thrashing machine).
//   While `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical)
//   is at or above GATE_MEM_LEVEL, at most GATE_MEM_RUNS heavy+light runs
//   execute, whatever slots are free. The check runs only for a waiter that
//   already has a slot in its own pool (so a run nobody would admit costs no
//   sysctl) and reads pressure at most once per ~3 s per process. Under the cap
//   the memory budget is shared FIFO across heavy and light: the waiter is
//   admitted only while running + (eligible waiters queued before it) <
//   GATE_MEM_RUNS, where "eligible" means a same-pool waiter ahead of it, or an
//   other-pool waiter that is within its own pool's free/stale slot count. So
//   a heavy run that queued first beats a later light run to the freed budget.
//   With ZERO gated runs executing, the first eligible waiter is always admitted:
//   the machine can sit at warn for hours and the queue must still move.
//   Two exits from the budget keep one run from wedging everyone:
//     * a child whose GATE_LOCK_HELD names a live heavy/light holder spends its
//       parent's budget (priority inheritance): no memory check at all, AND it
//       ignores the FIFO of its own pool, needing only a free or stale slot.
//       Anything less cycles: excluding only the parent from "running" lets the
//       child yield to an earlier waiter that the parent blocks, and same-pool
//       FIFO lets an earlier heavy waiter (blocked by the light parent) hold
//       the child back. Only a HEAVY child of a LIGHT holder can be exempt
//       (every other nesting is re-entrant and takes no slot), and heavy has
//       one slot, so nesting exceeds the memory cap by at most +1 run. The
//       holder must also be an ANCESTOR of the child (one `ps` snapshot per
//       acquire, on this path only; `ps` failing = inherit, since a refused
//       real child deadlocks), so a HEAVY request that merely inherited the
//       env var (detached from a vitest run) queues in the heavy FIFO and the
//       memory rule. Only a heavy request can inherit: a session never does;
//     * a holder older than GATE_MEM_HOLD_SECS (20 min) stops counting toward
//       the budget (a vitest hung on an open handle keeps heartbeating, a long
//       e2e is legitimate; neither should block every gated run for 3 h). Waiter
//       notes and gate:status name it ("PID n held 25m, no longer counted").
//   Two waiters that read "0 running" in the same instant can both start (the
//   same race as the slot rule): it costs memory for one run, never an exit
//   code. Pressure unknown (not macOS, sysctl failed) = no memory rule.
// - Sessions: a third pool, `session` (GATE_SESSION_SLOTS, 4), for headless
//   `claude -p` sessions started by .claude/skills/handoff/launch.sh, so a
//   handoff fan-out cannot start six at once. It ranks BELOW light: a session
//   holder never makes a child's heavy/light request re-entrant, run.mjs does
//   not export GATE_LOCK_HELD to a session's child (its tests queue like
//   anyone's), and a session request is never re-entrant itself. Sessions are
//   outside the memory rule both ways (not counted, not capped), and their
//   ceiling is GATE_SESSION_MAX_AGE_SECS (8 h) instead of 3 h: a headless turn
//   can hang on a background task indefinitely, and four such sessions must not
//   hold the pool for a day. A session's
//   staleness otherwise works as above: run.mjs stays the parent of `claude`
//   and heartbeats for as long as it runs.
// - Backward compatible: payloads and waiter files written by older versions
//   parse unchanged. A slot's weight comes from its NAME (heavy-0, session-2),
//   not its payload, so an old payload without a weight still gets the right
//   ceiling.
//
// Knobs: GATE_DIR, GATE_HEAVY_SLOTS (1), GATE_LIGHT_SLOTS (3),
// GATE_SESSION_SLOTS (4), GATE_POLL_MS (1000, clamped 20..5000),
// GATE_NOTIFY_SECS (30), GATE_HEARTBEAT_STALE_SECS (120), GATE_MAX_AGE_SECS
// (10800, heavy and light), GATE_SESSION_MAX_AGE_SECS (28800), GATE_MEM (0 =
// no memory rule), GATE_MEM_LEVEL (2), GATE_MEM_RUNS (1), GATE_MEM_HOLD_SECS
// (1200: older holders stop counting toward the budget), GATE_PRESSURE_FILE
// (tests: read the pressure level from this file on every check, no cache;
// missing file = 1), GATE_SWAP_TEXT (tests, with GATE_PRESSURE_FILE: the swap
// figure to print).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DIR = "/tmp/tickethunter-gate";
export const WEIGHTS = ["heavy", "light", "session"];
// The pools the memory rule counts and caps.
const MEM_WEIGHTS = ["heavy", "light"];
const RANK = { session: 0, light: 1, heavy: 2 };
const WAITER_STALE_MS = 15_000;
// Symlink targets are capped (~1023 bytes on macOS): a long command must not
// make symlink() fail on a free slot.
const MAX_CMD = 200;
const MAX_CWD = 300;

const posInt = (v, d) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function gateConfig(env = process.env) {
  // Poll well inside WAITER_STALE_MS, so a waiter never looks stale to itself.
  const pollMs = clamp(posInt(env.GATE_POLL_MS, 1000), 20, Math.floor(WAITER_STALE_MS / 3));
  const heartbeatStaleMs = posInt(env.GATE_HEARTBEAT_STALE_SECS, 120) * 1000;
  return {
    dir: env.GATE_DIR || DEFAULT_DIR,
    counts: {
      heavy: posInt(env.GATE_HEAVY_SLOTS, 1),
      light: posInt(env.GATE_LIGHT_SLOTS, 3),
      session: posInt(env.GATE_SESSION_SLOTS, 4),
    },
    pollMs,
    notifyMs: posInt(env.GATE_NOTIFY_SECS, 30) * 1000,
    heartbeatStaleMs,
    // Holders touch their link at least 4x per stale window.
    beatMs: clamp(Math.floor(heartbeatStaleMs / 4), 50, 5000),
    // A heartbeat this late is suspicious enough to pay for a `ps` call.
    suspectMs: Math.min(10_000, Math.floor(heartbeatStaleMs / 2)),
    maxAgeMs: posInt(env.GATE_MAX_AGE_SECS, 10_800) * 1000,
    sessionMaxAgeMs: posInt(env.GATE_SESSION_MAX_AGE_SECS, 28_800) * 1000,
    mem: {
      enabled: env.GATE_MEM !== "0",
      level: posInt(env.GATE_MEM_LEVEL, 2),
      runs: posInt(env.GATE_MEM_RUNS, 1),
      holdMs: posInt(env.GATE_MEM_HOLD_SECS, 1200) * 1000,
    },
  };
}

/** The holding ceiling for a slot of `weight` (unknown weights get heavy/light's). */
export function maxAgeFor(weight, cfg) {
  return weight === "session" ? cfg.sessionMaxAgeMs : cfg.maxAgeMs;
}

/** "heavy-0" → "heavy"; anything else → null. */
export function slotWeight(name) {
  const m = /^([a-z]+)-\d+$/.exec(path.basename(String(name)));
  return m && WEIGHTS.includes(m[1]) ? m[1] : null;
}

// ── memory pressure ─────────────────────────────────────────────────────────
const PRESSURE_LABEL = { 1: "normal", 2: "warn", 4: "critical" };
const PRESSURE_CACHE_MS = 3000;
let pressureCache = null;
let swapCache = null;

function sysctl(name) {
  return execFileSync("sysctl", ["-n", name], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();
}

/** "total = 19456.00M  used = 18944.25M ..." → "18.5G/19.0G", or null. */
export function formatSwap(text) {
  const num = (key) => {
    const m = new RegExp(`${key} = ([\\d.]+)([KMG])`).exec(text ?? "");
    if (!m) return NaN;
    return Number(m[1]) * { K: 1 / 1024 / 1024, M: 1 / 1024, G: 1 }[m[2]];
  };
  const used = num("used");
  const total = num("total");
  if (!Number.isFinite(used) || !Number.isFinite(total)) return null;
  return `${used.toFixed(1)}G/${total.toFixed(1)}G`;
}

function cachedSwap() {
  const now = Date.now();
  if (swapCache && now - swapCache.at < PRESSURE_CACHE_MS) return swapCache.value;
  let value = null;
  try {
    value = formatSwap(sysctl("vm.swapusage"));
  } catch {
    // unknown
  }
  swapCache = { at: now, value };
  return value;
}

/**
 * { level, label, swap } or null when unknown. `swap` ("18.4G/19.4G", or null)
 * is a lazy getter: only a caller that prints it forks the second sysctl.
 */
export function memoryPressure(env = process.env) {
  let level;
  let swap = () => null;
  if (env.GATE_PRESSURE_FILE) {
    level = 1;
    try {
      const n = Number.parseInt(fs.readFileSync(env.GATE_PRESSURE_FILE, "utf8").trim(), 10);
      if (Number.isInteger(n) && n > 0) level = n;
    } catch {
      // missing file = normal
    }
    swap = () => env.GATE_SWAP_TEXT ?? null;
  } else {
    if (process.platform !== "darwin") return null;
    const now = Date.now();
    if (!pressureCache || now - pressureCache.at >= PRESSURE_CACHE_MS) {
      let value = null;
      try {
        const n = Number.parseInt(sysctl("kern.memorystatus_vm_pressure_level"), 10);
        if (Number.isInteger(n) && n > 0) value = n;
      } catch {
        // unknown
      }
      pressureCache = { at: now, value };
    }
    if (pressureCache.value == null) return null;
    level = pressureCache.value;
    swap = cachedSwap;
  }
  return {
    level,
    label: PRESSURE_LABEL[level] ?? `level ${level}`,
    get swap() {
      return swap();
    },
  };
}

export function isBypassed(env = process.env) {
  return env.CI === "true" || env.CI === "1" || env.GATE_LOCK === "0";
}

export function slotNames(weight, cfg) {
  return Array.from({ length: cfg.counts[weight] }, (_, i) => `${weight}-${i}`);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// `ps` results, keyed by "<pid> <slot start>", reused for PS_CACHE_MS so a
// waiter polling a suspect slot does not fork `ps` on every poll.
const PS_CACHE_MS = 5000;
const psCache = new Map();
function cachedPidStartMs(pid, slotStart) {
  const key = `${pid} ${slotStart}`;
  const hit = psCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < PS_CACHE_MS) return hit.value;
  const value = pidStartMs(pid);
  psCache.set(key, { at: now, value });
  if (psCache.size > 64) psCache.delete(psCache.keys().next().value);
  return value;
}

/** Start time of a live PID in epoch ms (1 s resolution), or NaN if unknown. */
export function pidStartMs(pid) {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? Date.parse(out) : NaN;
  } catch {
    return NaN;
  }
}

export function fmtAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${s}s`;
}

function makePayload(pid, startMs, weight, cwd, cmd) {
  const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ");
  const build = (cwdMax, cmdMax) =>
    `${pid} ${startMs} ${JSON.stringify({
      weight,
      cwd: oneLine(cwd).slice(0, cwdMax),
      cmd: oneLine(cmd).slice(0, cmdMax),
    })}`;
  const full = build(MAX_CWD, MAX_CMD);
  // JSON escaping can grow the text; stay well under the symlink-target cap.
  return full.length <= 900 ? full : build(120, 80);
}

export function parsePayload(raw) {
  const m = /^(\d+) (\d+) (.*)$/s.exec(raw);
  if (!m) return { raw, pid: NaN, start: NaN, cwd: "?", cmd: raw, weight: "?" };
  let meta = {};
  try {
    meta = JSON.parse(m[3]);
  } catch {
    meta = { cmd: m[3] };
  }
  return {
    raw,
    pid: Number(m[1]),
    start: Number(m[2]),
    cwd: meta.cwd ?? "?",
    cmd: meta.cmd ?? "?",
    weight: meta.weight ?? "?",
  };
}

/** null = free; {invalid:true} = something that is not a gate symlink. */
export function readSlot(file) {
  let raw;
  try {
    raw = fs.readlinkSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err.code === "EINVAL") return { invalid: true, file };
    throw err;
  }
  let beat = NaN;
  try {
    beat = fs.lstatSync(file).mtimeMs;
  } catch {
    // Vanished between the two calls: treat the read as current.
    beat = Date.now();
  }
  return { ...parsePayload(raw), beat, slotWeight: slotWeight(file) };
}

export function staleReason(holder, now, cfg) {
  if (!holder || holder.invalid) return null;
  if (!pidAlive(holder.pid)) return "holder gone";
  const maxAge = maxAgeFor(holder.slotWeight ?? holder.weight, cfg);
  if (Number.isFinite(holder.start) && now - holder.start > maxAge) {
    return `over the ${fmtAge(maxAge)} ceiling`;
  }
  const beatAge = Number.isFinite(holder.beat) ? now - holder.beat : 0;
  if (beatAge > cfg.heartbeatStaleMs) return `no heartbeat for ${fmtAge(beatAge)}`;
  if (beatAge > cfg.suspectMs && Number.isFinite(holder.start)) {
    const started = cachedPidStartMs(holder.pid, holder.start);
    // lstart has 1 s resolution; the real holder started before it took the slot.
    if (Number.isFinite(started) && started > holder.start + 1000) {
      return "PID reused: that process started after the slot was taken";
    }
  }
  return null;
}

/** Live waiters (heartbeat fresh, PID alive), any weight, oldest first. */
export function readWaiters(cfg, now = Date.now()) {
  const wdir = path.join(cfg.dir, "waiters");
  let names = [];
  try {
    names = fs.readdirSync(wdir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(wdir, name);
    try {
      const st = fs.statSync(file);
      const w = JSON.parse(fs.readFileSync(file, "utf8"));
      if (now - st.mtimeMs > WAITER_STALE_MS || !pidAlive(w.pid)) continue;
      out.push({ ...w, file });
    } catch {
      // Half-written or vanished: ignore.
    }
  }
  return out.sort((a, b) => a.since - b.since || a.pid - b.pid);
}

/** The weight of the slot `pid` holds, or null. */
function heldWeight(pid, cfg) {
  for (const w of WEIGHTS) {
    for (const s of slotNames(w, cfg)) {
      try {
        if (readSlot(path.join(cfg.dir, s))?.pid === pid) return w;
      } catch {
        // unreadable slot: not evidence of anything
      }
    }
  }
  return null;
}

function describe(holders, now) {
  return holders.map((h) => `PID ${h.pid} (${h.cmd}, ${fmtAge(now - h.start)})`).join(", ");
}

const before = (a, b) => a.since < b.since || (a.since === b.since && a.pid < b.pid);

/**
 * Read every slot of `weight`: live holders, and candidates (free, or stale
 * with the reason). `strict` throws on a non-gate file (the caller's own pool);
 * otherwise such a slot is skipped.
 */
function scanPool(weight, cfg, now, strict) {
  const holders = [];
  const candidates = [];
  for (const name of slotNames(weight, cfg)) {
    const file = path.join(cfg.dir, name);
    let h;
    try {
      h = readSlot(file);
    } catch (err) {
      if (strict) throw err;
      continue;
    }
    if (h?.invalid) {
      if (strict) {
        throw new Error(`${file} exists but is not a gate slot link; remove it (rm -rf ${file}) and retry`);
      }
      continue;
    }
    if (!h) {
      candidates.push({ file });
      continue;
    }
    const why = staleReason(h, now, cfg);
    if (why) candidates.push({ file, stale: h, why });
    else holders.push(h);
  }
  return { holders, candidates };
}

/** True when `parent` (GATE_LOCK_HELD) is a live, non-stale heavy/light holder. */
function parentHoldsBudget(parent, cfg, now, pools) {
  if (!parent) return false;
  return MEM_WEIGHTS.some((w) => (pools[w] ??= scanPool(w, cfg, now, false)).holders.some((h) => h.pid === parent));
}

const MAX_ANCESTRY_HOPS = 64;

/**
 * Whether `ancestor` is on the ppid chain above `ppid` (inclusive), per a
 * "pid ppid" snapshot. false when the chain reaches pid 1 (a detached process
 * whose parent died is reparented to launchd), leaves the snapshot, loops, or
 * runs past MAX_ANCESTRY_HOPS.
 */
export function isAncestorIn(psText, ancestor, ppid) {
  const parentOf = new Map();
  for (const line of String(psText).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) parentOf.set(Number(m[1]), Number(m[2]));
  }
  let p = ppid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && p > 1; hop++) {
    if (p === ancestor) return true;
    p = parentOf.get(p);
    if (p === undefined) return false;
  }
  return false;
}

/**
 * Whether `ancestor` is an ancestor of this process: true/false, or null when
 * `ps` failed. One `ps` fork, skipped when it is the direct parent.
 */
export function isAncestor(ancestor) {
  if (ancestor === process.ppid) return true;
  let out;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  return isAncestorIn(out, ancestor, process.ppid);
}

/**
 * Live heavy/light holders split into those that count toward the memory
 * budget and those held past GATE_MEM_HOLD_SECS, which no longer do.
 */
function budgetHolders(holders, cfg, now) {
  const running = [];
  const overAge = [];
  for (const h of holders) {
    if (Number.isFinite(h.start) && now - h.start > cfg.mem.holdMs) overAge.push(h);
    else running.push(h);
  }
  return { running, overAge };
}

/**
 * The memory rule for a waiter `me` ({pid, since, weight, parent}) that already
 * has a slot in its own pool; `parent` is the PID named by GATE_LOCK_HELD, if
 * any. null = admit; otherwise why it waits: { pressure, running: [holders],
 * overAge: [holders no longer counted], ahead: [waiters competing for the
 * budget] }. `pools` caches scanPool results the caller already has.
 */
function memoryBlock(me, cfg, env, now, waiters, pools) {
  if (!cfg.mem.enabled || !MEM_WEIGHTS.includes(me.weight)) return null;
  const pool = (w) => (pools[w] ??= scanPool(w, cfg, now, false));
  const live = MEM_WEIGHTS.flatMap((w) => pool(w).holders);
  // An ancestor holding heavy/light is waiting on me: its budget is mine. The
  // caller passes `parent` only once it is an ancestor, or ancestry could not
  // be checked.
  if (me.parent && live.some((h) => h.pid === me.parent)) return null;
  const { running, overAge } = budgetHolders(live, cfg, now);
  // The budget is only contested once something runs or someone else waits.
  const others = waiters.filter((w) => w.pid !== me.pid && MEM_WEIGHTS.includes(w.weight) && before(w, me));
  if (running.length === 0 && others.length === 0) return null;
  const pressure = memoryPressure(env);
  if (!pressure || pressure.level < cfg.mem.level) return null;
  // Waiters queued before me that would take the budget first: everyone ahead
  // in my pool (I am eligible, so they are), and, in the other pool, those
  // within its free/stale slot count.
  const ahead = [];
  for (const w of MEM_WEIGHTS) {
    const queue = waiters.filter((x) => x.weight === w && x.pid !== me.pid);
    const eligible = w === me.weight ? queue : queue.slice(0, pool(w).candidates.length);
    ahead.push(...eligible.filter((x) => before(x, me)));
  }
  if (running.length + ahead.length < cfg.mem.runs) return null;
  return { pressure, running, overAge, ahead };
}

const describeOverAge = (holders, now) =>
  holders.map((h) => `PID ${h.pid} held ${fmtAge(now - h.start)}, no longer counted`).join("; ");

function memoryNote(block, cfg, now) {
  const { pressure, running, overAge, ahead } = block;
  const swap = pressure.swap;
  const runs = `${cfg.mem.runs} gated run${cfg.mem.runs === 1 ? "" : "s"}`;
  const queue = ahead.length
    ? `; queued first for it: ${ahead.map((w) => `PID ${w.pid} (${w.weight})`).join(", ")}`
    : "";
  return (
    `for memory: pressure ${pressure.label}${swap ? `, swap ${swap} used` : ""}; ` +
    `${runs} allowed under pressure, running: ${running.length ? describe(running, now) : "none"}${queue}` +
    (overAge.length ? `; ${describeOverAge(overAge, now)}` : "")
  );
}

/** Every lease held by THIS process, released synchronously on exit. */
const held = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const lease of [...held]) lease.release();
  });
}

function removeIfOurs(file, payload) {
  try {
    if (fs.readlinkSync(file) === payload) fs.unlinkSync(file);
  } catch {
    // Already gone or taken over: nothing of ours to remove.
  }
}

function takeOver(file, judged, why, log) {
  const aside = `${file}.takeover.${process.pid}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // Someone else won the rename, or it is already gone.
  }
  let got = null;
  try {
    got = fs.readlinkSync(aside);
  } catch {
    // fall through
  }
  if (got === judged.raw) {
    log(
      `gate: taking over ${path.basename(file)} from PID ${judged.pid} ` +
        `(${why}; held ${fmtAge(Date.now() - judged.start)}; was: ${judged.cmd})`,
    );
  } else if (got !== null) {
    // A fresh holder replaced the stale one between our read and the rename.
    try {
      fs.symlinkSync(got, file);
    } catch {
      // Slot refilled meanwhile: that holder runs without a file (see header).
    }
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // ignore
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a slot of `weight`. Resolves to a lease:
 *   { held: boolean, slot: string|null, reason?: "bypass"|"reentrant", release() }
 * `release` is idempotent and also runs on process exit.
 */
export async function acquire(weight, opts = {}) {
  if (!WEIGHTS.includes(weight)) throw new Error(`unknown weight "${weight}" (${WEIGHTS.join("|")})`);
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const label = opts.label ?? process.argv.slice(1).join(" ");
  const cwd = opts.cwd ?? process.cwd();
  const cfg = gateConfig(env);
  const noop = (reason) => ({ held: false, slot: null, reason, release() {} });

  if (isBypassed(env)) return noop("bypass");

  // A session request is never re-entrant: each headless session needs its own
  // slot, whoever launched it.
  if (env.GATE_LOCK_HELD && weight !== "session") {
    const ancestor = Number(env.GATE_LOCK_HELD);
    const w = pidAlive(ancestor) ? heldWeight(ancestor, cfg) : null;
    if (w && RANK[w] >= RANK[weight]) return noop("reentrant");
  }

  // Priority inheritance, for a HEAVY request only (light under heavy/light is
  // re-entrant above; a session never inherits). Re-checked every poll: exempt
  // only while the parent holds heavy/light.
  const parent = weight === "heavy" ? Number(env.GATE_LOCK_HELD) || null : null;
  // Inheritance also needs `parent` to be a real ancestor: anything spawned
  // under a holder (a process detached from a vitest run) inherits the env var
  // without being waited on. Asked once, on first need: a living chain cannot
  // gain an ancestor, and an intermediate that exits reparents us to pid 1, so
  // a later walk could wrongly say no; the cached first answer stays correct.
  // `ps` failed (null) = inherit, the pre-ancestry behaviour: a real
  // nested child refused its parent's budget deadlocks against that parent,
  // which is worse than an impostor jumping the queue.
  let ancestry;
  const inheritsFrom = (holds) => {
    if (!holds) return false;
    if (ancestry === undefined) ancestry = isAncestor(parent);
    return ancestry !== false;
  };

  const wdir = path.join(cfg.dir, "waiters");
  fs.mkdirSync(wdir, { recursive: true });
  installExitHook();

  const pid = process.pid;
  const since = Date.now();
  const waiterFile = path.join(wdir, `${weight}.${pid}.json`);
  let waiterWritten = false;
  const dropWaiter = () => {
    if (!waiterWritten) return;
    waiterWritten = false;
    try {
      fs.unlinkSync(waiterFile);
    } catch {
      // ignore
    }
  };
  // While waiting, the waiter file must not outlive us on a normal exit.
  const waitingLease = { release: dropWaiter };
  held.add(waitingLease);

  let queued = false;
  let lastNote = 0;
  let lastReason = null; // "slot" | "memory": what the last note blamed
  let lastChangeNote = -Infinity;
  let payload = null;
  let won = null;
  try {
    for (;;) {
      const now = Date.now();
      payload = makePayload(pid, now, weight, cwd, label);
      // Waiters BEFORE slots: a peer that takes its slot and then drops its
      // waiter file between the two reads is then seen at least once (as a
      // waiter or as a holder), never missed by the memory budget.
      const waiters = readWaiters(cfg, now);
      const pools = { [weight]: scanPool(weight, cfg, now, true) };
      const { holders, candidates } = pools[weight];
      const inherits = inheritsFrom(parentHoldsBudget(parent, cfg, now, pools));
      const ahead = inherits ? 0 : waiters.filter((w) => w.weight === weight && w.pid !== pid && before(w, { pid, since })).length;

      let mem = null;
      if (ahead < candidates.length) {
        mem = memoryBlock({ pid, since, weight, parent: inherits ? parent : null }, cfg, env, now, waiters, pools);
      }
      if (ahead < candidates.length && !mem) {
        for (const c of candidates) {
          if (c.stale) takeOver(c.file, c.stale, c.why, log);
          try {
            fs.symlinkSync(payload, c.file);
            won = c.file;
            break;
          } catch (err) {
            if (err.code !== "EEXIST") {
              throw new Error(`cannot create slot ${c.file}: ${err.message}`);
            }
          }
        }
        if (won) break;
      }

      // Heartbeat (and first write) of the waiter file.
      if (!waiterWritten) {
        const tmp = `${waiterFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ pid, weight, since, cwd, cmd: label.slice(0, MAX_CMD) }));
        fs.renameSync(tmp, waiterFile);
        waiterWritten = true;
      } else {
        try {
          const t = new Date();
          fs.utimesSync(waiterFile, t, t);
        } catch {
          waiterWritten = false; // removed under us (e.g. by a cleanup): rewrite next poll
        }
      }

      // One line when first queued, one per GATE_NOTIFY_SECS, and one at once
      // when the blocking reason flips between slot and memory (at most one
      // such extra line per notify interval, so a flapping reason cannot spam).
      const reason = mem ? "memory" : "slot";
      const changed = queued && reason !== lastReason && now - lastChangeNote >= cfg.notifyMs;
      if (!queued || changed || now - lastNote >= cfg.notifyMs) {
        let why;
        if (mem) {
          why = memoryNote(mem, cfg, now);
        } else {
          const behind = holders.length ? describe(holders, now) : "a slot being freed";
          why = `behind ${behind}${ahead > 0 ? `; ${ahead} waiting ahead` : ""}`;
        }
        log(queued ? `gate: still queued (${weight}, ${fmtAge(now - since)}) ${why}` : `gate: queued (${weight}) ${why}`);
        if (changed) lastChangeNote = now;
        queued = true;
        lastNote = now;
        lastReason = reason;
      }
      // Jitter so a crowd of waiters does not poll in lockstep.
      await sleep(cfg.pollMs + Math.floor(Math.random() * Math.min(250, cfg.pollMs)));
    }
  } finally {
    dropWaiter();
    held.delete(waitingLease);
  }

  const slot = path.basename(won);
  if (queued) log(`gate: acquired ${slot} after ${fmtAge(Date.now() - since)}`);
  const finalPayload = payload;
  // Heartbeat: touch the link itself, only while it is still ours. unref() so a
  // holder that is otherwise done (e.g. vitest after its run) can still exit.
  const beat = setInterval(() => {
    try {
      if (fs.readlinkSync(won) !== finalPayload) return;
      const t = new Date();
      fs.lutimesSync(won, t, t);
    } catch {
      // gone or taken over: nothing to refresh
    }
  }, cfg.beatMs);
  beat.unref();
  const lease = {
    held: true,
    slot,
    release() {
      if (!held.has(lease)) return;
      held.delete(lease);
      clearInterval(beat);
      removeIfOurs(won, finalPayload);
    },
  };
  held.add(lease);
  return lease;
}

/** Snapshot for `pnpm gate:status`. */
export function gateStatus(env = process.env) {
  const cfg = gateConfig(env);
  const now = Date.now();
  const slots = WEIGHTS.flatMap((w) => slotNames(w, cfg)).map((name) => {
    const file = path.join(cfg.dir, name);
    let h = null;
    try {
      h = readSlot(file);
    } catch (err) {
      return { name, error: err.message };
    }
    if (!h) return { name, free: true };
    if (h.invalid) return { name, error: "not a gate slot link" };
    return {
      name,
      pid: h.pid,
      alive: pidAlive(h.pid),
      ageMs: now - h.start,
      beatAgeMs: Number.isFinite(h.beat) ? now - h.beat : null,
      cwd: h.cwd,
      cmd: h.cmd,
      stale: staleReason(h, now, cfg),
    };
  });
  const liveWaiters = readWaiters(cfg, now);
  const waiters = liveWaiters.map((w) => ({
    weight: w.weight,
    pid: w.pid,
    waitedMs: now - w.since,
    cwd: w.cwd,
    cmd: w.cmd,
  }));

  const memSlots = slots.filter((s) => s.pid && !s.stale && MEM_WEIGHTS.includes(slotWeight(s.name)));
  const overAge = memSlots.filter((s) => s.ageMs > cfg.mem.holdMs).map((s) => ({ name: s.name, pid: s.pid, ageMs: s.ageMs }));
  const gatedRuns = memSlots.length - overAge.length;
  const p = cfg.mem.enabled ? memoryPressure(env) : null;
  const memory = {
    enabled: cfg.mem.enabled,
    level: p?.level ?? null,
    label: p?.label ?? null,
    swap: p ? p.swap : null,
    capLevel: cfg.mem.level,
    capRuns: cfg.mem.runs,
    holdMs: cfg.mem.holdMs,
    // Counted toward the budget; `overAge` holders run but no longer count.
    gatedRuns,
    overAge,
    // The cap applies now (pressure at/above the level) and is full.
    underPressure: Boolean(p && p.level >= cfg.mem.level),
    binding: Boolean(p && p.level >= cfg.mem.level && gatedRuns >= cfg.mem.runs),
  };

  const gatedPids = new Set([...slots.filter((s) => s.pid).map((s) => s.pid), ...liveWaiters.map((w) => w.pid)]);
  let ungated = [];
  try {
    ungated = findUngated(psSnapshot(), gatedPids);
  } catch (err) {
    ungated = { error: err.message };
  }
  return { dir: cfg.dir, counts: cfg.counts, slots, waiters, memory, ungated };
}

// ── ungated heavy work ──────────────────────────────────────────────────────
// What gate:status lists under "ungated": a heavy tool started without the
// gate (bare `tsc`, `next build`, `playwright test`). `tsc --watch` is skipped:
// the tsc-daemon's watcher is deliberate. Shells are skipped (see SHELL).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** One `ps` call: "pid ppid etime command" per line. */
export function psSnapshot() {
  return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,etime=,command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** ps etime "[[dd-]hh:]mm:ss" → ms, or NaN. */
export function etimeMs(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime).trim());
  if (!m) return NaN;
  const [, d = 0, h = 0, mi, s] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(s)) * 1000;
}

// A shell's `-c` script is text, not work: it can mention `playwright test`
// while running grep. The tool it starts shows up as its own process.
const SHELL = /^(?:\S*\/)?-?(?:sh|bash|zsh|dash|ksh|fish)$/;

export function isHeavyCommand(cmd) {
  if (SHELL.test(String(cmd).trim().split(/\s+/)[0] ?? "")) return false;
  const c = ` ${cmd} `;
  const tsc = /\/tsc\s/.test(c) || /bin\/tsc\s/.test(c) || /\stsc\s+-p\s/.test(c);
  if (tsc) return !/\s(--watch|-w)(\s|=)/.test(c);
  return /[\s/]next\s+build\s/.test(c) || /[\s/]playwright\s+test\s/.test(c);
}

/**
 * Heavy processes in a `ps` snapshot with no gated ancestor (themselves
 * included): an ancestor running scripts/dev/gate/run.mjs, or one whose PID is
 * in `gatedPids` (slot holders and queued waiters, e.g. a vitest/playwright
 * that took its slot in globalSetup). Only the deepest match of a chain is
 * listed (`sh -c "tsc -p …"` → the tsc under it).
 */
export function findUngated(psText, gatedPids = new Set(), root = REPO_ROOT) {
  const procs = new Map();
  for (const line of psText.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], cmd: m[4] });
  }
  const chain = (p) => {
    const out = [];
    const seen = new Set();
    for (let q = p; q && !seen.has(q.pid); q = procs.get(q.ppid)) {
      seen.add(q.pid);
      out.push(q);
      if (q.ppid === q.pid || q.ppid <= 1) break;
    }
    return out;
  };
  const heavy = [...procs.values()].filter((p) => isHeavyCommand(p.cmd));
  const heavyPids = new Set(heavy.map((p) => p.pid));
  const hasHeavyChild = new Set();
  for (const p of heavy) for (const a of chain(p).slice(1)) if (heavyPids.has(a.pid)) hasHeavyChild.add(a.pid);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return heavy
    .filter((p) => !hasHeavyChild.has(p.pid))
    .filter((p) => !chain(p).some((a) => gatedPids.has(a.pid) || a.cmd.includes("scripts/dev/gate/run.mjs")))
    .map((p) => ({
      pid: p.pid,
      elapsedMs: etimeMs(p.etime),
      cmd: p.cmd.split(prefix).join("").slice(0, 120),
    }));
}
