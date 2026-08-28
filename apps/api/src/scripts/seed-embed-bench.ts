/**
 * Embed test-bench seed: keeps https://ithasfire-embed-test.netlify.app
 * working against whatever DB it runs on (local docker or the LIVE dev Neon
 * DB), so the bench's grid/calendar/single-event/booking sections always have
 * content. Surgical by design — upserts only, fixed bench IDs, never wipes,
 * never touches rows it didn't create.
 *
 * Ensures, idempotently:
 *   • Three future-dated PUBLISHED events on the `dev-qa-collective` org
 *     (created via the REAL saveEventForOrg/upsertTicketType/publishEvent use
 *     cases, cloning category/location/payee wiring from the org's newest
 *     already-published event). On re-runs, bench events whose dates have
 *     passed are rolled forward to the same relative offsets (evergreen).
 *   • Embed allowlist rows for `ithasfire-embed-test.netlify.app`:
 *     org-subject (list/calendar, with `viewToggle` on so the bench exercises
 *     the viewer-side List/Calendar switcher) and event-subject (bench paid
 *     event).
 *   • The booking fixtures (E2E venue + its place-subject embed) IF missing —
 *     existing rows are left byte-for-byte untouched.
 *
 * Aborts (rather than inventing data) when `dev-qa-collective` or a reference
 * published event is missing — run the dev checkout seed first in that case.
 *
 * Run:
 *   DATABASE_URL=… pnpm -F api exec tsx src/scripts/seed-embed-bench.ts
 */
import "dotenv/config";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { saveEventForOrg, publishEvent } from "@th/core/use-cases/events";
import { upsertTicketType } from "@th/core/use-cases/ticket-types/upsert-ticket-type";
import { buildSearchIndex } from "@th/core/use-cases/search/build-search-index";
import { MultiIndexPostgresAdapter } from "@th/adapters/search/multi-index-postgres-adapter";

import { ensureSeedPrimaryPayoutLine } from "./seed/finance.js";
import { createInMemoryIdempotency } from "./seed/utils.js";

const ORG_SLUG = "dev-qa-collective";
const BENCH_DOMAIN = "ithasfire-embed-test.netlify.app";

// Fixed IDs the bench page references — keep in sync with
// ~/Projects/ithasfire-embed-test/index.html.
const ORG_EMBED_ID = "adf7aaf0-141f-405a-9e27-618e9df42c5c";
const EVENT_EMBED_ID = "e2e20000-0000-4000-8000-00000000e002";
const BOOKING_EMBED_ID = "e2e10000-0000-4000-8000-00000000e001";
const BOOKING_PLACE_ID = "e2e10000-0000-4000-8000-00000000a001";
const BOOKING_PLACE_NAME = "E2E-BOOKING-TEST Venue (Netlify)";

// Mirrors SEED_HOST_ATTESTATION in seed/events.ts (publish precondition).
const BENCH_ATTESTATION = {
  legalRightToHost: true,
  zoningAndNoiseCompliance: true,
  alcoholCompliance: true,
  taxResponsibility: true,
  organizerFaqReviewed: true,
};

type BenchEventFixture = {
  slug: string;
  title: string;
  daysFromNow: number;
  durationHours: number;
  tickets: { name: string; priceCents: number; capacity: number }[];
};

const BENCH_EVENTS: BenchEventFixture[] = [
  {
    slug: "bench-free-future",
    title: "Bench — Free Future Event",
    daysFromNow: 7,
    durationHours: 3,
    tickets: [{ name: "Free Entry", priceCents: 0, capacity: 100 }],
  },
  {
    slug: "bench-paid-future",
    title: "Bench — Paid Future Event",
    daysFromNow: 14,
    durationHours: 3,
    tickets: [{ name: "General Admission", priceCents: 2500, capacity: 100 }],
  },
  {
    slug: "bench-next-month",
    title: "Bench — Next Month Event",
    daysFromNow: 40,
    durationHours: 3,
    tickets: [{ name: "General Admission", priceCents: 1500, capacity: 100 }],
  },
];

// 20:00 local, +N days — matches the seed convention of evening events and
// keeps re-runs deterministic relative to "today".
function benchDates(daysFromNow: number, durationHours: number) {
  const startsAt = new Date();
  startsAt.setDate(startsAt.getDate() + daysFromNow);
  startsAt.setHours(20, 0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + durationHours * 60 * 60 * 1000);
  return { startsAt, endsAt };
}

type Summary = { item: string; id: string; outcome: string }[];

async function main() {
  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const deps = {
    repos,
    clock: createSystemClock(),
    idempotency: createInMemoryIdempotency(),
  };
  const summary: Summary = [];

  // ── Org + actor + reference event (abort rather than invent) ─────────────
  const org = await prisma.organization.findUnique({
    where: { slug: ORG_SLUG },
    select: { id: true },
  });
  if (!org) {
    throw new Error(
      `Org "${ORG_SLUG}" not found — run the dev checkout seed first; this script never creates orgs.`,
    );
  }

  const actor = await prisma.orgMember.findFirst({
    where: { orgId: org.id, role: { in: ["OWNER", "ADMIN"] } },
    select: { humanId: true },
  });
  if (!actor) {
    throw new Error(`Org "${ORG_SLUG}" has no OWNER/ADMIN member to act as.`);
  }

  // Newest published event = proven-publishable wiring to clone (category,
  // location, payee). The bench's own events are excluded so re-runs don't
  // clone from themselves.
  const reference = await prisma.event.findFirst({
    where: {
      orgId: org.id,
      status: "PUBLISHED",
      slug: { notIn: BENCH_EVENTS.map((f) => f.slug) },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      categoryId: true,
      countryCode: true,
      placeId: true,
      addressText: true,
      lat: true,
      lng: true,
      payoutTermsId: true,
    },
  });
  if (!reference) {
    throw new Error(
      `Org "${ORG_SLUG}" has no published non-bench event to clone config from.`,
    );
  }
  const referencePayeeLine = reference.payoutTermsId
    ? await prisma.payoutTermsLine.findFirst({
        where: { payoutTermsId: reference.payoutTermsId },
        select: { payeeId: true },
      })
    : null;

  // ── Bench events ─────────────────────────────────────────────────────────
  for (const fixture of BENCH_EVENTS) {
    const { startsAt, endsAt } = benchDates(
      fixture.daysFromNow,
      fixture.durationHours,
    );

    const existing = await prisma.event.findFirst({
      where: { slug: fixture.slug, orgId: org.id },
      select: { id: true, status: true, startsAt: true },
    });

    // A bench event someone cancelled/completed holds the unique slug; adopting
    // or recreating it would either resurrect a deliberate cancellation or
    // crash on the slug collision. Skip loudly instead.
    if (
      existing &&
      existing.status !== "PUBLISHED" &&
      existing.status !== "DRAFT"
    ) {
      summary.push({
        item: fixture.title,
        id: existing.id,
        outcome: `skipped (${existing.status})`,
      });
      continue;
    }

    if (existing && existing.status === "PUBLISHED") {
      if (existing.startsAt && existing.startsAt.getTime() > Date.now()) {
        summary.push({
          item: fixture.title,
          id: existing.id,
          outcome: "existing",
        });
      } else {
        // Evergreen: roll a lapsed bench event's dates forward. Dates only —
        // everything else on the row is left as-is.
        await prisma.event.update({
          where: { id: existing.id },
          data: { startsAt, endsAt },
        });
        summary.push({
          item: fixture.title,
          id: existing.id,
          outcome: "dates rolled forward",
        });
      }
      continue;
    }

    // Missing (or a DRAFT leftover from a partial run) → full use-case flow.
    const draft = await saveEventForOrg(deps, {
      eventId: existing?.status === "DRAFT" ? existing.id : undefined,
      orgId: org.id,
      actorHumanId: actor.humanId,
      title: fixture.title,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      location: reference.placeId
        ? { placeId: reference.placeId }
        : {
            addressText: reference.addressText ?? "Nashville, TN",
            lat: reference.lat ?? 36.16,
            lng: reference.lng ?? -86.78,
          },
      clientKey: `seed-embed-bench:${fixture.slug}`,
    });

    await prisma.event.update({
      where: { id: draft.eventId },
      data: {
        slug: fixture.slug,
        categoryId: reference.categoryId,
        countryCode: reference.countryCode ?? "US",
      },
    });

    // saveEventForOrg snapshots the org's default payout terms; if the org has
    // none configured, wire the reference event's payee in (same fallback
    // shape as seed/events.ts).
    const forTerms = await prisma.event.findUnique({
      where: { id: draft.eventId },
      select: { payoutTermsId: true },
    });
    let termsId = forTerms?.payoutTermsId ?? null;
    if (!termsId) {
      if (!referencePayeeLine) {
        throw new Error(
          `No org default payout terms and no reference payee line — cannot publish "${fixture.slug}".`,
        );
      }
      const created = await prisma.payoutTerms.create({
        data: {
          kind: "PRIMARY",
          status: "ACTIVE",
          settlementCurrency: "usd",
          version: 1,
          isDefault: false,
        },
        select: { id: true },
      });
      termsId = created.id;
      await prisma.event.update({
        where: { id: draft.eventId },
        data: { payoutTermsId: termsId },
      });
      await ensureSeedPrimaryPayoutLine(
        prisma,
        termsId,
        referencePayeeLine.payeeId,
      );
    }

    for (const ticket of fixture.tickets) {
      await upsertTicketType(deps, {
        actorHumanId: actor.humanId,
        eventId: draft.eventId,
        name: ticket.name,
        priceCents: ticket.priceCents,
        capacity: ticket.capacity,
        clientKey: `seed-embed-bench-tt:${fixture.slug}:${ticket.name}`,
      });
    }

    await publishEvent(deps, {
      actorHumanId: actor.humanId,
      eventId: draft.eventId,
      clientKey: `seed-embed-bench-publish:${fixture.slug}`,
      ipAddress: null,
      userAgent: "seed/embed-bench",
      attestation: BENCH_ATTESTATION,
    });

    summary.push({
      item: fixture.title,
      id: draft.eventId,
      outcome: "created + published",
    });
  }

  // ── Search index ─────────────────────────────────────────────────────────
  // The owner-subject widgets (grid/calendar) are fully search-served, so a
  // published-but-unindexed event is invisible to them. publishEvent only
  // indexes when handed a search port; index the bench events explicitly on
  // EVERY run (idempotent upsert) so the bench never depends on the nightly
  // full reindex. Postgres backend — same DB, no external search creds needed.
  const benchEventIds = (
    await prisma.event.findMany({
      where: {
        slug: { in: BENCH_EVENTS.map((f) => f.slug) },
        orgId: org.id,
        status: "PUBLISHED",
      },
      select: { id: true },
    })
  ).map((e) => e.id);
  if (benchEventIds.length > 0) {
    await buildSearchIndex(
      {
        repos,
        search: new MultiIndexPostgresAdapter({ prisma }),
        clock: createSystemClock(),
      },
      { eventIds: benchEventIds },
    );
    summary.push({
      item: `search index (${benchEventIds.length} events)`,
      id: "-",
      outcome: "upserted",
    });
  }

  // ── Embed allowlist rows ─────────────────────────────────────────────────
  // Upsert on the (subjectType, subjectId, domain) unique — an existing row
  // (whatever its id) keeps its id and every field this script doesn't name.
  //
  // `viewToggle` is the ONE field this seed asserts on the org row: the bench
  // page's viewer-toggle section needs the in-widget List/Calendar switcher
  // rendered, and that only happens when the row has it on (FR-010). It is a
  // converged assertion, not a create-only default — a re-run after someone
  // flipped it off in the admin UI puts the bench back. `defaultView` is
  // deliberately NOT written: the bench proves that a bare /embed/<id> follows
  // the stored default, which is "list" via the column default, and leaving it
  // unset also lets a manual admin change survive a re-run.
  const orgEmbed = await prisma.embed.upsert({
    where: {
      subjectType_subjectId_domain: {
        subjectType: "organization",
        subjectId: org.id,
        domain: BENCH_DOMAIN,
      },
    },
    update: { viewToggle: true },
    create: {
      id: ORG_EMBED_ID,
      subjectType: "organization",
      subjectId: org.id,
      domain: BENCH_DOMAIN,
      status: "ACTIVE",
      viewToggle: true,
    },
    select: { id: true },
  });
  summary.push({
    item: "org embed (grid/calendar, viewToggle on)",
    id: orgEmbed.id,
    outcome: orgEmbed.id === ORG_EMBED_ID ? "ensured" : "existing (kept id)",
  });

  const paidBench = await prisma.event.findUnique({
    where: { slug: "bench-paid-future" },
    select: { id: true },
  });
  if (paidBench) {
    const eventEmbed = await prisma.embed.upsert({
      where: {
        subjectType_subjectId_domain: {
          subjectType: "event",
          subjectId: paidBench.id,
          domain: BENCH_DOMAIN,
        },
      },
      update: {},
      create: {
        id: EVENT_EMBED_ID,
        subjectType: "event",
        subjectId: paidBench.id,
        domain: BENCH_DOMAIN,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    summary.push({
      item: "event embed (bench paid)",
      id: eventEmbed.id,
      outcome: "ensured",
    });
  }

  // ── Booking fixtures (create-if-missing ONLY — dev rows stay untouched) ──
  let place = await prisma.place.findFirst({
    where: { name: BOOKING_PLACE_NAME },
    select: { id: true },
  });
  if (!place) {
    place = await prisma.place.create({
      data: {
        id: BOOKING_PLACE_ID,
        name: BOOKING_PLACE_NAME,
        address: "100 Bench St, Nashville, TN",
        lat: 36.16,
        lng: -86.78,
        verification: "VERIFIED",
        acceptsBookingRequests: true,
      },
      select: { id: true },
    });
    await prisma.placeOwnership.create({
      data: {
        placeId: place.id,
        ownerType: "ORGANIZATION",
        ownerId: org.id,
        verified: true,
      },
    });
    summary.push({ item: "booking place", id: place.id, outcome: "created" });
  } else {
    summary.push({ item: "booking place", id: place.id, outcome: "existing" });
  }

  const bookingEmbed = await prisma.embed.upsert({
    where: {
      subjectType_subjectId_domain: {
        subjectType: "place",
        subjectId: place.id,
        domain: BENCH_DOMAIN,
      },
    },
    update: {},
    create: {
      id: BOOKING_EMBED_ID,
      subjectType: "place",
      subjectId: place.id,
      domain: BENCH_DOMAIN,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  summary.push({
    item: "booking embed",
    id: bookingEmbed.id,
    outcome: "ensured",
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\nseed-embed-bench summary:");
  for (const row of summary) {
    console.log(`  ${row.outcome.padEnd(22)} ${row.item}  (${row.id})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("seed-embed-bench failed:", err);
    process.exit(1);
  });
