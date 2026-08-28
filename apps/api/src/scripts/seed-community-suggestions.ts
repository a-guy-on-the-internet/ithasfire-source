/**
 * QA seed: one COMMUNITY (ownerless) event listing + a few PENDING edit
 * suggestions from mixed submitters (authed non-owner + anonymous), so a tester
 * lands on a populated moderator queue instead of empty states.
 *
 * Drives the REAL use cases (createCommunityListing, submitEventEditSuggestion) —
 * no raw SQL — so what you see matches production behavior (base-version
 * snapshots, sanitization, rate-limit path, etc.).
 *
 * Run (local dev DB):
 *   pnpm seed:community-qa
 * or:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public \
 *     pnpm -F api exec tsx src/scripts/seed-community-suggestions.ts
 *
 * Re-running creates a NEW listing + suggestion set each time (handy for
 * repeated test runs); it never mutates existing data.
 */
import "dotenv/config";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createProfanityContentFilterAdapter } from "@th/adapters/content-filter";
import { createDbAuthZAdapter } from "@th/adapters/authz/db-authz-adapter";
import {
  createCommunityListing,
  submitEventEditSuggestion,
} from "@th/core/use-cases/community";

// Seeded identities (see apps/api/src/scripts/seed/ids.ts + seeded humans).
const MODERATOR_HUMAN_ID = "00000000-0000-4000-8000-00000000d005"; // admin@ithasfire.com (platform ADMIN)
const SUBMITTER_A = "00000000-0000-4000-8000-00000000d020"; // alex.rivera@example.com (authed non-owner)
const SUBMITTER_B = "00000000-0000-4000-8000-00000000d025"; // diego.alvarez@example.com (authed non-owner)
const ANON_IP = "203.0.113.7"; // anonymous submitter (RFC 5737 test IP)
const MUSIC_CATEGORY_ID = "b2e5e4ef-4653-4434-9409-ef5fd14b77b9"; // seeded "music" category

async function main() {
  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  const contentFilter = createProfanityContentFilterAdapter();
  const authz = createDbAuthZAdapter({ repos });

  const now = clock.now();
  const startsAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // +14d
  const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000); // +3h
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");

  console.log("\n▶ Creating COMMUNITY listing (ownerless, published immediately)…");
  const created = await createCommunityListing(
    { repos, authz, clock, contentFilter },
    {
      actorHumanId: MODERATOR_HUMAN_ID,
      title: `[QA] Community Open Mic — ${stamp}`,
      startsAt,
      endsAt,
      timezone: "America/Chicago",
      addressText: "The Mohawk, 912 Red River St",
      countryCode: "US",
      region: "TX",
      locality: "Austin",
      postalCode: "78701",
      lat: 30.2686,
      lng: -97.7362,
      categoryId: MUSIC_CATEGORY_ID,
      ageLimit: null,
      content: null,
    },
  );

  const event = created.event;
  console.log(`  ✓ event ${event.id}  slug=${event.slug ?? "(none)"}`);

  // A few PENDING suggestions from different submitters. Each lands in the
  // community moderator queue (community listings are ownerless → reviewed by
  // COMMUNITY_MODERATOR/ADMIN, not an org owner).
  const suggestions: Array<{
    label: string;
    input: Parameters<typeof submitEventEditSuggestion>[1];
  }> = [
    {
      label: "authed non-owner → title change",
      input: {
        eventId: event.id,
        submitterHumanId: SUBMITTER_A,
        fields: { title: `[QA] Tuesday Open Mic & Jam — ${stamp}` },
        note: "The venue renamed the night to include the jam session.",
      },
    },
    {
      label: "anonymous (IP) → age limit",
      input: {
        eventId: event.id,
        submitterIp: ANON_IP,
        fields: { ageLimit: 18 },
        note: "This night is 18+ per the door policy.",
      },
    },
    {
      // Intentionally edits the SAME field as suggestion #1 → a realistic
      // "two people propose different titles" conflict for the reviewer to
      // adjudicate (approving one should surface base-version drift on the other).
      label: "second authed non-owner → competing title change",
      input: {
        eventId: event.id,
        submitterHumanId: SUBMITTER_B,
        fields: { title: `[QA] Tuesday Songwriter Showcase — ${stamp}` },
        note: "Prefer 'Songwriter Showcase' — that's what the flyers say.",
      },
    },
  ];

  console.log("▶ Submitting PENDING edit suggestions…");
  const ids: string[] = [];
  for (const s of suggestions) {
    try {
      const res = await submitEventEditSuggestion(
        { repos, clock, contentFilter },
        s.input,
      );
      ids.push(res.suggestion.id);
      console.log(`  ✓ ${s.label}  → suggestion ${res.suggestion.id}`);
    } catch (err) {
      console.error(`  ✗ ${s.label} FAILED:`, (err as Error).message);
    }
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("QA community-suggestions seed complete.");
  console.log(`  Event id        : ${event.id}`);
  console.log(`  Public page     : /events/${event.slug ?? "<slug>"}`);
  console.log(`  Moderator queue : /moderate/suggestions   (review here — listings are ownerless)`);
  console.log(`  Pending created : ${ids.length}/${suggestions.length}`);
  console.log("  Sign in as admin@ithasfire.com / Dev-Login-2026! (platform ADMIN = moderator).");
  console.log("──────────────────────────────────────────────────────────\n");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("seed-community-suggestions failed:", err);
  process.exit(1);
});
