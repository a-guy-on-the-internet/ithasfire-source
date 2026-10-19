import "dotenv/config";
import { config as dotenvConfig } from "dotenv";

// Prefer explicit env (CI, integration tests setting DATABASE_URL) over the
// developer's `.env.local`. Only fall back to `.env.local` when the caller
// hasn't already provided a DATABASE_URL.
dotenvConfig({ path: ".env.local" });

import { defineConfig, env } from "prisma/config";

// Prisma ORM v7 central config.
// - CLI (migrate/push/introspect) uses datasource.url.
// - Prisma Client runtime URL remains controlled by your DATABASE_URL env.
export default defineConfig({
  schema: "./packages/db/prisma/",
  datasource: {
    // Prisma config currently validates env at load time; client generation doesn't require a live DB,
    // so we provide a harmless default URL to keep local tooling (VS Code tasks) from failing.
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/dev?schema=public",
    // Optional: set this in CI to a dedicated shadow database for migrate
    // shadowDatabaseUrl: env("SHADOW_DATABASE_URL"),
  },
  migrations: {
    path: "./packages/db/prisma/migrations",
  },
});
