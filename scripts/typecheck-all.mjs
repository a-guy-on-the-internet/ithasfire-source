#!/usr/bin/env node
// The whole-monorepo typecheck, used by BOTH `pnpm typecheck:all` and the
// `typecheck` job in .github/workflows/deploy-dev.yml, so local and CI can
// never drift apart.
//
// Why a script instead of a tsconfig solution file: `tsconfig.all.json` lists
// its workspaces under `references`, and `tsc -p` IGNORES references (that
// needs `tsc -b`). It also still pointed at `packages/service/auth-client`,
// which no longer exists — so `pnpm typecheck:all` had been exiting 2 on
// TS6053 in under four seconds without checking a single file.
//
// `pnpm typecheck` alone is NOT the whole story either: tsconfig.base.json's
// exclude ends with "apps/**", so it covers packages/** only and every app
// needs its own `tsc -p`.
//
// Runs every target and reports ALL failures rather than stopping at the
// first, so one red workspace cannot hide another.
import { spawnSync } from "node:child_process";
// The list lives in scripts/typecheck-targets.mjs so scripts/tsc-daemon.mjs can
// watch exactly what this script checks. One list, or the daemon lies.
import { TYPECHECK_TARGETS } from "./typecheck-targets.mjs";

const targets = TYPECHECK_TARGETS.map((t) => ({ name: t.name, args: t.pnpmArgs }));

const failed = [];
for (const t of targets) {
  process.stdout.write(`\n=== ${t.name} ===\n`);
  const r = spawnSync("pnpm", t.args, {
    stdio: "inherit",
    // tsc pulls the whole transitive graph through the checker and dies on the
    // default heap at exit 134 ("Ineffective mark-compacts near heap limit").
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
  });
  if (r.status !== 0) failed.push(`${t.name} (exit ${r.status})`);
}

if (failed.length > 0) {
  console.error(`\n✗ typecheck FAILED:\n${failed.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\n✓ typecheck clean across ${targets.length} targets`);
