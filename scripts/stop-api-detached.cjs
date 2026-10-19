#!/usr/bin/env node
const { existsSync, readFileSync, unlinkSync } = require("node:fs");
const { resolve } = require("node:path");

const rootDir = resolve(__dirname, "..");
const tmpDir = resolve(rootDir, ".tmp");
const pidFile = resolve(tmpDir, "api-dev.pid");

const stopServer = () => {
  if (!existsSync(pidFile)) {
    console.log("No detached API dev server pid file found. Nothing to stop.");
    return;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  if (Number.isNaN(pid)) {
    unlinkSync(pidFile);
    console.warn("Detached API pid file was corrupt and has been removed.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to API dev server (pid ${pid}).`);
  } catch (error) {
    if (error.code === "ESRCH") {
      console.warn("API dev server process already stopped.");
    } else {
      console.error(`Failed to stop API dev server (pid ${pid}): ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    unlinkSync(pidFile);
  }
};

stopServer();
