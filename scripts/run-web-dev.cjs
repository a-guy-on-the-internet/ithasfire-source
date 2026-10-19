#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-var-requires */
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
const { existsSync } = require("node:fs");

const dotenv = require("dotenv");

const rootDir = resolve(__dirname, "..");
const DEFAULT_BASE_URL = "http://localhost:3001";

const loadEnv = () => {
  // In this repo, *.env.local files are typically kept inside the app folders.
  // This script runs from the monorepo root, so we explicitly load them.
  const candidates = [
    resolve(rootDir, "apps/web/.env.local"),
    resolve(rootDir, "apps/api/.env.local"),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    dotenv.config({ path: envPath, override: false });
  }
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = { base: undefined };

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === "--base" && args[i + 1]) {
      parsed.base = args[i + 1];
      i += 1;
      continue;
    }

    if (current.startsWith("--base=")) {
      parsed.base = current.split("=").slice(1).join("=");
    }
  }

  return parsed;
};

const ensureBaseUrl = () => {
  // Make env variables available from app-local .env.local files.
  // Env already set by the shell/CI still wins (`override: false`).
  loadEnv();

  const { base } = parseArgs();

  // CLI flag should be the strongest override.
  if (base && base.trim().length > 0) {
    process.env.WEB_API_BASE_URL = base.trim();
    process.env.NEXT_PUBLIC_API_BASE_URL = process.env.WEB_API_BASE_URL;
    return process.env.WEB_API_BASE_URL;
  }

  if (process.env.WEB_API_BASE_URL && process.env.WEB_API_BASE_URL.trim().length > 0) {
    const resolved = process.env.WEB_API_BASE_URL.trim();
    // Keep public env in sync so browser code has an absolute API base URL.
    process.env.NEXT_PUBLIC_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.trim().length
      ? process.env.NEXT_PUBLIC_API_BASE_URL.trim()
      : resolved;
    return resolved;
  }

  process.env.WEB_API_BASE_URL = DEFAULT_BASE_URL;
  process.env.NEXT_PUBLIC_API_BASE_URL = process.env.WEB_API_BASE_URL;
  return process.env.WEB_API_BASE_URL;
};

const run = () => {
  const baseUrl = ensureBaseUrl();
  console.log(
    `Starting web dev server with WEB_API_BASE_URL=${baseUrl} (NEXT_PUBLIC_API_BASE_URL=${process.env.NEXT_PUBLIC_API_BASE_URL})`,
  );

  const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(pnpmExecutable, ["-F", "web", "dev"], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (error) => {
    console.error("Failed to start web dev server:", error.message);
    process.exit(1);
  });
};

run();
