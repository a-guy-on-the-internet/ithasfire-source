#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync } = require("node:fs");
const { resolve, relative } = require("node:path");
const { pruneOldLogs } = require("./lib/prune-old-logs.cjs");
const {
  formatAccountBanner,
  parseEnvValue,
  redactSecrets,
  resolveStripeListenerConfig,
} = require("./lib/stripe-listen-config.cjs");

const rootDir = resolve(__dirname, "..");
const tmpDir = resolve(rootDir, ".tmp");
const logsDir = resolve(rootDir, "logs", "dev", "stripe");
const pidFile = resolve(tmpDir, "stripe-listen.pid");

const forwardTo =
  process.env.STRIPE_LISTEN_FORWARD_TO ??
  process.env.STRIPE_LISTEN_FORWARD_URL ??
  "http://localhost:3001/webhooks/stripe";

const ensureDir = (target) => {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
};

const isProcessActive = (pid) => {
  if (!pid || Number.isNaN(pid)) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const cleanStalePid = () => {
  if (!existsSync(pidFile)) {
    return;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  if (isProcessActive(pid)) {
    console.log(`Stripe listen already running in detached mode (pid ${pid}). Skipping new start.`);
    process.exit(0);
  }

  unlinkSync(pidFile);
};

const buildLogFilePath = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(logsDir, `stripe-listen-${stamp}.log`);
};

/**
 * The detached API (`pnpm api:bg`) reads STRIPE_WEBHOOK_SECRET from
 * apps/api/.env.local itself — this script cannot inject it. Compare (never
 * print) so a mismatch is visible instead of silently 400ing every delivery.
 */
const warnIfApiSecretMismatch = (webhookSecret) => {
  let configured = null;
  try {
    configured = parseEnvValue(
      readFileSync(resolve(rootDir, "apps/api/.env.local"), "utf8"),
      "STRIPE_WEBHOOK_SECRET",
    );
  } catch {
    /* no file — fall through to the warning */
  }
  if (configured === webhookSecret) return;
  console.warn(
    "WARNING: apps/api/.env.local STRIPE_WEBHOOK_SECRET does not match this listener's signing secret; " +
      "the API will reject deliveries (bad_signature). Set it to the value of " +
      "`STRIPE_API_KEY=<your STRIPE_SECRET_KEY> stripe listen --print-secret` and restart the API.",
  );
};
const startStripeListen = async () => {
  ensureDir(tmpDir);
  ensureDir(logsDir);
  const { removed } = pruneOldLogs(logsDir);
  if (removed > 0) {
    console.log(`Pruned ${removed} old Stripe listen log${removed === 1 ? "" : "s"} older than ~48 hours.`);
  }

  cleanStalePid();

  const logFile = buildLogFilePath();
  writeFileSync(logFile, `\n=== Stripe listen start ${new Date().toISOString()} ===\n`, { flag: "a" });

  const stdioTarget = openSync(logFile, "a");
  // Same account as the API's STRIPE_SECRET_KEY (see scripts/lib/stripe-listen-config.cjs).
  let listener;
  try {
    listener = await resolveStripeListenerConfig({ rootDir, forwardTo });
  } catch (error) {
    console.error("Failed to resolve the Stripe listener:", redactSecrets(error.message));
    process.exit(1);
  }
  if (listener.accountError) {
    console.warn(`Could not look up the Stripe account name (${listener.accountError}); continuing.`);
  }
  console.log(formatAccountBanner(listener.account));
  console.log(`Key from ${listener.keySource}; ${listener.events.length} event types from ${listener.eventsSource}.`);
  warnIfApiSecretMismatch(listener.webhookSecret);
  const child = spawn("stripe", listener.listenArgs, {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", stdioTarget, stdioTarget],
    shell: process.platform === "win32",
    env: listener.listenEnv(process.env),
  });

  child.on("error", (error) => {
    console.error("Failed to start Stripe listen:", error.message);
    process.exit(1);
  });

  child.unref();
  writeFileSync(pidFile, String(child.pid));

  const relativeLogPath = relative(rootDir, logFile);
  console.log(
    `Stripe listen started in detached mode (pid ${child.pid}). Logs streaming to ${relativeLogPath}.`
  );
  console.log(`Forwarding to: ${forwardTo}`);
  console.log(`Tail it with: tail -f ${relativeLogPath}`);
  console.log('Stop it anytime with "pnpm stripe:listen:bg:stop".');
};

startStripeListen().catch((error) => {
  console.error("Failed to start Stripe listen:", redactSecrets(error.message));
  process.exit(1);
});
