// Tests for the machine-wide gate. Run: `pnpm gate:test` (node --test; no CI
// job runs it, and CI bypasses the gate anyway). Every test uses its own
// GATE_DIR under the OS temp dir, never the real /tmp/tickethunter-gate.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, "run.mjs");
const dirs = [];

function tmpGate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "th-gate-test-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// GATE_PRESSURE_FILE pins memory pressure for every test (missing file = 1,
// normal), so the real machine's pressure never changes a result.
function baseEnv(dir, extra = {}) {
  const env = {
    ...process.env,
    GATE_DIR: dir,
    GATE_POLL_MS: "50",
    GATE_PRESSURE_FILE: path.join(dir, "pressure"),
    ...extra,
  };
  for (const k of ["CI", "GATE_LOCK", "GATE_LOCK_HELD", "GATE_MEM", "GATE_MEM_LEVEL", "GATE_MEM_RUNS", "GATE_SWAP_TEXT"]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}
const setPressure = (dir, level) => fs.writeFileSync(path.join(dir, "pressure"), `${level}\n`);

function run(args, env, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: ${args.join(" ")}\n${stderr}`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** A PID that is not running: a child that has already exited. */
async function deadPid() {
  const c = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => c.on("exit", r));
  return c.pid;
}

test("exit code passes through unchanged; a signal death becomes 128+n", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir);
  assert.equal((await run(["--weight", "light", "--", "sh", "-c", "exit 7"], env)).code, 7);
  assert.equal((await run(["--weight", "heavy", "--", "sh", "-c", "exit 0"], env)).code, 0);
  assert.equal((await run(["--weight", "heavy", "--", "sh", "-c", "kill -TERM $$"], env)).code, 143);
  assert.equal((await run(["--weight", "heavy", "--", "definitely-not-a-command-xyz"], env)).code, 127);
  // Slot released after each run.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== "waiters" && f !== "pressure"), []);
});

test("argv reaches the command unchanged, including a literal --", async () => {
  const env = baseEnv(tmpGate());
  const r = await run(
    ["--weight", "light", "--", process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "a b", "--", "--bogus"],
    env,
  );
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), ["a b", "--", "--bogus"]);
});

test("five light runs: at most three at once, the rest print queued", async () => {
  const dir = tmpGate();
  const log = path.join(dir, "events.log");
  const env = baseEnv(dir);
  const body = `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"+"+Date.now()+"\\n");` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},"-"+Date.now()+"\\n")},700);`;
  const results = await Promise.all(
    Array.from({ length: 5 }, () => run(["--weight", "light", "--", process.execPath, "-e", body], env)),
  );
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const events = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => ({ d: l[0] === "+" ? 1 : -1, t: Number(l.slice(1)) }))
    .sort((a, b) => a.t - b.t || a.d - b.d); // ends before starts at the same ms
  let running = 0;
  let peak = 0;
  for (const e of events) {
    running += e.d;
    peak = Math.max(peak, running);
  }
  assert.equal(events.length, 10);
  assert.ok(peak <= 3, `peak concurrency ${peak}`);
  const queued = results.filter((r) => /gate: queued \(light\) behind PID \d+/.test(r.stderr));
  assert.ok(queued.length >= 2, `queued lines: ${queued.length}`);
  for (const r of queued) assert.match(r.stderr, /gate: acquired light-\d after/);
});

test("heavy and light are independent pools: a held heavy slot does not block light", async () => {
  const dir = tmpGate();
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(`${process.pid} ${Date.now()} {"cmd":"test heavy holder"}`, path.join(dir, "heavy-0"));
  const r = await run(["--weight", "light", "--", "true"], baseEnv(dir), { timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /queued/);
});

test("a slot whose holder PID is gone is taken over, loudly", async () => {
  const dir = tmpGate();
  const pid = await deadPid();
  fs.symlinkSync(`${pid} ${Date.now()} {"cmd":"crashed run"}`, path.join(dir, "heavy-0"));
  const r = await run(["--weight", "heavy", "--", "true"], baseEnv(dir));
  assert.equal(r.code, 0);
  assert.match(r.stderr, new RegExp(`gate: taking over heavy-0 from PID ${pid} \\(holder gone; held \\d+s; was: crashed run\\)`));
  assert.equal(fs.existsSync(path.join(dir, "heavy-0")), false);
});

test("a live holder older than the max age is taken over", async () => {
  const dir = tmpGate();
  fs.symlinkSync(`${process.pid} ${Date.now() - 10_000} {"cmd":"hung run"}`, path.join(dir, "heavy-0"));
  const r = await run(["--weight", "heavy", "--", "true"], baseEnv(dir, { GATE_MAX_AGE_SECS: "5" }));
  assert.equal(r.code, 0);
  assert.match(r.stderr, /taking over heavy-0 from PID \d+ \(over the 5s ceiling; held \d+s; was: hung run\)/);
});

test("a live, young holder is NOT taken over: the waiter queues until it releases", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir);
  const holder = run(["--weight", "heavy", "--", "sleep", "1"], env);
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  const r = await run(["--weight", "heavy", "--", "true"], env);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /gate: queued \(heavy\) behind PID \d+ \(sleep 1, /);
  assert.doesNotMatch(r.stderr, /taking over/);
  assert.ok(Date.now() - t0 >= 400);
  assert.equal((await holder).code, 0);
});

test("re-entrant: a nested gate under a holder runs without queuing (no deadlock)", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir);
  // Outer holds heavy; inner asks for heavy too and would wait forever if not re-entrant.
  const r = await run(
    ["--weight", "heavy", "--", process.execPath, RUN, "--weight", "heavy", "--", "sh", "-c", 'echo "held=$GATE_LOCK_HELD"'],
    env,
    { timeoutMs: 8000 },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /queued/);
  assert.match(r.stdout, /held=\d+/);
});

test("GATE_LOCK_HELD naming a PID that holds nothing does not skip the gate", async () => {
  const dir = tmpGate();
  fs.symlinkSync(`${process.pid} ${Date.now()} {"cmd":"real holder"}`, path.join(dir, "heavy-0"));
  const env = baseEnv(dir, { GATE_LOCK_HELD: String(await deadPid()) });
  const child = spawn(process.execPath, [RUN, "--weight", "heavy", "--", "true"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  await new Promise((r) => setTimeout(r, 600));
  assert.match(stderr, /gate: queued \(heavy\)/);
  // A waiter file is visible to gate:status while it waits.
  assert.ok(fs.readdirSync(path.join(dir, "waiters")).some((f) => f.startsWith("heavy.")));
  fs.unlinkSync(path.join(dir, "heavy-0"));
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, "waiters")), []);
});

for (const [name, extra] of [
  ["CI=true", { CI: "true" }],
  ["CI=1", { CI: "1" }],
  ["GATE_LOCK=0", { GATE_LOCK: "0" }],
]) {
  test(`${name} bypasses the gate entirely`, async () => {
    const dir = tmpGate();
    fs.symlinkSync(`${process.pid} ${Date.now()} {"cmd":"holder"}`, path.join(dir, "heavy-0"));
    const r = await run(
      ["--weight", "heavy", "--", "sh", "-c", 'echo "held=${GATE_LOCK_HELD:-none}"; exit 3'],
      { ...baseEnv(dir), ...extra },
      { timeoutMs: 5000 },
    );
    assert.equal(r.code, 3);
    assert.doesNotMatch(r.stderr, /queued/);
    assert.match(r.stdout, /held=none/);
  });
}

test("vitest globalSetup: watch mode takes no slot; a run holds one light slot until teardown", async () => {
  const dir = tmpGate();
  const saved = { ...process.env };
  Object.assign(process.env, baseEnv(dir));
  try {
    const { default: setup } = await import("./vitest-global-setup.mjs");
    assert.equal(await setup({ config: { watch: true } }), undefined);
    assert.deepEqual(fs.readdirSync(dir), []);
    // Two projects in one process share one slot.
    const t1 = await setup({ config: { watch: false } });
    const t2 = await setup({ config: { watch: false } });
    const slots = () => fs.readdirSync(dir).filter((f) => f.startsWith("light-"));
    assert.deepEqual(slots(), ["light-0"]);
    t1();
    assert.deepEqual(slots(), ["light-0"]);
    t2();
    assert.deepEqual(slots(), []);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("SIGTERM/SIGINT to the gate is forwarded: child stops, slot released, 128+n", async () => {
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const dir = tmpGate();
    const pidFile = path.join(dir, "child.pid");
    const child = spawn(
      process.execPath,
      [RUN, "--weight", "heavy", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000)`],
      { env: baseEnv(dir), stdio: "ignore" },
    );
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(fs.lstatSync(path.join(dir, "heavy-0")).isSymbolicLink());
    child.kill(sig);
    const exitCode = await new Promise((r) => child.on("exit", (c) => r(c)));
    assert.equal(exitCode, code, sig);
    assert.throws(() => fs.lstatSync(path.join(dir, "heavy-0")), /ENOENT/);
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
  }
});

// ── helpers for the queue-shape tests ──────────────────────────────────────
async function waitFor(pred, timeoutMs = 10_000, what = "condition") {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
// Every background gate is killed at the end, so a failed assertion cannot
// leave a holder alive that keeps this file's process (and the run) open.
const bgChildren = [];
after(() => {
  for (const c of bgChildren) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    c.kill("SIGCONT"); // a SIGSTOPped waiter would ignore SIGTERM and hang the run
    c.kill("SIGTERM");
  }
});
function bg(args, env) {
  const child = spawn(process.execPath, [RUN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  bgChildren.push(child);
  const out = { stdout: "", stderr: "", child };
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => (out.stderr += d));
  out.exit = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  return out;
}
const waiterFiles = (dir) => {
  try {
    return fs.readdirSync(path.join(dir, "waiters")).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
};
const hasWaiter = (dir, pid) => waiterFiles(dir).some((f) => f.endsWith(`.${pid}.json`));
function fakeSlot(dir, name, { pid = process.pid, start = Date.now(), cmd = "fake holder", beatAgoMs = 0 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.symlinkSync(`${pid} ${start} ${JSON.stringify({ cmd })}`, file);
  if (beatAgoMs) {
    const t = new Date(Date.now() - beatAgoMs);
    fs.lutimesSync(file, t, t);
  }
  return file;
}

test("heartbeat: a slow live holder is not taken over, even past the stale window", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir, { GATE_HEARTBEAT_STALE_SECS: "1" });
  const holder = bg(["--weight", "heavy", "--", "sleep", "3"], env);
  await waitFor(() => fs.existsSync(path.join(dir, "heavy-0")) || fs.readdirSync(dir).includes("heavy-0"), 5000, "holder");
  const t0 = Date.now();
  const r = await run(["--weight", "heavy", "--", "true"], env);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /gate: queued \(heavy\)/);
  assert.doesNotMatch(r.stderr, /taking over/);
  assert.ok(Date.now() - t0 >= 1500, "waited for the holder rather than taking over");
  assert.equal((await holder.exit).code, 0);
});

test("heartbeat: a live holder whose heartbeat stopped is taken over", async () => {
  const dir = tmpGate();
  fakeSlot(dir, "heavy-0", { cmd: "stopped run", beatAgoMs: 5000 });
  const r = await run(["--weight", "heavy", "--", "true"], baseEnv(dir, { GATE_HEARTBEAT_STALE_SECS: "2" }));
  assert.equal(r.code, 0);
  assert.match(r.stderr, /taking over heavy-0 from PID \d+ \(no heartbeat for 5s; held \d+s; was: stopped run\)/);
});

test("PID reuse: a live PID that started after the slot was taken counts as gone", async () => {
  const dir = tmpGate();
  const { pidStartMs } = await import("./gate.mjs");
  const started = pidStartMs(process.pid);
  assert.ok(Number.isFinite(started), "ps lstart parsed");
  // The slot claims to have been taken a minute before this process existed.
  fakeSlot(dir, "heavy-0", { start: started - 60_000, cmd: "killed -9 run", beatAgoMs: 20_000 });
  const r = await run(["--weight", "heavy", "--", "true"], baseEnv(dir));
  assert.equal(r.code, 0);
  assert.match(r.stderr, /taking over heavy-0 from PID \d+ \(PID reused: that process started after the slot was taken;/);
});

test("PID reuse check does not fire on a genuine holder with a late heartbeat", async () => {
  const dir = tmpGate();
  fakeSlot(dir, "heavy-0", { start: Date.now(), cmd: "busy run", beatAgoMs: 20_000 });
  const w = bg(["--weight", "heavy", "--", "true"], baseEnv(dir));
  await waitFor(() => /queued \(heavy\)/.test(w.stderr), 5000, "queued line");
  await new Promise((r) => setTimeout(r, 500));
  assert.doesNotMatch(w.stderr, /taking over/);
  fs.unlinkSync(path.join(dir, "heavy-0"));
  assert.equal((await w.exit).code, 0);
});

test("re-entry is limited to the holder's weight: light holder → heavy child queues", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir);
  fakeSlot(dir, "heavy-0", { cmd: "someone's tsc" });
  const outer = bg(["--weight", "light", "--", process.execPath, RUN, "--weight", "heavy", "--", "true"], env);
  await waitFor(() => /gate: queued \(heavy\) behind PID \d+ \(someone's tsc/.test(outer.stderr), 5000, "nested heavy queued");
  fs.unlinkSync(path.join(dir, "heavy-0"));
  assert.equal((await outer.exit).code, 0);
});

test("re-entry: heavy holder → light child runs without a slot, even with every light slot full", async () => {
  const dir = tmpGate();
  for (const s of ["light-0", "light-1", "light-2"]) fakeSlot(dir, s);
  const r = await run(
    ["--weight", "heavy", "--", process.execPath, RUN, "--weight", "light", "--", "true"],
    baseEnv(dir),
    { timeoutMs: 8000 },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /queued/);
});

test("a holder that calls process.exit before teardown still releases its slot", async () => {
  const dir = tmpGate();
  const gateUrl = new URL("./gate.mjs", import.meta.url).href;
  const script = `const { acquire } = await import(${JSON.stringify(gateUrl)});
    const fs = await import("node:fs");
    const lease = await acquire("light", { label: "exit-early" });
    process.stdout.write(lease.slot + ":" + fs.readdirSync(${JSON.stringify(dir)}).filter((f) => f.startsWith("light-")).join(","));
    process.exit(3);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: baseEnv(dir), stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 3);
  assert.equal(stdout, "light-0:light-0");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("light-")), []);
});

test("FIFO within a pool: waiters acquire in arrival order", async () => {
  const dir = tmpGate();
  const order = path.join(dir, "order.log");
  const env = baseEnv(dir, { GATE_LIGHT_SLOTS: "1" });
  fakeSlot(dir, "light-0");
  const ws = [];
  for (const id of [1, 2, 3, 4]) {
    const w = bg(["--weight", "light", "--", process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(order)}, "${id}\\n"); setTimeout(() => {}, 150)`], env);
    await waitFor(() => hasWaiter(dir, w.child.pid), 5000, `waiter ${id}`);
    ws.push(w);
  }
  fs.unlinkSync(path.join(dir, "light-0"));
  for (const w of ws) assert.equal((await w.exit).code, 0, w.stderr);
  assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["1", "2", "3", "4"]);
  assert.match(ws[3].stderr, /; 3 waiting ahead/);
});

test("a SIGKILLed waiter does not block the waiters behind it", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir, { GATE_LIGHT_SLOTS: "1" });
  fakeSlot(dir, "light-0");
  const a = bg(["--weight", "light", "--", "true"], env);
  await waitFor(() => hasWaiter(dir, a.child.pid), 5000, "waiter A");
  const b = bg(["--weight", "light", "--", "true"], env);
  await waitFor(() => hasWaiter(dir, b.child.pid), 5000, "waiter B");
  a.child.kill("SIGKILL");
  await a.exit;
  assert.ok(hasWaiter(dir, a.child.pid), "A's file is left behind by SIGKILL");
  fs.unlinkSync(path.join(dir, "light-0"));
  const t0 = Date.now();
  assert.equal((await b.exit).code, 0);
  assert.ok(Date.now() - t0 < 3000, "B did not wait for A's file to age out");
});

test("a live waiter whose heartbeat stopped is ignored by the queue", async () => {
  const dir = tmpGate();
  fs.mkdirSync(path.join(dir, "waiters"), { recursive: true });
  // Oldest possible arrival, live PID (this process), heartbeat 20 s old.
  const f = path.join(dir, "waiters", `light.${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, weight: "light", since: 0, cwd: "/", cmd: "frozen" }));
  const t = new Date(Date.now() - 20_000);
  fs.utimesSync(f, t, t);
  const r = await run(["--weight", "light", "--", "true"], baseEnv(dir, { GATE_LIGHT_SLOTS: "1" }), { timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /queued/);
});

test("a signal while queued removes the waiter file and exits 128+n", async () => {
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const dir = tmpGate();
    fakeSlot(dir, "heavy-0");
    const w = bg(["--weight", "heavy", "--", "true"], baseEnv(dir));
    await waitFor(() => hasWaiter(dir, w.child.pid), 5000, "waiter file");
    w.child.kill(sig);
    assert.equal((await w.exit).code, code, sig);
    assert.deepEqual(waiterFiles(dir), []);
    assert.ok(fs.lstatSync(path.join(dir, "heavy-0")).isSymbolicLink(), "the holder's slot is untouched");
  }
});

test("--ready-file is written once the slot is held, before the command starts", async () => {
  const dir = tmpGate();
  const ready = path.join(dir, "ready");
  fakeSlot(dir, "heavy-0", { cmd: "holder" });
  const w = bg(["--weight", "heavy", "--ready-file", ready, "--", "sh", "-c", `cat ${JSON.stringify(ready)}`], baseEnv(dir));
  await waitFor(() => hasWaiter(dir, w.child.pid), 5000, "waiter file");
  assert.equal(fs.existsSync(ready), false, "not written while queued");
  fs.unlinkSync(path.join(dir, "heavy-0"));
  assert.equal((await w.exit).code, 0);
  assert.equal(w.stdout.trim(), "heavy-0");
});

test("GATE_POLL_MS is clamped so a waiter never looks stale to itself", async () => {
  const { gateConfig } = await import("./gate.mjs");
  assert.equal(gateConfig({ GATE_POLL_MS: "600000" }).pollMs, 5000);
  assert.equal(gateConfig({ GATE_POLL_MS: "1" }).pollMs, 20);
  assert.equal(gateConfig({}).maxAgeMs, 3 * 3600 * 1000);
  assert.equal(gateConfig({}).heartbeatStaleMs, 120_000);
});

test("playwright globalSetup: UI mode takes no slot; a normal run holds heavy until teardown", async () => {
  const dir = tmpGate();
  const saved = { env: { ...process.env }, argv: process.argv };
  Object.assign(process.env, baseEnv(dir));
  try {
    const { default: setup, isUiMode } = await import("./playwright-global-setup.mjs");
    assert.equal(isUiMode(["node", "playwright", "test", "--ui"]), true);
    assert.equal(isUiMode(["node", "playwright", "test", "--ui-port=8080"]), true);
    assert.equal(isUiMode(["node", "playwright", "test", "e2e/ui-thing.spec.ts"]), false);
    process.argv = ["node", "playwright", "test", "--ui"];
    assert.equal(await setup(), undefined);
    assert.deepEqual(fs.readdirSync(dir), []);
    process.argv = ["node", "playwright", "test"];
    const teardown = await setup();
    assert.ok(fs.lstatSync(path.join(dir, "heavy-0")).isSymbolicLink());
    await teardown();
    assert.throws(() => fs.lstatSync(path.join(dir, "heavy-0")), /ENOENT/);
  } finally {
    process.argv = saved.argv;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
  }
});

test("usage errors exit 64", async () => {
  const env = baseEnv(tmpGate());
  assert.equal((await run(["--weight", "medium", "--", "true"], env)).code, 64);
  assert.equal((await run(["--weight", "light", "--"], env)).code, 64);
});

// ── memory-aware admission ─────────────────────────────────────────────────
/** A gated run that holds its slot until `release` exists, then exits 0. */
function holdUntil(dir, weight, name, env) {
  const started = path.join(dir, `${name}.started`);
  const release = path.join(dir, `${name}.release`);
  const body = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(started)},"");` +
    `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t)}},20);`;
  const p = bg(["--weight", weight, "--label", name, "--", process.execPath, "-e", body], env);
  p.started = () => fs.existsSync(started);
  p.release = () => fs.writeFileSync(release, "");
  return p;
}

test("memory: under pressure a second light run waits, names memory, and starts once pressure drops", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir, { GATE_SWAP_TEXT: "18.4G/19.4G" });
  setPressure(dir, 2);
  const first = holdUntil(dir, "light", "first", env);
  await waitFor(first.started, 5000, "first light running");
  const second = holdUntil(dir, "light", "second", env);
  await waitFor(() => /queued \(light\) for memory/.test(second.stderr), 5000, "memory queued line");
  assert.match(
    second.stderr,
    /gate: queued \(light\) for memory: pressure warn, swap 18\.4G\/19\.4G used; 1 gated run allowed under pressure, running: PID \d+ \(first, \d+s\)/,
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(second.started(), false, "still held back by the memory cap");
  setPressure(dir, 1);
  await waitFor(second.started, 5000, "second starts after pressure drops");
  assert.equal(first.started() && first.child.exitCode, null, "first is still running");
  first.release();
  second.release();
  assert.equal((await first.exit).code, 0);
  assert.equal((await second.exit).code, 0);
});

test("memory: with nothing running, a run starts at once whatever the pressure", async () => {
  const dir = tmpGate();
  setPressure(dir, 4);
  const r = await run(["--weight", "heavy", "--", "true"], baseEnv(dir), { timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /queued/);
});

test("memory: GATE_MEM=0 ignores pressure", async () => {
  const dir = tmpGate();
  setPressure(dir, 4);
  const env = baseEnv(dir, { GATE_MEM: "0" });
  const first = holdUntil(dir, "light", "first", env);
  await waitFor(first.started, 5000, "first light running");
  const r = await run(["--weight", "light", "--", "true"], env, { timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /queued/);
  first.release();
  assert.equal((await first.exit).code, 0);
});

test("memory: GATE_MEM_RUNS raises the cap; GATE_MEM_LEVEL raises the threshold", async () => {
  const dir = tmpGate();
  setPressure(dir, 2);
  const first = holdUntil(dir, "light", "first", baseEnv(dir));
  await waitFor(first.started, 5000, "first light running");
  for (const extra of [{ GATE_MEM_RUNS: "2" }, { GATE_MEM_LEVEL: "4" }]) {
    const r = await run(["--weight", "heavy", "--", "true"], baseEnv(dir, extra), { timeoutMs: 5000 });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /queued/, JSON.stringify(extra));
  }
  first.release();
  await first.exit;
});

test("memory: an earlier heavy waiter beats a later light waiter to the freed budget", async () => {
  const dir = tmpGate();
  const order = path.join(dir, "order.log");
  const env = baseEnv(dir);
  setPressure(dir, 2);
  fakeSlot(dir, "light-0", { cmd: "running light" });
  const mark = (id) => [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(order)}, "${id}\\n"); setTimeout(() => {}, 300)`];
  const heavy = bg(["--weight", "heavy", "--", ...mark("heavy")], env);
  await waitFor(() => /queued \(heavy\) for memory/.test(heavy.stderr), 5000, "heavy blocked by memory");
  const light = bg(["--weight", "light", "--", ...mark("light")], env);
  await waitFor(() => /queued \(light\) for memory/.test(light.stderr), 5000, "light blocked by memory");
  assert.match(light.stderr, new RegExp(`queued first for it: PID ${heavy.child.pid} \\(heavy\\)`));
  // Freeze the heavy waiter (its waiter file stays live for 15 s), then free the
  // budget: the light waiter must still hold back for it, on the rule alone.
  heavy.child.kill("SIGSTOP");
  fs.unlinkSync(path.join(dir, "light-0"));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fs.existsSync(order), false, "light did not jump the earlier heavy waiter");
  heavy.child.kill("SIGCONT");
  assert.equal((await heavy.exit).code, 0, heavy.stderr);
  assert.equal((await light.exit).code, 0, light.stderr);
  assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["heavy", "light"]);
});

test("memory: a later same-pool waiter does not start beside an earlier one", async () => {
  const dir = tmpGate();
  const order = path.join(dir, "order.log");
  const env = baseEnv(dir);
  setPressure(dir, 2);
  fakeSlot(dir, "light-0");
  const mark = (id) => [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(order)}, "${id}\\n")`];
  const a = bg(["--weight", "light", "--", ...mark("a")], env);
  await waitFor(() => hasWaiter(dir, a.child.pid), 5000, "waiter a");
  const b = bg(["--weight", "light", "--", ...mark("b")], env);
  await waitFor(() => /queued \(light\) for memory/.test(b.stderr), 5000, "b blocked by memory");
  a.child.kill("SIGSTOP");
  fs.unlinkSync(path.join(dir, "light-0"));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fs.existsSync(order), false, "b waited for a, which queued first");
  a.child.kill("SIGCONT");
  assert.equal((await a.exit).code, 0, a.stderr);
  assert.equal((await b.exit).code, 0, b.stderr);
  assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["a", "b"]);
});

test("memory: a waiter whose reason changes from slot to memory says so at once", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir, { GATE_NOTIFY_SECS: "60" });
  setPressure(dir, 2);
  fakeSlot(dir, "heavy-0", { cmd: "heavy holder" });
  fakeSlot(dir, "light-0", { cmd: "light holder" });
  const w = bg(["--weight", "heavy", "--", "true"], env);
  await waitFor(() => /queued \(heavy\) behind PID \d+ \(heavy holder/.test(w.stderr), 5000, "slot line");
  fs.unlinkSync(path.join(dir, "heavy-0")); // heavy slot free, light still runs: memory binds
  await waitFor(() => /still queued \(heavy, \d+s\) for memory: pressure warn; .*running: PID \d+ \(light holder/.test(w.stderr), 5000, "memory line");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(w.stderr.trim().split("\n").length, 2, "no spam: one line per reason");
  fs.unlinkSync(path.join(dir, "light-0"));
  assert.equal((await w.exit).code, 0);
});

// ── session pool ───────────────────────────────────────────────────────────
test("session: capped at GATE_SESSION_SLOTS, outside the memory rule, child gets no GATE_LOCK_HELD", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir, { GATE_SESSION_SLOTS: "2" });
  setPressure(dir, 4);
  const s1 = holdUntil(dir, "session", "s1", env);
  const s2 = holdUntil(dir, "session", "s2", env);
  await waitFor(() => s1.started() && s2.started(), 5000, "two sessions running under pressure 4");
  // Sessions don't count toward the memory cap: a light run starts at once.
  const light = await run(["--weight", "light", "--", "true"], env, { timeoutMs: 5000 });
  assert.equal(light.code, 0);
  assert.doesNotMatch(light.stderr, /queued/);
  // A third session queues on the slot, not on memory.
  const s3 = bg(["--weight", "session", "--", "sh", "-c", 'echo "held=${GATE_LOCK_HELD:-none}"'], { ...env, GATE_LOCK_HELD: String(s1.child.pid) });
  await waitFor(() => /gate: queued \(session\) behind PID \d+ \(s[12], .*\(s[12], /.test(s3.stderr), 5000, "third session queued");
  assert.doesNotMatch(s3.stderr, /memory/);
  s1.release();
  assert.equal((await s3.exit).code, 0, s3.stderr);
  assert.match(s3.stdout, /held=none/);
  s2.release();
  await Promise.all([s1.exit, s2.exit]);
});

test("session: a session holder named in GATE_LOCK_HELD never makes light re-entrant", async () => {
  const dir = tmpGate();
  fakeSlot(dir, "session-0", { cmd: "claude -p" });
  // Light holders are a different live PID, so GATE_LOCK_HELD names ONLY a session holder.
  for (const s of ["light-0", "light-1", "light-2"]) fakeSlot(dir, s, { pid: process.ppid });
  const w = bg(["--weight", "light", "--", "true"], baseEnv(dir, { GATE_LOCK_HELD: String(process.pid) }));
  await waitFor(() => /gate: queued \(light\)/.test(w.stderr), 5000, "light queued");
  fs.unlinkSync(path.join(dir, "light-0"));
  assert.equal((await w.exit).code, 0);
});

test("session: per-weight ceiling; a 4 h session slot is not stale, a 4 h light slot is", async () => {
  const { gateConfig, readSlot, staleReason, maxAgeFor } = await import("./gate.mjs");
  const cfg = gateConfig({});
  assert.equal(cfg.sessionMaxAgeMs, 28_800_000);
  assert.equal(maxAgeFor("session", cfg), 28_800_000);
  assert.equal(maxAgeFor("heavy", cfg), 10_800_000);
  assert.equal(gateConfig({ GATE_SESSION_SLOTS: "6" }).counts.session, 6);
  const dir = tmpGate();
  const start = Date.now() - 4 * 3600_000;
  // Old-format payloads (no weight field): the slot NAME decides the ceiling.
  fakeSlot(dir, "session-0", { start, cmd: "claude -p" });
  fakeSlot(dir, "light-0", { start, cmd: "vitest" });
  const now = Date.now();
  assert.equal(staleReason(readSlot(path.join(dir, "session-0")), now, cfg), null);
  assert.match(staleReason(readSlot(path.join(dir, "light-0")), now, cfg), /over the 3h0m ceiling/);
  assert.match(staleReason(readSlot(path.join(dir, "session-0")), now + 5 * 3600_000, cfg), /over the 8h0m ceiling/);
});

// ── status ─────────────────────────────────────────────────────────────────
test("status --json includes memory and ungated; text shows session slots and memory", async () => {
  const dir = tmpGate();
  setPressure(dir, 2);
  fakeSlot(dir, "light-0", { cmd: "vitest run" });
  const env = baseEnv(dir, { GATE_SWAP_TEXT: "1.0G/2.0G" });
  const status = (args) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(HERE, "status.mjs"), ...args], { env, stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("exit", (code) => resolve({ code, out }));
    });
  const j = await status(["--json"]);
  assert.equal(j.code, 0);
  const s = JSON.parse(j.out);
  assert.deepEqual(s.counts, { heavy: 1, light: 3, session: 4 });
  assert.ok(s.slots.some((x) => x.name === "session-3"));
  assert.deepEqual(
    { level: s.memory.level, label: s.memory.label, swap: s.memory.swap, gatedRuns: s.memory.gatedRuns, binding: s.memory.binding },
    { level: 2, label: "warn", swap: "1.0G/2.0G", gatedRuns: 1, binding: true },
  );
  assert.ok(Array.isArray(s.ungated));
  const t = await status([]);
  assert.match(t.out, /memory: pressure warn \(2\), swap 1\.0G\/2\.0G used; cap BINDING: 1 gated run active/);
  assert.match(t.out, /session-0 +free/);
  assert.match(t.out, /ungated \(bypassed the gate\):/);
});

test("findUngated: bare tsc/next build/playwright listed; gated, --watch and wrappers not", async () => {
  const { findUngated, isHeavyCommand } = await import("./gate.mjs");
  assert.equal(isHeavyCommand("node /r/node_modules/.bin/tsc -p tsconfig.json --noEmit"), true);
  assert.equal(isHeavyCommand("node /r/node_modules/typescript/bin/tsc --watch -p x"), false);
  assert.equal(isHeavyCommand("bash scripts/dev/tsc-daemon.sh start"), false);
  assert.equal(isHeavyCommand("node /x/tsserver.js --max-old-space-size=3072"), false);
  assert.equal(isHeavyCommand("/bin/zsh -c source snap.sh && eval 'E2E=1 pnpm exec playwright test e2e/x.spec.ts'"), false);
  assert.equal(isHeavyCommand("bash -c tsc -p tsconfig.json"), false);
  const ps = [
    "  100     1  1-02:03:04 /bin/zsh",
    "  200   100       05:00 node /repo/scripts/dev/gate/run.mjs --weight heavy -- tsc -p a",
    "  201   200       04:59 node /repo/node_modules/.bin/tsc -p a",
    "  300   100       03:00 pnpm exec tsc -p tsconfig.json --noEmit",
    "  800   100       02:14 /bin/zsh -c eval 'cd apps/web; E2E_USE_LIVE_STACK=1 pnpm exec playwright test e2e/z.spec.ts'",
    "  801   800       02:14 ugrep -G --hidden -I playwright",
    "  301   300       02:59 node /repo/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit",
    "  400   100       10:00 node /repo/node_modules/.bin/next build",
    "  500   100       00:30 node /repo/node_modules/.bin/playwright test e2e/x.spec.ts",
    "  600   100       00:30 node /repo/node_modules/.bin/playwright test e2e/y.spec.ts",
    "  700   100    01:00:00 node /repo/node_modules/.bin/tsc -w -p a",
  ].join("\n");
  const got = findUngated(ps, new Set([600]), "/repo");
  assert.deepEqual(got.map((u) => u.pid), [301, 400, 500]);
  assert.equal(got[0].cmd, "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit");
  assert.equal(got[1].elapsedMs, 600_000);
});

test("memoryPressure: pressure file read on every call; missing file = normal", async () => {
  const { memoryPressure } = await import("./gate.mjs");
  const dir = tmpGate();
  const env = { GATE_PRESSURE_FILE: path.join(dir, "pressure") };
  assert.deepEqual({ ...memoryPressure(env) }, { level: 1, label: "normal", swap: null });
  setPressure(dir, 4);
  assert.equal(memoryPressure(env).label, "critical");
  setPressure(dir, 2);
  assert.equal(memoryPressure(env).label, "warn");
});

// ── review round 1: nesting under pressure, over-age holders ───────────────
test("memory: light holder → heavy child is not blocked by its own parent at pressure 2 (no deadlock)", async () => {
  const dir = tmpGate();
  setPressure(dir, 2);
  const r = await run(
    ["--weight", "light", "--", process.execPath, RUN, "--weight", "heavy", "--", "sh", "-c", "echo inner-ran"],
    baseEnv(dir),
    { timeoutMs: 8000 },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /inner-ran/);
  assert.doesNotMatch(r.stderr, /for memory/);
});

test("memory: the nested child does not yield to a waiter that its own parent blocks", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir);
  setPressure(dir, 2);
  const go = path.join(dir, "go");
  // The outer light run waits for `go` before asking for heavy, so a second,
  // unrelated light waiter queues BEFORE the nested heavy request.
  const outer = bg(
    ["--weight", "light", "--label", "outer", "--", "sh", "-c",
      `while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.05; done; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(RUN)} --weight heavy -- echo inner-ran`],
    env,
  );
  await waitFor(() => fs.readdirSync(dir).includes("light-0"), 5000, "outer holds light");
  const other = bg(["--weight", "light", "--", "true"], env);
  await waitFor(() => /queued \(light\) for memory: .*running: PID \d+ \(outer/.test(other.stderr), 5000, "other blocked by outer");
  fs.writeFileSync(go, "");
  const o = await outer.exit;
  assert.equal(o.code, 0, outer.stderr);
  assert.match(outer.stdout, /inner-ran/);
  assert.equal((await other.exit).code, 0, other.stderr);
});

test("memory: a holder past GATE_MEM_HOLD_SECS stops counting, and notes/status name it", async () => {
  const dir = tmpGate();
  setPressure(dir, 2);
  const env = baseEnv(dir, { GATE_MEM_HOLD_SECS: "5" });
  const old = fakeSlot(dir, "light-0", { start: Date.now() - 10_000, cmd: "hung vitest" });
  // Only the over-age holder runs: a heavy run starts at once.
  const r = await run(["--weight", "heavy", "--", "true"], env, { timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /queued/);
  // With a young holder too, the waiter blocks on that one and names the old one.
  fakeSlot(dir, "heavy-0", { pid: process.ppid, cmd: "young tsc" });
  const w = bg(["--weight", "light", "--", "true"], env);
  await waitFor(() => /for memory: .*running: PID \d+ \(young tsc, .*; PID \d+ held 1\ds, no longer counted/.test(w.stderr), 5000, "over-age named");
  const { gateStatus } = await import("./gate.mjs");
  const m = gateStatus(env).memory;
  assert.equal(m.gatedRuns, 1);
  assert.deepEqual(m.overAge.map((o) => o.name), ["light-0"]);
  fs.unlinkSync(path.join(dir, "heavy-0"));
  assert.equal((await w.exit).code, 0);
  fs.unlinkSync(old);
  const { gateConfig } = await import("./gate.mjs");
  assert.equal(gateConfig({}).mem.holdMs, 1_200_000);
});

test("memory: the nested heavy child inherits its light parent's budget past an earlier HEAVY waiter", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir);
  setPressure(dir, 2);
  const go = path.join(dir, "go");
  const outer = bg(
    ["--weight", "light", "--label", "outer", "--", "sh", "-c",
      `while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.05; done; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(RUN)} --weight heavy -- echo inner-ran`],
    env,
  );
  await waitFor(() => fs.readdirSync(dir).includes("light-0"), 5000, "outer holds light");
  // H1: an unrelated heavy waiter, queued first, held back by the outer light run.
  const h1 = bg(["--weight", "heavy", "--", "true"], env);
  await waitFor(() => /queued \(heavy\) for memory: .*running: PID \d+ \(outer/.test(h1.stderr), 5000, "H1 blocked by outer");
  const t0 = Date.now();
  fs.writeFileSync(go, "");
  const o = await Promise.race([outer.exit, new Promise((r) => setTimeout(() => r({ code: "hung" }), 8000))]);
  assert.equal(o.code, 0, outer.stderr);
  assert.match(outer.stdout, /inner-ran/);
  assert.ok(Date.now() - t0 < 8000);
  assert.equal((await h1.exit).code, 0, h1.stderr);
});

// ── review round 3: inheritance needs real ancestry ───────────────────────
test("memory: GATE_LOCK_HELD naming a light holder that is NOT an ancestor grants no inheritance", async () => {
  const dir = tmpGate();
  const order = path.join(dir, "order.log");
  const env = baseEnv(dir);
  setPressure(dir, 2);
  const outer = holdUntil(dir, "light", "outer", env);
  await waitFor(outer.started, 5000, "outer holds light");
  const mark = (id) => [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(order)}, "${id}\\n")`];
  // H1: an unrelated heavy waiter, queued first, held back by the outer light run.
  const h1 = bg(["--weight", "heavy", "--", ...mark("h1")], env);
  await waitFor(() => /queued \(heavy\) for memory: .*running: PID \d+ \(outer/.test(h1.stderr), 5000, "H1 blocked by outer");
  // The impostor carries the outer holder's PID but is spawned from THIS process,
  // like something detached from inside a gated vitest run.
  const imp = bg(["--weight", "heavy", "--", ...mark("imp")], { ...env, GATE_LOCK_HELD: String(outer.child.pid) });
  await waitFor(() => hasWaiter(dir, imp.child.pid), 5000, "impostor queued");
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fs.existsSync(order), false, `impostor neither jumped H1 nor skipped the memory cap: ${imp.stderr}`);
  assert.match(imp.stderr, /gate: queued \(heavy\)/);
  outer.release();
  assert.equal((await outer.exit).code, 0);
  assert.equal((await h1.exit).code, 0, h1.stderr);
  assert.equal((await imp.exit).code, 0, imp.stderr);
  assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["h1", "imp"]);
});

test("isAncestorIn: walks the ppid chain; reparented-to-1, missing and looping chains are not ancestors", async () => {
  const { isAncestorIn } = await import("./gate.mjs");
  const ps = ["  100     1", "  200   100", "  300   200", "  400   300", "  500     1", "  600   700", "  700   600"].join("\n");
  assert.equal(isAncestorIn(ps, 100, 400), true, "grandparent's parent");
  assert.equal(isAncestorIn(ps, 400, 400), true, "direct parent");
  assert.equal(isAncestorIn(ps, 500, 400), false, "unrelated holder");
  assert.equal(isAncestorIn(ps, 100, 500), false, "reparented to launchd");
  assert.equal(isAncestorIn(ps, 100, 999), false, "chain leaves the snapshot");
  assert.equal(isAncestorIn(ps, 100, 600), false, "a ppid loop terminates");
  assert.equal(isAncestorIn("", 100, 1), false);
});

test("memory: a heavy child two shells below its light parent (the multi-hop ps walk) inherits past an earlier HEAVY waiter", async () => {
  const dir = tmpGate();
  const env = baseEnv(dir);
  setPressure(dir, 2);
  const go = path.join(dir, "go");
  const q = JSON.stringify;
  // No exec and a trailing command at each level, so both shells stay in the
  // chain: run.mjs light → sh → sh → run.mjs heavy (its ppid is NOT the holder).
  const inner = `while [ ! -f ${q(go)} ]; do sleep 0.05; done; ${q(process.execPath)} ${q(RUN)} --weight heavy -- echo inner-ran; true`;
  const outer = bg(["--weight", "light", "--label", "outer", "--", "sh", "-c", `sh -c '${inner}'; true`], env);
  await waitFor(() => fs.readdirSync(dir).includes("light-0"), 5000, "outer holds light");
  const h1 = bg(["--weight", "heavy", "--", "true"], env);
  await waitFor(() => /queued \(heavy\) for memory: .*running: PID \d+ \(outer/.test(h1.stderr), 5000, "H1 blocked by outer");
  fs.writeFileSync(go, "");
  const o = await Promise.race([outer.exit, new Promise((r) => setTimeout(() => r({ code: "hung" }), 8000))]);
  assert.equal(o.code, 0, outer.stderr);
  assert.match(outer.stdout, /inner-ran/);
  assert.equal((await h1.exit).code, 0, h1.stderr);
});

test("session: a session request under a light holder does not inherit (keeps the session FIFO)", async () => {
  const dir = tmpGate();
  const order = path.join(dir, "order.log");
  const env = baseEnv(dir);
  const fakes = ["session-0", "session-1", "session-2", "session-3"].map((s) => fakeSlot(dir, s));
  const mark = (id) => [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(order)}, "${id}\\n")`];
  const s1 = bg(["--weight", "session", "--", ...mark("s1")], env);
  await waitFor(() => hasWaiter(dir, s1.child.pid), 5000, "s1 queued");
  // s2 is a real child of a light holder, so GATE_LOCK_HELD names an ancestor.
  const outer = bg(["--weight", "light", "--label", "outer", "--", process.execPath, RUN, "--weight", "session", "--", ...mark("s2")], env);
  await waitFor(() => /gate: queued \(session\)/.test(outer.stderr), 5000, "s2 queued");
  s1.child.kill("SIGSTOP");
  fs.unlinkSync(fakes[0]);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fs.existsSync(order), false, "s2 did not jump s1, which queued first");
  s1.child.kill("SIGCONT");
  // Free the rest only after s1 has run, so the order below is not a spawn race.
  await waitFor(() => fs.existsSync(order), 5000, "s1 ran");
  for (const f of fakes.slice(1)) fs.unlinkSync(f);
  assert.equal((await s1.exit).code, 0, s1.stderr);
  assert.equal((await outer.exit).code, 0, outer.stderr);
  assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["s1", "s2"]);
});
