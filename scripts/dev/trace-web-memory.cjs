#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Trace memory growth of the local `next dev` web server.
 *
 * Next 16's dev server self-restarts with "Server is approaching the used
 * memory threshold" and prints nothing about *what* grew. This samples RSS +
 * V8 heap over time and grabs .heapsnapshot files at rising watermarks, so two
 * snapshots can be diffed in Chrome DevTools (Memory → Load → Comparison view)
 * to see which constructors retained between them.
 *
 * Usage:
 *   node scripts/dev/trace-web-memory.cjs                     # auto-detect PID
 *   node scripts/dev/trace-web-memory.cjs --pid 12345
 *   node scripts/dev/trace-web-memory.cjs --interval 5 --snapshot-at 1200 --snapshot-every 400
 *
 * Flags:
 *   --pid N             process to watch (default: largest-RSS next-server under this repo)
 *   --interval N        sample seconds (default 5)
 *   --snapshot-at N     RSS in MB at which to take the FIRST heap snapshot (default 1200)
 *   --snapshot-every N  take another snapshot each additional N MB of growth (default 400)
 *   --max-snapshots N   stop after N snapshots (default 3)
 *   --out DIR           output dir (default logs/dev/web/mem)
 *
 * Heap snapshots are written next to a samples.csv. Snapshotting pauses the
 * server for a few seconds and the .heapsnapshot JSON runs ~1.5x the live heap
 * on disk (a 1.6GB RSS process produced a 1.6GB file in testing), so it is
 * deliberately watermark-triggered rather than periodic. `logs/` is gitignored,
 * but delete the snapshots when you're done — they add up fast.
 */
const { execFileSync } = require("node:child_process");
const { mkdirSync, createWriteStream, appendFileSync } = require("node:fs");
const { resolve, join } = require("node:path");

const rootDir = resolve(__dirname, "..", "..");

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out = {
    pid: undefined,
    interval: 5,
    snapshotAt: 1200,
    snapshotEvery: 400,
    maxSnapshots: 3,
    out: join(rootDir, "logs/dev/web/mem"),
  };
  const num = (v) => Number.parseInt(v, 10);
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inlineValue] = args[i].includes("=")
      ? [args[i].slice(0, args[i].indexOf("=")), args[i].slice(args[i].indexOf("=") + 1)]
      : [args[i], undefined];
    const value = inlineValue ?? args[i + 1];
    const consume = () => {
      if (inlineValue === undefined) i += 1;
    };
    switch (flag) {
      case "--pid": out.pid = num(value); consume(); break;
      case "--interval": out.interval = num(value); consume(); break;
      case "--snapshot-at": out.snapshotAt = num(value); consume(); break;
      case "--snapshot-every": out.snapshotEvery = num(value); consume(); break;
      case "--max-snapshots": out.maxSnapshots = num(value); consume(); break;
      case "--out": out.out = resolve(value); consume(); break;
      default: break;
    }
  }
  return out;
};

/** Find the `next dev` server process for THIS repo, largest RSS first. */
const findNextPid = () => {
  const raw = execFileSync("ps", ["-Ao", "pid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const candidates = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) return null;
      return { pid: Number(match[1]), rssKb: Number(match[2]), command: match[3] };
    })
    .filter(Boolean)
    // Next dev runs the compiler/render work in a `next-server` / start-server
    // child; the parent CLI process stays small, so match either and rank by RSS.
    .filter((p) => /next-server|next\/dist\/server|next dev/.test(p.command))
    .filter((p) => !/trace-web-memory/.test(p.command))
    .sort((a, b) => b.rssKb - a.rssKb);

  return candidates[0];
};

/** RSS in MB for a pid, or null if the process is gone. */
const readRssMb = (pid) => {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!out) return null;
    return Number(out) / 1024;
  } catch {
    return null;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open the inspector on a running process. SIGUSR1 makes node start listening
 * on 127.0.0.1:9229; it is a no-op if the inspector is already open.
 */
const openInspector = async (pid) => {
  try {
    process.kill(pid, "SIGUSR1");
  } catch (err) {
    throw new Error(`could not signal pid ${pid}: ${err.message}`);
  }
  // The inspector needs a moment to bind the port.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    try {
      const res = await fetch("http://127.0.0.1:9229/json/list");
      const list = await res.json();
      const target = list.find((t) => t.webSocketDebuggerUrl);
      if (target) return target.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
  }
  throw new Error("inspector did not open on 127.0.0.1:9229");
};

/** Take a .heapsnapshot over the inspector protocol and stream it to disk. */
const takeHeapSnapshot = (wsUrl, filePath) =>
  new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(wsUrl);
    const file = createWriteStream(filePath);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already closing */ }
      file.end(() => (err ? rejectPromise(err) : resolvePromise(filePath)));
    };

    const timeout = setTimeout(() => finish(new Error("heap snapshot timed out after 180s")), 180_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "HeapProfiler.takeHeapSnapshot",
        // Skip the GC-tracing/allocation metadata we don't need; keeps it faster.
        params: { reportProgress: false, captureNumericValue: false },
      }));
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.method === "HeapProfiler.addHeapSnapshotChunk") {
        file.write(msg.params.chunk);
        return;
      }
      if (msg.id === 1) {
        clearTimeout(timeout);
        finish(msg.error ? new Error(JSON.stringify(msg.error)) : undefined);
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      finish(new Error("inspector websocket error"));
    });
  });

const main = async () => {
  const opts = parseArgs();

  let pid = opts.pid;
  if (!pid) {
    const found = findNextPid();
    if (!found) {
      console.error("No `next dev` process found. Start the web dev server first, or pass --pid.");
      process.exit(1);
    }
    pid = found.pid;
    console.log(`Watching pid ${pid} (${(found.rssKb / 1024).toFixed(0)}MB): ${found.command.slice(0, 110)}`);
  }

  mkdirSync(opts.out, { recursive: true });
  const csvPath = join(opts.out, "samples.csv");
  appendFileSync(csvPath, "iso,elapsed_s,rss_mb\n");

  console.log(`Sampling every ${opts.interval}s → ${csvPath}`);
  console.log(`First snapshot at ${opts.snapshotAt}MB, then every +${opts.snapshotEvery}MB (max ${opts.maxSnapshots}).`);

  const startedAt = Date.now();
  let wsUrl = null;
  let snapshots = 0;
  let nextWatermark = opts.snapshotAt;
  let peak = 0;

  for (;;) {
    const rss = readRssMb(pid);
    if (rss === null) {
      console.log(`\npid ${pid} exited (dev server restarted?). Samples kept at ${csvPath}`);
      // A self-restart is itself the event we care about — record it.
      appendFileSync(csvPath, `${new Date().toISOString()},${((Date.now() - startedAt) / 1000).toFixed(0)},PROCESS_GONE\n`);
      return;
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    appendFileSync(csvPath, `${new Date().toISOString()},${elapsed},${rss.toFixed(1)}\n`);
    if (rss > peak) peak = rss;
    process.stdout.write(`\rRSS ${rss.toFixed(0)}MB (peak ${peak.toFixed(0)}MB) · ${elapsed}s · snapshots ${snapshots}   `);

    if (rss >= nextWatermark && snapshots < opts.maxSnapshots) {
      const label = `heap-${snapshots + 1}-${Math.round(rss)}mb.heapsnapshot`;
      const filePath = join(opts.out, label);
      process.stdout.write(`\nRSS crossed ${Math.round(nextWatermark)}MB — taking ${label} (server pauses briefly)...\n`);
      try {
        if (!wsUrl) wsUrl = await openInspector(pid);
        await takeHeapSnapshot(wsUrl, filePath);
        snapshots += 1;
        nextWatermark = rss + opts.snapshotEvery;
        console.log(`Wrote ${filePath}`);
        if (snapshots >= opts.maxSnapshots) {
          console.log("\nSnapshot budget spent. Compare them in Chrome DevTools:");
          console.log("  chrome://inspect → Memory → Load → select both → Comparison view, sort by Delta.");
        }
      } catch (err) {
        console.error(`\nSnapshot failed: ${err.message}`);
        // Back off past this watermark so we don't retry every tick.
        nextWatermark = rss + opts.snapshotEvery;
        wsUrl = null;
      }
    }

    await sleep(opts.interval * 1000);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
