#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Long-session V8 heap sampler for the `next dev` web server.
 *
 * Complements trace-web-memory.cjs (RSS-only): the dev-server self-restart
 * fires on V8 heap (>80% of heap_size_limit in start-server.js), which RSS
 * can't see — native Turbopack memory dwarfs the JS heap. This samples
 * process.memoryUsage() + v8.getHeapStatistics() via the inspector protocol
 * every N seconds and appends CSV, surviving dev-server restarts by
 * re-discovering the newest next-server PID.
 *
 * Usage: node scripts/dev/sample-web-heap.mjs [--interval 60] [--out FILE]
 * Output columns: iso,pid,rss_mb,heap_used_mb,heap_total_mb,heap_limit_mb,external_mb,pct_of_limit
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const intervalSec = Number(opt("interval", "60"));
const outFile = opt(
  "out",
  "/Users/somehuman/Projects/TicketHunter/logs/dev/web/mem/heap-samples.csv",
);

const findPid = () => {
  const raw = execFileSync("ps", ["-Ao", "pid=,rss=,command="], { encoding: "utf8" });
  const rows = raw
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .filter((m) => /next-server/.test(m[3]))
    .sort((a, b) => Number(b[2]) - Number(a[2]));
  return rows[0] ? Number(rows[0][1]) : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const openInspector = async (pid) => {
  process.kill(pid, "SIGUSR1"); // no-op if already open
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try {
      const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
      const t = list.find((x) => x.webSocketDebuggerUrl);
      if (t) return t.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
  }
  throw new Error("inspector did not open");
};

const evalOnce = (ws, expr) =>
  new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMsg);
      if (msg.error || msg.result?.exceptionDetails) reject(new Error("eval failed"));
      else resolve(msg.result.result.value);
    };
    ws.addEventListener("message", onMsg);
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression: expr, returnByValue: true },
      }),
    );
    setTimeout(() => reject(new Error("eval timeout")), 10_000);
  });

// `require` may be undefined in the inspected context (bundled CJS / ESM), so
// fall back through the diagnostic report for the heap limit.
const EXPR = `(() => {
  const m = process.memoryUsage();
  let limit = 0;
  try { limit = process.getBuiltinModule("v8").getHeapStatistics().heap_size_limit; } catch {}
  if (!limit) { try { limit = require("v8").getHeapStatistics().heap_size_limit; } catch {} }
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, limit };
})()`;

if (!existsSync(outFile)) {
  writeFileSync(outFile, "iso,pid,rss_mb,heap_used_mb,heap_total_mb,heap_limit_mb,external_mb,pct_of_limit\n");
}

let ws = null;
let pid = null;

for (;;) {
  try {
    if (!pid || !ws || ws.readyState !== 1) {
      pid = findPid();
      if (!pid) {
        await sleep(intervalSec * 1000);
        continue;
      }
      const url = await openInspector(pid);
      ws = new WebSocket(url);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
      });
    }
    const s = await evalOnce(ws, EXPR);
    const mb = (b) => (b / 1048576).toFixed(1);
    const pct = s.limit ? ((s.heapUsed / s.limit) * 100).toFixed(1) : "";
    appendFileSync(
      outFile,
      `${new Date().toISOString()},${pid},${mb(s.rss)},${mb(s.heapUsed)},${mb(s.heapTotal)},${mb(s.limit)},${mb(s.external)},${pct}\n`,
    );
    // The watchdog restarts at 80% — flag approach loudly in the CSV.
    if (s.limit && s.heapUsed / s.limit > 0.6) {
      appendFileSync(outFile, `${new Date().toISOString()},${pid},HEAP_ABOVE_60PCT\n`);
    }
  } catch (err) {
    console.error(`${new Date().toISOString()} sample failed: ${err.message}`);
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
    pid = null;
  }
  await sleep(intervalSec * 1000);
}
