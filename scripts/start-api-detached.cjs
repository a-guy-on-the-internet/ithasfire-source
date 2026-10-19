#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync } = require("node:fs");
const { resolve, relative } = require("node:path");
const { pruneOldLogs } = require("./lib/prune-old-logs.cjs");

const rootDir = resolve(__dirname, "..");
const tmpDir = resolve(rootDir, ".tmp");
const logsDir = resolve(rootDir, "logs", "dev", "api");
const pidFile = resolve(tmpDir, "api-dev.pid");

const buildLogFilePath = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(logsDir, `api-${stamp}.log`);
};

const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const ensureDir = (target) => {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
};

const readEnvValue = (filePath, key) => {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const text = readFileSync(filePath, "utf8");
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, "m"));
  if (!match?.[1]) {
    return undefined;
  }

  return match[1].trim().replace(/^['"]|['"]$/g, "");
};

const buildChildEnv = () => {
  const env = { ...process.env };

  if (!env.DATABASE_URL) {
    const candidates = [
      resolve(rootDir, ".env.local"),
      resolve(rootDir, ".env"),
      resolve(rootDir, "apps", "api", ".env.local"),
      resolve(rootDir, "apps", "api", ".env"),
    ];

    for (const candidate of candidates) {
      const resolved = readEnvValue(candidate, "DATABASE_URL");
      if (resolved) {
        env.DATABASE_URL = resolved;
        console.log(
          `Using DATABASE_URL from ${relative(rootDir, candidate)} for detached API startup.`,
        );
        break;
      }
    }
  }

  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL was not found in the shell, repo-root env files, or apps/api local env files. Refusing to start detached API without a database connection.",
    );
  }

  return env;
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
    console.log(`API dev server already running in detached mode (pid ${pid}). Skipping new start.`);
    process.exit(0);
  }

  unlinkSync(pidFile);
};

const startServer = () => {
  ensureDir(tmpDir);
  ensureDir(logsDir);
  const { removed } = pruneOldLogs(logsDir);
  if (removed > 0) {
    console.log(`Pruned ${removed} old API log${removed === 1 ? "" : "s"} older than ~48 hours.`);
  }
  cleanStalePid();

  const logFile = buildLogFilePath();
  writeFileSync(logFile, `\n=== API dev start ${new Date().toISOString()} ===\n`, { flag: "a" });

  const stdioTarget = openSync(logFile, "a");

  let childEnv;
  try {
    childEnv = buildChildEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const child = spawn(pnpmExecutable, ["-F", "api", "dev"], {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", stdioTarget, stdioTarget],
    shell: process.platform === "win32",
    env: childEnv,
  });

  child.on("error", (error) => {
    console.error("Failed to start API dev server:", error.message);
    process.exit(1);
  });

  child.unref();
  writeFileSync(pidFile, String(child.pid));

  const relativeLogPath = relative(rootDir, logFile);
  console.log(
    `API dev server started in detached mode (pid ${child.pid}). Logs streaming to ${relativeLogPath}.`,
  );
  console.log(`Tail it with: tail -f ${relativeLogPath}`);
  console.log("Stop it anytime with \"pnpm api:bg:stop\".");
};

startServer();
