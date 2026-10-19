import type { Prisma, PrismaClient } from "@prisma/client";
import { config as dotenvConfig, parse as parseDotenv } from "dotenv";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { configureLocationObfuscation } from "@th/core/lib/location/obfuscation-key";
import { projectEventLocationAtPlace } from "@th/core/lib/location/place-event-location";
import { generateEventSlug } from "@th/core/use-cases/events/_shared/slug";
import { buildPageSlug } from "@th/core/use-cases/places/_shared/page-slug";
import { recalculatePlaceStats } from "@th/core/use-cases/place-reviews/recalculate-place-stats";

import { seedPlaceEntityPage } from "./entity-pages.js";
import { buildSeedEventBody, type PlaceFixture } from "./fixtures.js";
import { DEMO_IDS } from "./ids.js";
import {
  STRIPE_MIN_AMOUNT_CENTS,
  createConfirmedPaymentIntent,
  ensureSeedEventPrimaryTerms,
  loadSeedEventPricing,
  priceSeedOrder,
  pricedOrderColumns,
  seedStripeFromEnv,
  writeSeedTaxLines,
} from "./order-pricing.js";
import { ensurePlaces } from "./places.js";
import { pMap, slugify } from "./utils.js";

// ── Venue track-record fixture ───────────────────────────────────────────
//
// docs/specs/2026-09-24/completed/venue-track-record-and-review-switch.spec.yaml
// (R3, R4, R5, R7, R9; FR-008, FR-009, FR-013).
//
// The track record is built from things that HAPPENED — published shows
// that ended, tickets scanned at the door, who was on the bill — and the
// stock dev database has one past show per venue and not a single scanned
// ticket, so none of it can be seen. This fixture mints two venues for the
// demo org (the dev-login admin is an ADMIN there, so the settings toggles
// are reachable too):
//
//   FISHBOWL HOUSE — a DIY house in East Nashville. Address withheld
//     (`locationMode: OBSCURED`, 800 m), performer reviews OFF (R3's
//     default for a withheld place), attendee reviews not public, community
//     listings accepted. FOURTEEN past PUBLISHED PUBLIC shows: five sparse
//     Fridays across 2025, then a WEEKLY Thursday run — the nine most recent
//     Thursdays before today — so the derived cadence reads "weekly". The
//     nine weekly shows are TICKETED with a SUCCEEDED order and 20–60
//     SCANNED tickets each (R4: attendance is people checked in, never
//     tickets sold); the five older ones are RSVP-only with no tickets, so
//     they count toward shows hosted but not attendance (R5). Lineups repeat:
//     Rat Cathedral ×5, Sister Furnace ×4, Cold Stomach ×3, twelve one-offs,
//     and two `externalName`-only acts with no linked human (R7 / FR-013).
//     ZERO PlaceReview rows on purpose — FR-008 must compute stats for a
//     place nobody has ever reviewed.
//
//   CORNER LOT — exact address, performer reviews ON, a page, no shows. The
//     empty state.
//
// VENUE CONFIRMATION: every show is owned by the org that owns the place
// (`Event.orgId` = the demo org, which holds a VERIFIED, unrevoked
// ORGANIZATION `PlaceOwnership`), so `isVenueConfirmed` holds by the OWNER
// arm — "confirmed by construction". No stamp is written.
//
// Rows are written directly (no publish use case — that refuses a start in
// the past and needs payout plumbing), the way the Apple-review event and
// `attendee-review-fixture.ts` are. With a Stripe key (the env the seed
// loaded) each order gets a real confirmed test-mode PaymentIntent, as every
// paid checkout has; without one it has none. Their money is NOT
// hand-written, either: each ticketed show is given the PRIMARY terms
// event creation + publish would have left it, and its order is priced by the
// same checkout functions as the rest of the seed (`order-pricing.ts`).
//
// IDEMPOTENT: fixed ids + upserts for every row; per-show rows the current
// plan no longer produces (a ticket count that shrank between versions) are
// deleted so a re-run CONVERGES rather than accumulating. The weekly dates
// are relative to today, so a re-run a week later moves the run forward —
// same rows, same ids, same counts.
//
// STORED STATS: the track-record block reads the `PlaceStats` projection, which
// only the real `recalculatePlaceStats` use case writes (a scheduled job in
// production; the local stack runs no scheduler). The fixture runs that use
// case at the end and throws if Fishbowl House's row is missing, counts fewer
// shows than the fixture's ended shows, or is stale, so the block can never be
// left saying "No shows on the books yet" beside a full events list.
// `recomputeTrackRecordStats` runs that step alone against an existing database.
//
// STANDALONE: `pnpm -F api exec tsx src/scripts/seed/track-record-fixture.ts`
// loads the repo-root `.env.local` (the LOCAL dev database) and refuses any
// non-localhost DATABASE_URL unless THC_SEED_ALLOW_REMOTE_DB=true — the same
// guard `seed-data.ts` applies. Also wired into `seed-data.ts` after the
// attendee-review fixture.

const ZONE = "America/Chicago";
/** Doors 8pm local, three hours. */
const SHOW_START_HOUR = 20;
const SHOW_DURATION_MS = 3 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GA_PRICE_CENTS = 1000;
/** TN state + Davidson County admission tax, basis points (seed stamp). */
const NASHVILLE_ADMISSION_TAX_BPS = 975;

const ORG_ID = DEMO_IDS.org;

export const FISHBOWL_HOUSE_PLACE: PlaceFixture = {
  id: DEMO_IDS.trackRecordFishbowl,
  name: "Fishbowl House",
  address: "1412 Holly St",
  city: "Nashville",
  region: "TN",
  country: "US",
  postcode: "37206",
  lat: 36.1771,
  lng: -86.7389,
  timezone: ZONE,
  capacity: 60,
  ownerOrgId: ORG_ID,
  // The attendee aggregate is the owner's opt-in; a house that withholds its
  // address has not opted in. Explicit because `ensurePlaces` defaults ON.
  attendeeReviewsPublic: false,
};

export const CORNER_LOT_PLACE: PlaceFixture = {
  id: DEMO_IDS.trackRecordCornerLot,
  name: "Corner Lot",
  address: "804 Buchanan St",
  city: "Nashville",
  region: "TN",
  country: "US",
  postcode: "37208",
  lat: 36.1836,
  lng: -86.8016,
  timezone: ZONE,
  capacity: 120,
  ownerOrgId: ORG_ID,
};

/** Five sparse Fridays, eight weeks apart (R9: "N years running" needs a first show well back). */
const OLDER_SHOW_DATES: ReadonlyArray<LocalDate> = [
  { year: 2025, month: 3, day: 14 },
  { year: 2025, month: 5, day: 9 },
  { year: 2025, month: 7, day: 4 },
  { year: 2025, month: 8, day: 29 },
  { year: 2025, month: 10, day: 24 },
];
const WEEKLY_SHOW_COUNT = 9;
/** Checked-in count per weekly show, in run order (20–60, varying). */
const WEEKLY_SCANNED = [31, 44, 23, 58, 37, 27, 49, 55, 40] as const;
/**
 * Tickets issued but never scanned, per weekly show — no-shows at the door.
 * scanned + unscanned must fit the GA capacity (60): checkout's capacity gate
 * refuses anything past it (the 58-scan show was 58 + 6 = 64 before).
 */
const WEEKLY_UNSCANNED = [3, 5, 2, 2, 4, 2, 5, 3, 4] as const;

type ActFixture = { id: string; name: string; slug: string; bio: string };

const REGULAR_ACTS: ReadonlyArray<ActFixture> = [
  {
    id: DEMO_IDS.trackRecordActRatCathedral,
    name: "Rat Cathedral",
    slug: "rat-cathedral",
    bio: "Three-piece from Inglewood. Loud, short, on time.",
  },
  {
    id: DEMO_IDS.trackRecordActSisterFurnace,
    name: "Sister Furnace",
    slug: "sister-furnace",
    bio: "Slowcore duo. Tape loops and one very tired snare.",
  },
  {
    id: DEMO_IDS.trackRecordActColdStomach,
    name: "Cold Stomach",
    slug: "cold-stomach",
    bio: "Hardcore, mostly. Twelve-minute sets.",
  },
];

const ONE_OFF_ACT_NAMES = [
  "Gutter Ballet",
  "Porch Light Tenants",
  "Dial Tone Saints",
  "Housefire Choir",
  "Nettle & Ash",
  "The Long Weekend",
  "Vacant Lot Orchestra",
  "Sleep Study",
  "Half Moon Heaters",
  "Copper Kettle Riot",
  "Bruise Cruise",
  "Wet Cement",
] as const;

const ONE_OFF_ACTS: ReadonlyArray<ActFixture> = ONE_OFF_ACT_NAMES.map(
  (name, i) => ({
    id: DEMO_IDS.trackRecordOneOffActs[i]!,
    name,
    slug: slugify(name),
    bio: `${name} — played Fishbowl House once. Would again.`,
  }),
);

/** Acts on a bill with no platform human behind them (`externalName` only). */
const UNLINKED_ACT_NAMES = ["The Mildew Sisters", "Pawn Shop Choir"] as const;

const DOOR_HUMAN_NAMES = [
  "June Okafor",
  "Teddy Marsh",
  "Priya Natarajan",
  "Wes Calloway",
  "Marisol Vega",
  "Dani Kowalski",
] as const;

type LineupSlot =
  | { kind: "regular"; index: number }
  | { kind: "oneOff"; index: number }
  | { kind: "unlinked"; index: number };

const regular = (index: number): LineupSlot => ({ kind: "regular", index });
const oneOff = (index: number): LineupSlot => ({ kind: "oneOff", index });
const unlinked = (index: number): LineupSlot => ({ kind: "unlinked", index });

/**
 * Bills for the 14 shows in chronological order (0–4 the sparse 2025
 * Fridays, 5–13 the weekly Thursday run). Tallies: Rat Cathedral on 0, 3,
 * 5, 8, 11 (×5); Sister Furnace on 1, 4, 7, 10 (×4); Cold Stomach on 2, 5,
 * 9 (×3); each one-off exactly once; the two unlinked acts on 2 and 8.
 */
const LINEUPS: ReadonlyArray<ReadonlyArray<LineupSlot>> = [
  [regular(0), oneOff(0)],
  [regular(1), oneOff(1)],
  [regular(2), oneOff(2), unlinked(0)],
  [regular(0), oneOff(3)],
  [regular(1), oneOff(4)],
  [regular(0), regular(2)],
  [oneOff(5), oneOff(6)],
  [regular(1), oneOff(7)],
  [regular(0), unlinked(1)],
  [regular(2), oneOff(8)],
  [regular(1), oneOff(9)],
  [regular(0)],
  [oneOff(10)],
  [oneOff(11)],
];

// ── Deterministic per-row ids (prefix e1…, see ids.ts) ───────────────────

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const hex4 = (n: number) => n.toString(16).padStart(4, "0");
const eventIdFor = (show: number) =>
  `00000000-0000-4000-8000-e1e00000${hex2(show)}00`;
const ticketTypeIdFor = (show: number) =>
  `00000000-0000-4000-8000-e1ee0000${hex2(show)}00`;
const orderIdFor = (show: number) =>
  `00000000-0000-4000-8000-e1c00000${hex2(show)}00`;
const orderItemIdFor = (show: number, n: number) =>
  `00000000-0000-4000-8000-e1a0${hex2(show)}${hex4(n)}00`;
const ticketIdFor = (show: number, n: number) =>
  `00000000-0000-4000-8000-e1d0${hex2(show)}${hex4(n)}00`;
const eventHumanIdFor = (show: number, slot: number) =>
  `00000000-0000-4000-8000-e1b0${hex2(show)}${hex2(slot)}0000`;
const ticketScanIdFor = (show: number, n: number) =>
  `00000000-0000-4000-8000-e1f0${hex2(show)}${hex4(n)}00`;
const ticketCodeFor = (show: number, n: number) =>
  `FBH-${hex2(show).toUpperCase()}-${String(n).padStart(3, "0")}`;

// ── Local-date arithmetic (no luxon in apps/api's deps) ──────────────────

type LocalDate = { year: number; month: number; day: number };

const pickPart = (parts: Intl.DateTimeFormatPart[], type: string) =>
  Number(parts.find((p) => p.type === type)?.value);

/** The calendar date it is in `zone` at instant `at`. */
function localDateIn(zone: string, at: Date): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  return {
    year: pickPart(parts, "year"),
    month: pickPart(parts, "month"),
    day: pickPart(parts, "day"),
  };
}

/** `zone`'s UTC offset at `at`, in ms (positive east of Greenwich). */
function utcOffsetMs(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const asIfUtc = Date.UTC(
    pickPart(parts, "year"),
    pickPart(parts, "month") - 1,
    pickPart(parts, "day"),
    pickPart(parts, "hour"),
    pickPart(parts, "minute"),
    pickPart(parts, "second"),
  );
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Wall-clock `hour:00` on `date` in `zone`, as an instant. */
function zonedToUtc(date: LocalDate, hour: number, zone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0);
  // One correction pass is exact except across a DST jump at that very
  // hour; shows start at 20:00 and both US transitions happen at 02:00.
  return new Date(naive - utcOffsetMs(zone, new Date(naive)));
}

function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday, for a calendar date (zone-independent). */
const weekdayOf = (date: LocalDate) =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

const isoDate = (d: LocalDate) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/**
 * The `count` most recent Thursdays STRICTLY before today (in the venue's
 * zone), ascending. A show on today's date would not have ended yet, and
 * the track record is on an `endsAt` basis (FR-009).
 */
function recentThursdays(now: Date, count: number): LocalDate[] {
  const THURSDAY = 4;
  const today = localDateIn(ZONE, now);
  let back = (weekdayOf(today) - THURSDAY + 7) % 7;
  if (back === 0) back = 7;
  const latest = addDays(today, -back);
  return Array.from({ length: count }, (_, k) =>
    addDays(latest, -7 * (count - 1 - k)),
  );
}

// ── Plan ─────────────────────────────────────────────────────────────────

type ShowPlan = {
  index: number;
  eventId: string;
  date: LocalDate;
  startsAt: Date;
  endsAt: Date;
  title: string;
  lineup: ReadonlyArray<LineupSlot>;
  /** null = RSVP-only (no ticket type, no order, no tickets). */
  tickets: { scanned: number; unscanned: number } | null;
};

const slotName = (slot: LineupSlot): string => {
  switch (slot.kind) {
    case "regular":
      return REGULAR_ACTS[slot.index]!.name;
    case "oneOff":
      return ONE_OFF_ACTS[slot.index]!.name;
    case "unlinked":
      return UNLINKED_ACT_NAMES[slot.index]!;
  }
};

export function planFishbowlShows(now: Date): ShowPlan[] {
  const weekly = recentThursdays(now, WEEKLY_SHOW_COUNT);
  const dates: ReadonlyArray<{ date: LocalDate; weekly: boolean }> = [
    ...OLDER_SHOW_DATES.map((date) => ({ date, weekly: false })),
    ...weekly.map((date) => ({ date, weekly: true })),
  ];
  return dates.map(({ date, weekly: isWeekly }, index) => {
    const startsAt = zonedToUtc(date, SHOW_START_HOUR, ZONE);
    const lineup = LINEUPS[index]!;
    const names = lineup.map(slotName).join(" + ");
    const weeklyIndex = index - OLDER_SHOW_DATES.length;
    return {
      index,
      eventId: eventIdFor(index),
      date,
      startsAt,
      endsAt: new Date(startsAt.getTime() + SHOW_DURATION_MS),
      title: isWeekly ? `Fishbowl Thursdays: ${names}` : `House show: ${names}`,
      lineup,
      tickets: isWeekly
        ? {
            scanned: WEEKLY_SCANNED[weeklyIndex]!,
            unscanned: WEEKLY_UNSCANNED[weeklyIndex]!,
          }
        : null,
    };
  });
}

// ── Seeder ───────────────────────────────────────────────────────────────

export type SeedTrackRecordFixtureResult = {
  fishbowl: {
    placeId: string;
    pageSlug: string;
    eventIds: string[];
    ticketedEventIds: string[];
    rsvpEventIds: string[];
    scannedTickets: number;
    issuedTickets: number;
    /** The verified stored `PlaceStats` figures. */
    stats: TrackRecordStatsCheck;
  };
  cornerLot: { placeId: string; pageSlug: string };
};

export type TrackRecordStatsCheck = {
  showsHosted: number;
  firstShowAt: Date | null;
  lastShowAt: Date | null;
};

/** Hard cap on recompute batches, so the loop below can never spin. */
const RECOMPUTE_MAX_BATCHES = 20;

/**
 * Run the real `recalculatePlaceStats` use case until Fishbowl House's row is
 * written, then check it. The use case is batch-shaped (oldest stale first)
 * and cannot target one place, so other stale places are computed along the
 * way, as the scheduled job would. Safe to run on its own against an existing
 * database: it only writes `PlaceStats`.
 *
 * `opts.now` is stamped onto EVERY place the batch processes, not just this
 * one: a future `now` counts shows that have not happened and writes rows
 * dated in the future, and a `now` more than 30 days in the past leaves every
 * processed row stale again at once and can starve this place. Pass it only
 * on a database that holds no other place's history, or leave it at the wall
 * clock.
 *
 * Throws when the place fails to compute (its error is attached as `cause`),
 * or its row is missing, counts fewer shows than the fixture's ended shows in
 * the database, or is stale (its `lastShowAt` is before the last of them
 * ended). More shows than that is fine: the count covers every confirmed
 * past show at the place, not only fixture rows.
 */
export async function recomputeTrackRecordStats(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<TrackRecordStatsCheck> {
  const now = opts.now ?? new Date();
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock({ nowProvider: () => now });
  const placeId = FISHBOWL_HOUSE_PLACE.id;

  // The use case swallows per-place failures and reports them; keep each one
  // by place id so the cause is not lost.
  const failures = new Map<string, unknown>();
  const reportError = (
    err: unknown,
    ctx?: { extra?: Record<string, unknown> },
  ) => {
    const failedId = ctx?.extra?.placeId;
    if (typeof failedId === "string") failures.set(failedId, err);
  };

  let stoppedOnEmptyBatch = false;
  for (let batch = 0; batch < RECOMPUTE_MAX_BATCHES; batch++) {
    const run = await recalculatePlaceStats(
      { repos, clock, reportError },
      { batchSize: 500 },
    );
    if (run.failedPlaceIds.includes(placeId)) {
      throw new Error(
        `[track-record] recalculatePlaceStats failed for Fishbowl House (${placeId}).`,
        { cause: failures.get(placeId) },
      );
    }
    if (run.placeIds.includes(placeId)) break;
    if (run.placesProcessed === 0) {
      stoppedOnEmptyBatch = true;
      break;
    }
  }

  const others = [...failures.keys()].filter((id) => id !== placeId);
  if (others.length > 0) {
    console.warn(
      `  [track-record] recalculatePlaceStats failed for ${others.length} other place(s): ${others.join(", ")}`,
    );
  }

  // Measured against the fixture's shows as the database holds them, not the
  // plan for `now`: run on its own a week after the last seed, the plan has
  // already moved one Thursday on and the rows have not.
  const seeded = await prisma.event.findMany({
    where: {
      id: { in: planFishbowlShows(now).map((show) => show.eventId) },
      // Only what the use case counts: a show someone cancelled by hand, or
      // moved to another place, is not expected in the row.
      placeId,
      status: { in: ["PUBLISHED", "COMPLETED"] },
      endsAt: { lte: now },
    },
    select: { endsAt: true },
  });
  const expected = seeded.length;
  if (expected === 0) {
    throw new Error(
      `[track-record] Fishbowl House (${placeId}) has no ended fixture shows; seed them before recomputing its stats.`,
    );
  }
  const row = await prisma.placeStats.findUnique({
    where: { placeId },
    select: { showsHosted: true, firstShowAt: true, lastShowAt: true },
  });
  if (!row) {
    throw new Error(
      `[track-record] No PlaceStats row for Fishbowl House (${placeId}) after recalculatePlaceStats` +
        (stoppedOnEmptyBatch
          ? ` (it stopped on a batch that processed nothing; ${others.length} other place(s) failed)`
          : ` (${RECOMPUTE_MAX_BATCHES} batches did not reach it)`) +
        `; the track-record block would read "No shows on the books yet".`,
    );
  }
  if (row.showsHosted < expected) {
    throw new Error(
      `[track-record] PlaceStats.showsHosted for Fishbowl House is ${row.showsHosted}, expected at least ${expected} (one per ended fixture show).`,
    );
  }
  const lastSeededEnd = new Date(
    Math.max(...seeded.map((event) => event.endsAt.getTime())),
  );
  if (!row.lastShowAt || row.lastShowAt.getTime() < lastSeededEnd.getTime()) {
    throw new Error(
      `[track-record] PlaceStats for Fishbowl House is stale: lastShowAt is ${row.lastShowAt?.toISOString() ?? "null"}, expected at or after ${lastSeededEnd.toISOString()}.`,
    );
  }
  return {
    showsHosted: row.showsHosted,
    firstShowAt: row.firstShowAt,
    lastShowAt: row.lastShowAt,
  };
}

/**
 * Seed both venues, their pages, the acts, and Fishbowl House's 14 shows.
 * Requires the demo org (`DEMO_IDS.org`) to exist — it owns both places.
 */
export const seedTrackRecordFixture = async (
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<SeedTrackRecordFixtureResult> => {
  const now = opts.now ?? new Date();

  const org = await prisma.organization.findUnique({
    where: { id: ORG_ID },
    select: { id: true, name: true },
  });
  if (!org) {
    throw new Error(
      `[track-record] Demo org ${ORG_ID} not found — run the identity seed first.`,
    );
  }

  // ── Places (ownership + default space/calendar via the shared helper) ──
  await ensurePlaces(prisma, [FISHBOWL_HOUSE_PLACE, CORNER_LOT_PLACE]);

  // The flags `ensurePlaces` does not model. Set on every run so a re-seed
  // converges a hand-flipped toggle back to the fixture state.
  await prisma.place.update({
    where: { id: FISHBOWL_HOUSE_PLACE.id },
    data: {
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
      locationLabel: "East Nashville",
      // R3: a withheld-address place defaults performer reviews OFF.
      communityReviewsEnabled: false,
      acceptsCommunityListings: true,
      attendeeReviewsPublic: false,
    },
  });
  await prisma.place.update({
    where: { id: CORNER_LOT_PLACE.id },
    data: {
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
      communityReviewsEnabled: true,
      acceptsCommunityListings: false,
    },
  });

  // ── Pages (same routine as every other seeded venue) ──────────────────
  for (const [index, fixture] of [FISHBOWL_HOUSE_PLACE, CORNER_LOT_PLACE].entries()) {
    await seedPlaceEntityPage(
      prisma,
      {
        id: fixture.id,
        name: fixture.name,
        city: fixture.city,
        region: fixture.region,
        capacity: fixture.capacity ?? null,
      },
      index,
    );
  }

  // ── Acts: a Human + PUBLIC EntityPage each ────────────────────────────
  for (const act of [...REGULAR_ACTS, ...ONE_OFF_ACTS]) {
    await prisma.human.upsert({
      where: { id: act.id },
      update: { name: act.name, status: "ACTIVE" },
      create: { id: act.id, name: act.name, status: "ACTIVE", locale: "en" },
    });
    await prisma.entityPage.upsert({
      where: { ownerType_ownerId: { ownerType: "HUMAN", ownerId: act.id } },
      // Same posture as `upsertEntityPage`: never clobber a slug someone
      // customised; converge everything else.
      update: { displayName: act.name, bio: act.bio, visibility: "PUBLIC" },
      create: {
        ownerType: "HUMAN",
        ownerId: act.id,
        slug: act.slug,
        displayName: act.name,
        bio: act.bio,
        visibility: "PUBLIC",
      },
    });
  }

  // ── Ticket holders ────────────────────────────────────────────────────
  const doorHumanIds = DEMO_IDS.trackRecordDoorHumans;
  for (const [i, humanId] of doorHumanIds.entries()) {
    await prisma.human.upsert({
      where: { id: humanId },
      update: { name: DOOR_HUMAN_NAMES[i]!, status: "ACTIVE" },
      create: {
        id: humanId,
        name: DOOR_HUMAN_NAMES[i]!,
        status: "ACTIVE",
        locale: "en",
        source: "IMPORT",
      },
    });
  }

  // ── Shows ─────────────────────────────────────────────────────────────
  const defaultCalendar = await prisma.calendar.findFirst({
    where: { placeId: FISHBOWL_HOUSE_PLACE.id, isDefault: true },
    select: { id: true, primarySpaceId: true },
  });
  if (!defaultCalendar) {
    throw new Error(
      "[track-record] Fishbowl House has no default calendar — ensurePlaces should have minted one.",
    );
  }
  const category = await prisma.category.findUnique({
    where: { slug: "music" },
    select: { id: true },
  });

  const shows = planFishbowlShows(now);

  // ── The show's LOCATION: the house's public projection, never the house ──
  // (place-address-withholding D1.) An event at a withheld venue stores what
  // the app's own write path stores — the venue's public circle centre, its
  // area label, no postcode — so a re-seed cannot recreate true copies of the
  // address on 14 events. Read back from the Place row this run just wrote,
  // mapped the way the events adapter maps it, through the SAME projector.
  configureSeedObfuscationKey();
  const houseRow = await prisma.place.findUniqueOrThrow({
    where: { id: FISHBOWL_HOUSE_PLACE.id },
    select: {
      address: true,
      city: true,
      region: true,
      country: true,
      postcode: true,
      lat: true,
      lng: true,
      locationMode: true,
      locationRadiusMeters: true,
      locationLabel: true,
    },
  });
  const houseLocation = projectEventLocationAtPlace(
    {
      id: FISHBOWL_HOUSE_PLACE.id,
      locationMode: houseRow.locationMode,
      locationRadiusMeters: houseRow.locationRadiusMeters,
      locationLabel: houseRow.locationLabel,
      formattedAddress: houseRow.address,
      city: houseRow.city,
      region: houseRow.region,
      countryCode: houseRow.country,
      postalCode: houseRow.postcode,
      lat: houseRow.lat,
      lng: houseRow.lng,
    },
    { locationMode: "OBSCURED", locationRadiusMeters: 800 },
  );
  if (!houseLocation.withheld) {
    throw new Error(
      "[track-record] Fishbowl House must be withheld before its shows are seeded.",
    );
  }
  const repos = createPrismaRepos(prisma);
  const stripe = seedStripeFromEnv();

  let scannedTickets = 0;
  let issuedTickets = 0;

  await pMap(shows, 4, async (show) => {
    const ticketed = show.tickets !== null;
    const { slug, shortId } = generateEventSlug({
      eventId: show.eventId,
      orgId: org.id,
      humanId: null,
      eventTitle: show.title,
      startsAt: show.startsAt,
      timezone: ZONE,
      orgName: org.name,
      countryCode: "US",
      regionCode: "TN",
      cityOrRegionCode: "nashville",
      shortId: null,
    });
    const revealAt = new Date(show.startsAt.getTime() - DAY_MS);

    const eventData = {
      title: show.title,
      slug,
      shortId,
      orgId: org.id,
      humanId: null,
      placeId: FISHBOWL_HOUSE_PLACE.id,
      spaceId: defaultCalendar.primarySpaceId,
      calendarId: defaultCalendar.id,
      categoryId: category?.id ?? null,
      startsAt: show.startsAt,
      endsAt: show.endsAt,
      status: "PUBLISHED" as const,
      visibility: "PUBLIC" as const,
      attendanceMode: ticketed ? ("TICKETED" as const) : ("RSVP" as const),
      stewardship: "OWNED" as const,
      gateType: "NONE" as const,
      // A show at a withheld-address house is itself OBSCURED, with the
      // house's radius; reveal a day before, and mark the reveal fan-out as
      // already done so the address-reveal job never retro-spams 14 past
      // shows (the column's own backfill rule for past events).
      locationMode: houseLocation.privacy.locationMode,
      locationRadiusMeters: houseLocation.privacy.locationRadiusMeters,
      locationLabel: "East Nashville",
      addressRevealAt: revealAt,
      addressRevealPreset: "DAY_BEFORE" as const,
      addressRevealNotifiedAt: revealAt,
      // The public projection (see above): centre or null, area label, no
      // postcode, no fine geohash.
      addressText: houseLocation.columns.addressText,
      lat: houseLocation.columns.lat,
      lng: houseLocation.columns.lng,
      geohash6: houseLocation.columns.geohash6,
      geohash8: null,
      locality: houseLocation.columns.locality,
      region: houseLocation.columns.region,
      postalCode: houseLocation.columns.postalCode,
      countryCode: houseLocation.columns.countryCode ?? "US",
      regionCode: "TN",
      timezone: ZONE,
      publishedAt: new Date(show.startsAt.getTime() - 21 * DAY_MS),
      currency: ticketed ? "usd" : null,
      admissionTaxRateBps: ticketed ? NASHVILLE_ADMISSION_TAX_BPS : null,
      taxRateSource: ticketed ? "seed" : null,
      body: buildSeedEventBody(show.title, show.index) as Prisma.InputJsonValue,
      // Owner arm of `isVenueConfirmed` — nothing to stamp.
      venueConfirmedAt: null,
      venueConfirmedPlaceId: null,
      venueConfirmationWithdrawnAt: null,
    };

    await prisma.event.upsert({
      where: { id: show.eventId },
      update: eventData,
      create: { id: show.eventId, ...eventData },
    });

    // Lineup — PERFORMER rows, headliner first. Upsert by fixed id so the
    // unlinked (`humanId: null`) entries, which the (eventId, humanId)
    // unique cannot key, converge too.
    const keptEventHumanIds: string[] = [];
    for (const [slotIndex, slot] of show.lineup.entries()) {
      const id = eventHumanIdFor(show.index, slotIndex);
      keptEventHumanIds.push(id);
      const linked =
        slot.kind === "regular"
          ? REGULAR_ACTS[slot.index]!
          : slot.kind === "oneOff"
            ? ONE_OFF_ACTS[slot.index]!
            : null;
      const data = {
        eventId: show.eventId,
        humanId: linked ? linked.id : null,
        externalName: linked ? null : UNLINKED_ACT_NAMES[slot.index]!,
        externalUrl: null,
        role: "PERFORMER" as const,
        customRoleLabel: null,
        sortOrder: slotIndex,
      };
      await prisma.eventHuman.upsert({
        where: { id },
        update: data,
        create: { id, ...data },
      });
    }
    await prisma.eventHuman.deleteMany({
      where: { eventId: show.eventId, id: { notIn: keptEventHumanIds } },
    });

    if (!show.tickets) {
      // RSVP-only (R5): no ticket type, no order, no tickets — converge a
      // show that was ticketed in an earlier version of this plan.
      await prisma.ticket.deleteMany({ where: { eventId: show.eventId } });
      await prisma.order.deleteMany({ where: { eventId: show.eventId } });
      await prisma.ticketType.deleteMany({ where: { eventId: show.eventId } });
      return;
    }

    const issued = show.tickets.scanned + show.tickets.unscanned;
    const capacity = FISHBOWL_HOUSE_PLACE.capacity ?? 60;
    if (issued > capacity) {
      throw new Error(
        `[track-record] show ${show.index} issues ${issued} tickets against capacity ${capacity}; checkout would refuse it.`,
      );
    }
    const ticketTypeId = ticketTypeIdFor(show.index);
    const orderId = orderIdFor(show.index);
    // Bought three days out; a SUCCEEDED order, charged through Stripe when
    // the seed has a key (see below) — same posture as the attendee-review
    // fixture's order.
    const occurredAt = new Date(show.startsAt.getTime() - 3 * DAY_MS);

    await prisma.ticketType.upsert({
      where: { id: ticketTypeId },
      update: {
        eventId: show.eventId,
        name: "General Admission",
        priceCents: GA_PRICE_CENTS,
        capacity: FISHBOWL_HOUSE_PLACE.capacity ?? 60,
        status: "ACTIVE",
      },
      create: {
        id: ticketTypeId,
        eventId: show.eventId,
        name: "General Admission",
        priceCents: GA_PRICE_CENTS,
        capacity: FISHBOWL_HOUSE_PLACE.capacity ?? 60,
        status: "ACTIVE",
      },
    });

    // The terms a published event carries, then the cart checkout would
    // have priced: `issued` GA tickets in one order.
    await ensureSeedEventPrimaryTerms(prisma, repos, {
      id: show.eventId,
      orgId: org.id,
    });
    const priced = priceSeedOrder(
      await loadSeedEventPricing(prisma, repos, show.eventId),
      [{ ticketTypeId, qty: issued }],
      occurredAt,
    );

    // The charge. A re-run keeps the order's PaymentIntent while its money is
    // unchanged; a plan change that moves the money needs a new one.
    const existing = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        stripePaymentIntentId: true,
        amountGrossCents: true,
        feesPlatformCents: true,
        taxAmountCents: true,
      },
    });
    let stripePaymentIntentId: string | null =
      existing?.stripePaymentIntentId &&
      existing.amountGrossCents === priced.amountGrossCents &&
      existing.feesPlatformCents === priced.feesPlatformCents &&
      existing.taxAmountCents === priced.taxAmountCents
        ? existing.stripePaymentIntentId
        : null;
    if (
      !stripePaymentIntentId &&
      stripe &&
      priced.chargeCents >= STRIPE_MIN_AMOUNT_CENTS
    ) {
      stripePaymentIntentId = await createConfirmedPaymentIntent(stripe, {
        amountCents: priced.chargeCents,
        currency: "usd",
        metadata: { orderId, eventId: show.eventId, source: "track-record-seed" },
      });
    }
    // Keyless-seed exception: with no Stripe key a paid order has no PI.
    // A new PI means a new Stripe fee: clear the old one so the sweep reads it.
    const processorFeeReset =
      existing && existing.stripePaymentIntentId !== stripePaymentIntentId
        ? {
            processorFeeCents: null,
            processorFeeReadFailures: 0,
            processorFeeReadFailedAt: null,
          }
        : {};

    const orderData = {
      eventId: show.eventId,
      buyerHumanId: doorHumanIds[show.index % doorHumanIds.length]!,
      ...pricedOrderColumns(priced),
      currency: "usd",
      status: "SUCCEEDED" as const,
      occurredAt,
      stripePaymentIntentId,
      source: "PRIMARY" as const,
    };
    await prisma.order.upsert({
      where: { id: orderId },
      update: { ...orderData, ...processorFeeReset },
      create: { id: orderId, ...orderData },
    });
    // The upsert above RE-PRICES an existing order, so its tax lines follow.
    await writeSeedTaxLines(prisma, repos, orderId, priced, "replace");

    const keptOrderItemIds: string[] = [];
    const keptTicketIds: string[] = [];
    const keptScanIds: string[] = [];
    for (let n = 0; n < issued; n += 1) {
      const orderItemId = orderItemIdFor(show.index, n);
      const ticketId = ticketIdFor(show.index, n);
      keptOrderItemIds.push(orderItemId);
      keptTicketIds.push(ticketId);
      const scanned = n < show.tickets.scanned;
      // Doors at 20:00; the line moves at roughly one scan every 45 s.
      const scannedAt = scanned
        ? new Date(show.startsAt.getTime() + 20 * 60 * 1000 + n * 45 * 1000)
        : null;

      // One OrderItem per ticket (qty 1), as `seed/orders.ts` does —
      // `Ticket.orderItemId` is unique, so a qty-N line cannot back N tickets.
      const item = priced.items[n]!;
      const itemMoney = {
        unitPriceCents: item.unitPriceCents,
        amountCents: item.unitPriceCents,
        meta: item.meta,
      };
      await prisma.orderItem.upsert({
        where: { id: orderItemId },
        update: { orderId, ticketTypeId, kind: "ticket", qty: 1, ...itemMoney },
        create: {
          id: orderItemId,
          orderId,
          kind: "ticket",
          ticketTypeId,
          qty: 1,
          ...itemMoney,
        },
      });
      const ticketData = {
        eventId: show.eventId,
        orderId,
        orderItemId,
        ticketTypeId,
        ownerHumanId: doorHumanIds[n % doorHumanIds.length]!,
        code: ticketCodeFor(show.index, n),
        status: scanned ? ("SCANNED" as const) : ("VALID" as const),
        issuedAt: occurredAt,
        scannedAt,
      };
      await prisma.ticket.upsert({
        where: { id: ticketId },
        update: ticketData,
        create: { id: ticketId, ...ticketData },
      });
      // The door count reads the append-only scan log, not the ticket's own
      // stamp (R11 / FU-005): one ACCEPTED row per admitted ticket, scanned
      // by the dev-login admin (a member of the demo org). Deterministic id,
      // so a re-run converges instead of double-logging.
      if (scannedAt) {
        const scanData = {
          ticketId,
          eventId: show.eventId,
          actorHumanId: DEMO_IDS.human,
          scannedAt,
          outcome: "ACCEPTED" as const,
          message: null,
        };
        await prisma.ticketScan.upsert({
          where: { id: ticketScanIdFor(show.index, n) },
          update: scanData,
          create: { id: ticketScanIdFor(show.index, n), ...scanData },
        });
        keptScanIds.push(ticketScanIdFor(show.index, n));
      }
    }

    // Converge: drop rows an earlier, larger plan left behind.
    await prisma.ticketScan.deleteMany({
      where: { eventId: show.eventId, id: { notIn: keptScanIds } },
    });
    await prisma.ticket.deleteMany({
      where: { eventId: show.eventId, id: { notIn: keptTicketIds } },
    });
    await prisma.orderItem.deleteMany({
      where: { orderId, id: { notIn: keptOrderItemIds } },
    });
    await prisma.order.deleteMany({
      where: { eventId: show.eventId, id: { not: orderId } },
    });
    await prisma.ticketType.deleteMany({
      where: { eventId: show.eventId, id: { not: ticketTypeId } },
    });

    scannedTickets += show.tickets.scanned;
    issuedTickets += issued;
  });

  const stats = await recomputeTrackRecordStats(prisma, { now });

  const ticketedEventIds = shows.filter((s) => s.tickets).map((s) => s.eventId);
  const rsvpEventIds = shows.filter((s) => !s.tickets).map((s) => s.eventId);
  const fishbowlPageSlug = buildPageSlug(
    FISHBOWL_HOUSE_PLACE.name,
    FISHBOWL_HOUSE_PLACE.id,
  );
  const cornerLotPageSlug = buildPageSlug(
    CORNER_LOT_PLACE.name,
    CORNER_LOT_PLACE.id,
  );

  const first = shows[0]!;
  const last = shows[shows.length - 1]!;
  console.log(
    `  [track-record] Fishbowl House (/p/${fishbowlPageSlug}): ${shows.length} past shows ` +
      `${isoDate(first.date)} → ${isoDate(last.date)}, ${ticketedEventIds.length} ticketed ` +
      `(${scannedTickets} scanned of ${issuedTickets} issued), ${rsvpEventIds.length} RSVP-only; ` +
      `0 performer reviews; stored stats showsHosted=${stats.showsHosted}. Corner Lot (/p/${cornerLotPageSlug}): no shows.`,
  );

  return {
    fishbowl: {
      placeId: FISHBOWL_HOUSE_PLACE.id,
      pageSlug: fishbowlPageSlug,
      eventIds: shows.map((s) => s.eventId),
      ticketedEventIds,
      rsvpEventIds,
      scannedTickets,
      issuedTickets,
      stats,
    },
    cornerLot: { placeId: CORNER_LOT_PLACE.id, pageSlug: cornerLotPageSlug },
  };
};

// ── Standalone entry ─────────────────────────────────────────────────────
//
//   pnpm -F api exec tsx src/scripts/seed/track-record-fixture.ts
//
// Deliberately NOT `import "dotenv/config"`: that reads `apps/api/.env`
// (which points at a remote database) when run from that directory. The
// repo-root `.env.local` is the local dev database and is loaded with
// override; anything that is not localhost is refused unless
// THC_SEED_ALLOW_REMOTE_DB=true, the same escape hatch `seed-data.ts` has.

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

/**
 * Key the obfuscation circles the way the API does (HKDF over
 * `UNSUBSCRIBE_SECRET`, see `apps/api/src/lib/dep.ts`), so seeded centres are
 * the ones the running app would have stored. The secret lives in
 * `apps/api/.env.local`, which the standalone run does not load — only that
 * one key is read from it. No secret → nothing is configured and the circles
 * fail CLOSED (the shows are stored with no coordinates; the next save or
 * venue privacy change fills them in). Never configured keyless: inside a
 * process that already holds the key this must not clobber it.
 */
function configureSeedObfuscationKey(): void {
  let secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) {
    const apiEnv = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../.env.local",
    );
    if (existsSync(apiEnv)) {
      secret = parseDotenv(readFileSync(apiEnv)).UNSUBSCRIBE_SECRET;
    }
  }
  if (secret) configureLocationObfuscation({ secret });
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rootEnvLocal = path.resolve(here, "../../../../../.env.local");
  dotenvConfig({ path: rootEnvLocal, override: true });

  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(`[track-record] DATABASE_URL not set (looked in ${rootEnvLocal}).`);
  }
  const hostname = new URL(raw).hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (!isLocal && process.env.THC_SEED_ALLOW_REMOTE_DB !== "true") {
    throw new Error(
      `[track-record] Refusing to seed a non-local database (${hostname}). Set THC_SEED_ALLOW_REMOTE_DB=true to override.`,
    );
  }
  console.log(`[track-record] Seeding against ${hostname}`);

  const { getPrisma } = await import("@th/db");
  const prisma = getPrisma();
  try {
    const result = await seedTrackRecordFixture(prisma);
    console.log(
      `[track-record] Done. Fishbowl House place ${result.fishbowl.placeId}; Corner Lot place ${result.cornerLot.placeId}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
