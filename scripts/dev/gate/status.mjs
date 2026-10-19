#!/usr/bin/env node
// `pnpm gate:status`: who holds each gate slot, who is waiting, the memory rule,
// and heavy work that bypassed the gate (see ./gate.mjs). `--json` prints the
// raw snapshot.

import fs from "node:fs";

import { fmtAge, gateStatus, parsePayload, pidAlive } from "./gate.mjs";

const s = gateStatus();
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  process.exit(0);
}

const lines = [`gate: ${s.dir} (${s.counts.heavy} heavy + ${s.counts.light} light + ${s.counts.session} session)`];

const m = s.memory;
if (!m.enabled) lines.push("memory: rule off (GATE_MEM=0)");
else if (m.level == null) lines.push("memory: pressure unknown; rule not applied");
else {
  const runs = `${m.gatedRuns} gated run${m.gatedRuns === 1 ? "" : "s"} active`;
  const cap = !m.underPressure
    ? `cap off (applies at level ${m.capLevel}); ${runs}`
    : m.binding
      ? `cap BINDING: ${runs}, ${m.capRuns} allowed under pressure; new heavy/light runs wait`
      : `cap on: ${runs}, ${m.capRuns} allowed under pressure`;
  lines.push(`memory: pressure ${m.label} (${m.level})${m.swap ? `, swap ${m.swap} used` : ""}; ${cap}`);
  for (const o of m.overAge ?? []) {
    lines.push(`  ${o.name}: PID ${o.pid} held ${fmtAge(o.ageMs)}, no longer counted (over ${fmtAge(m.holdMs)})`);
  }
}

for (const slot of s.slots) {
  if (slot.free) lines.push(`  ${slot.name.padEnd(9)} free`);
  else if (slot.error) lines.push(`  ${slot.name.padEnd(9)} ERROR ${slot.error}`);
  else {
    const state = slot.alive ? "alive" : "DEAD";
    const stale = slot.stale ? ` [stale: ${slot.stale}; next waiter takes it over]` : "";
    lines.push(
      `  ${slot.name.padEnd(9)} PID ${slot.pid} ${state}, held ${fmtAge(slot.ageMs)}, heartbeat ${slot.beatAgeMs == null ? "?" : `${fmtAge(slot.beatAgeMs)} ago`}${stale}\n` +
        `            cwd ${slot.cwd}\n            cmd ${slot.cmd}`,
    );
  }
}
lines.push(s.waiters.length ? `waiting (${s.waiters.length}, oldest first):` : "waiting: none");
for (const w of s.waiters) {
  lines.push(
    `  ${String(w.weight).padEnd(7)} PID ${w.pid}, waited ${fmtAge(w.waitedMs)}\n            cwd ${w.cwd}\n            cmd ${w.cmd}`,
  );
}

if (!Array.isArray(s.ungated)) lines.push(`ungated: cannot read ps (${s.ungated.error})`);
else if (!s.ungated.length) lines.push("ungated (bypassed the gate): none");
else {
  lines.push(`ungated (bypassed the gate): ${s.ungated.length}`);
  for (const u of s.ungated) {
    const age = Number.isFinite(u.elapsedMs) ? fmtAge(u.elapsedMs) : "?";
    lines.push(`  PID ${u.pid}, running ${age}: ${u.cmd}`);
  }
}

// The single lock scripts/dev/with-gate-lock.sh used before 2026-10-14; a
// session still running the old script holds it.
const OLD = "/tmp/tickethunter-gate.lock";
try {
  const h = parsePayload(fs.readlinkSync(OLD));
  lines.push(`legacy ${OLD}: PID ${h.pid} ${pidAlive(h.pid) ? "alive" : "DEAD"} (${h.cmd})`);
} catch {
  // absent: nothing to show
}

process.stdout.write(`${lines.join("\n")}\n`);
