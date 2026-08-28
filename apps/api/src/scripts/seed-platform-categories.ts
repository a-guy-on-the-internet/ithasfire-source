/**
 * seed-platform-categories.ts — Install the production category taxonomy.
 *
 * Usage (against remote Neon):
 *   DATABASE_URL=<neon-url> pnpm -F api tsx \
 *     src/scripts/seed-platform-categories.ts
 *
 * Or via the root convenience script:
 *   pnpm seed:categories          (local dev DB, dotenv-aware)
 *   pnpm seed:categories:remote   (uses whatever DATABASE_URL is exported)
 *
 * What it does:
 *   - Upserts every `SEED_CATEGORIES` entry where `platformDefault !== false`.
 *   - Idempotent: re-running adjusts name/sortOrder and re-activates rows
 *     without touching event references.
 *   - Skips entries flagged `platformDefault: false` (currently
 *     `support-recovery`) — those are dev-only fixtures.
 *
 * Run automatically by the deploy-dev / deploy-prod workflows alongside
 * the platform admin seed.
 */

import "dotenv/config";
import { getPrisma } from "@th/db";
import { ensureCategories } from "./seed/index.js";

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Pass it as an env var or put it in .env.local.",
  );
  process.exit(1);
}

try {
  const url = new URL(process.env.DATABASE_URL);
  console.log(`[categories-seed] Target database host: ${url.hostname}`);
} catch {
  console.log("[categories-seed] DATABASE_URL set (could not parse host)");
}

const prisma = getPrisma();

async function main() {
  const map = await ensureCategories(prisma, { platformOnly: true });
  const slugs = Object.keys(map).sort();
  console.log(
    `[categories-seed] Upserted ${slugs.length} platform categor${slugs.length === 1 ? "y" : "ies"}: ${slugs.join(", ")}`,
  );
}

main()
  .catch((err) => {
    console.error("[categories-seed] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
