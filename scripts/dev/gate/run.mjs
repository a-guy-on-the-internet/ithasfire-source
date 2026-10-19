#!/usr/bin/env node
// Run a command under the machine-wide gate (see ./gate.mjs).
//
//   node scripts/dev/gate/run.mjs --weight heavy|light|session [--label <text>] [--ready-file <path>] -- <cmd> [args...]
//
// Waits for a slot, then spawns <cmd> with stdio inherited and
// GATE_LOCK_HELD=<this pid> (so nested gates run without re-queuing).
// `--weight session` (a headless `claude -p` from the handoff launcher) is the
// exception: its child gets NO GATE_LOCK_HELD, and an inherited one is removed,
// so the session's own tests and typechecks queue like anyone's. This process
// stays alive as the session's parent and heartbeats its slot. SIGINT,
// SIGTERM and SIGHUP are forwarded to the child. Exits with the child's exact
// code; a child killed by a signal exits 128+n. A gate that cannot create its
// slot exits 70; a missing command exits 127. Argv reaches <cmd> unchanged.
//
// --ready-file <path>: written once the slot is held (or the gate is bypassed or
// re-entered), just before <cmd> starts. A caller that bounds <cmd> by wall
// clock (.githooks/pre-push) starts its clock there, so queue time is not
// charged to the run.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import { WEIGHTS, acquire } from "./gate.mjs";

const USAGE = "usage: run.mjs --weight heavy|light|session [--label <text>] [--ready-file <path>] -- <cmd> [args...]";

function parse(argv) {
  let weight;
  let label;
  let readyFile;
  let i = 0;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") {
      i += 1;
      break;
    }
    if (a === "--weight") weight = argv[++i];
    else if (a.startsWith("--weight=")) weight = a.slice("--weight=".length);
    else if (a === "--label") label = argv[++i];
    else if (a.startsWith("--label=")) label = a.slice("--label=".length);
    else if (a === "--ready-file") readyFile = argv[++i];
    else if (a.startsWith("--ready-file=")) readyFile = a.slice("--ready-file=".length);
    else break; // first non-option word starts the command
  }
  return { weight, label, readyFile, cmd: argv.slice(i) };
}

const { weight, label, readyFile, cmd } = parse(process.argv.slice(2));
if (!cmd.length || !WEIGHTS.includes(weight)) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(64);
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
let child = null;
let lease = { release() {} };

const exitFor = (sig) => 128 + (os.constants.signals[sig] ?? 0);
for (const sig of SIGNALS) {
  process.on(sig, () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(sig);
      return; // exit when the child does
    }
    lease.release();
    process.exit(exitFor(sig));
  });
}

try {
  lease = await acquire(weight, { label: label ?? cmd.join(" ") });
} catch (err) {
  process.stderr.write(`gate: ${err.message}\n`);
  process.exit(70);
}

if (readyFile) {
  try {
    fs.writeFileSync(readyFile, `${lease.slot ?? lease.reason}\n`);
  } catch (err) {
    process.stderr.write(`gate: cannot write --ready-file ${readyFile}: ${err.message}\n`);
  }
}

const env = { ...process.env };
if (weight === "session") delete env.GATE_LOCK_HELD;
else if (lease.held) env.GATE_LOCK_HELD = String(process.pid);

child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env });
child.on("error", (err) => {
  lease.release();
  process.stderr.write(`gate: cannot run ${cmd[0]}: ${err.message}\n`);
  process.exit(err.code === "ENOENT" ? 127 : 126);
});
child.on("exit", (code, signal) => {
  lease.release();
  process.exit(code ?? exitFor(signal));
});
