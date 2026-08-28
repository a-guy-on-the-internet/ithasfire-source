/**
 * QA seed: makes the review system (performer→venue place reviews + verified
 * attendee reviews) actually VISIBLE in local dev.
 *
 * Why this script exists: every public review surface is SNAPSHOT-ONLY by
 * design — `PlaceStats.publicSnapshot` (place-review-anonymization) and
 * `ReviewAggregate.snapshot` (attendee-reviews FR-004) are the sole sources
 * public reads may serve. Seeding review ROWS alone therefore renders
 * NOTHING. This script seeds above every k-threshold and then drives the REAL
 * recompute use cases so the snapshots exist:
 *   • recomputePublicSnapshots  → venue_stats block, RequestToPlay stats line,
 *                                 trusted-venues.
 *   • recomputeReviewAggregates → audience_stats block, event rating line.
 *
 * Everything domain-shaped goes through the REAL use cases (submitPlaceReview,
 * submitAttendeeReview, setPerformerMode, both recomputes) — never hand-written
 * snapshot SQL — so what you see matches production behaviour (denormalized
 * aggregation targets, scanned-ticket gating, suppression, bucket rounding).
 * Only QA SCAFFOLDING (page blocks, tickets, the prompt outbox, place flags)
 * is written directly.
 *
 * Thresholds cleared (see the two policy modules for the constants):
 *   place reviews  — headline k>=3, payout k>=5, day/genre slices k>=10,
 *                    genre fold k>=3  → seeds 12 reviews, all with payoutCents.
 *   attendee       — MIN_REVIEWERS=5 distinct reviewers per slice
 *                    → seeds 7 VERIFIED reviews from 7 distinct humans.
 *   community      — MIN_REVIEWERS=5 distinct COMMUNITY reviewers, counted
 *                    SEPARATELY from verified (FR-010) → seeds 6 COMMUNITY
 *                    reviews with distinct QA identities. The public community
 *                    slice is ALSO gated on Place.attendeeReviewsPublic (FR-005,
 *                    owner opt-in), which this seed flips to true.
 *
 * Run (LOCAL docker DB only — the script refuses any non-local host):
 *   pnpm seed:reviews-qa
 * or:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public \
 *     pnpm -F api exec tsx src/scripts/seed-reviews-qa.ts
 *
 * Idempotent: re-running creates no duplicates (place reviews are keyed by a
 * deterministic QA anonymousEmail, attendee reviews by the (event, human)
 * unique, tickets/prompts/blocks by deterministic ids/kinds) and simply
 * recomputes the same snapshots.
 */
import "dotenv/config";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { submitPlaceReview } from "@th/core/use-cases/place-reviews/submit-place-review";
import { recomputePublicSnapshots } from "@th/core/use-cases/place-reviews/recompute-public-snapshots";
import { submitAttendeeReview } from "@th/core/use-cases/attendee-reviews/submit-attendee-review";
import { submitCommunityVenueReview } from "@th/core/use-cases/attendee-reviews/submit-community-venue-review";
import { recomputeReviewAggregates } from "@th/core/use-cases/attendee-reviews/recompute-review-aggregates";
import { setPerformerMode } from "@th/core/use-cases/performers/set-performer-mode";

// ─────────────────────────────────────────────────────────────────────────────
// Safety: LOCAL DOCKER ONLY
// ─────────────────────────────────────────────────────────────────────────────
//
// apps/api/.env points DATABASE_URL at the Neon dev CLOUD database. `dotenv`
// does not override an already-set process env var, so an explicit
// `DATABASE_URL=...localhost... pnpm ...` prefix wins — but this seed writes a
// lot of rows, so we assert the host rather than trust that precedence.

function assertLocalDatabase(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL is not set. Run via `pnpm seed:reviews-qa` (it pins the local docker URL).",
    );
  }
  const host = new URL(raw).hostname;
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db"]);
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL host is "${host}", not a local docker host.\n` +
        `This QA seed only ever writes to the local docker postgres. Re-run with:\n` +
        `  pnpm seed:reviews-qa`,
    );
  }
  return host;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target fixtures (see apps/api/src/scripts/seed/ids.ts + fixtures.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SOMA Warehouse — the one seeded place that is VERIFIED, listed in the
 * directory, has an EntityPage, AND hosts an event that already carries
 * tickets. Its event is owned by Bay Area Festivals, of which the dev-login
 * admin is an ADMIN — so the same login can both submit a review and read the
 * owner-only feedback tab.
 */
const PLACE_ID = "00000000-0000-4000-8000-00000000d035";
/** [STRIPE] SOMA Warehouse Rave — PUBLISHED, at PLACE_ID, owned by ORG_ID. */
const EVENT_TITLE = "[STRIPE] SOMA Warehouse Rave";
/** Bay Area Festivals — dev-login admin is an ADMIN member. */
const ORG_SLUG = "bay-area-festivals";
/** admin@ithasfire.com / Dev-Login-2026! */
const DEV_LOGIN_HUMAN_ID = "00000000-0000-4000-8000-00000000d005";

/**
 * Seven DISTINCT seeded attendee humans. Distinctness is load-bearing: every
 * attendee k-gate counts DISTINCT reviewers (humanId), not rows. The dev-login
 * admin is deliberately NOT in this list — it must stay review-free so
 * /review-event/<id> is submittable end-to-end.
 */
const ATTENDEE_HUMAN_IDS = [
  "00000000-0000-4000-8000-0000d1000000", // Olivia Thompson
  "00000000-0000-4000-8000-0000d1010000", // Liam Nguyen
  "00000000-0000-4000-8000-0000d1020000", // Sophia Patel
  "00000000-0000-4000-8000-0000d1030000", // Noah Garcia
  "00000000-0000-4000-8000-0000d1040000", // Emma Williams
  "00000000-0000-4000-8000-0000d1050000", // Ethan Brown
  "00000000-0000-4000-8000-0000d1060000", // Ava Johnson
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Place-review fixtures (performer → venue)
// ─────────────────────────────────────────────────────────────────────────────
//
// 12 reviews, ALL carrying payoutCents, so every slice clears:
//   headline (k>=3) · payout (k>=5) · dayOfWeek + genres (k>=10).
// Genre mix is chosen so the k>=3 fold keeps real names instead of collapsing
// everything into "other": techno×4, house×3, bass×3 survive; ambient×1 and
// punk×1 fold → snapshot genres = [techno, house, bass, other].
// Payment mix over 12: GUARANTEE×5 (40%), DOOR_SPLIT×4 (35%),
// BAR_PERCENTAGE×2 (15%), TIPS_ONLY×1 (10%) — sums to 100 after 5% stepping.
// wouldPlayAgain: YES×9 → 75%. Payouts sort to a $200.00 median, $100 min,
// $350 max (all already $25-bucket aligned).

type PlaceReviewFixture = {
  /** Deterministic QA identity — also the idempotency key for this seed. */
  n: number;
  name: string;
  payoutCents: number;
  paymentMethod:
    | "GUARANTEE"
    | "DOOR_SPLIT"
    | "BAR_PERCENTAGE"
    | "TIPS_ONLY";
  venuePromoted: "ACTIVELY_PROMOTED" | "POSTED_ONCE" | "NO_PROMOTION";
  soundQuality: "GREAT" | "ADEQUATE" | "BAD" | "NONEXISTENT";
  stageEquipment: "FULL" | "PARTIAL" | "NONE";
  audienceFit: "PERFECT_FIT" | "OKAY" | "WRONG_CROWD";
  parkingLoadIn: "DEDICATED_LOT" | "STREET_NEARBY" | "DIFFICULT" | "NIGHTMARE";
  bookerRating: "EXCELLENT" | "GOOD" | "OKAY" | "POOR" | "TERRIBLE";
  staffSupport: "YES" | "SOMEWHAT" | "NO";
  wouldPlayAgain: "YES" | "MAYBE" | "NO";
  genre: string;
  /** 0=Sun … 6=Sat. Passed explicitly so the slice is timezone-deterministic. */
  dayOfWeek: number;
  /** Days before "now" the gig happened — drives gigDate. */
  gigDaysAgo: number;
  comment?: string;
};

const PLACE_REVIEWS: PlaceReviewFixture[] = [
  {
    n: 1,
    name: "Nadia Foss",
    payoutCents: 20_000,
    paymentMethod: "GUARANTEE",
    venuePromoted: "ACTIVELY_PROMOTED",
    soundQuality: "GREAT",
    stageEquipment: "FULL",
    audienceFit: "PERFECT_FIT",
    parkingLoadIn: "STREET_NEARBY",
    bookerRating: "EXCELLENT",
    staffSupport: "YES",
    wouldPlayAgain: "YES",
    genre: "techno",
    dayOfWeek: 5,
    gigDaysAgo: 40,
    comment:
      "Load-in was painless and the monitor engineer actually listened. Paid in cash the same night.",
  },
  {
    n: 2,
    name: "Cal Brennan",
    payoutCents: 15_000,
    paymentMethod: "DOOR_SPLIT",
    venuePromoted: "POSTED_ONCE",
    soundQuality: "ADEQUATE",
    stageEquipment: "PARTIAL",
    audienceFit: "OKAY",
    parkingLoadIn: "DIFFICULT",
    bookerRating: "GOOD",
    staffSupport: "SOMEWHAT",
    wouldPlayAgain: "YES",
    genre: "techno",
    dayOfWeek: 6,
    gigDaysAgo: 54,
  },
  {
    n: 3,
    name: "Imani Boateng",
    payoutCents: 30_000,
    paymentMethod: "GUARANTEE",
    venuePromoted: "ACTIVELY_PROMOTED",
    soundQuality: "GREAT",
    stageEquipment: "FULL",
    audienceFit: "PERFECT_FIT",
    parkingLoadIn: "DEDICATED_LOT",
    bookerRating: "EXCELLENT",
    staffSupport: "YES",
    wouldPlayAgain: "YES",
    genre: "techno",
    dayOfWeek: 5,
    gigDaysAgo: 67,
    comment:
      "Best-run warehouse night in the city. Sound check started on time, which never happens.",
  },
  {
    n: 4,
    name: "Rue Halvorsen",
    payoutCents: 12_500,
    paymentMethod: "DOOR_SPLIT",
    venuePromoted: "POSTED_ONCE",
    soundQuality: "ADEQUATE",
    stageEquipment: "PARTIAL",
    audienceFit: "OKAY",
    parkingLoadIn: "DIFFICULT",
    bookerRating: "GOOD",
    staffSupport: "SOMEWHAT",
    wouldPlayAgain: "MAYBE",
    genre: "techno",
    dayOfWeek: 4,
    gigDaysAgo: 80,
    comment:
      "Fine room, but the door count and my count did not match. Ask for the clicker total.",
  },
  {
    n: 5,
    name: "Devon Okafor",
    payoutCents: 25_000,
    paymentMethod: "GUARANTEE",
    venuePromoted: "ACTIVELY_PROMOTED",
    soundQuality: "GREAT",
    stageEquipment: "FULL",
    audienceFit: "PERFECT_FIT",
    parkingLoadIn: "STREET_NEARBY",
    bookerRating: "EXCELLENT",
    staffSupport: "YES",
    wouldPlayAgain: "YES",
    genre: "house",
    dayOfWeek: 6,
    gigDaysAgo: 95,
  },
  {
    n: 6,
    name: "Sasha Vidal",
    payoutCents: 17_500,
    paymentMethod: "DOOR_SPLIT",
    venuePromoted: "POSTED_ONCE",
    soundQuality: "GREAT",
    stageEquipment: "PARTIAL",
    audienceFit: "PERFECT_FIT",
    parkingLoadIn: "STREET_NEARBY",
    bookerRating: "GOOD",
    staffSupport: "YES",
    wouldPlayAgain: "YES",
    genre: "house",
    dayOfWeek: 5,
    gigDaysAgo: 110,
    comment:
      "Crowd stayed until close. Merch table placement is bad — you are behind the bar line.",
  },
  {
    n: 7,
    name: "Theo Marchetti",
    payoutCents: 22_500,
    paymentMethod: "GUARANTEE",
    venuePromoted: "ACTIVELY_PROMOTED",
    soundQuality: "ADEQUATE",
    stageEquipment: "FULL",
    audienceFit: "OKAY",
    parkingLoadIn: "DEDICATED_LOT",
    bookerRating: "GOOD",
    staffSupport: "YES",
    wouldPlayAgain: "YES",
    genre: "house",
    dayOfWeek: 3,
    gigDaysAgo: 126,
  },
  {
    n: 8,
    name: "Priya Raman",
    payoutCents: 10_000,
    paymentMethod: "BAR_PERCENTAGE",
    venuePromoted: "NO_PROMOTION",
    soundQuality: "BAD",
    stageEquipment: "NONE",
    audienceFit: "WRONG_CROWD",
    parkingLoadIn: "NIGHTMARE",
    bookerRating: "POOR",
    staffSupport: "NO",
    wouldPlayAgain: "NO",
    genre: "bass",
    dayOfWeek: 2,
    gigDaysAgo: 141,
    comment:
      "Zero promo, wrong bill, and the bar cut barely covered gas. Would not book again.",
  },
  {
    n: 9,
    name: "Jonas Wexler",
    payoutCents: 35_000,
    paymentMethod: "GUARANTEE",
    venuePromoted: "ACTIVELY_PROMOTED",
    soundQuality: "GREAT",
    stageEquipment: "FULL",
    audienceFit: "PERFECT_FIT",
    parkingLoadIn: "DEDICATED_LOT",
    bookerRating: "EXCELLENT",
    staffSupport: "YES",
    wouldPlayAgain: "YES",
    genre: "bass",
    dayOfWeek: 6,
    gigDaysAgo: 158,
  },
  {
    n: 10,
    name: "Elena Duarte",
    payoutCents: 27_500,
    paymentMethod: "DOOR_SPLIT",
    venuePromoted: "ACTIVELY_PROMOTED",
    soundQuality: "GREAT",
    stageEquipment: "PARTIAL",
    audienceFit: "PERFECT_FIT",
    parkingLoadIn: "STREET_NEARBY",
    bookerRating: "EXCELLENT",
    staffSupport: "YES",
    wouldPlayAgain: "YES",
    genre: "bass",
    dayOfWeek: 5,
    gigDaysAgo: 173,
    comment:
      "Genuinely the friendliest staff on this side of town. They fed the whole lineup.",
  },
  {
    n: 11,
    name: "Marcus Oyelaran",
    payoutCents: 15_000,
    paymentMethod: "BAR_PERCENTAGE",
    venuePromoted: "POSTED_ONCE",
    soundQuality: "ADEQUATE",
    stageEquipment: "PARTIAL",
    audienceFit: "OKAY",
    parkingLoadIn: "DIFFICULT",
    bookerRating: "OKAY",
    staffSupport: "SOMEWHAT",
    wouldPlayAgain: "YES",
    genre: "ambient",
    dayOfWeek: 0,
    gigDaysAgo: 190,
  },
  {
    n: 12,
    name: "Wren Kowalczyk",
    payoutCents: 20_000,
    paymentMethod: "TIPS_ONLY",
    venuePromoted: "NO_PROMOTION",
    soundQuality: "ADEQUATE",
    stageEquipment: "NONE",
    audienceFit: "OKAY",
    parkingLoadIn: "DIFFICULT",
    bookerRating: "OKAY",
    staffSupport: "SOMEWHAT",
    wouldPlayAgain: "MAYBE",
    genre: "punk",
    dayOfWeek: 1,
    gigDaysAgo: 205,
  },
];

/** Deterministic, obviously-fake identity — doubles as the idempotency key. */
function qaReviewerEmail(n: number): string {
  return `qa-performer-${String(n).padStart(2, "0")}@reviews-qa.invalid`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attendee-review fixtures (verified attendee → event)
// ─────────────────────────────────────────────────────────────────────────────
//
// 7 reviews from 7 distinct humans (MIN_REVIEWERS = 5, so the EVENT, PLACE and
// OWNER aggregates all publish). Facet coverage is deliberately uneven to make
// the "present keys only" suppression visible in the rendered block:
//   soundQuality  → 7 raters  → PUBLISHED
//   venueComfort  → 6 raters  → PUBLISHED
//   organization  → 5 raters  → PUBLISHED (exactly at the k-threshold)
//   valueForMoney → 3 raters  → SUPPRESSED (key absent, never zeroed)
// Overall ratings 5,4,5,4,3,5,2 → mean 4.0; 5 of 7 are top-box (>=4) → 71.4%
// → 70% after 5% stepping. reviewCountBand "7" (exact below 20).

type AttendeeReviewFixture = {
  humanId: string;
  overallRating: number;
  soundQuality?: number;
  venueComfort?: number;
  organization?: number;
  valueForMoney?: number;
  text?: string;
};

const ATTENDEE_REVIEWS: AttendeeReviewFixture[] = [
  {
    humanId: ATTENDEE_HUMAN_IDS[0],
    overallRating: 5,
    soundQuality: 5,
    venueComfort: 4,
    organization: 5,
    valueForMoney: 5,
    text: "Sound was immaculate and the doors actually opened on time. Best night out I have had all year.",
  },
  {
    humanId: ATTENDEE_HUMAN_IDS[1],
    overallRating: 4,
    soundQuality: 4,
    venueComfort: 4,
    organization: 4,
    valueForMoney: 4,
    text: "Great set. Only gripe is the bar line ate about twenty minutes of the opener.",
  },
  {
    humanId: ATTENDEE_HUMAN_IDS[2],
    overallRating: 5,
    soundQuality: 5,
    venueComfort: 5,
    organization: 5,
    valueForMoney: 4,
  },
  {
    humanId: ATTENDEE_HUMAN_IDS[3],
    overallRating: 4,
    soundQuality: 4,
    venueComfort: 3,
    organization: 4,
    text: "Loved the lineup. It got genuinely too warm near the back wall by midnight.",
  },
  {
    humanId: ATTENDEE_HUMAN_IDS[4],
    overallRating: 3,
    soundQuality: 3,
    venueComfort: 3,
    organization: 3,
  },
  {
    humanId: ATTENDEE_HUMAN_IDS[5],
    overallRating: 5,
    soundQuality: 5,
    venueComfort: 5,
  },
  {
    humanId: ATTENDEE_HUMAN_IDS[6],
    overallRating: 2,
    soundQuality: 2,
    text: "Muddy low end from where I stood and no one at the door could tell us where will-call was.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Community-review fixtures (unverified, venue-direct → COMMUNITY source)
// ─────────────────────────────────────────────────────────────────────────────
//
// 6 COMMUNITY reviews from 6 DISTINCT anonymous QA identities (MIN_REVIEWERS = 5
// counted SEPARATELY per source — FR-010 — so this clears the community k-gate
// with one to spare). These anchor to placeId only (eventId = null), so they
// only ever surface on the PLACE aggregate's `community` slice, never on the
// EVENT/OWNER rollups. Varied overall ratings (mix of 3–5) plus a few with text
// + facets make the community line and the owner panel non-trivial.
//
// Idempotency: community submit is FULLY OPEN (no unique key), so re-runs would
// duplicate. We guard ourselves with a findFirst on (placeId, anonymousEmail,
// source=COMMUNITY) before every submit — the deterministic QA email is the key.

type CommunityReviewFixture = {
  /** Deterministic QA identity 1..6 — also the idempotency key for this seed. */
  n: number;
  name: string;
  overallRating: number;
  soundQuality?: number;
  venueComfort?: number;
  organization?: number;
  valueForMoney?: number;
  text?: string;
};

const COMMUNITY_REVIEWS: CommunityReviewFixture[] = [
  {
    n: 1,
    name: "QA Community 1",
    overallRating: 5,
    soundQuality: 5,
    venueComfort: 4,
    organization: 5,
    text: "Found this spot through a friend — the room sounds fantastic and staff were welcoming.",
  },
  {
    n: 2,
    name: "QA Community 2",
    overallRating: 4,
    venueComfort: 4,
    valueForMoney: 4,
  },
  {
    n: 3,
    name: "QA Community 3",
    overallRating: 3,
    soundQuality: 3,
    organization: 3,
    text: "Decent night but the entrance line was disorganised and it took a while to get in.",
  },
  {
    n: 4,
    name: "QA Community 4",
    overallRating: 5,
    soundQuality: 4,
    venueComfort: 5,
    organization: 4,
  },
  {
    n: 5,
    name: "QA Community 5",
    overallRating: 4,
    soundQuality: 4,
  },
  {
    n: 6,
    name: "QA Community 6",
    overallRating: 5,
    soundQuality: 5,
    venueComfort: 4,
    organization: 5,
    valueForMoney: 5,
    text: "Regular here now. Consistently well-run and the sound is a cut above other rooms this size.",
  },
];

/** Deterministic, obviously-fake identity — doubles as the idempotency key. */
function qaCommunityEmail(n: number): string {
  return `qa-community-${n}@ithasfire.local`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const dbHost = assertLocalDatabase();

  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  const now = clock.now();

  console.log(`\n▶ Target DB host: ${dbHost} (local docker) ✓`);

  // ── 0. Resolve the target place + event ────────────────────────────────────
  const place = await prisma.place.findUnique({ where: { id: PLACE_ID } });
  if (!place) {
    throw new Error(
      `Place ${PLACE_ID} (SOMA Warehouse) not found. Run \`pnpm seed:dev\` first.`,
    );
  }
  // Resolve the event by its STABLE key (title + placeId), not a hardcoded
  // UUID — `seed:dev` regenerates this event with a fresh random id each run,
  // so a baked-in eventId goes stale on every reseed. The place, by contrast,
  // has a fixed fixture id (PLACE_ID).
  const event = await prisma.event.findFirst({
    where: { title: EVENT_TITLE, placeId: PLACE_ID },
  });
  if (!event) {
    throw new Error(
      `Event "${EVENT_TITLE}" at place ${PLACE_ID} not found. Run \`pnpm seed:dev\` first.`,
    );
  }
  const eventId = event.id;
  console.log(`  place : ${place.name} (${place.slug ?? "no slug"})`);
  console.log(`  event : ${event.title} (${eventId})`);

  // ── 1. Place must be VERIFIED + accepting requests ─────────────────────────
  // The public page drops `request_to_play` entirely unless the venue is
  // verified AND accepting requests (EntityPageShell) — and the stats line
  // lives INSIDE that form.
  await prisma.place.update({
    where: { id: PLACE_ID },
    data: {
      verification: "VERIFIED",
      acceptsBookingRequests: true,
      listedInDirectory: true,
    },
  });
  console.log(
    "  ✓ place: verification=VERIFIED, acceptsBookingRequests=true, listedInDirectory=true",
  );

  // ── 2. Event must have ENDED and sit inside the 30-day review window ───────
  // Pinned to now-3d on every run so the window never expires as the fixture
  // ages. (This event already ended in the base seed — this only makes the
  // date deterministic.)
  const endsAt = new Date(now.getTime() - 3 * DAY_MS);
  const startsAt = new Date(endsAt.getTime() - 4 * 60 * 60 * 1000);
  await prisma.event.update({
    where: { id: eventId },
    data: { startsAt, endsAt },
  });
  console.log(
    `  ✓ event: startsAt=${startsAt.toISOString()} endsAt=${endsAt.toISOString()} (ended 3d ago, window open)`,
  );

  // ── 3. EntityPage blocks (QA scaffolding) ─────────────────────────────────
  // The venue template only seeds blocks on NEW pages; this page already
  // exists, so the stats blocks would never appear on their own. Both blocks
  // are server-injected (`data` stays a heading only — get-public-page rebuilds
  // the content from the snapshots and ignores anything else stored here).
  const entityPage = await prisma.entityPage.findFirst({
    where: { ownerType: "PLACE", ownerId: PLACE_ID },
    include: { blocks: true },
  });
  if (!entityPage) {
    throw new Error(
      `EntityPage for place ${PLACE_ID} not found. Run \`pnpm seed:dev\` first.`,
    );
  }

  const existingKinds = new Set(entityPage.blocks.map((b) => b.kind));
  let nextOrder =
    entityPage.blocks.reduce((max, b) => Math.max(max, b.orderIndex), -1) + 1;

  const requiredBlocks = [
    { kind: "venue_stats", data: { heading: "What performers report" } },
    { kind: "audience_stats", data: { heading: "What attendees report" } },
    { kind: "request_to_play", data: {} },
  ];

  const addedBlocks: string[] = [];
  for (const spec of requiredBlocks) {
    if (existingKinds.has(spec.kind)) continue;
    await prisma.pageBlock.create({
      data: {
        pageId: entityPage.id,
        kind: spec.kind,
        orderIndex: nextOrder++,
        data: spec.data,
        visible: true,
      },
    });
    addedBlocks.push(spec.kind);
  }
  console.log(
    addedBlocks.length > 0
      ? `  ✓ page blocks added: ${addedBlocks.join(", ")}`
      : "  = page blocks already present (venue_stats, audience_stats, request_to_play)",
  );

  // ── 4. Performer mode for dev-login ───────────────────────────────────────
  // The RequestToPlay form (and therefore its stats line) only renders for a
  // performer-mode-enabled viewer; otherwise the block shows the opt-in gate.
  // Real use case — idempotent by design.
  await setPerformerMode(
    { repos, clock },
    {
      actorHumanId: DEV_LOGIN_HUMAN_ID,
      ownerType: "human",
      ownerId: DEV_LOGIN_HUMAN_ID,
      enabled: true,
    },
  );
  console.log("  ✓ performer mode enabled for dev-login (admin@ithasfire.com)");

  // ── 5. Twelve place reviews (REAL submitPlaceReview) ──────────────────────
  const existingQaReviews = await prisma.placeReview.findMany({
    where: {
      placeId: PLACE_ID,
      anonymousEmail: { in: PLACE_REVIEWS.map((r) => qaReviewerEmail(r.n)) },
    },
    select: { anonymousEmail: true },
  });
  const seededEmails = new Set(
    existingQaReviews.map((r) => r.anonymousEmail).filter(Boolean),
  );

  let placeReviewsCreated = 0;
  let placeReviewsSkipped = 0;
  for (const fixture of PLACE_REVIEWS) {
    const email = qaReviewerEmail(fixture.n);
    if (seededEmails.has(email)) {
      placeReviewsSkipped += 1;
      continue;
    }
    const gigDate = new Date(now.getTime() - fixture.gigDaysAgo * DAY_MS);
    await submitPlaceReview(
      { repos, clock },
      {
        placeId: PLACE_ID,
        anonymousName: fixture.name,
        anonymousEmail: email,
        payoutCents: fixture.payoutCents,
        paymentMethod: fixture.paymentMethod,
        venuePromoted: fixture.venuePromoted,
        soundQuality: fixture.soundQuality,
        stageEquipment: fixture.stageEquipment,
        audienceFit: fixture.audienceFit,
        parkingLoadIn: fixture.parkingLoadIn,
        bookerRating: fixture.bookerRating,
        staffSupport: fixture.staffSupport,
        wouldPlayAgain: fixture.wouldPlayAgain,
        // The web form sends genre === genreTags[0]; mirror it so the
        // per-review genre de-duplication in the policy is exercised.
        genre: fixture.genre,
        genreTags: [fixture.genre],
        gigDate,
        dayOfWeek: fixture.dayOfWeek,
        ...(fixture.comment ? { comment: fixture.comment } : {}),
        // SURVEY (not PLATFORM) → no 14-day post-event embargo, so these land
        // in the public snapshot on the very first recompute.
        source: "SURVEY",
      },
    );
    placeReviewsCreated += 1;
  }
  console.log(
    `  ✓ place reviews: ${placeReviewsCreated} created, ${placeReviewsSkipped} already present (target 12)`,
  );

  // ── 6. SCANNED tickets (QA scaffolding) ───────────────────────────────────
  // submitAttendeeReview enforces verified attendance via a SCANNED ticket
  // owned by the actor. Give every reviewer — and dev-login — one. Deterministic
  // ids keep the re-run a no-op.
  const ticketHumans = [...ATTENDEE_HUMAN_IDS, DEV_LOGIN_HUMAN_ID];
  let ticketsCreated = 0;
  for (const [index, humanId] of ticketHumans.entries()) {
    const already = await prisma.ticket.count({
      where: { eventId: eventId, ownerHumanId: humanId, status: "SCANNED" },
    });
    if (already > 0) continue;
    const suffix = String(index).padStart(2, "0");
    // Deterministic, valid-hex UUID so a re-run upserts the same row.
    const ticketId = `00000000-0000-4000-8000-0000fa${suffix}0000`;
    await prisma.ticket.upsert({
      where: { id: ticketId },
      create: {
        id: ticketId,
        eventId: eventId,
        ownerHumanId: humanId,
        code: `QA-REVIEW-${suffix}`,
        status: "SCANNED",
        issuedAt: startsAt,
        scannedAt: startsAt,
      },
      update: { status: "SCANNED", scannedAt: startsAt },
    });
    ticketsCreated += 1;
  }
  console.log(
    `  ✓ scanned tickets: ${ticketsCreated} created (${ticketHumans.length} humans need one; the rest already had one)`,
  );

  // ── 7. Seven attendee reviews (REAL submitAttendeeReview) ─────────────────
  // The real use case stamps the denormalized aggregation targets (placeId,
  // ownerType/ownerId, seriesId) from the EVENT ROW — that stamping is exactly
  // what the PLACE/OWNER rollups read, so hand-writing rows here would silently
  // break them.
  let attendeeReviewsCreated = 0;
  let attendeeReviewsSkipped = 0;
  for (const fixture of ATTENDEE_REVIEWS) {
    try {
      await submitAttendeeReview(
        { repos, clock },
        {
          eventId: eventId,
          actorHumanId: fixture.humanId,
          overallRating: fixture.overallRating,
          ...(fixture.soundQuality !== undefined
            ? { soundQuality: fixture.soundQuality }
            : {}),
          ...(fixture.venueComfort !== undefined
            ? { venueComfort: fixture.venueComfort }
            : {}),
          ...(fixture.organization !== undefined
            ? { organization: fixture.organization }
            : {}),
          ...(fixture.valueForMoney !== undefined
            ? { valueForMoney: fixture.valueForMoney }
            : {}),
          ...(fixture.text ? { text: fixture.text } : {}),
        },
      );
      attendeeReviewsCreated += 1;
    } catch (err) {
      // The (eventId, humanId) unique makes re-runs idempotent: an existing
      // review is the expected steady state, not a failure.
      const code = (err as { code?: string } | null)?.code;
      if (code === "ATTENDEE_REVIEW_ALREADY_SUBMITTED") {
        attendeeReviewsSkipped += 1;
        continue;
      }
      throw err;
    }
  }
  console.log(
    `  ✓ attendee reviews: ${attendeeReviewsCreated} created, ${attendeeReviewsSkipped} already present (target 7)`,
  );

  // ── 7b. Six COMMUNITY reviews (REAL submitCommunityVenueReview) ───────────
  // Unverified, venue-direct feedback anchored to PLACE_ID (eventId = null).
  // Community submit is fully-open (no unique key), so we self-guard idempotency
  // with a findFirst on (placeId, anonymousEmail, source=COMMUNITY) before each
  // submit — the deterministic QA email is the key. These land in the PLACE
  // aggregate's SEPARATE `community` slice (FR-010), never in the verified one.
  let communityReviewsCreated = 0;
  let communityReviewsSkipped = 0;
  for (const fixture of COMMUNITY_REVIEWS) {
    const anonymousEmail = qaCommunityEmail(fixture.n);
    const existing = await prisma.attendeeReview.findFirst({
      where: { placeId: PLACE_ID, anonymousEmail, source: "COMMUNITY" },
      select: { id: true },
    });
    if (existing) {
      communityReviewsSkipped += 1;
      continue;
    }
    await submitCommunityVenueReview(
      { repos, clock },
      {
        placeId: PLACE_ID,
        anonymousName: fixture.name,
        anonymousEmail,
        overallRating: fixture.overallRating,
        ...(fixture.soundQuality !== undefined
          ? { soundQuality: fixture.soundQuality }
          : {}),
        ...(fixture.venueComfort !== undefined
          ? { venueComfort: fixture.venueComfort }
          : {}),
        ...(fixture.organization !== undefined
          ? { organization: fixture.organization }
          : {}),
        ...(fixture.valueForMoney !== undefined
          ? { valueForMoney: fixture.valueForMoney }
          : {}),
        ...(fixture.text ? { text: fixture.text } : {}),
      },
    );
    communityReviewsCreated += 1;
  }
  console.log(
    `  ✓ community reviews: ${communityReviewsCreated} created, ${communityReviewsSkipped} already present (target 6)`,
  );

  // ── 7c. Owner opt-in: publish the attendee/community aggregates (FR-005) ──
  // The public audience_stats community slice is gated on this place flag —
  // without it, the snapshot may compute but the surface stays hidden. QA
  // place-flag write, direct like the verification/directory flags above.
  await prisma.place.update({
    where: { id: PLACE_ID },
    data: { attendeeReviewsPublic: true },
  });
  console.log("  ✓ place: attendeeReviewsPublic=true (owner opt-in, FR-005)");

  // ── 8. PostEventPrompt outbox rows (QA scaffolding, never dispatched) ─────
  const prompts: {
    humanId: string;
    status: "PENDING" | "SENT";
    sentAt: Date | null;
  }[] = [
    { humanId: DEV_LOGIN_HUMAN_ID, status: "PENDING", sentAt: null },
    {
      humanId: ATTENDEE_HUMAN_IDS[0],
      status: "SENT",
      sentAt: new Date(now.getTime() - 2 * DAY_MS),
    },
  ];
  for (const prompt of prompts) {
    await prisma.postEventPrompt.upsert({
      where: {
        eventId_humanId_audience: {
          eventId: eventId,
          humanId: prompt.humanId,
          audience: "ATTENDEE",
        },
      },
      create: {
        eventId: eventId,
        humanId: prompt.humanId,
        placeId: PLACE_ID,
        audience: "ATTENDEE",
        status: prompt.status,
        attempts: prompt.status === "SENT" ? 1 : 0,
        sentAt: prompt.sentAt,
      },
      update: {},
    });
  }
  console.log(
    "  ✓ post-event prompts: 1 PENDING + 1 SENT (ATTENDEE audience, not dispatched — no emails)",
  );

  // ── 9. THE RECOMPUTES — without these, nothing renders ────────────────────
  console.log("\n▶ Running the real recompute use cases…");

  const placeSnapshots = await recomputePublicSnapshots(
    {
      repos: {
        placeReviews: repos.placeReviews,
        placeStats: repos.placeStats,
        events: repos.events,
      },
      clock,
    },
    { batchSize: 100 },
  );
  console.log(
    `  ✓ recomputePublicSnapshots  → placesRecomputed=${placeSnapshots.placesRecomputed} placesFailed=${placeSnapshots.placesFailed}`,
  );

  const reviewAggregates = await recomputeReviewAggregates(
    {
      repos: {
        attendeeReviews: repos.attendeeReviews,
        reviewAggregates: repos.reviewAggregates,
      },
      clock,
    },
    { batchSize: 100 },
  );
  console.log(
    `  ✓ recomputeReviewAggregates → subjectsRecomputed=${reviewAggregates.subjectsRecomputed} subjectsFailed=${reviewAggregates.subjectsFailed}`,
  );

  // ── 10. Verify the snapshots actually PUBLISHED ───────────────────────────
  // A snapshot row that exists but carries no `headline` / `summary` means a
  // k-threshold was missed — the surfaces would silently render nothing, which
  // is the exact failure this seed exists to prevent. Surface it loudly.
  const stats = await prisma.placeStats.findUnique({
    where: { placeId: PLACE_ID },
    select: { publicSnapshot: true, publicSnapshotAt: true },
  });
  const placeSnapshot = stats?.publicSnapshot as {
    headline?: unknown;
    payout?: unknown;
    dayOfWeek?: unknown;
    genres?: unknown;
  } | null;

  const aggregates = await prisma.reviewAggregate.findMany({
    where: {
      OR: [
        { subjectType: "EVENT", subjectId: eventId },
        { subjectType: "PLACE", subjectId: PLACE_ID },
      ],
    },
    select: { subjectType: true, snapshot: true },
  });
  const eventAgg = aggregates.find((a) => a.subjectType === "EVENT");
  const placeAgg = aggregates.find((a) => a.subjectType === "PLACE");
  const hasSummary = (row: (typeof aggregates)[number] | undefined) =>
    Boolean((row?.snapshot as { summary?: unknown } | null)?.summary);
  const hasCommunity = (row: (typeof aggregates)[number] | undefined) =>
    Boolean((row?.snapshot as { community?: unknown } | null)?.community);

  // Re-read the flag we set so the report shows the actual persisted value.
  const flagRow = await prisma.place.findUnique({
    where: { id: PLACE_ID },
    select: { attendeeReviewsPublic: true },
  });

  console.log("\n▶ Published slices (what the surfaces will actually read):");
  console.log(
    `  place publicSnapshot : headline=${Boolean(placeSnapshot?.headline)} payout=${Boolean(
      placeSnapshot?.payout,
    )} dayOfWeek=${Boolean(placeSnapshot?.dayOfWeek)} genres=${JSON.stringify(
      placeSnapshot?.genres ?? null,
    )}`,
  );
  console.log(
    `  EVENT aggregate      : summary=${hasSummary(eventAgg)}   PLACE aggregate: summary=${hasSummary(placeAgg)} community=${hasCommunity(placeAgg)}`,
  );
  console.log(
    `  place attendeeReviewsPublic (owner opt-in) : ${flagRow?.attendeeReviewsPublic === true}`,
  );

  const problems: string[] = [];
  if (!placeSnapshot?.headline) problems.push("place headline slice MISSING");
  if (!placeSnapshot?.payout) problems.push("place payout slice MISSING");
  if (!placeSnapshot?.genres) problems.push("place genre slice MISSING");
  if (!hasSummary(eventAgg)) problems.push("EVENT aggregate summary MISSING");
  if (!hasSummary(placeAgg)) problems.push("PLACE aggregate summary MISSING");
  // The two NEW community-feature invariants: the segregated community slice
  // must publish (k>=5 distinct COMMUNITY reviewers) AND the owner opt-in flag
  // must be on (FR-005). A missing community slice means the k-gate was missed;
  // a false flag means the public surface would stay hidden despite the data.
  if (!hasCommunity(placeAgg))
    problems.push(
      "PLACE aggregate community slice MISSING (community k>=5 not met?)",
    );
  if (flagRow?.attendeeReviewsPublic !== true)
    problems.push("place attendeeReviewsPublic is NOT true (owner opt-in off)");
  if (problems.length > 0) {
    console.error(
      `\n  ✗ SOME SLICES DID NOT PUBLISH — the UI will render nothing for them:\n     - ${problems.join(
        "\n     - ",
      )}`,
    );
  }

  // ── WHAT TO LOOK AT ───────────────────────────────────────────────────────
  const placeSlug = entityPage.slug;
  const eventSlug = event.slug;
  const line = "─".repeat(78);

  console.log(`\n${line}`);
  console.log("WHAT TO LOOK AT");
  console.log(line);
  console.log(`
  Sign in as   : admin@ithasfire.com / Dev-Login-2026!
  Target place : ${place.name}  (${PLACE_ID})
  Target event : ${event.title}  (${eventId})

  1) VENUE PAGE — performer + attendee aggregate blocks
     http://localhost:3000/p/${placeSlug}
       • "venue_stats" block  → headline "Reported by N performers", would-play-again %,
         median/min/max payout in $25 buckets, payment-method mix, day-of-week + genre cloud.
       • "audience_stats" block → "Rated by N verified attendees", overall score, recommend %,
         and ONLY the facets that cleared 5 distinct raters (valueForMoney is deliberately
         suppressed — 3 raters — so you can see present-keys-only rendering).
       • Hero "Booking request" button → the Request-to-Play form; its stats line reads
         "N performers have reviewed this venue · X% would play again · median reported payout $Y".
         (Performer mode is already enabled for dev-login, so no opt-in gate.)

  2) ATTENDEE REVIEW FORM — submittable end-to-end as dev-login
     http://localhost:3000/review-event/${eventId}
       • The conversational multi-screen form. dev-login has a SCANNED ticket on this
         event, the event ended 3 days ago (inside the 30-day window), and has NO review
         yet → eligibility passes. Submitting makes the admin tab count go 7 → 8.
       • Public aggregates will NOT move until the recompute runs again — that delay IS
         the anonymity mechanism, not a bug.

  3) ADMIN — private "Attendee feedback" tab (owner-only, exact numbers)
     http://localhost:3000/admin/${ORG_SLUG}/events/${eventId}?tab=feedback
       • Exact (un-bucketed) aggregate + 4 UNATTRIBUTED comments with a Report action.
       • No names, no per-review ratings, no timestamps — by design (FR-002).

  4) PUBLIC EVENT PAGE — the "this event" rating line
     http://localhost:3000/events/${eventSlug}
       • Quiet rating line under the organizer attribution, from the EVENT aggregate.

  Note: all four surfaces are SNAPSHOT-ONLY. If you add reviews by hand, re-run
        \`pnpm seed:reviews-qa\` (or the two recompute jobs) or nothing will change.
`);
  console.log(`${line}\n`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("seed-reviews-qa failed:", err);
  process.exit(1);
});
