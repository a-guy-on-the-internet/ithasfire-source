import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./bypass-guard.pl", import.meta.url));
const run = (stdin) => spawnSync("perl", [guard], { input: stdin, encoding: "utf8" });
const cmd = (command) => run(JSON.stringify({ tool_input: { command } }));

const blocked = [
  "tsc -p tsconfig.json --noEmit",
  "cd apps/web && pnpm exec tsc -p tsconfig.json --noEmit",
  "npx tsc -p tsconfig.json --noEmit",
  "node_modules/.bin/tsc -p tsconfig.json",
  "./node_modules/.bin/tsc --noEmit",
  "node ../../node_modules/typescript/bin/tsc -p .",
  "pnpm -F web exec tsc --noEmit",
  "pnpm --filter @th/core exec tsc --noEmit",
  "yarn tsc --noEmit",
  "timeout 600 tsc --noEmit",
  "env NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit",
  "echo hi; tsc --noEmit",
  "false || tsc --noEmit",
  "cat x | tsc --noEmit",
  "(cd apps/api && tsc --noEmit)",
  "x=$(tsc --noEmit)",
  "echo a\ntsc --noEmit",
  "exec tsc --noEmit",
  "next build",
  "pnpm exec next build",
  "npx next build",
  "cd apps/web && next build",
  "pnpm -F web exec next build",
  "NODE_ENV=production pnpm exec tsc -p x",
  "cat <<'EOF'\nhello\nEOF\ntsc --noEmit",
  "pnpm --filter=web exec tsc --noEmit",
  "pnpm -C apps/web exec tsc --noEmit",
  "pnpm --dir apps/web exec tsc --noEmit",
  "pnpm -r exec tsc --noEmit",
  "pnpm -F web tsc --noEmit",
  "npx -y tsc --noEmit",
  "npx -p typescript tsc --noEmit",
  "node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p .",
  "sleep 1 & tsc --noEmit",
  "echo hi 2>&1 | tsc --noEmit",
  "make &> /dev/null; tsc --noEmit",
  "npm exec tsc -- --noEmit",
  "pnpm dlx tsc --noEmit",
  "pnpm -r exec next build",
  "for d in a b; do pnpm -F $d exec tsc; done",
  "if true; then tsc -p x; fi",
  "while true; do npx tsc; done",
  "! tsc -p x",
  "time tsc -p x",
  "time -p tsc -p x",
  "if false; then echo; else tsc -p x; fi",
];

const allowed = [
  "node scripts/dev/gate/run.mjs --weight heavy -- tsc --noEmit",
  "bash scripts/dev/gate/with-gate-lock.sh pnpm exec tsc --noEmit",
  "node scripts/dev/gate/with-gate.mjs tsc --noEmit",
  "GATE_LOCK=0 tsc --noEmit",
  "tsc --version",
  "tsc -v",
  "tsc --help",
  "tsc -p x --showConfig",
  "tsc --watch",
  "tsc -w -p x",
  "pnpm tsc:status",
  "pnpm exec tsc-daemon status",
  "pnpm typecheck",
  "pnpm typecheck:web",
  "pnpm -F web build",
  "ls",
  "pnpm -r run typecheck",
  "for f in *.ts; do echo $f; done",
  "time pnpm typecheck",
  "if grep -q tsc x; then echo y; fi",
  "pnpm -r exec echo hi",
  "pnpm -F web exec vitest run",
  "npx -y prettier --check x",
  "node --max-old-space-size=8192 scripts/x.mjs",
  "pnpm -C apps/web exec playwright test",
  "sleep 1 & echo tsc",
  "ls 2>&1 | grep tsc",
  'grep -n "tsc -p" package.json',
  "rg tsc scripts",
  "grep tsc package.json",
  'git commit -m "fix tsc"',
  "echo tsc",
  "cat tsconfig.json",
  // Not a command position: reading or listing the binary runs nothing.
  "ls node_modules/.bin/tsc",
  "cat <<'EOF'\nrun tsc -p x\nEOF",
  "echo 'next build'",
  "git log --oneline -- next.config.ts",
];

for (const c of blocked) {
  test(`blocks: ${JSON.stringify(c)}`, () => {
    const r = cmd(c);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Ungated/);
  });
}
for (const c of allowed) {
  test(`allows: ${JSON.stringify(c)}`, () => {
    const r = cmd(c);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });
}
for (const [name, input] of [
  ["malformed JSON", "{not json"],
  ["empty stdin", ""],
  ["no tool_input", "{}"],
  ["non-string command", JSON.stringify({ tool_input: { command: 5 } })],
  ["array top level", "[]"],
]) {
  test(`fails open: ${name}`, () => assert.equal(run(input).status, 0));
}

test("per-call latency", () => {
  const t = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) cmd("pnpm typecheck");
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / 50;
  console.log(`bypass-guard: ${ms.toFixed(1)} ms/call (incl. process spawn)`);
  assert.ok(ms < 100);
});
