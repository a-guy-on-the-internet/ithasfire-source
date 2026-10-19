import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
import { spawn } from "node:child_process";

async function retryWithBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const initialDelayMs = opts?.initialDelayMs ?? 500;
  const maxDelayMs = opts?.maxDelayMs ?? 10_000;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;

      const backoff = Math.min(
        maxDelayMs,
        initialDelayMs * Math.pow(2, attempt - 1),
      );
      console.warn(
        `${label} failed (attempt ${attempt}/${maxAttempts}). Retrying in ${backoff}ms…`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after ${maxAttempts} attempts`);
}

// Ensure this script behaves the same no matter how it's invoked (pnpm/tsx/CI/etc).
// Repo convention: `.env.local` is the primary env file.
// IMPORTANT: when callers explicitly provide DATABASE_URL (e.g. Playwright E2E
// pointing at apps/api/.env.local / Neon), do NOT override it.
dotenvConfig({ path: ".env.local", override: !process.env.DATABASE_URL });

const LOCAL_DB_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "db",
  "postgres",
  "host.docker.internal",
]);

function isLocalDatabaseUrl(dbUrl: string) {
  try {
    const parsed = new URL(dbUrl);
    return LOCAL_DB_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        // Ensure child processes use the same DB URL we resolved for this script.
        DATABASE_URL: process.env.DATABASE_URL,
      },
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`),
        );
      }
    });
  });
}

async function main() {
  // Prefer explicit DATABASE_URL, but fall back to the local docker-compose DB.
  // This script is used by Playwright to guarantee a clean, deterministic DB.
  const fallbackLocal =
    "postgresql://postgres:postgres@localhost:5432/dev?schema=public";
  const envUrl = process.env.DATABASE_URL;
  const dbUrl =
    !envUrl || /postgres:\/\/USER:PASSWORD@HOST:5432\/DB\b/.test(envUrl)
      ? fallbackLocal
      : envUrl;

  const args = new Set(process.argv.slice(2));
  const allowRemote =
    args.has("--allow-remote") ||
    process.env.THC_RESET_ALLOW_REMOTE_DB === "true";
  const confirmRemote =
    args.has("--confirm") || process.env.THC_RESET_CONFIRM_REMOTE_DB === "true";

  if (!isLocalDatabaseUrl(dbUrl)) {
    if (!allowRemote || !confirmRemote) {
      throw new Error(
        "Refusing to reset a non-local database without explicit opt-in. Rerun with --allow-remote --confirm or set THC_RESET_ALLOW_REMOTE_DB=true and THC_RESET_CONFIRM_REMOTE_DB=true.",
      );
    }

    console.warn(
      "WARNING: resetting a non-local database because explicit opt-in was provided.",
    );
  }

  process.env.DATABASE_URL = dbUrl;

  console.log(`DATABASE_URL (resolved) = ${dbUrl}`);

  console.log(`Resetting database (migrations) at ${dbUrl}`);
  // Use Prisma Migrate as the source of truth.
  // This ensures E2E/dev DBs start from a clean state AND match migration history.
  await retryWithBackoff(
    "prisma migrate reset --force",
    async () =>
      run("pnpm", [
        "exec",
        "prisma",
        "migrate",
        "reset",
        "--force",
        "--config",
        "./prisma.config.ts",
      ]),
    {
      maxAttempts: 6,
      initialDelayMs: 750,
      maxDelayMs: 15_000,
    },
  );

  await retryWithBackoff(
    "prisma migrate deploy",
    async () =>
      run("pnpm", [
        "exec",
        "prisma",
        "migrate",
        "deploy",
        "--config",
        "./prisma.config.ts",
      ]),
    {
      maxAttempts: 6,
      initialDelayMs: 750,
      maxDelayMs: 15_000,
    },
  );

  if (process.argv.includes("--seed")) {
    console.log("Seeding demo data via pnpm seed:dev …");
    await run("pnpm", ["seed:dev"]);
  }

  console.log("Database reset complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
