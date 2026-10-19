#!/usr/bin/env node
// `node scripts/with-gate.mjs <heavy|light> -- <cmd> [args...]`
//
// Runs <cmd> under the machine-wide gate (scripts/dev/gate/run.mjs at the repo
// root) so local Next builds queue for the heavy slot instead of stacking.
//
// The Docker image build (apps/web/Dockerfile) copies apps/ and packages/ but
// not scripts/, so there the gate is absent and the command runs ungated, as
// it does in CI (the gate itself bypasses on CI=true/1 or GATE_LOCK=0).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gate = resolve(here, "../../../scripts/dev/gate/run.mjs");
const [weight, sep, ...cmd] = process.argv.slice(2);
if (!weight || sep !== "--" || cmd.length === 0) {
  process.stderr.write("usage: with-gate.mjs <heavy|light> -- <cmd> [args...]\n");
  process.exit(64);
}

const [file, args] = existsSync(gate)
  ? [process.execPath, [gate, "--weight", weight, "--", ...cmd]]
  : [cmd[0], cmd.slice(1)];

const child = spawn(file, args, { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("error", (err) => {
  process.stderr.write(`with-gate: cannot run ${file}: ${err.message}\n`);
  process.exit(err.code === "ENOENT" ? 127 : 126);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0));
});
