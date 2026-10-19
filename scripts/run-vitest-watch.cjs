#!/usr/bin/env node
const { spawn } = require("node:child_process");
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { resolve, relative } = require("node:path");
const { pruneOldLogs } = require("./lib/prune-old-logs.cjs");

const rootDir = resolve(__dirname, "..");
const logsRoot = resolve(rootDir, "logs", "dev", "tests");

const usage = `Usage: pnpm vitest:bg --dir <relative-path> [options] [-- [...vitestArgs]]

Options:
  --dir <path>        Relative path to the workspace package (required)
  --label <name>      Optional label for the watcher (defaults to sanitized dir)
  --once | --run      Run Vitest once instead of watch mode
  --help | -h         Show this help message
  -- <args>           Forward any following args directly to Vitest

All other unknown flags or positional arguments are forwarded to Vitest automatically.
`;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    dir: undefined,
    label: undefined,
    once: false,
    passthrough: [],
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];

    if (current === "--") {
      parsed.passthrough.push(...args.slice(i + 1));
      break;
    }

    if (current === "--help" || current === "-h") {
      parsed.help = true;
      continue;
    }

    if (current === "--dir" && args[i + 1]) {
      parsed.dir = args[i + 1];
      i += 1;
      continue;
    }

    if (current.startsWith("--dir=")) {
      parsed.dir = current.split("=").slice(1).join("=");
      continue;
    }

    if (current === "--label" && args[i + 1]) {
      parsed.label = args[i + 1];
      i += 1;
      continue;
    }

    if (current.startsWith("--label=")) {
      parsed.label = current.split("=").slice(1).join("=");
      continue;
    }

    if (current === "--once" || current === "--run") {
      parsed.once = true;
      continue;
    }

    parsed.passthrough.push(current);
  }

  return parsed;
};

const ensureDir = (target) => {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
};

const sanitizeLabel = (value) => value.replace(/[^a-zA-Z0-9.-]+/g, "-");

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

const cleanStalePid = (pidFile) => {
  if (!existsSync(pidFile)) {
    return false;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  if (isProcessActive(pid)) {
    return true;
  }

  unlinkSync(pidFile);
  return false;
};

const buildLogPath = (labelDir, label) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(labelDir, `${label}-${stamp}.log`);
};

const run = () => {
  const { dir, label, once, passthrough, help } = parseArgs();

  if (help) {
    console.log(usage);
    process.exit(0);
  }

  if (!dir) {
    console.error("Missing required --dir <relative-path> argument.\n");
    console.log(usage);
    process.exit(1);
  }

  const targetDir = resolve(rootDir, dir);
  if (!existsSync(targetDir)) {
    console.error(`Target directory ${relative(rootDir, targetDir)} does not exist.`);
    process.exit(1);
  }

  const derivedLabel = sanitizeLabel(label ?? relative(rootDir, targetDir));
  ensureDir(logsRoot);
  const { removed } = pruneOldLogs(logsRoot);
  if (removed > 0) {
    console.log(`Pruned ${removed} old test log${removed === 1 ? "" : "s"} older than ~48 hours.`);
  }
  const labelDir = resolve(logsRoot, derivedLabel);
  ensureDir(labelDir);

  const pidFile = resolve(labelDir, "watcher.pid");
  if (cleanStalePid(pidFile)) {
    console.log(
      `Vitest watcher already running for label "${derivedLabel}" (pid ${readFileSync(pidFile, "utf8").trim()}). Stop it before starting a new one.`,
    );
    process.exit(0);
  }

  const logPath = buildLogPath(labelDir, derivedLabel);
  const logStream = createWriteStream(logPath, { flags: "a" });

  const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const vitestArgs = [once ? "--run" : "--watch", ...passthrough];
  const child = spawn(pnpmExecutable, ["vitest", ...vitestArgs], {
    cwd: targetDir,
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
    shell: process.platform === "win32",
  });

  writeFileSync(pidFile, String(child.pid));
  const relativeLogPath = relative(rootDir, logPath);
  const relativePidPath = relative(rootDir, pidFile);

  console.log(
    `Vitest ${once ? "run" : "watch"} started for ${relative(rootDir, targetDir)} (label ${derivedLabel}, pid ${child.pid}).`,
  );
  console.log(`Logs streaming to ${relativeLogPath}`);
  console.log(`Stop it later with: pnpm vitest:bg:stop --label ${derivedLabel}`);
  console.log(`(Or manually: kill $(cat ${relativePidPath}))`);
  if (passthrough.length > 0) {
    console.log(`Forwarding additional Vitest args: ${passthrough.join(" ")}`);
  }

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    logStream.write(chunk);
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
    }
    logStream.end();
  };

  const forwardSignal = (signal) => {
    if (child && isProcessActive(child.pid)) {
      try {
        process.kill(child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "EPERM") {
          console.warn(`Could not forward ${signal} to Vitest (pid ${child.pid}): ${error.message}`);
        }
      }
    }
  };

  const handleSignal = (signal) => {
    forwardSignal(signal);
    cleanup();
    process.exit(0);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  child.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    cleanup();
    console.error("Failed to start Vitest:", error.message);
    process.exit(1);
  });
};

run();
