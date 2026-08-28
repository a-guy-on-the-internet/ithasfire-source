import type { Prisma, PrismaClient } from "@prisma/client";
import {
  PLATFORM_VOLUNTEER_WAIVER_BODY,
  PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID,
  composeAssembledWaiverBody,
} from "@th/core/use-cases/waivers";
import { DEMO_IDS } from "./ids.js";

/**
 * Platform waiver templates (orgId = null), available to all orgs as
 * pre-built defaults.
 *
 * The three attendee-facing templates are ASSEMBLED from the waiver clause
 * library (waiver-clauses.ts) via the same pure composition helper the
 * `assembleWaiver` use case uses, so shared clause text exists exactly once.
 * They are seed-only rows (no migration ships them to prod — prod's only
 * migration-created template is the Standard Volunteer Waiver below), so
 * rebuilding their body/source here is dev-local and low-risk.
 *
 * `ensurePlatformWaivers` therefore REQUIRES the clause library to be seeded
 * first (seedWaiverClauses) — seed-data.ts runs the clauses step before this
 * one.
 */

/**
 * Shared attendee core: the clauses every attendee-facing platform template
 * includes, in clause-library `sortOrder` (composition sorts regardless).
 */
const ATTENDEE_CORE_CLAUSE_SLUGS = [
  "released-parties-definition",
  "core-release",
  "core-assumption-of-risk",
  "amplified-sound",
  "medical-acknowledgment",
  "gross-negligence-footer",
  "severability-reformation",
  "platform-disclaimer-footer",
] as const;

type AssembledPlatformWaiverSeed = {
  id: string;
  name: string;
  isDefault: boolean;
  clauseSlugs: readonly string[];
  jurisdictionState: string | null;
};

const ASSEMBLED_PLATFORM_WAIVERS: AssembledPlatformWaiverSeed[] = [
  {
    id: DEMO_IDS.waiverGeneral,
    name: "General Event Waiver",
    isDefault: true,
    clauseSlugs: ATTENDEE_CORE_CLAUSE_SLUGS,
    jurisdictionState: null,
  },
  {
    id: DEMO_IDS.waiverLiveMusic,
    name: "Live Music Waiver",
    isDefault: false,
    clauseSlugs: [...ATTENDEE_CORE_CLAUSE_SLUGS, "physical-activity", "crowding"],
    jurisdictionState: null,
  },
  {
    id: DEMO_IDS.waiverPrivateResidence,
    name: "House Show / Private Event Waiver",
    isDefault: false,
    clauseSlugs: [
      ...ATTENDEE_CORE_CLAUSE_SLUGS,
      "private-residential",
      "byob-alcohol",
      "governing-law-tn",
    ],
    jurisdictionState: "TN",
  },
];

/**
 * Upsert platform-level waiver templates (orgId = null).
 *
 * Idempotency (unchanged semantics from the hand-written era): every run
 * upserts — create with version 1 when missing, otherwise update
 * name/body/flags in place WITHOUT bumping `version`. That is acceptable for
 * these seed-managed dev rows; real body revisions of migration-shipped
 * platform templates must go through a migration that bumps version (see
 * packages/core/src/use-cases/waivers/constants.ts).
 */
export async function ensurePlatformWaivers(prisma: PrismaClient) {
  console.log("Seeding platform waiver templates...");

  // Load the clause rows the assembled templates reference.
  const referencedSlugs = [
    ...new Set(ASSEMBLED_PLATFORM_WAIVERS.flatMap((w) => w.clauseSlugs)),
  ];
  const clauses = await prisma.waiverClause.findMany({
    where: { slug: { in: referencedSlugs } },
    select: { id: true, slug: true, version: true, body: true, sortOrder: true },
  });
  const clauseBySlug = new Map(clauses.map((c) => [c.slug, c]));
  const missing = referencedSlugs.filter((slug) => !clauseBySlug.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `ensurePlatformWaivers: waiver clause(s) not seeded yet: ${missing.join(", ")} — run seedWaiverClauses first`,
    );
  }

  // Attendee-facing templates, ASSEMBLED from the clause library.
  for (const w of ASSEMBLED_PLATFORM_WAIVERS) {
    const { body, assembledFromClauses } = composeAssembledWaiverBody(
      w.clauseSlugs.map((slug) => clauseBySlug.get(slug)!),
    );
    const shared = {
      name: w.name,
      body,
      isDefault: w.isDefault,
      kind: "ATTENDEE",
      source: "ASSEMBLED",
      assembledFromClauses:
        assembledFromClauses as unknown as Prisma.InputJsonValue,
      jurisdictionState: w.jurisdictionState,
    } as const;

    // Body text is the acceptance contract: `WaiverAcceptance` /
    // `VolunteerWaiverAcceptance` rows snapshot (templateId, version,
    // bodyHash), and coverage checks match on version. Updating the body IN
    // PLACE at the same version would make old acceptances silently "cover"
    // text the human never saw — so when the stored body differs, bump the
    // version alongside it. Metadata-only drift (name/flags) updates in place.
    const existing = await prisma.waiverTemplate.findUnique({
      where: { id: w.id },
      select: { body: true, version: true },
    });
    await prisma.waiverTemplate.upsert({
      where: { id: w.id },
      update: {
        ...shared,
        ...(existing && existing.body !== body
          ? { version: existing.version + 1 }
          : {}),
      },
      create: { id: w.id, orgId: null, humanId: null, version: 1, ...shared },
    });
  }

  // Platform default volunteer waiver (FR-010,
  // docs/specs/2026-07-07/ask-level-volunteer-waivers.spec.yaml). Stays
  // FREEFORM and un-assembled on purpose: its employment-status and
  // follow-instructions clauses are volunteer-specific and deliberately not
  // in the attendee clause library. Prod gets this row from migration
  // 20260707150000_add_ask_waiver_template (kind backfilled to VOLUNTEER by
  // 20260804120000_waiver_template_kind); the seed ensures it locally.
  // Both id and body come from the core constants so seed, code, and
  // migration SQL cannot drift (constants.test.ts pins the SQL copy).
  await prisma.waiverTemplate.upsert({
    where: { id: PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID },
    update: {
      name: "Standard Volunteer Waiver",
      body: PLATFORM_VOLUNTEER_WAIVER_BODY,
      isDefault: true,
      kind: "VOLUNTEER",
      source: "FREEFORM",
    },
    create: {
      id: PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID,
      orgId: null,
      humanId: null,
      name: "Standard Volunteer Waiver",
      body: PLATFORM_VOLUNTEER_WAIVER_BODY,
      version: 1,
      isDefault: true,
      kind: "VOLUNTEER",
      source: "FREEFORM",
    },
  });

  console.log(
    `  Ensured ${ASSEMBLED_PLATFORM_WAIVERS.length + 1} platform waiver templates`,
  );
}

/** Exported for seed-validation tests (clause mapping + default-per-kind pins). */
export const PLATFORM_WAIVER_SEEDS = {
  attendeeCoreSlugs: ATTENDEE_CORE_CLAUSE_SLUGS,
  assembled: ASSEMBLED_PLATFORM_WAIVERS,
} as const;
