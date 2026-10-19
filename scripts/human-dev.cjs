#!/usr/bin/env node
/**
 * Human-friendly dev script.
 *
 * Startup order:
 *   1. Docker infra (Postgres + Redis)
 *   2. API server  (waits until /health responds)
 *   3. Jobs server (waits until /health responds)
 *   4. Stripe CLI listener (forwards webhooks to local API)
 *   5. Web server  (Next.js, pointed at the local API)
 *   6. Database seed
 *
 * Usage:
 *   pnpm human:dev             # Full stack + seed
 *   pnpm human:dev --no-seed   # Skip seeding
 *   pnpm human:dev --seed-only # Just seed the DB, don't boot servers
 *
 * For AI agents use `pnpm api:bg` / `pnpm web:dev:local` instead.
 */

const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const {
  applyWebhookSecretOverride,
  formatAccountBanner,
  redactSecrets,
  resolveStripeListenerConfig,
} = require("./lib/stripe-listen-config.cjs");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const ARGS = process.argv.slice(2);

const FLAG_NO_SEED = ARGS.includes("--no-seed");
const FLAG_SEED_ONLY = ARGS.includes("--seed-only");
const FLAG_SEED_REMOTE =
  ARGS.includes("--seed-remote") || process.env.HUMAN_DEV_SEED_REMOTE === "1";

const API_PORT = 3001;
const JOBS_PORT = 3002;
const WEB_PORT = 3000;
const TRANSCODER_PORT = 3099;
const API_HEALTH_URL = `http://127.0.0.1:${API_PORT}/health`;
const JOBS_HEALTH_URL = `http://127.0.0.1:${JOBS_PORT}/health`;
const TRANSCODER_HEALTH_URL = `http://127.0.0.1:${TRANSCODER_PORT}/health`;
const LOCAL_DB_URL =
  "postgresql://postgres:postgres@localhost:5432/dev?schema=public";

// ─────────────────────────────────────────────────────────────────────────────
// Logging helpers
// ─────────────────────────────────────────────────────────────────────────────

const C = /** @type {const} */ ({
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
});

function log(color, tag, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`${color}[${ts}] [${tag}]${C.reset} ${msg}`);
}

function banner(msg) {
  const bar = "\u2550".repeat(60);
  console.log(`\n${C.bold}${C.cyan}${bar}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${msg}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${bar}${C.reset}\n`);
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {number} port */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(400);
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.connect(port, "127.0.0.1", () => { s.end(); resolve(true); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Docker infra
// ─────────────────────────────────────────────────────────────────────────────

function ensureDocker() {
  banner("Ensuring Docker infra is running");
  try {
    execSync("docker compose up -d", {
      cwd: path.join(ROOT, "infra", "docker"),
      stdio: "inherit",
    });
    log(C.green, "INFRA", "Docker containers are up");
  } catch {
    log(C.red, "INFRA", "Failed to start Docker. Is Docker Desktop running?");
    process.exit(1);
  }
}

async function waitForDb(timeoutMs = 60_000) {
  const dir = path.join(ROOT, "infra", "docker");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const id = execSync("docker compose ps -q db", { cwd: dir })
        .toString()
        .trim();
      if (id) {
        const s = execSync(
          `docker inspect -f '{{.State.Health.Status}}' ${id}`,
        )
          .toString()
          .trim();
        if (s === "healthy") return;
        log(C.yellow, "INFRA", `DB health: ${s}`);
      }
    } catch {
      /* container may not exist yet */
    }
    await delay(1_000);
  }
  log(C.yellow, "INFRA", "DB health-check timed out; continuing anyway");
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP health-check (used to wait for the API)
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<{status:number, body:string}|null>} */
function httpGet(url, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitForApi(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await httpGet(API_HEALTH_URL);
    if (res && res.status >= 200 && res.status < 400) return true;
    await delay(500);
  }
  return false;
}

async function waitForJobs(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await httpGet(JOBS_HEALTH_URL);
    if (res && res.status >= 200 && res.status < 400) return true;
    await delay(500);
  }
  return false;
}

async function waitForTranscoder(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await httpGet(TRANSCODER_HEALTH_URL);
    if (res && res.status >= 200 && res.status < 400) return true;
    await delay(500);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Process management
// ─────────────────────────────────────────────────────────────────────────────

/** @type {import("child_process").ChildProcess[]} */
const children = [];

function waitForPort(port, timeoutMs = 60_000) {
  const start = Date.now();
  return new Promise(async (resolve) => {
    while (Date.now() - start < timeoutMs) {
      if (await isPortInUse(port)) return resolve(true);
      await delay(500);
    }
    resolve(false);
  });
}

function spawnService(tag, cmd, cmdArgs, extraEnv = {}) {
  const color =
    tag === "API" ? C.cyan
    : tag === "JOBS" ? C.yellow
    : tag === "STRIPE" ? C.magenta
    : tag === "TRANSCODER" ? C.cyan
    : C.green;
  const proc = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "1", ...extraEnv },
  });

  proc.stdout.on("data", (d) => {
    for (const l of d.toString().split("\n").filter(Boolean)) log(color, tag, l);
  });
  proc.stderr.on("data", (d) => {
    for (const l of d.toString().split("\n").filter(Boolean)) log(C.yellow, tag, l);
  });
  proc.on("error", (e) => {
    log(C.red, tag, `Process error: ${e.message}`);
    console.error("HEY WE ERRORED:", `${tag} failed to start: ${e.message}`);
    shutdown();
    process.exit(1);
  });
  proc.on("exit", (code) => {
    if (code && code !== 0) {
      log(C.red, tag, `Exited with code ${code}`);
      if (tag === "API" || tag === "JOBS" || tag === "WEB") {
        console.error("HEY WE ERRORED:", `${tag} exited with code ${code}`);
        shutdown();
        process.exit(1);
      }
    }
  });

  children.push(proc);
  return proc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeding
// ─────────────────────────────────────────────────────────────────────────────

function resolveSeedDbUrl() {
  const url = process.env.DATABASE_URL ?? LOCAL_DB_URL;
  try {
    const host = new URL(url).hostname;
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLocal && !FLAG_SEED_REMOTE) {
      log(
        C.yellow,
        "SEED",
        `Non-local DATABASE_URL (${host}); using local fallback. Pass --seed-remote to override.`,
      );
      return LOCAL_DB_URL;
    }
  } catch {
    return LOCAL_DB_URL;
  }
  return url;
}

/**
 * Read the "Dev Login User" block from the seed credentials file the seed
 * step writes (apps/api/.secrets/seed-credentials.txt) and format it for the
 * ready banner. Returns "" when the file is missing (e.g. --no-seed) so the
 * banner stays intact. Reading the file avoids hardcoding credentials here and
 * keeps the banner in sync with whatever the seed actually created.
 */
function formatSeedLogin() {
  try {
    const credsPath = path.join(
      ROOT,
      "apps/api/.secrets/seed-credentials.txt",
    );
    const lines = fs.readFileSync(credsPath, "utf-8").split("\n");
    const email = lines.find((l) => l.startsWith("Email:"))?.slice(6).trim();
    const password = lines
      .find((l) => l.startsWith("Password:"))
      ?.slice(9)
      .trim();
    if (!email || !password) return "";
    return `
  ${C.bold}${C.green}Sign in (dev admin):${C.reset}
  ${C.cyan}Email:${C.reset}    ${email}
  ${C.cyan}Password:${C.reset} ${password}
  ${C.cyan}More:${C.reset}     apps/api/.secrets/seed-credentials.txt
`;
  } catch {
    return "";
  }
}

async function seedDatabase() {
  banner("Seeding database");
  const dbUrl = resolveSeedDbUrl();

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync("pnpm seed:dev", {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: dbUrl },
      });
      log(C.green, "SEED", "Database seeded successfully");
      return;
    } catch {
      log(C.yellow, "SEED", `Attempt ${attempt}/3 failed`);
      if (attempt < 3) await delay(attempt * 1_000);
    }
  }

  throw new Error("Seeding failed after 3 attempts");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stale lock cleanup
// ─────────────────────────────────────────────────────────────────────────────

function removeStaleNextLock() {
  const lockPath = path.join(ROOT, "apps", "web", ".next", "dev", "lock");
  try {
    if (fs.existsSync(lockPath)) {
      log(C.yellow, "WEB", "Removing stale .next/dev/lock");
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort `adb reverse` so a USB- or wireless-attached Android device
 * (Pixel test phone, scanner builds) can hit the local API + Metro on
 * `http://localhost:3001` / `:8082`. No-op if `adb` isn't on PATH or no
 * device is attached — devs who don't run scanner builds shouldn't see a
 * red banner because of it.
 */
function setupAdbReverse() {
  try {
    execSync("adb version", { stdio: "ignore" });
  } catch {
    // adb not installed — silent no-op.
    return;
  }

  let devices;
  try {
    const raw = execSync("adb devices", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    devices = raw
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.endsWith("\tdevice"));
  } catch {
    return;
  }

  if (!devices.length) {
    log(C.yellow, "ADB", "No Android device attached — skipping reverse port forward.");
    return;
  }

  const ports = [API_PORT, JOBS_PORT, 8082];
  let ok = 0;
  for (const port of ports) {
    try {
      execSync(`adb reverse tcp:${port} tcp:${port}`, { stdio: "ignore" });
      ok += 1;
    } catch {
      // Soft failure — surface but keep going.
      log(C.yellow, "ADB", `reverse tcp:${port} failed (device may be offline)`);
    }
  }
  if (ok > 0) {
    log(C.green, "ADB", `Forwarded ${ok} port(s) to ${devices.length} device(s) — phone can now hit localhost.`);
  }
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;

  if (platform === "darwin") {
    cmd = "open";
  } else if (platform === "win32") {
    cmd = "cmd";
  } else {
    cmd = "xdg-open";
  }

  try {
    if (platform === "win32") {
      execSync(`cmd /c start "" "${url}"`, { stdio: "ignore" });
    } else {
      execSync(`${cmd} "${url}"`, { stdio: "ignore" });
    }
    log(C.green, "WEB", `Opened browser at ${url}`);
  } catch (err) {
    log(C.yellow, "WEB", `Failed to open browser automatically: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe listener resolution
// ─────────────────────────────────────────────────────────────────────────────

const STRIPE_FORWARD_TO =
  process.env.STRIPE_LISTEN_FORWARD_TO ?? `http://localhost:${API_PORT}/webhooks/stripe`;

/**
 * Attach the Stripe CLI listener to the API's own account. Reads
 * STRIPE_SECRET_KEY from apps/api/.env.local (fallback apps/api/.env), asks
 * the CLI for that account's signing secret, and looks up the account name
 * so a key/account mismatch is visible at boot. Returns null (and logs why)
 * when webhooks can't be wired — the stack still boots. Never logs the key.
 */
async function resolveStripeListener() {
  try {
    execSync("stripe --version", { stdio: "ignore" });
  } catch {
    log(
      C.yellow,
      "STRIPE",
      "Stripe CLI not found; skipping webhook listener. Install: https://docs.stripe.com/stripe-cli",
    );
    return null;
  }
  try {
    const cfg = await resolveStripeListenerConfig({ rootDir: ROOT, forwardTo: STRIPE_FORWARD_TO });
    if (cfg.accountError) {
      log(
        C.yellow,
        "STRIPE",
        `Could not look up the Stripe account name (${cfg.accountError}); continuing with the signing secret already obtained.`,
      );
    }
    log(C.magenta, "STRIPE", formatAccountBanner(cfg.account));
    return cfg;
  } catch (err) {
    log(C.red, "STRIPE", `⚠ Could not set up the webhook listener: ${redactSecrets(err.message)}`);
    log(C.yellow, "STRIPE", "  Booting without Stripe webhooks (checkout will not finalize, disputes will not land).");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

function shutdown() {
  console.log(`\n${C.yellow}Shutting down...${C.reset}`);
  for (const p of children) {
    try {
      p.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
  setTimeout(() => process.exit(0), 1_500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${C.bold}${C.cyan}\u2554${"=".repeat(58)}\u2557${C.reset}
${C.bold}${C.cyan}\u2551  Ithas Fire  Human Dev Mode${" ".repeat(28)}\u2551${C.reset}
${C.bold}${C.cyan}\u2551  For humans who click around and test stuff.${" ".repeat(12)}\u2551${C.reset}
${C.bold}${C.cyan}\u2551  Ctrl+C to stop everything.${" ".repeat(30)}\u2551${C.reset}
${C.bold}${C.cyan}\u255A${"=".repeat(58)}\u255D${C.reset}
`);

  // 1. Docker infra (Postgres + Redis)
  ensureDocker();
  await waitForDb();

  // --seed-only: seed and exit immediately
  if (FLAG_SEED_ONLY) {
    await seedDatabase();
    log(C.green, "DONE", "Seed complete (--seed-only). Exiting.");
    process.exit(0);
  }

  // 1b. Resolve the Stripe listener BEFORE the API boots: the listener must
  // run on the same Stripe account as the API's STRIPE_SECRET_KEY, and the
  // API must verify deliveries with THAT account's CLI signing secret. Both
  // come from `stripe listen --api-key <key> --print-secret`; the secret is
  // injected (pinned) into the API child's env below. Best-effort: with no
  // CLI / no key we boot without webhooks, as before.
  const stripeListener = await resolveStripeListener();

  // 2. Start API and wait for it to become healthy
  banner("Starting API server (port " + API_PORT + ")");

  if (await isPortInUse(API_PORT)) {
    log(C.yellow, "API", `Port ${API_PORT} already in use -- assuming API is running`);
    if (stripeListener) {
      log(
        C.yellow,
        "STRIPE",
        "API was not started by this script, so STRIPE_WEBHOOK_SECRET could not be injected — deliveries will 400 unless its env already matches this listener's secret. Remedy: stop the existing API and re-run `pnpm human:dev`.",
      );
    }
  } else {
    spawnService(
      "API",
      "pnpm",
      ["-F", "api", "dev"],
      stripeListener
        ? applyWebhookSecretOverride(process.env, stripeListener.webhookSecret)
        : {},
    );
    if (stripeListener) {
      log(C.green, "STRIPE", "Injected this listener's signing secret into the API env (STRIPE_WEBHOOK_SECRET, pinned via DEV_ENV_PINS)");
    }
  }

  log(C.cyan, "API", "Waiting for health-check ...");
  const apiOk = await waitForApi();
  if (apiOk) {
    log(C.green, "API", "Healthy");
  } else {
    throw new Error("API health-check failed (timeout)");
  }

  // 3. Start Jobs server and wait for it to become healthy
  banner("Starting Jobs server (port " + JOBS_PORT + ")");

  if (await isPortInUse(JOBS_PORT)) {
    log(C.yellow, "JOBS", `Port ${JOBS_PORT} already in use -- assuming Jobs server is running`);
  } else {
    spawnService("JOBS", "pnpm", ["-F", "jobs", "dev"]);
  }

  log(C.yellow, "JOBS", "Waiting for health-check ...");
  const jobsOk = await waitForJobs();
  if (jobsOk) {
    log(C.green, "JOBS", "Healthy");
  } else {
    throw new Error("Jobs health-check failed (timeout)");
  }

  // 3b. Start audio transcoder (port 3099). Best-effort: a missing
  // transcoder doesn't block the rest of the stack, but uploading audio
  // will fail with "Dispatch failed: fetch failed" until it's up.
  banner("Starting Audio Transcoder (port " + TRANSCODER_PORT + ")");
  if (await isPortInUse(TRANSCODER_PORT)) {
    log(C.yellow, "TRANSCODER", `Port ${TRANSCODER_PORT} already in use -- assuming transcoder is running`);
  } else {
    spawnService("TRANSCODER", "pnpm", ["-F", "audio-transcoder", "dev"]);
  }
  log(C.cyan, "TRANSCODER", "Waiting for health-check ...");
  const transcoderOk = await waitForTranscoder();
  if (transcoderOk) {
    log(C.green, "TRANSCODER", "Healthy");
  } else {
    log(C.yellow, "TRANSCODER", "⚠ Health-check timed out — audio uploads will fail until it's up.");
  }

  // 4. Start Stripe CLI listener on the API's own Stripe account (resolved in
  // step 1b). Skipped when the CLI / key / account lookup failed.
  let stripeListening = false;
  if (stripeListener) {
    banner("Starting Stripe webhook listener");
    log(C.magenta, "STRIPE", formatAccountBanner(stripeListener.account));
    log(
      C.magenta,
      "STRIPE",
      `Key from ${stripeListener.keySource}; ${stripeListener.events.length} event types from ${stripeListener.eventsSource}`,
    );
    // Key travels as STRIPE_API_KEY in the child env, never on argv.
    const stripeProc = spawnService(
      "STRIPE",
      "stripe",
      stripeListener.listenArgs,
      stripeListener.listenEnv({}),
    );
    // Detect auth failures early and surface a helpful remediation hint
    const stripeAuthErrPatterns = ["api_key_expired", "Authorization failed", "status=401"];
    let stripeAuthErrShown = false;
    const onStripeAuthErr = (chunk) => {
      if (stripeAuthErrShown) return;
      const text = chunk.toString();
      if (stripeAuthErrPatterns.some((p) => text.includes(p))) {
        stripeAuthErrShown = true;
        log(C.red, "STRIPE", "⚠ Stripe API key rejected (expired or invalid).");
        log(C.yellow, "STRIPE", `  Fix STRIPE_SECRET_KEY in ${stripeListener.keySource}, then restart.`);
      }
    };
    stripeProc.stdout.on("data", onStripeAuthErr);
    stripeProc.stderr.on("data", onStripeAuthErr);
    stripeListening = true;
    log(C.green, "STRIPE", `Forwarding webhooks to ${STRIPE_FORWARD_TO}`);
  }

  // 5. Start Web (after API is confirmed up)
  banner("Starting Web server (port " + WEB_PORT + ")");
  removeStaleNextLock();

  if (await isPortInUse(WEB_PORT)) {
    log(C.yellow, "WEB", `Port ${WEB_PORT} already in use -- skipping spawn`);
  } else {
    spawnService("WEB", "pnpm", ["-F", "web", "dev"], {
      WEB_API_BASE_URL: `http://localhost:${API_PORT}`,
      PORT: String(WEB_PORT),
      HOSTNAME: "0.0.0.0",
    });
  }

  const webOk = await waitForPort(WEB_PORT, 90_000);
  if (!webOk) {
    throw new Error("Web server failed to start on port " + WEB_PORT);
  }

  // 5b. Wire `adb reverse` for any attached Android devices so the
  // scanner / mobile builds can reach localhost:3001 + 3002 + 8082
  // without LAN gymnastics. No-op if adb isn't installed or no device.
  setupAdbReverse();

  // 6. Seed (servers are running so the UI is usable right away)
  if (!FLAG_NO_SEED) {
    // small delay so the seed logs don't interleave with Next.js compile output
    await delay(2_000);
    await seedDatabase();
  } else {
    log(C.yellow, "SEED", "Skipping seed (--no-seed)");
  }

  // Ready banner
  const stripeStatus = stripeListening
    ? `${C.green}active${C.reset} (${stripeListener.account.name ?? stripeListener.account.id} → localhost:${API_PORT})`
    : `${C.yellow}inactive${C.reset} (see STRIPE lines above)`;
  console.log(`
${C.bold}${C.green}${"=".repeat(60)}${C.reset}
${C.bold}${C.green}  Dev stack is running!${C.reset}
${C.bold}${C.green}${"=".repeat(60)}${C.reset}

  ${C.cyan}Web:${C.reset}     http://localhost:${WEB_PORT}
  ${C.cyan}API:${C.reset}     http://localhost:${API_PORT}
  ${C.cyan}Jobs:${C.reset}    http://localhost:${JOBS_PORT}
  ${C.cyan}Health:${C.reset}  ${API_HEALTH_URL}
  ${C.cyan}Mailpit:${C.reset} http://localhost:8025  ${C.reset}(catches all dev email)
  ${C.cyan}Stripe:${C.reset}  ${stripeStatus}
${formatSeedLogin()}
  Press ${C.bold}Ctrl+C${C.reset} to stop everything.
`);

  openBrowser(`http://localhost:${WEB_PORT}`);
}

main().catch((err) => {
  console.error(`${C.red}Fatal:${C.reset}`, err);
  console.error("HEY WE ERRORED");
  shutdown();
  process.exit(1);
});
