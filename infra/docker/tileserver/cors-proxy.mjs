/**
 * Lightweight CORS-aware reverse proxy for TileServer GL.
 *
 * Cloud Run exposes port $PORT (default 8080).  This proxy listens on that
 * port and forwards every request to TileServer GL which runs on an internal
 * port (TILESERVER_PORT, default 8081).
 *
 * CORS behaviour is driven by the ALLOWED_ORIGINS env var — a comma-separated
 * list of allowed origins.  If the request's Origin header is not in the list
 * the response omits Access-Control-Allow-Origin entirely (browser will block
 * the fetch).
 *
 * When ALLOWED_ORIGINS is empty or unset the proxy falls back to "*" so local
 * dev and health-checks keep working.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const LISTEN_PORT = parseInt(process.env.PORT || "8080", 10);
const BACKEND_PORT = parseInt(process.env.TILESERVER_PORT || "8081", 10);
const BACKEND_HOST = "127.0.0.1";

// ── Per-IP sliding-window rate limiter ──────────────────────────────────────
// Env-configurable.  Defaults: 50 requests per 1-second window per IP.
// Cloud Run instances are ephemeral, so the counters reset on cold start.
// That's fine — this catches scripted abuse, not sophisticated DDoS.
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_RPS || "50", 10);
const RATE_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "1000", 10);

/** @type {Map<string, { count: number, resetAt: number }>} */
const ipBuckets = new Map();

// Evict stale entries every 30s so the Map doesn't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of ipBuckets) {
    if (bucket.resetAt < now) ipBuckets.delete(ip);
  }
}, 30_000).unref(); // .unref() so the timer doesn't prevent graceful exit

/**
 * Returns true if the request is allowed, false if rate-limited.
 * @param {string} ip
 */
function rateLimit(ip) {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 1, resetAt: now + RATE_WINDOW_MS };
    ipBuckets.set(ip, bucket);
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT;
}

// Parse allowed origins from env (comma-separated, trimmed, lowered).
const rawOrigins = (process.env.ALLOWED_ORIGINS || "").trim();
const allowedOrigins = rawOrigins
  ? rawOrigins.split(",").map((o) => o.trim().toLowerCase())
  : null; // null = allow all

function resolveOrigin(reqOrigin) {
  if (!reqOrigin) return null; // no Origin header → no ACAO header
  if (!allowedOrigins) return "*"; // no restriction configured
  const lower = reqOrigin.toLowerCase();
  for (const pattern of allowedOrigins) {
    // Exact match (e.g. "http://localhost:3000")
    if (pattern === lower) return reqOrigin;

    // Wildcard subdomain match.
    // Pattern may be "https://*.ithasfire.com" or bare "*.ithasfire.com".
    const starIdx = pattern.indexOf("*.");
    if (starIdx !== -1) {
      const suffix = pattern.slice(starIdx + 1); // e.g. ".ithasfire.com"
      const schemePrefix = pattern.slice(0, starIdx); // e.g. "https://" or ""

      // If pattern has a scheme, match scheme + any subdomain + suffix.
      // If bare wildcard, match any scheme + subdomain + suffix.
      if (schemePrefix) {
        // e.g. pattern "https://*.ithasfire.com"
        //      lower   "https://web-dev.ithasfire.com"
        if (
          lower.startsWith(schemePrefix) &&
          lower.endsWith(suffix) &&
          lower.length > schemePrefix.length + suffix.length
        ) {
          return reqOrigin;
        }
        // Also match the bare domain (no subdomain):
        // e.g. "https://ithasfire.com" matches "https://*.ithasfire.com"
        if (lower === schemePrefix + suffix.slice(1)) return reqOrigin;
      } else {
        // Bare wildcard: "*.ithasfire.com"
        // Match "https://anything.ithasfire.com" or "http://..."
        const afterScheme = lower.replace(/^https?:\/\//, "");
        if (afterScheme.endsWith(suffix) && afterScheme.length > suffix.length) {
          return reqOrigin;
        }
      }
    }
  }
  return null; // origin not allowed
}

// ── Headless X server for MapLibre's native renderer ────────────────────────
// The base image's docker-entrypoint.sh is what normally starts Xvfb, and this
// image overrides ENTRYPOINT to run this proxy instead — so if we don't start
// it here, nothing does.  A missing display is not a partial outage: the first
// raster request (/styles/:id/static/... or /styles/:id/{z}/{x}/{y}.png) makes
// tileserver-gl abort with `std::runtime_error: Failed to open X display`, which
// trips the tile.on("exit") handler below and takes the whole container down —
// vector tiles, style.json and fonts included.  That's why a dead Xvfb is
// restarted rather than merely logged.
//
// Only ":<digits>" works.  "99" is not something X accepts as a display, and
// ":99.0" makes XVFB_LOCK point at /tmp/.X99.0-lock while Xvfb actually locks
// /tmp/.X99-lock (the screen suffix isn't part of the lock name) — both quietly
// reinstate the original bug, so reject them instead of trusting the env.
const DEFAULT_DISPLAY = ":99";
const requestedDisplay = process.env.XVFB_DISPLAY || DEFAULT_DISPLAY;
const DISPLAY = /^:\d+$/.test(requestedDisplay) ? requestedDisplay : DEFAULT_DISPLAY;
if (DISPLAY !== requestedDisplay) {
  console.error(
    `XVFB_DISPLAY="${requestedDisplay}" is not of the form ":<n>" — falling back to ${DEFAULT_DISPLAY}`
  );
}

// Derived from DISPLAY so the display and its lock file can't drift apart.
const XVFB_LOCK = `/tmp/.X${DISPLAY.slice(1)}-lock`;

// Xvfb always emits these three on startup and they mean nothing.  Cloud Run
// logs stderr at ERROR severity and min_instances is 0, so unfiltered they'd
// forge an ERROR line on every cold start.  Same patterns the base image's
// entrypoint greps out.
const XKB_NOISE =
  /(Could not resolve keysym|XKEYBOARD keymap compiler|xkbcomp are not fatal)/;

// tileserver-gl retries opening the display ~20 times over ~12s before it
// aborts, so an Xvfb that comes back inside that window actually rescues the
// in-flight render.  That retry window is doing the real work here: Cloud Run
// runs this service with cpu_idle (CPU throttled to ~0 between requests), so
// neither the exit handler nor this backoff makes progress while the instance
// is idle.  The respawn is therefore lazy — in practice X comes back when the
// next request wakes the instance, quite possibly the very raster request that
// needs it.  Don't read the delay below as a recovery-time guarantee.
//
// The cap means "crash-looping", not "cumulative bad luck": the counter resets
// once a child has stayed up XVFB_HEALTHY_AFTER_MS, so an instance that loses X
// five times over several hours and recovers each time still gets a sixth try.
const XVFB_MAX_RESTARTS = 5;
const XVFB_RESTART_DELAY_MS = 500;
const XVFB_HEALTHY_AFTER_MS = 60_000;
let xvfbRestarts = 0;

// Set before we kill the children on SIGTERM/SIGINT.  Without it every
// scale-to-zero and every revision rollout logs an ERROR-severity line claiming
// a failure that didn't happen — poisoning the one string worth alerting on.
let shuttingDown = false;

/** @type {import("node:child_process").ChildProcess} */
let xvfb;

/** Starts Xvfb, wiring up log filtering and bounded restart-on-death. */
function startXvfb() {
  if (shuttingDown) return;

  // A lock file left behind by a crashed X server makes Xvfb refuse to start,
  // so clear it on every attempt, not just the first.  Best-effort: the common
  // case is "not there", which force already swallows.
  try {
    rmSync(XVFB_LOCK, { force: true });
  } catch (err) {
    console.error(`could not remove stale ${XVFB_LOCK}: ${err.message}`);
  }

  xvfb = spawn("Xvfb", [DISPLAY, "-nolisten", "unix"], {
    // stderr is piped (not inherited) purely so we can drop the xkb noise.
    stdio: ["ignore", "inherit", "pipe"],
  });

  // Treat a child that survives the window as a recovery, not a strike.  Cleared
  // in the exit handler so a child dying inside the window can't reset the count
  // on its way out.  .unref() so a pending reset never holds the process open.
  const healthyTimer = setTimeout(() => {
    xvfbRestarts = 0;
  }, XVFB_HEALTHY_AFTER_MS);
  healthyTimer.unref();

  // Filter line-by-line, buffering the trailing partial line: a chunk boundary
  // can land mid-message, and a half-line never matches the noise patterns.
  let pending = "";
  xvfb.stderr.setEncoding("utf8");
  xvfb.stderr.on("data", (chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line && !XKB_NOISE.test(line)) console.error(line);
    }
  });

  xvfb.stderr.on("end", () => {
    // Flush a trailing line that arrived without a newline — when X dies that
    // last unterminated line is usually the one saying why.
    if (pending && !XKB_NOISE.test(pending)) console.error(pending);
    pending = "";
  });

  xvfb.on("error", (err) => {
    console.error(
      `failed to spawn Xvfb: ${err.message} — the next raster request will crash tileserver-gl`
    );
  });

  xvfb.on("exit", (code, signal) => {
    clearTimeout(healthyTimer);
    if (shuttingDown) return; // we killed it on purpose
    if (xvfbRestarts >= XVFB_MAX_RESTARTS) {
      console.error(
        `Xvfb exited (code ${code}, signal ${signal}) after ${XVFB_MAX_RESTARTS} restarts — giving up; the next raster request will crash tileserver-gl`
      );
      return;
    }
    xvfbRestarts += 1;
    console.error(
      `Xvfb exited (code ${code}, signal ${signal}) — restarting (${xvfbRestarts}/${XVFB_MAX_RESTARTS})`
    );
    setTimeout(startXvfb, XVFB_RESTART_DELAY_MS).unref();
  });
}

startXvfb();

// ── Start TileServer GL on the internal port ────────────────────────────────
const tileArgs = [
  "/usr/src/app/",
  "--no-cors", // we handle CORS ourselves
  "--port",
  String(BACKEND_PORT),
  "--config",
  "config.json",
];

const tile = spawn("node", tileArgs, {
  stdio: "inherit",
  cwd: "/data",
  env: {
    ...process.env,
    // TileServer GL's server.js reads `process.env.PORT` with higher priority
    // than the --port CLI flag.  Cloud Run sets PORT=8080 for the proxy, so we
    // must override it in the child so tileserver binds the internal port.
    PORT: String(BACKEND_PORT),
    // MapLibre's native renderer connects to this display for raster output.
    // Scoped to the child so the proxy itself keeps a clean env.
    DISPLAY,
  },
});

tile.on("exit", (code) => {
  if (shuttingDown) {
    // Expected: we just killed it.  Exit 0 rather than returning, because this
    // handler is also what ends the process — server.close() only stops new
    // connections, so idle keep-alives would otherwise hold us open until
    // Cloud Run's SIGKILL.
    console.log("tileserver-gl exited during shutdown");
    process.exit(0);
  }
  console.error(`tileserver-gl exited with code ${code}`);
  process.exit(code ?? 1);
});

// Wait for TileServer GL to be ready before accepting traffic.
// GCSFuse + large PMTiles files can take 30-60+ seconds to scan on cold start.
const BACKEND_READY_TIMEOUT_MS = 240_000; // 4 minutes (matches Cloud Run startup probe)
const BACKEND_POLL_INTERVAL_MS = 2_000;

await new Promise((resolve, reject) => {
  const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
  const check = () => {
    const req = http.get(
      { hostname: BACKEND_HOST, port: BACKEND_PORT, path: "/health", timeout: 2000 },
      (res) => {
        res.resume(); // drain
        if (res.statusCode && res.statusCode < 500) {
          console.log(`tileserver-gl ready (HTTP ${res.statusCode}) after ${Math.round((Date.now() - (deadline - BACKEND_READY_TIMEOUT_MS)) / 1000)}s`);
          resolve();
        } else if (Date.now() >= deadline) {
          reject(new Error(`tileserver-gl not ready after ${BACKEND_READY_TIMEOUT_MS / 1000}s`));
        } else {
          setTimeout(check, BACKEND_POLL_INTERVAL_MS);
        }
      }
    );
    req.on("error", () => {
      if (Date.now() >= deadline) {
        reject(new Error(`tileserver-gl not ready after ${BACKEND_READY_TIMEOUT_MS / 1000}s`));
      } else {
        setTimeout(check, BACKEND_POLL_INTERVAL_MS);
      }
    });
  };
  // Initial delay — give the process a moment to start
  setTimeout(check, 1500);
});

// ── Reverse proxy with CORS ─────────────────────────────────────────────────
const server = http.createServer((clientReq, clientRes) => {
  // Fast-path health check so Cloud Run startup probes don't wait for origin
  if (clientReq.url === "/health" || clientReq.url === "/healthz") {
    clientRes.writeHead(200, { "content-type": "text/plain" });
    clientRes.end("OK");
    return;
  }

  // Per-IP rate limit.  X-Forwarded-For is set by Cloud Run's load balancer;
  // fall back to socket address for local dev / direct access.
  const clientIp =
    (clientReq.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    clientReq.socket.remoteAddress ||
    "unknown";

  if (!rateLimit(clientIp)) {
    const retryAfter = Math.ceil(RATE_WINDOW_MS / 1000);
    clientRes.writeHead(429, {
      "content-type": "text/plain",
      "retry-after": String(retryAfter),
    });
    clientRes.end("Too Many Requests");
    return;
  }

  const origin = resolveOrigin(clientReq.headers["origin"]);

  // Preflight
  if (clientReq.method === "OPTIONS") {
    const headers = {
      "access-control-max-age": "86400",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers":
        "Origin, Accept, Content-Type, Range",
      // The CORS decision depends on the request Origin, and tile/style/font
      // responses are cached (cache-control: public). Without Vary: Origin a
      // shared cache could replay an allow-origin header minted for one origin
      // to a different origin, silently breaking (or wrongly granting) CORS.
      vary: "Origin",
      "content-length": "0",
    };
    if (origin) headers["access-control-allow-origin"] = origin;
    clientRes.writeHead(204, headers);
    clientRes.end();
    return;
  }

  // Proxy to tileserver
  // Forward the original Host header so TileServer GL generates correct
  // public URLs in style.json / tilejson responses.  We only override the
  // internal host when there is no incoming Host header (shouldn't happen).
  // Never forward client credentials upstream. The tileserver serves public
  // map assets and has no notion of our sessions, so a `Cookie` (session token)
  // or `Authorization` header on an inbound request must be stripped before
  // proxying — otherwise this proxy would leak the caller's credentials to the
  // tileserver backend (and any logs/caches in that path). Destructure them out
  // and spread the rest.
  const {
    cookie: _cookie,
    authorization: _authorization,
    ...forwardableHeaders
  } = clientReq.headers;

  const proxyReq = http.request(
    {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...forwardableHeaders,
        host: clientReq.headers.host || `${BACKEND_HOST}:${BACKEND_PORT}`,
        "x-forwarded-proto": clientReq.headers["x-forwarded-proto"] || "https",
      },
    },
    (proxyRes) => {
      const headers = { ...proxyRes.headers };

      // Replace any wildcard CORS header from tileserver (shouldn't exist
      // with --no-cors, but belt-and-suspenders).
      delete headers["access-control-allow-origin"];

      if (origin) {
        headers["access-control-allow-origin"] = origin;
      }

      // Mark the response as varying on Origin so shared caches don't replay an
      // allow-origin header minted for one origin to another. Merge with any
      // Vary the backend already set rather than clobbering it.
      const existingVary = headers["vary"];
      const varyTokens = (
        Array.isArray(existingVary) ? existingVary.join(",") : existingVary || ""
      )
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (!varyTokens.some((t) => t.toLowerCase() === "origin")) {
        varyTokens.push("Origin");
      }
      headers["vary"] = varyTokens.join(", ");

      // Encourage browsers and intermediate caches to store tiles.
      if (
        !headers["cache-control"] &&
        /\.(pbf|json|png|jpg|jpeg|webp)(\?|$)/i.test(clientReq.url ?? "")
      ) {
        headers["cache-control"] = "public, max-age=604800"; // 7 days
      }

      clientRes.writeHead(proxyRes.statusCode ?? 200, headers);
      proxyRes.pipe(clientRes);
    }
  );

  proxyReq.on("error", (err) => {
    console.error("proxy error:", err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "text/plain" });
    }
    clientRes.end("Bad Gateway");
  });

  clientReq.pipe(proxyReq);
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(
    `CORS proxy listening on :${LISTEN_PORT} → tileserver :${BACKEND_PORT}`
  );
  console.log(`Rate limit: ${RATE_LIMIT} req/${RATE_WINDOW_MS}ms per IP`);
  if (allowedOrigins) {
    console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
  } else {
    console.log("Allowed origins: * (unrestricted — set ALLOWED_ORIGINS to lock down)");
  }
});

// Graceful shutdown
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`Caught ${sig}, shutting down`);
    // Before the kills, so the exit handlers read this as intent rather than
    // reporting a failure or respawning Xvfb on the way out.
    shuttingDown = true;
    server.close();
    tile.kill(sig);
    xvfb.kill(sig);
  });
}
