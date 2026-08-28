import type { BookingFeeType, HumanJob, PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import { DEMO_IDS, DEV_LOGIN_USER, DEV_LOGIN_MXN_USER } from "./ids.js";
import type {
  AdditionalHumanFixture,
  AdditionalOrgFixture,
} from "./fixtures.js";
import { ADDITIONAL_HUMANS, ADDITIONAL_ORGS } from "./fixtures.js";

// ── Primary org ──────────────────────────────────────────────────────────

export const ensureOrg = async (prisma: PrismaClient) =>
  prisma.organization.upsert({
    where: { id: DEMO_IDS.org },
    update: { name: "Ithas Fire Demo Org", slug: "demo", status: "ACTIVE" },
    create: {
      id: DEMO_IDS.org,
      name: "Ithas Fire Demo Org",
      slug: "demo",
      status: "ACTIVE",
      defaultLocale: "en",
    },
  });

// ── Demo human (org owner) ──────────────────────────────────────────────

export const ensureDemoHuman = async (prisma: PrismaClient) => {
  const human = await prisma.human.upsert({
    where: { id: DEMO_IDS.human },
    update: {
      name: "Demo Host",
      status: "ACTIVE",
    },
    create: {
      id: DEMO_IDS.human,
      name: "Demo Host",
      status: "ACTIVE",
      locale: "en",
    },
  });

  // Ensure authUser for identity data (email/verified)
  await prisma.authUser.upsert({
    where: { id: human.id },
    update: {
      email: "demo@ithasfire.local",
      emailVerified: true,
      humanId: human.id,
    },
    create: {
      id: human.id,
      email: "demo@ithasfire.local",
      emailVerified: true,
      name: "Demo Host",
      humanId: human.id,
    },
  });

  await prisma.orgMember.upsert({
    where: { orgId_humanId: { orgId: DEMO_IDS.org, humanId: human.id } },
    update: { role: "OWNER" },
    create: {
      orgId: DEMO_IDS.org,
      humanId: human.id,
      role: "OWNER",
    },
  });

  return human;
};

// ── Dev-login user (primary test account) ────────────────────────────────

export const ensureDevLoginUser = async (prisma: PrismaClient) => {
  const email = DEV_LOGIN_USER.email.toLowerCase();
  const passwordHash = await hashPassword(DEV_LOGIN_USER.password);

  const human = await prisma.human.upsert({
    where: { id: DEMO_IDS.devUser },
    update: {
      name: DEV_LOGIN_USER.name,
      status: "ACTIVE",
      roles: ["USER", "ADMIN"],
    },
    create: {
      id: DEMO_IDS.devUser,
      name: DEV_LOGIN_USER.name,
      status: "ACTIVE",
      locale: "en",
      roles: ["USER", "ADMIN"],
    },
  });

  await prisma.entityPage.upsert({
    where: { ownerType_ownerId: { ownerType: "HUMAN", ownerId: human.id } },
    update: {
      displayName: DEV_LOGIN_USER.name,
      slug: DEV_LOGIN_USER.profileSlug,
      avatarUrl: DEV_LOGIN_USER.image,
    },
    create: {
      ownerType: "HUMAN",
      ownerId: human.id,
      displayName: DEV_LOGIN_USER.name,
      slug: DEV_LOGIN_USER.profileSlug,
      visibility: "PUBLIC",
      avatarUrl: DEV_LOGIN_USER.image,
    },
  });

  const authUser = await prisma.authUser.upsert({
    where: { id: DEMO_IDS.devUser },
    update: {
      email,
      name: DEV_LOGIN_USER.name,
      emailVerified: true,
      humanId: human.id,
      image: DEV_LOGIN_USER.image,
    },
    create: {
      id: DEMO_IDS.devUser,
      email,
      name: DEV_LOGIN_USER.name,
      emailVerified: true,
      humanId: human.id,
      image: DEV_LOGIN_USER.image,
    },
  });

  await prisma.authAccount.upsert({
    where: {
      providerId_accountId: {
        providerId: "credential",
        accountId: authUser.id,
      },
    },
    update: {
      password: passwordHash,
      userId: authUser.id,
    },
    create: {
      providerId: "credential",
      accountId: authUser.id,
      userId: authUser.id,
      password: passwordHash,
    },
  });

  // Give the dev-login user ADMIN access on the primary Demo Org so they see
  // its events in the admin data table alongside the additional orgs.
  await prisma.orgMember.upsert({
    where: { orgId_humanId: { orgId: DEMO_IDS.org, humanId: human.id } },
    update: { role: "ADMIN" },
    create: { orgId: DEMO_IDS.org, humanId: human.id, role: "ADMIN" },
  });

  return DEV_LOGIN_USER;
};

// ── Dev-login MXN user (MXN currency test account) ───────────────────────

export const ensureDevLoginMxnUser = async (prisma: PrismaClient) => {
  const email = DEV_LOGIN_MXN_USER.email.toLowerCase();
  const passwordHash = await hashPassword(DEV_LOGIN_MXN_USER.password);

  const human = await prisma.human.upsert({
    where: { id: DEMO_IDS.devUserMxn },
    update: {
      name: DEV_LOGIN_MXN_USER.name,
      status: "ACTIVE",
    },
    create: {
      id: DEMO_IDS.devUserMxn,
      name: DEV_LOGIN_MXN_USER.name,
      status: "ACTIVE",
      locale: "es",
    },
  });

  await prisma.entityPage.upsert({
    where: { ownerType_ownerId: { ownerType: "HUMAN", ownerId: human.id } },
    update: {
      displayName: DEV_LOGIN_MXN_USER.name,
      slug: DEV_LOGIN_MXN_USER.profileSlug,
      avatarUrl: DEV_LOGIN_MXN_USER.image,
    },
    create: {
      ownerType: "HUMAN",
      ownerId: human.id,
      displayName: DEV_LOGIN_MXN_USER.name,
      slug: DEV_LOGIN_MXN_USER.profileSlug,
      visibility: "PUBLIC",
      avatarUrl: DEV_LOGIN_MXN_USER.image,
    },
  });

  const authUser = await prisma.authUser.upsert({
    where: { id: DEMO_IDS.devUserMxn },
    update: {
      email,
      name: DEV_LOGIN_MXN_USER.name,
      emailVerified: true,
      humanId: human.id,
      image: DEV_LOGIN_MXN_USER.image,
    },
    create: {
      id: DEMO_IDS.devUserMxn,
      email,
      name: DEV_LOGIN_MXN_USER.name,
      emailVerified: true,
      humanId: human.id,
      image: DEV_LOGIN_MXN_USER.image,
    },
  });

  await prisma.authAccount.upsert({
    where: {
      providerId_accountId: {
        providerId: "credential",
        accountId: authUser.id,
      },
    },
    update: {
      password: passwordHash,
      userId: authUser.id,
    },
    create: {
      providerId: "credential",
      accountId: authUser.id,
      userId: authUser.id,
      password: passwordHash,
    },
  });

  return DEV_LOGIN_MXN_USER;
};

// ── Additional humans ────────────────────────────────────────────────────

export const ensureAdditionalHumans = async (
  prisma: PrismaClient,
  fixtures: AdditionalHumanFixture[] = ADDITIONAL_HUMANS,
) => {
  const passwordHash = await hashPassword("demo1234");

  const createdHumans = await Promise.all(
    fixtures.map(async (fixture) => {
      const human = await prisma.human.upsert({
        where: { id: fixture.id },
        update: { name: fixture.name },
        create: { id: fixture.id, name: fixture.name, locale: "en" },
      });

      const [authUser] = await Promise.all([
        prisma.authUser.upsert({
          where: { id: fixture.authUserId },
          update: {
            email: fixture.email,
            name: fixture.name,
            emailVerified: true,
            humanId: human.id,
          },
          create: {
            id: fixture.authUserId,
            email: fixture.email,
            name: fixture.name,
            emailVerified: true,
            humanId: human.id,
          },
        }),
        prisma.entityPage.upsert({
          where: {
            ownerType_ownerId: { ownerType: "HUMAN", ownerId: human.id },
          },
          update: {
            displayName: fixture.name,
            slug: fixture.profileSlug,
            bio: fixture.bio,
          },
          create: {
            ownerType: "HUMAN",
            ownerId: human.id,
            displayName: fixture.name,
            slug: fixture.profileSlug,
            bio: fixture.bio,
            visibility: "PUBLIC",
          },
        }),
      ]);

      await prisma.authAccount.upsert({
        where: {
          providerId_accountId: {
            providerId: "credential",
            accountId: authUser.id,
          },
        },
        update: { password: passwordHash, userId: authUser.id },
        create: {
          providerId: "credential",
          accountId: authUser.id,
          userId: authUser.id,
          password: passwordHash,
        },
      });

      return { id: human.id, name: fixture.name };
    }),
  );

  return createdHumans;
};

// ── Performer profiles ─────────────────────────────────────────────────────

// Fixed enable timestamp — this repo bans nondeterministic seed dates
// (no Date.now / new Date() without an argument), so pin a stable instant.
const PERFORMER_ENABLED_AT = new Date("2026-01-01T00:00:00.000Z");

// Humans that opt INTO performer mode. PerformerProfile is the single
// performer-mode gate (packages/core/src/lib/performer-mode.ts): an entity is a
// performer iff it has a profile with enabledAt set and disabledAt null. The
// seeded tier demo (entity-pages.ts) gives Alex Rivera the musician EPK and
// Diego Alvarez the working-act set, so both must be performer-enabled for the
// tier to be coherent end-to-end (resolveCategory → "performer"). The dev-login
// admin is enabled too so the primary test account exercises performer mode +
// booking-request prefill out of the box.
const PERFORMER_ENABLED_HUMAN_IDS = [
  DEMO_IDS.devUser,
  DEMO_IDS.human2,
  DEMO_IDS.human7,
];

export const ensurePerformerProfiles = async (
  prisma: PrismaClient,
  humanIds: string[] = PERFORMER_ENABLED_HUMAN_IDS,
) => {
  await Promise.all(
    humanIds.map((ownerId) =>
      prisma.performerProfile.upsert({
        where: { ownerType_ownerId: { ownerType: "human", ownerId } },
        update: { enabledAt: PERFORMER_ENABLED_AT, disabledAt: null },
        create: {
          ownerType: "human",
          ownerId,
          enabledAt: PERFORMER_ENABLED_AT,
          disabledAt: null,
        },
      }),
    ),
  );
  return humanIds.length;
};

// ── Performer booking defaults ─────────────────────────────────────────────

/**
 * Saved booking-request prefill data per performer-enabled human, plus the
 * Human profile content (`jobs` / `genreTags`) the booking form's genre
 * prefill reads — genre is intentionally NOT stored on
 * PerformerBookingDefaults (see packages/db/prisma/performer.prisma); the
 * create path prefills the sender's first `Human.genreTags` entry instead, so
 * both are seeded here as one coherent "prefill content" unit.
 *
 * Constraints mirrored from the runtime write paths so the seeded rows are
 * exactly what update-performer-booking-defaults would have saved:
 * - `setLengthMinutes` ∈ BOOKING_SET_LENGTH_PRESETS ([15,30,45,60,90,120]).
 * - `feeAmountCents`/`feeCurrency` only alongside GUARANTEE or DOOR_SPLIT
 *   (pitch-schema `hasConsistentFeeAsk`); NEGOTIABLE carries neither.
 *   Currency is the platform base "usd" (BOOKING_FEE_DEFAULT_CURRENCY).
 * - Links are https URLs, matching each persona's entity-page content
 *   (entity-pages.ts) where one exists.
 *
 * `stats` seeds a HumanStats row so the "Include verified platform stats"
 * checkbox gate (performers.getMyStatus → human.statsEligible =
 * isPerformerStatsEligible → totalEventsPerformed >= 3) is exercisable
 * locally in BOTH branches: devUser/human2 eligible, human7 (2 events)
 * deliberately below the threshold. `channelBreakdown` follows the
 * compute-human-stats shape ({ source, tickets }[], sources
 * "checkout_select" | "ref_link") — the public stats block reads the
 * `ref_link` entry as refLinkTickets (packages/core/src/lib/performer-stats.ts).
 * These are static demo numbers; the real compute-human-stats job would
 * overwrite them if run locally, which is fine/expected.
 */
type PerformerBookingDefaultsSeed = {
  ownerId: string;
  jobs: HumanJob[];
  genreTags: string[];
  stats: {
    totalEventsPerformed: number;
    totalTicketsAttributed: number;
    avgDrawPerEvent: number;
    channelBreakdown: { source: string; tickets: number }[];
    totalConsentedFans: number;
    repeatFanCount: number;
    followerCount: number;
    last90DayTickets: number;
    last90DayEvents: number;
  };
  actName: string;
  lineupSize: number;
  setLengthMinutes: number;
  techNeeds: string;
  contactPhone: string;
  feeType: BookingFeeType;
  feeAmountCents: number | null;
  feeCurrency: string | null;
  messageTemplate: string;
  includeVerifiedStats: boolean;
  linkMusic: string;
  linkVideo: string;
  linkSocial: string;
  linkEpk: string;
};

// Pinned deterministic "computed at" instant for the seeded HumanStats rows
// (same no-nondeterministic-seed-dates rule as PERFORMER_ENABLED_AT).
const STATS_COMPUTED_AT = new Date("2026-07-01T00:00:00.000Z");

const PERFORMER_BOOKING_DEFAULTS: PerformerBookingDefaultsSeed[] = [
  {
    // Dev-login admin — the primary test account. Fully-populated GUARANTEE
    // persona so every prefill field lights up on the booking form.
    ownerId: DEMO_IDS.devUser,
    jobs: ["EVENT_ORGANIZER", "MUSICIAN"],
    genreTags: ["Americana", "Indie Rock", "Honky-Tonk"],
    // Eligible (>= 3 shows). 540 tickets over 12 shows = 45 avg; channel
    // split sums back to the attributed total.
    stats: {
      totalEventsPerformed: 12,
      totalTicketsAttributed: 540,
      avgDrawPerEvent: 45,
      channelBreakdown: [
        { source: "checkout_select", tickets: 420 },
        { source: "ref_link", tickets: 120 },
      ],
      totalConsentedFans: 130,
      repeatFanCount: 85,
      followerCount: 210,
      last90DayTickets: 160,
      last90DayEvents: 3,
    },
    actName: "Ithas Fire House Band",
    lineupSize: 4,
    setLengthMinutes: 45,
    techNeeds:
      "Four-piece setup: two vocal mics, DIs for guitar and bass, and a house drum kit if available — we bring our own breakables.",
    contactPhone: "+16155550142",
    feeType: "GUARANTEE",
    feeAmountCents: 50_000, // $500 guarantee
    feeCurrency: "usd",
    messageTemplate:
      "Hi — we're the Ithas Fire House Band, a four-piece playing rowdy Americana originals around Nashville. We'd love a Friday or Saturday slot and will push the show hard to our local list.",
    includeVerifiedStats: true,
    linkMusic: "https://ithasfirehouseband.bandcamp.com",
    linkVideo: "https://www.youtube.com/@ithasfirehouseband",
    linkSocial: "https://instagram.com/ithasfirehouseband",
    linkEpk: "https://ithasfire.com/p/admin",
  },
  {
    // Alex Rivera — musician-tier EPK (entity-pages.ts buildMusicianEpkBlocks).
    // DOOR_SPLIT persona: no fee amount (allowed but omitted — the split IS
    // the ask), links match the seeded EPK music/video/links blocks.
    ownerId: DEMO_IDS.human2,
    jobs: ["MUSICIAN"],
    genreTags: ["Indie Folk", "Americana", "Alt-Country"],
    // Eligible — the seasoned act: 1320 tickets over 24 shows = 55 avg.
    stats: {
      totalEventsPerformed: 24,
      totalTicketsAttributed: 1320,
      avgDrawPerEvent: 55,
      channelBreakdown: [
        { source: "checkout_select", tickets: 1015 },
        { source: "ref_link", tickets: 305 },
      ],
      totalConsentedFans: 310,
      repeatFanCount: 190,
      followerCount: 480,
      last90DayTickets: 240,
      last90DayEvents: 5,
    },
    actName: "Alex Rivera",
    lineupSize: 4,
    setLengthMinutes: 60,
    techNeeds:
      "Full-band setup: 3 vocal mics, 2 DI boxes (acoustic guitar + keys), 4 monitor mixes. Prefer a 15-minute line check.",
    contactPhone: "+16155550137",
    feeType: "DOOR_SPLIT",
    feeAmountCents: null,
    feeCurrency: null,
    messageTemplate:
      "Hi — I'm Alex Rivera, an East Nashville songwriter playing lived-in indie folk, solo or with a full band up to a 4-piece. Happy to work a door split and bring out the listening-room crowd.",
    includeVerifiedStats: true,
    linkMusic: "https://alexrivera.bandcamp.com",
    linkVideo: "https://www.youtube.com/watch?v=9bZkp7q19f0",
    linkSocial: "https://instagram.com/alexriveramusic",
    linkEpk: "https://alexriveramusic.example/booking",
  },
  {
    // Diego Alvarez — performer-tier working act (buildPerformerBlocks).
    // NEGOTIABLE persona: no amount/currency (pitch-schema forbids an amount
    // with NEGOTIABLE). Lineup 2 = Diego + guest musician, matching his
    // seeded booking-info notes ("solo or with a guest musician").
    ownerId: DEMO_IDS.human7,
    jobs: ["VISUAL_ARTIST", "MUSICIAN"],
    genreTags: ["Live A/V", "Ambient", "Experimental"],
    // Deliberately INELIGIBLE (2 < MIN_SHOWS_FOR_STATS = 3) so the hidden
    // branch of the verified-stats checkbox gate stays demoable locally.
    stats: {
      totalEventsPerformed: 2,
      totalTicketsAttributed: 70,
      avgDrawPerEvent: 35,
      channelBreakdown: [
        { source: "checkout_select", tickets: 52 },
        { source: "ref_link", tickets: 18 },
      ],
      totalConsentedFans: 12,
      repeatFanCount: 6,
      followerCount: 45,
      last90DayTickets: 70,
      last90DayEvents: 2,
    },
    actName: "Diego Alvarez — Live A/V",
    lineupSize: 2,
    setLengthMinutes: 30,
    techNeeds:
      "Dark room (or rooftop after sunset), one 4x8 projection surface or a clean wall, two mains, and a table for the 16mm rig and modular.",
    contactPhone: "+13125550164",
    feeType: "NEGOTIABLE",
    feeAmountCents: null,
    feeCurrency: null,
    messageTemplate:
      "Hi — I run live 16mm projection sets with an ambient score, solo or with a guest musician. Give me a dark room or a rooftop after sunset and I'll turn it into a screening night. Fee is flexible.",
    includeVerifiedStats: true,
    linkMusic: "https://diegoalvarez.bandcamp.com",
    linkVideo: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    linkSocial: "https://instagram.com/diegoalvarez.av",
    linkEpk: "https://diegoalvarez.example/screenings",
  },
];

/**
 * Seed a complete PerformerBookingDefaults row (booking-form prefill) for each
 * performer-enabled demo human, the `Human.jobs` / `Human.genreTags` the genre
 * prefill reads, and a HumanStats row so the verified-stats eligibility gate
 * has real data to evaluate (static demo numbers — the compute-human-stats
 * job overwrites them if run locally, which is fine/expected). Idempotent:
 * upserts on the [ownerType, ownerId] / humanId uniques + plain update on the
 * (already-seeded) Human rows. Must run AFTER ensureDevLoginUser /
 * ensureAdditionalHumans created the humans.
 */
export const ensurePerformerBookingDefaults = async (
  prisma: PrismaClient,
  seeds: PerformerBookingDefaultsSeed[] = PERFORMER_BOOKING_DEFAULTS,
) => {
  await Promise.all(
    seeds.map(async ({ ownerId, jobs, genreTags, stats, ...defaults }) => {
      const statsData = { ...stats, computedAt: STATS_COMPUTED_AT };
      await Promise.all([
        prisma.performerBookingDefaults.upsert({
          where: { ownerType_ownerId: { ownerType: "human", ownerId } },
          update: defaults,
          create: { ownerType: "human", ownerId, ...defaults },
        }),
        prisma.human.update({
          where: { id: ownerId },
          data: { jobs, genreTags },
        }),
        prisma.humanStats.upsert({
          where: { humanId: ownerId },
          update: statsData,
          create: { humanId: ownerId, ...statsData },
        }),
      ]);
    }),
  );
  return seeds.length;
};

// ── Additional orgs ──────────────────────────────────────────────────────

export const ensureAdditionalOrgs = async (
  prisma: PrismaClient,
  fixtures: AdditionalOrgFixture[] = ADDITIONAL_ORGS,
) => {
  const createdOrgs = await Promise.all(
    fixtures.map(async (fixture) => {
      const org = await prisma.organization.upsert({
        where: { id: fixture.id },
        update: { name: fixture.name, slug: fixture.slug },
        create: { id: fixture.id, name: fixture.name, slug: fixture.slug },
      });

      // Members + admins can be upserted in parallel
      const memberOps = fixture.memberHumanIds.map((humanId) => {
        const role = humanId === fixture.ownerHumanId ? "OWNER" : "VIEWER";
        return prisma.orgMember.upsert({
          where: { orgId_humanId: { orgId: org.id, humanId } },
          update: { role },
          create: { orgId: org.id, humanId, role },
        });
      });
      const adminOps = (fixture.adminHumanIds ?? []).map((humanId) =>
        prisma.orgMember.upsert({
          where: { orgId_humanId: { orgId: org.id, humanId } },
          update: { role: "ADMIN" },
          create: { orgId: org.id, humanId, role: "ADMIN" },
        }),
      );
      await Promise.all([...memberOps, ...adminOps]);

      return { id: org.id, name: fixture.name };
    }),
  );

  return createdOrgs;
};
