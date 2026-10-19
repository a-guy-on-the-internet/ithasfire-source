#!/usr/bin/env node
/* eslint-disable no-console */

const { execSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3001";
const normalizedApiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
const healthUrl = `${normalizedApiBaseUrl}/health`;
const authSessionUrl = `${normalizedApiBaseUrl}/api/auth/get-session`;
const e2eResetUrl = `${normalizedApiBaseUrl}/e2e/reset`;
const webServerMode = process.env.PLAYWRIGHT_WEBSERVER_MODE === "1";
const readyPort = Number(process.env.PLAYWRIGHT_API_READY_PORT ?? 3101);
const readyPath =
  process.env.PLAYWRIGHT_API_READY_PATH ??
  (process.env.PLAYWRIGHT_API_READY_TOKEN ? `/ready/${process.env.PLAYWRIGHT_API_READY_TOKEN}` : "/");
const e2eDbLockDir = path.resolve(__dirname, "..", ".tmp", "e2e-db-reset.lock");
const e2eDbLockOwnerPath = path.join(e2eDbLockDir, "owner.json");
const e2eDbLockPollMs = 250;
const e2eDbLockTimeoutMs = Number(process.env.PLAYWRIGHT_E2E_DB_LOCK_TIMEOUT_MS ?? 110_000);
const e2eDbLockOwnerlessGraceMs = Number(process.env.PLAYWRIGHT_E2E_DB_LOCK_OWNERLESS_GRACE_MS ?? 5_000);

const isHttpOk = (status) => status >= 200 && status < 300;
const isAuthSessionReady = (status) => isHttpOk(status) || status === 401;

async function probeApiReadiness({ timeoutMs = 1_000, runReset = false } = {}) {
  const health = await request(healthUrl, { method: "GET", timeoutMs });
  if (!isHttpOk(health.status)) {
    return { ready: false, reason: `health returned ${health.status}` };
  }

  const authSession = await request(authSessionUrl, {
    method: "GET",
    timeoutMs,
    headers: { accept: "application/json" },
  });
  if (!isAuthSessionReady(authSession.status)) {
    return {
      ready: false,
      reason: `auth session returned ${authSession.status}`,
    };
  }

  if (runReset && process.env.E2E_RESET_SECRET) {
    const resetRes = await request(e2eResetUrl, {
      method: "POST",
      timeoutMs: Math.max(timeoutMs, 2_000),
      headers: {
        "x-e2e-reset-secret": process.env.E2E_RESET_SECRET,
        "content-type": "application/json",
      },
      body: "{}",
    });

    if (!isHttpOk(resetRes.status)) {
      return {
        ready: false,
        reason: `e2e reset returned ${resetRes.status}`,
        body: resetRes.body,
      };
    }
  }

  return { ready: true };
}

function request(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: opts?.method ?? "GET",
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        headers: opts?.headers ?? {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );

    // Prevent hanging forever if the server accepts a connection but never responds.
    // (Happens sometimes when the API process is half-started.)
    const timeoutMs = opts?.timeoutMs ?? 1_000;
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (opts?.body) req.write(opts.body);
    req.end();
  });
}

function isProcessActive(pid) {
  if (!pid || Number.isNaN(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockOwner() {
  try {
    return JSON.parse(fs.readFileSync(e2eDbLockOwnerPath, "utf8"));
  } catch {
    return null;
  }
}

function describeLockOwner(owner) {
  if (!owner) return "unknown owner";

  const parts = [`pid ${owner.pid ?? "unknown"}`];
  if (owner.startedAt) parts.push(`since ${owner.startedAt}`);
  if (owner.command) parts.push(`command: ${owner.command}`);
  return parts.join(", ");
}

function lockDirAgeMs() {
  try {
    return Date.now() - fs.statSync(e2eDbLockDir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function releaseE2eDbLock() {
  const owner = readLockOwner();
  if (owner?.pid && owner.pid !== process.pid) return;

  try {
    fs.rmSync(e2eDbLockDir, { recursive: true, force: true });
    console.log(`[wait-api-healthy] released E2E DB lock: ${e2eDbLockDir}`);
  } catch (error) {
    console.warn("[wait-api-healthy] failed to release E2E DB lock", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function acquireE2eDbLock() {
  fs.mkdirSync(path.dirname(e2eDbLockDir), { recursive: true });

  const startedWaitingAt = Date.now();
  let lastLogAt = 0;

  while (true) {
    try {
      fs.mkdirSync(e2eDbLockDir);
      fs.writeFileSync(
        e2eDbLockOwnerPath,
        JSON.stringify(
          {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            command: process.argv.join(" "),
          },
          null,
          2,
        ),
      );
      console.log(`[wait-api-healthy] acquired E2E DB lock: ${e2eDbLockDir}`);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const owner = readLockOwner();
    const ownerPid = Number(owner?.pid);
    if (!owner && lockDirAgeMs() > e2eDbLockOwnerlessGraceMs) {
      console.warn("[wait-api-healthy] removing stale ownerless E2E DB lock");
      fs.rmSync(e2eDbLockDir, { recursive: true, force: true });
      continue;
    }
    if (owner && !isProcessActive(ownerPid)) {
      console.warn(`[wait-api-healthy] removing stale E2E DB lock (${describeLockOwner(owner)})`);
      fs.rmSync(e2eDbLockDir, { recursive: true, force: true });
      continue;
    }

    const elapsedMs = Date.now() - startedWaitingAt;
    if (elapsedMs > e2eDbLockTimeoutMs) {
      throw new Error(
        `Timed out waiting for E2E DB lock after ${elapsedMs}ms (${describeLockOwner(owner)}). ` +
          "Another Playwright run is still using the shared local database.",
      );
    }

    if (Date.now() - lastLogAt > 10_000) {
      console.log(`[wait-api-healthy] waiting for E2E DB lock (${describeLockOwner(owner)})`);
      lastLogAt = Date.now();
    }

    await delay(e2eDbLockPollMs);
  }
}

function installE2eDbLockCleanup() {
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseE2eDbLock();
  };

  process.once("exit", releaseOnce);
  process.once("SIGINT", () => {
    releaseOnce();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    releaseOnce();
    process.exit(143);
  });
}

function resolveDatabaseUrl(repoRoot) {
  // For Playwright E2E we *must* be deterministic and local.
  // Prefer explicit E2E DB URLs passed via Playwright config.
  // (This avoids accidentally talking to a remote/Neon DB.)
  if (process.env.PLAYWRIGHT_DATABASE_URL) return process.env.PLAYWRIGHT_DATABASE_URL;
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const candidates = [
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env"),
    path.join(repoRoot, "apps", "api", ".env.local"),
    path.join(repoRoot, "apps", "api", ".env"),
  ];

  try {
    for (const envFile of candidates) {
      if (!fs.existsSync(envFile)) continue;
      const text = fs.readFileSync(envFile, "utf8");
      const match = text.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m);
      if (match?.[1]) {
        return match[1].trim().replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}

function stopDetachedApi(repoRoot, reason) {
  try {
    console.warn(
      `[wait-api-healthy] stopping existing detached API before restart${reason ? `: ${reason}` : ""}`,
    );
    execSync("pnpm -w api:bg:stop", {
      stdio: "inherit",
      cwd: repoRoot,
      env: { ...process.env },
    });
  } catch (error) {
    console.warn("[wait-api-healthy] failed to stop detached API cleanly; continuing", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function keepAliveForPlaywright() {
  if (Number.isFinite(readyPort) && readyPort > 0) {
    await new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        const requestUrl = new URL(_req.url ?? "/", "http://127.0.0.1");
        if (readyPath !== "/" && requestUrl.pathname !== readyPath) {
          res.statusCode = 404;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("not ready");
          return;
        }

        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("ok");
      });

      server.on("error", reject);
      server.listen(readyPort, "127.0.0.1", resolve);
    });

    console.log(`[wait-api-healthy] ready sentinel listening on http://127.0.0.1:${readyPort}${readyPath}`);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await delay(60_000);
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const shouldFreshStart = process.env.PLAYWRIGHT_API_FRESH_START === "1";
  let dbUrl;
  let existingApiReason = null;

  if (process.env.PLAYWRIGHT_E2E === "1" || shouldFreshStart) {
    await acquireE2eDbLock();
    installE2eDbLockCleanup();
  }

  if (shouldFreshStart) {
    console.log("[wait-api-healthy] fresh API start requested; skipping reuse checks");
    stopDetachedApi(repoRoot, "fresh start requested");
  } else {
    // If the API is already up, only reuse it when auth readiness and optional
    // E2E reset are working too. A bare /health 200 is not enough.
    try {
      const existing = await probeApiReadiness({
        timeoutMs: 750,
        runReset: Boolean(process.env.E2E_RESET_SECRET),
      });

      if (existing.ready) {
        console.log(`[wait-api-healthy] already reusable: ${healthUrl}`);
        if (webServerMode) {
          await keepAliveForPlaywright();
        }
        process.exit(0);
      }

      existingApiReason = existing.reason ?? "readiness probes failed";
    } catch (error) {
      existingApiReason = error instanceof Error ? error.message : "readiness probe failed";
    }

    if (existingApiReason) {
      console.warn(`[wait-api-healthy] existing API is not reusable yet: ${existingApiReason}`);
      stopDetachedApi(repoRoot, existingApiReason);
    }
  }

  // Ensure the DB schema exists before we boot the API.
  // E2E runs assume Better Auth tables exist (auth_user, auth_account, etc).
  // If the target DATABASE_URL hasn't been migrated yet, Better Auth will 500.
  try {
    dbUrl = resolveDatabaseUrl(repoRoot);
    if (!dbUrl) {
      console.error(
        "[wait-api-healthy] DATABASE_URL not found (checked env, repo-root env files, and apps/api env files).",
      );
      process.exit(1);
    }

    execSync("pnpm -w db:reset:remote", {
      stdio: "inherit",
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        // Force a compatible Prisma engine mode for runtime auth calls.
        PRISMA_CLIENT_ENGINE_TYPE:
          process.env.PRISMA_CLIENT_ENGINE_TYPE ?? "library",
      },
    });

    // Seed demo events for Home page E2E.
    // The Playwright webServer always resets the DB, so without this, Home can
    // legitimately render empty lists even though the app is working.
    execSync("pnpm -w tsx apps/api/src/scripts/seed/seed-data.ts", {
      stdio: "inherit",
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        PRISMA_CLIENT_ENGINE_TYPE:
          process.env.PRISMA_CLIENT_ENGINE_TYPE ?? "library",
        // Keep seed deterministic across machines.
        THC_EVENTS_DEFAULT_REGION_CODE:
          process.env.THC_EVENTS_DEFAULT_REGION_CODE ?? "ca-sf",
      },
    });
  } catch (error) {
    console.error("[wait-api-healthy] failed to reset/apply migrations", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  try {
    // Start the API in detached mode. This command exits immediately.
    execSync("pnpm -w api:bg", {
      stdio: "inherit",
      // Run from repo root.
      cwd: repoRoot,
      env: {
        ...process.env,
        // Critical: the detached API must point at the same DB we just reset.
        DATABASE_URL: dbUrl,
        APP_BASE_URL: apiBaseUrl,
        BETTER_AUTH_BASE_URL: apiBaseUrl,
        // Make sure the spawned detached API uses the same Prisma engine mode
        // that E2E expects (otherwise Better Auth can 500 on sign-up).
        PRISMA_CLIENT_ENGINE_TYPE:
          process.env.PRISMA_CLIENT_ENGINE_TYPE ?? "library",
      },
    });
  } catch (error) {
    // Best-effort: if it's already running, the helper may no-op or fail.
    console.warn("[wait-api-healthy] api:bg returned non-zero; continuing to poll health", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // In Playwright webServer mode, be generous: Next/web + API boot can be slow,
  // and we want to avoid flake where tests start while the detached API is
  // still binding ports.
  const defaultTimeoutMs = process.env.PLAYWRIGHT_WEBSERVER_MODE === "1" ? 30_000 : 5_000;
  const timeoutMs = Number(
    process.env.API_HEALTH_TIMEOUT_MS ??
      process.env.HEALTH_TIMEOUT_MS ??
      defaultTimeoutMs,
  );
  const delayMs = Number(process.env.API_HEALTH_POLL_MS ?? 200);
  const attempts = Math.max(1, Math.ceil(timeoutMs / delayMs));

  let lastReason = "server did not pass readiness probes";

  for (let i = 0; i < attempts; i += 1) {
    try {
      const readiness = await probeApiReadiness({
        timeoutMs: 750,
        runReset: Boolean(process.env.E2E_RESET_SECRET),
      });
      if (readiness.ready) {
        // In Playwright's webServer mode we need to keep this process alive.
        // In normal CLI usage we want to exit ASAP.
        if (webServerMode) {
          await keepAliveForPlaywright();
        }

        process.exit(0);
      }

      lastReason = readiness.reason ?? lastReason;
      if (readiness.body && readiness.reason?.startsWith("e2e reset returned")) {
        lastReason = `${lastReason}. Response: ${readiness.body}`;
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }

    await delay(delayMs);
  }

  console.error(`[wait-api-healthy] API failed to become ready: ${healthUrl} (${lastReason})`);
  process.exit(1);
}

main().catch((err) => {
  console.error("[wait-api-healthy] fatal", err);
  process.exit(1);
});
