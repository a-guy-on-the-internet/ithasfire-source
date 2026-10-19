// vitest globalSetup: every `vitest run` waits for a LIGHT gate slot (see
// ./gate.mjs), held by the main vitest process for the whole run and released
// at teardown (and on process exit, if teardown never runs).
//
// Watch mode takes no slot: the `pnpm vitest:bg` watcher lives for hours and
// would pin a slot the whole time.
//
// Wired into every vitest config in the repo as a path string, never an
// import, so no tsconfig has to type a .mjs file. A config with several
// projects can load this module once per project (each through its own module
// instance), so the lease is shared through a process-wide registry: one slot
// per vitest process, released when the last project tears down.

import { acquire } from "./gate.mjs";

const KEY = Symbol.for("tickethunter.gate.vitest");

function isWatch(project) {
  const cfg = project?.config ?? project?.vitest?.config;
  return Boolean(cfg?.watch);
}

export default async function setup(project) {
  if (isWatch(project)) return undefined;
  const state = (globalThis[KEY] ??= { count: 0, pending: null });
  state.count += 1;
  state.pending ??= acquire("light", {
    label: `vitest ${process.argv.slice(2).join(" ")}`.trim(),
  });
  let lease;
  try {
    lease = await state.pending;
  } catch (err) {
    state.count -= 1;
    state.pending = null;
    throw new Error(`gate: ${err.message}`);
  }
  if (lease.held) process.env.GATE_LOCK_HELD = String(process.pid);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    state.count -= 1;
    if (state.count === 0) {
      lease.release();
      state.pending = null;
    }
  };
}
