import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
import { spawn } from "node:child_process";

// Ensure this script behaves the same no matter how it's invoked (pnpm/tsx/CI/etc).
// Repo convention: `.env.local` is the primary env file.
// IMPORTANT: when callers explicitly provide DATABASE_URL (e.g. Playwright E2E
// pointing at apps/api/.env.local / Neon), do NOT override it.
dotenvConfig({ path: ".env.local", override: !process.env.DATABASE_URL });

function run(command: string, args: string[], input?: string) {
  return new Promise<void>((resolve, reject) => {
    const stdioOpt = input ? ["pipe", "inherit", "inherit"] : "inherit";
    const child = spawn(command, args, {
      stdio: stdioOpt as any,
      env: {
        ...process.env,
        // Ensure child processes use the same DB URL we resolved for this script.
        DATABASE_URL: process.env.DATABASE_URL,
      },
    });

    if (input) {
      // Write input to stdin and close it so the child receives EOF
      child.stdin?.write(input);
      child.stdin?.end();
    }

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
  const fallbackLocal =
    "postgresql://postgres:postgres@localhost:5432/dev?schema=public";
  const envUrl = process.env.DATABASE_URL;
  const dbUrl =
    !envUrl || /postgres:\/\/USER:PASSWORD@HOST:5432\/DB\b/.test(envUrl)
      ? fallbackLocal
      : envUrl;

  process.env.DATABASE_URL = dbUrl;

  console.log(`DATABASE_URL (resolved) = ${dbUrl}`);

  const args = process.argv.slice(2);
  const allowRemote = args.includes("--allow-remote");
  const confirm = args.includes("--confirm");
  const noMigrate = args.includes("--no-migrate");
  const seed = args.includes("--seed");

  // Safety: refuse to operate on remote DBs unless explicitly allowed.
  const hostMatch = dbUrl.match(/@([^:/?#]+)(?::\d+)?/);
  const host = hostMatch?.[1] ?? "";
  const isLocalHost =
    host === "localhost" || host === "127.0.0.1" || host === "::1";

  if (!isLocalHost && !allowRemote) {
    console.error(
      "Refusing to wipe a non-local database. If you really mean it, rerun with --allow-remote --confirm",
    );
    process.exit(1);
  }

  // Local DBs: assume the caller wants to wipe immediately (no extra confirmation flag required).
  // Remote DBs: be explicit — require both --allow-remote and --confirm to proceed.
  if (!isLocalHost) {
    if (!confirm) {
      console.error(
        "Refusing to wipe a non-local database without --confirm. Rerun with --confirm --allow-remote to proceed.",
      );
      process.exit(1);
    }
    console.warn(
      "WARNING: You are wiping a non-local database. This is destructive.",
    );
  } else {
    console.log(
      "Local database detected — proceeding to wipe without additional confirmation.",
    );
  }

  console.log(`Wiping database at ${dbUrl}…`);

  const schemaMatch = dbUrl.match(/[?&]schema=([^&]+)/);
  const schemaName = schemaMatch
    ? decodeURIComponent(schemaMatch[1])
    : "public";
  const dropSql = `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE; CREATE SCHEMA IF NOT EXISTS "${schemaName}";`;

  await run("pnpm", ["exec", "prisma", "db", "execute", "--stdin"], dropSql);

  console.log(`Schema ${schemaName} dropped and recreated.`);

  if (!noMigrate) {
    console.log("Running migrations (prisma migrate deploy) …");
    await run("pnpm", [
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      "./prisma.config.ts",
    ]);
    console.log("Migrations applied.");
  } else {
    console.log("Skipping migrations (--no-migrate)");
  }

  if (seed) {
    console.log("Seeding demo data via pnpm seed:dev …");
    await run("pnpm", ["seed:dev"]);
  }

  console.log("Database wipe complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
