#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const rootDir = resolve(__dirname, "..");
const tmpDir = resolve(rootDir, ".tmp");
const pidFile = resolve(tmpDir, "api-dev.pid");

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

const reportStatus = () => {
  if (!existsSync(pidFile)) {
    console.log("Detached API dev server is not running (no pid file).");
    return;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  if (isProcessActive(pid)) {
    console.log(`Detached API dev server is running (pid ${pid}).`);
  } else {
    console.log("Detached API dev server pid file exists but process is not running. Run \"pnpm api:bg\" to restart.");
  }
};

reportStatus();
