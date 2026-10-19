/**
 * QA seed: fills the local dev moderation queues so moderation can be demoed
 * on a working queue instead of empty states.
 *
 *   • Entity reports        → /platform/reports       (PENDING + RESOLVED + DISMISSED)
 *   • Flagged place reviews → /platform/reviews       (3 flagged, 1 flagged then hidden)
 *   • Moderator applications→ /moderate/applications  (3 PENDING, 1 APPROVED, 1 REJECTED)
 *   • Category requests     → /platform/categories    (3 PENDING, 1 REJECTED)
 *   • Image moderation      → /moderate/images, /platform/image-moderation
 *                             (4 FLAGGED at varied severities incl. one degraded,
 *                              1 auto-APPROVED, 1 FLAGGED then cleared by a human)
 *
 * Every domain row goes through the REAL use case (submitEntityReport,
 * reviewEntityReport, flagPlaceReview, hidePlaceReview, applyToBeModerator,
 * reviewModeratorApplication, requestCategoryOption, reviewCategoryRequest,
 * enqueueImageModeration, moderateImage, reviewFlaggedImage), so the audit
 * rows, staff notifications, dedupe and status CAS all behave as in
 * production. The only stand-ins are ports with no local backend: the image
 * moderation provider (a stub that returns a scripted verdict per image) and
 * object storage (a stub that returns placeholder bytes for the provider).
 * Prisma is used directly only for READS that make the seed idempotent.
 *
 * Depends on: `pnpm seed:dev` (places, orgs, humans, events, event covers) and
 * `pnpm seed:reviews-qa` (the 12 SOMA Warehouse place reviews). Missing
 * fixtures are reported and skipped, not invented.
 *
 * Side effect worth knowing: a FLAGGED image record hides that event's cover
 * on public surfaces until a moderator approves it. That is the real
 * behaviour; the covers picked are the ones listed in IMAGE_FIXTURES.
 * Approving a moderator application grants the COMMUNITY_MODERATOR role.
 *
 * Run (LOCAL docker DB only — the script refuses any non-local host):
 *   pnpm -F api run seed:moderation-qa
 *
 * Idempotent: each row has a deterministic key (report: reporter + subject;
 * application: applicant; category request: slug; review flag: review id;
 * image: storage key). A re-run finds the existing row and only drives it
 * forward to its target state, so nothing is duplicated.
 */
import "dotenv/config";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createDbAuthZAdapter } from "@th/adapters/authz/db-authz-adapter";
import { createProfanityContentFilterAdapter } from "@th/adapters/content-filter";
import { requireStaffSecondFactorBypass } from "./lib/staff-second-factor-bypass";
import {
  submitEntityReport,
  reviewEntityReport,
} from "@th/core/use-cases/entity-reports";
import {
  applyToBeModerator,
  reviewModeratorApplication,
} from "@th/core/use-cases/community";
import {
  requestCategoryOption,
  reviewCategoryRequest,
} from "@th/core/use-cases/categories";
import {
  flagPlaceReview,
  hidePlaceReview,
} from "@th/core/use-cases/place-reviews";
import {
  enqueueImageModeration,
  moderateImage,
  reviewFlaggedImage,
  type ModerateImageConfig,
} from "@th/core/use-cases/moderation";
import type { LoggerPort } from "@th/ports/logger";
import type {
  ImageModerationResult,
  ModerationPort,
} from "@th/ports/moderation";
import type { ImageModerationCategoryScore } from "@th/types/repos/image-moderation-records";

// ─────────────────────────────────────────────────────────────────────────────
// Safety: LOCAL DOCKER ONLY (same guard as seed-reviews-qa.ts)
// ─────────────────────────────────────────────────────────────────────────────
//
// apps/api/.env points DATABASE_URL at the Neon dev CLOUD database. `dotenv`
// does not override an already-set process env var, so the package script's
// `DATABASE_URL=...localhost...` prefix wins — but assert the host rather
// than trust that precedence.

function assertLocalDatabase(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL is not set. Run via `pnpm -F api run seed:moderation-qa` (it pins the local docker URL).",
    );
  }
  const host = new URL(raw).hostname;
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db"]);
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL host is "${host}", not a local docker host.\n` +
        `This QA seed only ever writes to the local docker postgres. Re-run with:\n` +
        `  pnpm -F api run seed:moderation-qa`,
    );
  }
  return host;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeded identities (apps/api/src/scripts/seed/ids.ts, identity.ts, orders.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** admin@ithasfire.com / Dev-Login-2026! — platform ADMIN, the only staff human. */
const ADMIN = "00000000-0000-4000-8000-00000000d005";
// Additional humans (password demo1234).
const ALEX_RIVERA = "00000000-0000-4000-8000-00000000d020"; // OWNER austin-live-events
const JAMIE_CHEN = "00000000-0000-4000-8000-00000000d021"; // OWNER bay-area-festivals
const SAM_OKONKWO = "00000000-0000-4000-8000-00000000d022";
const TAYLOR_MORGAN = "00000000-0000-4000-8000-00000000d023";
const MORGAN_KOWALSKI = "00000000-0000-4000-8000-00000000d024"; // OWNER chicago-underground
const DIEGO_ALVAREZ = "00000000-0000-4000-8000-00000000d025";
const DEMO_HOST = "00000000-0000-4000-8000-00000000d004"; // OWNER demo org
// Seeded buyers / attendees.
const OLIVIA = "00000000-0000-4000-8000-0000d1000000";
const LIAM = "00000000-0000-4000-8000-0000d1010000";
const SOPHIA = "00000000-0000-4000-8000-0000d1020000";
const NOAH = "00000000-0000-4000-8000-0000d1030000";
const EMMA = "00000000-0000-4000-8000-0000d1040000";
const ETHAN = "00000000-0000-4000-8000-0000d1050000";
const MASON = "00000000-0000-4000-8000-0000d1070000";

// Places / orgs.
const PLACE = {
  fillmore: "00000000-0000-4000-8000-00000000d032",
  redRocks: "00000000-0000-4000-8000-00000000d034",
  somaWarehouse: "00000000-0000-4000-8000-00000000d035",
  theChapel: "00000000-0000-4000-8000-00000000d03a",
  fishbowlHouse: "00000000-0000-4000-8000-00000000e100",
  cornerLot: "00000000-0000-4000-8000-00000000e101",
} as const;
const ORG = {
  austinLive: "00000000-0000-4000-8000-00000000d010",
  chicagoUnderground: "00000000-0000-4000-8000-00000000d016",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type ReportFixture = {
  label: string;
  reporter: string;
  subjectType: "PLACE" | "HUMAN" | "ORGANIZATION";
  subjectId: string;
  reason:
    | "CLOSED_OR_GONE"
    | "INCORRECT_INFO"
    | "DUPLICATE"
    | "INAPPROPRIATE"
    | "SPAM"
    | "IMPERSONATION"
    | "OTHER";
  details?: string;
  decide?: { verdict: "RESOLVED" | "DISMISSED"; note: string };
};

const REPORTS: ReportFixture[] = [
  {
    label: "The Chapel (SF) — closed",
    reporter: EMMA,
    subjectType: "PLACE",
    subjectId: PLACE.theChapel,
    reason: "CLOSED_OR_GONE",
    details:
      "Walked past on Saturday and the marquee is blank, box office number goes to a disconnected line. Pretty sure they stopped booking shows after the summer.",
  },
  {
    label: "Corner Lot (Nashville) — wrong address",
    reporter: LIAM,
    subjectType: "PLACE",
    subjectId: PLACE.cornerLot,
    reason: "INCORRECT_INFO",
    details:
      "The pin is a block off. The lot is behind the laundromat on Gallatin Ave, not on the corner the map shows. Two of us walked to the wrong spot.",
  },
  {
    label: "Fishbowl House (Nashville) — duplicate",
    reporter: NOAH,
    subjectType: "PLACE",
    subjectId: PLACE.fishbowlHouse,
    reason: "DUPLICATE",
    details:
      "This is the same house venue as 'The Fishbowl' that the hosts posted under their own page. Same address, same Thursday shows.",
  },
  {
    label: "Chicago Underground Collective — impersonation",
    reporter: SOPHIA,
    subjectType: "ORGANIZATION",
    subjectId: ORG.chicagoUnderground,
    reason: "IMPERSONATION",
    details:
      "The collective that actually runs the Logan Square DIY nights says this page isn't theirs. Their Instagram links somewhere else.",
  },
  {
    label: "Morgan Kowalski — spam profile",
    reporter: OLIVIA,
    subjectType: "HUMAN",
    subjectId: MORGAN_KOWALSKI,
    reason: "SPAM",
    details:
      "Profile keeps messaging people with a link to a resale site charging triple face value.",
  },
  {
    label: "Red Rocks — capacity wrong (RESOLVED)",
    reporter: DIEGO_ALVAREZ,
    subjectType: "PLACE",
    subjectId: PLACE.redRocks,
    reason: "INCORRECT_INFO",
    details:
      "Capacity on the page is way off. Red Rocks holds about 9,500, the listing says a few hundred.",
    decide: {
      verdict: "RESOLVED",
      note: "Checked against the venue's site; capacity corrected on the place record.",
    },
  },
  {
    label: "SOMA Warehouse — inappropriate photo (RESOLVED)",
    reporter: ETHAN,
    subjectType: "PLACE",
    subjectId: PLACE.somaWarehouse,
    reason: "INAPPROPRIATE",
    details:
      "One of the gallery photos on the page is a flyer with a slur written on it.",
    decide: {
      verdict: "RESOLVED",
      note: "Removed the gallery photo and messaged the page owner.",
    },
  },
  {
    label: "The Fillmore — reported as spam (DISMISSED)",
    reporter: MASON,
    subjectType: "PLACE",
    subjectId: PLACE.fillmore,
    reason: "SPAM",
    details: "Too many events posted here, feels like spam.",
    decide: {
      verdict: "DISMISSED",
      note: "A busy room, not spam. Every listing matches the venue's own calendar.",
    },
  },
  {
    label: "Austin Live Events — billing complaint (DISMISSED)",
    reporter: TAYLOR_MORGAN,
    subjectType: "ORGANIZATION",
    subjectId: ORG.austinLive,
    reason: "OTHER",
    details:
      "I was charged twice for the comedy night and nobody has answered my email.",
    decide: {
      verdict: "DISMISSED",
      note: "Not a listing problem. Routed to support as a billing ticket.",
    },
  },
];

/** Place reviews from seed-reviews-qa, keyed by their anonymousEmail. */
type ReviewFlagFixture = {
  anonymousEmail: string;
  flagger: string;
  flagReason: string;
  hide?: boolean;
};

const REVIEW_FLAGS: ReviewFlagFixture[] = [
  {
    anonymousEmail: "priya.raman@example.com",
    flagger: JAMIE_CHEN,
    flagReason:
      "Says we cut the bar split, but we have the signed deal memo showing the agreed terms. We think this is a retaliation review after a booking dispute.",
  },
  {
    anonymousEmail: "rue.halvorsen@example.com",
    flagger: JAMIE_CHEN,
    flagReason:
      "Implies our door staff skimmed the count. That's an accusation about named staff; please check it.",
  },
  {
    anonymousEmail: "elena.duarte@example.com",
    flagger: SAM_OKONKWO,
    flagReason:
      "I think this review is about The Chapel, not SOMA Warehouse. The details match the other room.",
  },
  {
    anonymousEmail: "wren.kowalczyk@example.com",
    flagger: JAMIE_CHEN,
    flagReason:
      "Posted twice from the same tour; this is a duplicate of an earlier review.",
    hide: true,
  },
];

type ApplicationFixture = {
  applicant: string;
  statement: string;
  decide?: { decision: "APPROVE" | "REJECT"; note: string };
};

const APPLICATIONS: ApplicationFixture[] = [
  {
    applicant: TAYLOR_MORGAN,
    statement:
      "I run the East Nashville songwriter round and keep a spreadsheet of every house show in the neighborhood. Happy to keep the community listings accurate.",
  },
  {
    applicant: LIAM,
    statement:
      "I go to three or four shows a week in the Mission and already fix wrong times in our group chat. I'd like to do it here.",
  },
  {
    applicant: EMMA,
    statement:
      "Former box office manager. I know what a real listing looks like and can spot the fake ones.",
  },
  {
    applicant: SAM_OKONKWO,
    statement:
      "Volunteer at two Oakland DIY spaces. I've been suggesting edits for months and would like to review them too.",
    decide: {
      decision: "APPROVE",
      note: "Long history of accurate edit suggestions. Welcome aboard.",
    },
  },
  {
    applicant: ETHAN,
    statement: "I want to promote my own nights.",
    decide: {
      decision: "REJECT",
      note: "Moderators can't review their own listings. Thanks for applying.",
    },
  },
];

type CategoryRequestFixture = {
  requester: string;
  /** Upcoming event the requester can edit (title lookup). */
  eventTitle: string;
  name: string;
  note: string;
  reject?: string;
};

const CATEGORY_REQUESTS: CategoryRequestFixture[] = [
  {
    requester: ALEX_RIVERA,
    eventTitle: "Sixth Street Comedy Night",
    name: "Comedy",
    note: "Stand-up nights don't fit under Arts & Culture or Nightlife, and we run one every other week.",
  },
  {
    requester: ALEX_RIVERA,
    eventTitle: "Austin Tech Lecture Series",
    name: "Talks & Lectures",
    note: "A monthly lecture series. Conference & Workshop reads like a paid all-day event.",
  },
  {
    requester: DEMO_HOST,
    eventTitle: "Lower East Side Charity Fundraiser",
    name: "Charity & Fundraisers",
    note: "Benefit shows where proceeds go to a cause. People search for these specifically.",
  },
  {
    requester: MORGAN_KOWALSKI,
    eventTitle: "West Loop Wine Tasting",
    name: "Wine Tasting",
    note: "Our tastings get lost among the restaurant events.",
    reject:
      "Covered by Food & Drink. A category this narrow would sit empty most weeks.",
  },
];

type ImageFixture = {
  /** event_images.key of a seeded cover (`pnpm seed:dev`). */
  storageKey: string;
  label: string;
  verdict:
    | { kind: "scores"; categories: ImageModerationCategoryScore[] }
    | { kind: "degraded" };
  /** Human decision after the provider holds it. */
  clear?: string;
};

const IMAGE_FIXTURES: ImageFixture[] = [
  {
    storageKey: "demo-cover-18",
    label: "Logan Square DIY Punk Show — VIOLENCE 6",
    verdict: {
      kind: "scores",
      categories: [
        { category: "VIOLENCE", severity: 6 },
        { category: "SEXUAL", severity: 0 },
        { category: "HATE", severity: 0 },
        { category: "SELF_HARM", severity: 0 },
      ],
    },
  },
  {
    storageKey: "demo-cover-22",
    label: "VIP Members Only Night — SEXUAL 6",
    verdict: {
      kind: "scores",
      categories: [
        { category: "SEXUAL", severity: 6 },
        { category: "VIOLENCE", severity: 0 },
        { category: "HATE", severity: 0 },
        { category: "SELF_HARM", severity: 0 },
      ],
    },
  },
  {
    storageKey: "demo-cover-15",
    label: "Sixth Street Comedy Night — HATE 2",
    verdict: {
      kind: "scores",
      categories: [
        { category: "HATE", severity: 2 },
        { category: "SEXUAL", severity: 0 },
        { category: "VIOLENCE", severity: 2 },
        { category: "SELF_HARM", severity: 0 },
      ],
    },
  },
  {
    storageKey: "demo-cover-6",
    label: "Brooklyn Warehouse Showcase — provider failed (degraded)",
    verdict: { kind: "degraded" },
  },
  {
    storageKey: "demo-cover-19",
    label: "Empty Bottle Indie Showcase — VIOLENCE 4 (auto-approved)",
    verdict: {
      kind: "scores",
      categories: [
        { category: "VIOLENCE", severity: 4 },
        { category: "SEXUAL", severity: 2 },
        { category: "HATE", severity: 0 },
        { category: "SELF_HARM", severity: 0 },
      ],
    },
  },
  {
    storageKey: "demo-cover-23",
    label: "Secret Supper Club — SEXUAL 6, cleared by a moderator",
    verdict: {
      kind: "scores",
      categories: [
        { category: "SEXUAL", severity: 6 },
        { category: "VIOLENCE", severity: 0 },
        { category: "HATE", severity: 0 },
        { category: "SELF_HARM", severity: 0 },
      ],
    },
    clear:
      "Candlelit dinner photo; the provider misread the lighting. Fine to publish.",
  },
];

/**
 * The shipped thresholds (moderate-image.ts, decided 2026-08-20): SEXUAL and
 * VIOLENCE hold at 6, HATE and SELF_HARM at 2.
 */
const MODERATION_CONFIG: ModerateImageConfig = {
  reviewThreshold: 4,
  categoryThresholds: { SEXUAL: 6, VIOLENCE: 6, HATE: 2, SELF_HARM: 2 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Stand-in ports
// ─────────────────────────────────────────────────────────────────────────────

const quietLogger: LoggerPort = {
  child: () => quietLogger,
  withTime: (_name, f) => f(),
  log: (level, msg, extra) => {
    if (level === "warn" || level === "error") console.warn(`  [${level}] ${msg}`, extra ?? "");
  },
  info: () => {},
  warn: (msg, extra) => console.warn(`  [warn] ${msg}`, extra ?? ""),
  error: (msg, extra) => console.warn(`  [error] ${msg}`, extra ?? ""),
};

/** Scripted provider: returns whatever verdict the current fixture sets. */
class ScriptedModeration implements ModerationPort {
  next: ImageFixture["verdict"] | null = null;
  async moderateImage(): Promise<ImageModerationResult> {
    const v = this.next;
    if (!v) throw new Error("ScriptedModeration called without a verdict");
    if (v.kind === "degraded") {
      return {
        verdict: "FLAGGED",
        maxSeverity: 0,
        categories: [],
        provider: "azure-content-safety",
        rawSeverityScale: "eight",
        degraded: true,
      };
    }
    const maxSeverity = Math.max(...v.categories.map((c) => c.severity));
    return {
      verdict: "APPROVED", // the use case owns the threshold decision
      maxSeverity,
      categories: v.categories,
      provider: "azure-content-safety",
      rawSeverityScale: "eight",
      degraded: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  const host = assertLocalDatabase();
  const staffSecondFactorBypass = requireStaffSecondFactorBypass();
  console.log(`seed-moderation-qa → local DB host "${host}"`);

  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  // Same wiring as apps/api/src/lib/dep.ts.
  const authz = createDbAuthZAdapter({ repos, staffSecondFactorBypass });
  const contentFilter = createProfanityContentFilterAdapter();
  const failures: string[] = [];
  const note = (label: string, actions: string[]) =>
    console.log(`  ✓ ${label}: ${actions.length ? actions.join(", ") : "already at target, skipped"}`);
  const fail = (label: string, err: unknown) => {
    const msg = `${label}: ${errCode(err)}`;
    failures.push(msg);
    console.warn(`  ✗ ${msg}`);
  };

  // ── a. Entity reports ────────────────────────────────────────────────────
  console.log("\n▶ Entity reports (/platform/reports)");
  for (const r of REPORTS) {
    try {
      const actions: string[] = [];
      let report = await prisma.entityReport.findFirst({
        where: {
          reporterHumanId: r.reporter,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true },
      });
      if (!report) {
        const res = await submitEntityReport(
          { repos, clock, logger: quietLogger },
          {
            actorHumanId: r.reporter,
            subjectType: r.subjectType,
            subjectId: r.subjectId,
            reason: r.reason,
            details: r.details,
          },
        );
        report = { id: res.reportId, status: "PENDING" };
        actions.push("submitted");
      }
      if (r.decide && report.status === "PENDING") {
        await reviewEntityReport(
          { repos, authz, clock, logger: quietLogger },
          {
            actorHumanId: ADMIN,
            reportId: report.id,
            verdict: r.decide.verdict,
            reviewNote: r.decide.note,
          },
        );
        actions.push(`reviewed → ${r.decide.verdict}`);
      }
      note(r.label, actions);
    } catch (err) {
      fail(`report ${r.label}`, err);
    }
  }

  // ── b. Flagged place reviews ─────────────────────────────────────────────
  console.log("\n▶ Flagged place reviews (/platform/reviews)");
  for (const f of REVIEW_FLAGS) {
    try {
      const review = await prisma.placeReview.findFirst({
        where: { anonymousEmail: f.anonymousEmail },
        select: { id: true, anonymousName: true, flagged: true, hidden: true },
      });
      if (!review) {
        fail(
          `review ${f.anonymousEmail}`,
          "not found — run `pnpm seed:reviews-qa` first",
        );
        continue;
      }
      const actions: string[] = [];
      if (!review.flagged) {
        await flagPlaceReview(
          { repos, clock },
          { reviewId: review.id, actorHumanId: f.flagger, flagReason: f.flagReason },
        );
        actions.push("flagged");
      }
      if (f.hide && !review.hidden) {
        await hidePlaceReview(
          { repos, authz, clock },
          { reviewId: review.id, actorHumanId: ADMIN },
        );
        actions.push("hidden");
      }
      note(`${review.anonymousName ?? review.id}`, actions);
    } catch (err) {
      fail(`review ${f.anonymousEmail}`, err);
    }
  }

  // ── c. Moderator applications ────────────────────────────────────────────
  console.log("\n▶ Moderator applications (/moderate/applications)");
  for (const a of APPLICATIONS) {
    try {
      const actions: string[] = [];
      let app = await prisma.communityModeratorApplication.findFirst({
        where: { applicantHumanId: a.applicant },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true },
      });
      if (!app) {
        const res = await applyToBeModerator(
          { repos, authz, clock, contentFilter, logger: quietLogger },
          { actorHumanId: a.applicant, statement: a.statement },
        );
        app = { id: res.application.id, status: "PENDING" };
        actions.push("applied");
      }
      if (a.decide && app.status === "PENDING") {
        await reviewModeratorApplication(
          { repos, authz, clock, logger: quietLogger },
          {
            actorHumanId: ADMIN,
            applicationId: app.id,
            decision: a.decide.decision,
            reviewNote: a.decide.note,
          },
        );
        actions.push(`reviewed → ${a.decide.decision}`);
      }
      const human = await prisma.human.findUnique({
        where: { id: a.applicant },
        select: { name: true },
      });
      note(`${human?.name ?? a.applicant}`, actions);
    } catch (err) {
      fail(`application ${a.applicant}`, err);
    }
  }

  // ── d. Category requests ─────────────────────────────────────────────────
  console.log("\n▶ Category requests (/platform/categories)");
  for (const c of CATEGORY_REQUESTS) {
    try {
      const actions: string[] = [];
      const event = await prisma.event.findFirst({
        where: { title: c.eventTitle },
        orderBy: { startsAt: "desc" },
        select: { id: true },
      });
      if (!event) {
        fail(`category ${c.name}`, `event "${c.eventTitle}" not found`);
        continue;
      }
      let request = await prisma.eventCategoryRequest.findFirst({
        where: { name: c.name, requesterHumanId: c.requester },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true },
      });
      if (!request) {
        const res = await requestCategoryOption(
          { repos, clock, contentFilter, logger: quietLogger },
          {
            actorHumanId: c.requester,
            eventId: event.id,
            kind: "CATEGORY",
            name: c.name,
            note: c.note,
          },
        );
        request = { id: res.request.id, status: res.request.status };
        actions.push("requested");
      }
      if (c.reject && request.status === "PENDING") {
        await reviewCategoryRequest(
          { repos, authz, clock, logger: quietLogger },
          {
            actorHumanId: ADMIN,
            requestId: request.id,
            decision: "REJECT",
            reviewNote: c.reject,
          },
        );
        actions.push("reviewed → REJECTED");
      }
      note(c.name, actions);
    } catch (err) {
      fail(`category ${c.name}`, err);
    }
  }

  // ── f. Image moderation ──────────────────────────────────────────────────
  console.log("\n▶ Image moderation (/moderate/images, /platform/image-moderation)");
  const provider = new ScriptedModeration();
  // Placeholder bytes: the scripted provider never reads them. The seeded
  // covers are Unsplash URLs, not objects in a local bucket.
  const fileStorage = {
    getObject: async () => ({
      content: Buffer.from("qa-seed-placeholder"),
      contentType: "image/jpeg",
    }),
  };
  for (const img of IMAGE_FIXTURES) {
    try {
      const actions: string[] = [];
      const image = await prisma.image.findFirst({
        where: { key: img.storageKey, deletedAt: null },
        select: {
          eventId: true,
          publicUrl: true,
          contentType: true,
          createdByHumanId: true,
        },
      });
      if (!image) {
        fail(`image ${img.storageKey}`, "seeded cover not found — run `pnpm seed:dev`");
        continue;
      }
      let record = await repos.imageModerationRecords.getByKey(img.storageKey);
      if (!record) {
        await repos.tx((tx) =>
          enqueueImageModeration(tx, {
            storageKey: img.storageKey,
            kind: "EVENT_HERO",
            subjectType: image.eventId ? "EVENT" : undefined,
            subjectId: image.eventId ?? undefined,
            publicUrl: image.publicUrl,
            contentType: image.contentType,
            createdByHumanId: image.createdByHumanId,
          }),
        );
        actions.push("enqueued");
        record = await repos.imageModerationRecords.getByKey(img.storageKey);
      }
      if (record && record.status === "PENDING") {
        provider.next = img.verdict;
        const res = await moderateImage(
          {
            repos,
            fileStorage,
            moderation: provider,
            config: MODERATION_CONFIG,
            logger: quietLogger,
            reportError: () => {},
          },
          { storageKey: img.storageKey },
        );
        actions.push(`provider → ${res.status}${res.degraded ? " (degraded)" : ""}`);
        record = await repos.imageModerationRecords.getByKey(img.storageKey);
      }
      if (img.clear && record && record.status === "FLAGGED") {
        await reviewFlaggedImage(
          { repos, clock, logger: quietLogger },
          {
            actorHumanId: ADMIN,
            recordId: record.id,
            decision: "APPROVE",
            note: img.clear,
          },
        );
        actions.push("moderator → APPROVED");
      }
      note(img.label, actions);
    } catch (err) {
      fail(`image ${img.storageKey}`, err);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const [reports, apps, cats, images, flaggedReviews, hiddenReviews] =
    await Promise.all([
      prisma.entityReport.groupBy({ by: ["status"], _count: true }),
      prisma.communityModeratorApplication.groupBy({ by: ["status"], _count: true }),
      prisma.eventCategoryRequest.groupBy({ by: ["status"], _count: true }),
      prisma.imageModerationRecord.groupBy({ by: ["status"], _count: true }),
      prisma.placeReview.count({ where: { flagged: true, hidden: false } }),
      prisma.placeReview.count({ where: { hidden: true } }),
    ]);
  const fmt = (rows: { status: string; _count: number }[]) =>
    rows.map((r) => `${r.status} ${r._count}`).join(", ") || "none";

  console.log("\n──────────────────────────────────────────────────────────────────");
  console.log("QA moderation seed complete. Web: http://localhost:3000");
  console.log("  Staff sign-in : admin@ithasfire.com / Dev-Login-2026!  (platform ADMIN; needs DEV_BYPASS_STAFF_2FA=true on the API)");
  console.log(`  /platform/reports           entity reports: ${fmt(reports)}`);
  console.log(`  /platform/reviews           place reviews: flagged ${flaggedReviews}, hidden ${hiddenReviews} (default filter = Flagged)`);
  console.log(`  /moderate/applications      moderator applications: ${fmt(apps)}`);
  console.log(`  /platform/categories        category requests: ${fmt(cats)}`);
  console.log(`  /moderate/images            image records: ${fmt(images)}`);
  console.log("  /platform/image-moderation  same records, platform view + queue health");
  console.log("  /platform/places            place verification (seed:verification-qa)");
  console.log("  /moderate/suggestions       edit suggestions (seed:community-qa)");
  console.log("  Approved moderator: sam.okonkwo@example.com / demo1234 (COMMUNITY_MODERATOR) can open /moderate.");
  console.log("  Note: FLAGGED covers are hidden on their public event pages until approved.");
  if (failures.length) {
    console.log(`\n  ${failures.length} step(s) refused:`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  console.log("──────────────────────────────────────────────────────────────────\n");

  await prisma.$disconnect();
  if (failures.length) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error("seed-moderation-qa failed:", err);
  process.exit(1);
});
