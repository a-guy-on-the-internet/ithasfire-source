/**
 * seed-platform-tags.ts — Install the production genre tag taxonomy.
 *
 * Usage (against remote Neon):
 *   DATABASE_URL=<neon-url> pnpm -F api tsx \
 *     src/scripts/seed-platform-tags.ts
 *
 * Or via the root convenience script:
 *   pnpm seed:tags          (local dev DB, dotenv-aware)
 *   pnpm seed:tags:remote   (uses whatever DATABASE_URL is exported)
 *
 * What it does:
 *   - Upserts every `SEED_TAG_GENRES` entry whose owning category ships to
 *     prod (i.e. not flagged `platformDefault: false` in `SEED_CATEGORIES`).
 *   - Idempotent: re-running adjusts the tag name on slug without touching
 *     event references.
 *   - Skips tags belonging to withheld categories (currently
 *     `support-recovery`) — those are dev-only fixtures.
 *
 * Run automatically by the deploy-dev / deploy-prod workflows alongside
 * the platform admin and category seeds.
 */

import "dotenv/config";
import { getPrisma } from "@th/db";
import { ensureGenreTags } from "./seed/index.js";

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Pass it as an env var or put it in .env.local.",
  );
  process.exit(1);
}

try {
  const url = new URL(process.env.DATABASE_URL);
  console.log(`[tags-seed] Target database host: ${url.hostname}`);
} catch {
  console.log("[tags-seed] DATABASE_URL set (could not parse host)");
}

const prisma = getPrisma();

async function main() {
  const map = await ensureGenreTags(prisma, { platformOnly: true });
  const slugs = Object.keys(map).sort();
  console.log(
    `[tags-seed] Upserted ${slugs.length} platform tag${slugs.length === 1 ? "" : "s"}: ${slugs.join(", ")}`,
  );
}

main()
  .catch((err) => {
    console.error("[tags-seed] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
