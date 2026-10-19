#!/usr/bin/env node
const { spawn } = require("node:child_process");
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { resolve, relative } = require("node:path");
const { pruneOldLogs } = require("./lib/prune-old-logs.cjs");

const rootDir = resolve(__dirname, "..");
const logsDir = resolve(rootDir, "logs", "dev", "mobile");
const pidFile = resolve(logsDir, "mobile-dev.pid");
const DEFAULT_BASE_URL = "http://localhost:3001";

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    base: undefined,
    storybook: false,
    passthrough: [],
  };

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === "--") {
      parsed.passthrough = args.slice(i + 1);
      break;
    }

    if (current === "--base" && args[i + 1]) {
      parsed.base = args[i + 1];
      i += 1;
      continue;
    }

    if (current.startsWith("--base=")) {
      parsed.base = current.split("=").slice(1).join("=");
      continue;
    }

    if (current === "--storybook") {
      parsed.storybook = true;
      continue;
    }
  }

  return parsed;
};

const ensureDir = (target) => {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
};

const ensureLocalDependencyLink = (packageName) => {
  const mobileNodeModules = resolve(rootDir, "apps", "mobile", "node_modules");
  ensureDir(mobileNodeModules);

  const linkPath = resolve(mobileNodeModules, packageName);
  if (existsSync(linkPath)) {
    return;
  }

  const target = resolve(rootDir, "node_modules", packageName);
  if (!existsSync(target)) {
    console.warn(`Missing ${packageName} under root node_modules; skipping local link.`);
    return;
  }

  try {
    symlinkSync(target, linkPath, "junction");
    console.log(`Linked ${packageName} into apps/mobile/node_modules for Expo CLI validation.`);
  } catch (error) {
    console.warn(`Failed to link ${packageName} into apps/mobile/node_modules:`, error.message);
  }
};

const writePidFile = (pid) => {
  try {
    writeFileSync(pidFile, String(pid));
  } catch (error) {
    console.warn(`Failed to write mobile pid file at ${relative(rootDir, pidFile)}:`, error.message);
  }
};

const removePidFile = () => {
  if (!existsSync(pidFile)) {
    return;
  }

  try {
    unlinkSync(pidFile);
  } catch (error) {
    console.warn(`Failed to remove mobile pid file at ${relative(rootDir, pidFile)}:`, error.message);
  }
};

const ensureBaseUrl = (env, preferredBase) => {
  const trimmedPreferred = preferredBase?.trim();
  if (trimmedPreferred) {
    env.EXPO_PUBLIC_API_BASE_URL = trimmedPreferred;
    return trimmedPreferred;
  }

  const existing = env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (existing && existing.length > 0) {
    return existing;
  }

  env.EXPO_PUBLIC_API_BASE_URL = DEFAULT_BASE_URL;
  return env.EXPO_PUBLIC_API_BASE_URL;
};

const configureStorybookFlag = (env, shouldEnable) => {
  if (shouldEnable) {
    env.EXPO_PUBLIC_STORYBOOK = "1";
    return;
  }

  if (!env.EXPO_PUBLIC_STORYBOOK) {
    env.EXPO_PUBLIC_STORYBOOK = "0";
  }
};

const buildLogPath = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(logsDir, `mobile-${stamp}.log`);
};

const run = () => {
  const { base, storybook, passthrough } = parseArgs();
  ensureDir(logsDir);
  ensureLocalDependencyLink("expo-apple-authentication");
  const { removed } = pruneOldLogs(logsDir);
  if (removed > 0) {
    console.log(`Pruned ${removed} old mobile log${removed === 1 ? "" : "s"} older than ~48 hours.`);
  }

  const env = { ...process.env };
  const baseUrl = ensureBaseUrl(env, base);
  configureStorybookFlag(env, storybook);

  const logPath = buildLogPath();
  const logStream = createWriteStream(logPath, { flags: "a" });

  console.log(`Starting Expo dev server with EXPO_PUBLIC_API_BASE_URL=${baseUrl}`);
  if (env.EXPO_PUBLIC_STORYBOOK === "1") {
    console.log("Storybook mode enabled (EXPO_PUBLIC_STORYBOOK=1)");
  }
  const relativeLogPath = relative(rootDir, logPath);
  console.log(`Logs streaming to ${relativeLogPath}`);
  console.log(`Tail it with: tail -f ${relativeLogPath}`);

  const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(
    pnpmExecutable,
    ["-F", "mobile", "start", ...passthrough],
    {
      cwd: rootDir,
      stdio: ["inherit", "pipe", "pipe"],
      env,
      shell: process.platform === "win32",
    },
  );

  writePidFile(child.pid);
  console.log(`PID file written to ${relative(rootDir, pidFile)} (pid ${child.pid}).`);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    logStream.write(chunk);
  });

  child.on("exit", (code) => {
    removePidFile();
    logStream.end(() => process.exit(code ?? 0));
  });

  child.on("error", (error) => {
    removePidFile();
    logStream.end(() => {
      console.error("Failed to start Expo dev server:", error.message);
      process.exit(1);
    });
  });
};

run();
