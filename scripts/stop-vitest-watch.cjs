#!/usr/bin/env node
const { existsSync, readFileSync, unlinkSync } = require("node:fs");
const { resolve, relative } = require("node:path");

const rootDir = resolve(__dirname, "..");
const logsRoot = resolve(rootDir, "logs", "dev", "tests");

const parseArgs = () => {
  const args = process.argv.slice(2);
  let label;

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];

    if (current === "--label" && args[i + 1]) {
      label = args[i + 1];
      i += 1;
      continue;
    }

    if (current.startsWith("--label=")) {
      label = current.split("=").slice(1).join("=");
      continue;
    }
  }

  return { label };
};

const stop = () => {
  const { label } = parseArgs();
  if (!label) {
    console.error("Missing required --label <name> argument.");
    process.exit(1);
  }

  const labelDir = resolve(logsRoot, label);
  const pidFile = resolve(labelDir, "watcher.pid");

  if (!existsSync(pidFile)) {
    console.log(`No pid file found for label ${label} (${relative(rootDir, pidFile)}). Nothing to stop.`);
    return;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  if (Number.isNaN(pid)) {
    unlinkSync(pidFile);
    console.warn(`Pid file for label ${label} was corrupt and has been removed.`);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to Vitest watcher ${label} (pid ${pid}).`);
  } catch (error) {
    if (error.code === "ESRCH") {
      console.warn(`Process ${pid} was already stopped.`);
    } else {
      console.error(`Failed to stop Vitest watcher ${label}: ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
    }
  }
};

stop();
