import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Shared constants: tier thresholds
// ─────────────────────────────────────────────────────────────────────────────

export const TIER_THRESHOLDS = {
  ESTABLISHED: {
    completedEventCount: 3,
    totalTicketsSold: 0,
    maxDisputeRate: 0.05,
    accountAgeDays: 60,
  },
  TRUSTED: {
    completedEventCount: 10,
    totalTicketsSold: 500,
    maxDisputeRate: 0.02,
    accountAgeDays: 0,
    requiresContactEmail: true,
  },
  TOP: {
    completedEventCount: 50,
    totalTicketsSold: 5000,
    maxDisputeRate: 0.01,
    accountAgeDays: 0,
    requiresVerifiedVenue: true,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const trustTierSchema = z.enum([
  "NEW",
  "ESTABLISHED",
  "TRUSTED",
  "TOP",
  "CUSTOM",
]);
const ownerTypeSchema = z.enum(["org", "human"]);

export const getOrganizerTrustProfileInputSchema = z
  .object({
    /** Provide orgId directly for an organization. */
    orgId: z.string().uuid().optional(),
    /** Provide humanId directly for a solo human organizer. */
    humanId: z.string().uuid().optional(),
    /** Provide eventId to auto-resolve the owner (org or human). */
    eventId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.orgId || v.humanId || v.eventId, {
    message: "One of orgId, humanId, or eventId is required",
  });

export const getOrganizerTrustProfileOutputSchema = z.object({
  ownerType: ownerTypeSchema,
  ownerId: z.string(),
  tier: trustTierSchema,
  /** Display label — computed from tier unless CUSTOM. */
  label: z.string().nullable(),
  /** Icon key (lucide icon name) or null. */
  icon: z.string().nullable(),
  /** How many events the organizer has completed. Public-safe metric. */
  completedEventCount: z.number().int(),
  /** Total tickets sold. Public-safe metric. */
  totalTicketsSold: z.number().int(),
  /** Account age in days. */
  accountAgeDays: z.number().int(),
  /** Whether a contact email is set. */
  hasContactEmail: z.boolean(),
});

export type GetOrganizerTrustProfileInput = z.infer<
  typeof getOrganizerTrustProfileInputSchema
>;
export type GetOrganizerTrustProfileOutput = z.infer<
  typeof getOrganizerTrustProfileOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetOrganizerTrustProfileDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tier computation (pure, exported for testing)
// ─────────────────────────────────────────────────────────────────────────────

export type TrustStatsInput = {
  completedEventCount: number;
  totalTicketsSold: number;
  disputeRate: number;
  accountAgeDays: number;
  hasContactEmail: boolean;
  hasVerifiedVenue: boolean;
};

/**
 * Deterministic tier computation from raw stats.
 * Returns the highest tier the organizer qualifies for.
 * Works for both orgs and humans — same thresholds.
 */
export function computeTrustTier(
  stats: TrustStatsInput,
): "NEW" | "ESTABLISHED" | "TRUSTED" | "TOP" {
  const { TOP, TRUSTED, ESTABLISHED } = TIER_THRESHOLDS;

  if (
    stats.completedEventCount >= TOP.completedEventCount &&
    stats.totalTicketsSold >= TOP.totalTicketsSold &&
    stats.disputeRate <= TOP.maxDisputeRate &&
    stats.hasVerifiedVenue
  ) {
    return "TOP";
  }

  if (
    stats.completedEventCount >= TRUSTED.completedEventCount &&
    stats.totalTicketsSold >= TRUSTED.totalTicketsSold &&
    stats.disputeRate <= TRUSTED.maxDisputeRate &&
    stats.hasContactEmail
  ) {
    return "TRUSTED";
  }

  if (
    stats.completedEventCount >= ESTABLISHED.completedEventCount &&
    stats.disputeRate <= ESTABLISHED.maxDisputeRate &&
    stats.accountAgeDays >= ESTABLISHED.accountAgeDays
  ) {
    return "ESTABLISHED";
  }

  return "NEW";
}

/** Default display labels for each tier. */
const TIER_LABELS: Record<string, string> = {
  NEW: "",
  ESTABLISHED: "Established",
  TRUSTED: "Trusted Organizer",
  TOP: "Top Organizer",
};

/** Default icon keys (lucide icon names) for each tier. */
const TIER_ICONS: Record<string, string | null> = {
  NEW: null,
  ESTABLISHED: "badge-check",
  TRUSTED: "shield-check",
  TOP: "crown",
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function emptyProfile(
  ownerType: "org" | "human",
  ownerId: string,
): GetOrganizerTrustProfileOutput {
  return {
    ownerType,
    ownerId,
    tier: "NEW",
    label: null,
    icon: null,
    completedEventCount: 0,
    totalTicketsSold: 0,
    accountAgeDays: 0,
    hasContactEmail: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public use case: returns the trust profile for an organizer (org or human).
 * If the organizer has a platform-override tier (CUSTOM or manual tier), that
 * takes precedence. Otherwise the tier is computed from live aggregate stats.
 */
export async function getOrganizerTrustProfile(
  deps: GetOrganizerTrustProfileDeps,
  rawInput: unknown,
): Promise<GetOrganizerTrustProfileOutput> {
  const input = parseInput(getOrganizerTrustProfileInputSchema, rawInput);

  // ── Resolve owner from eventId if needed ────────────────────────────
  let ownerType: "org" | "human" | undefined;
  let ownerId: string | undefined;

  if (input.orgId) {
    ownerType = "org";
    ownerId = input.orgId;
  } else if (input.humanId) {
    ownerType = "human";
    ownerId = input.humanId;
  } else if (input.eventId) {
    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      return emptyProfile("org", "");
    }
    if (event.orgId) {
      ownerType = "org";
      ownerId = event.orgId;
    } else if (event.humanId) {
      ownerType = "human";
      ownerId = event.humanId;
    } else {
      return emptyProfile("org", "");
    }
  }

  if (!ownerType || !ownerId) {
    throw {
      code: "invalid_input",
      message: "One of orgId, humanId, or eventId is required",
    } as const;
  }

  // ── Org path ────────────────────────────────────────────────────────
  if (ownerType === "org") {
    return resolveOrgTrust(deps, ownerId);
  }

  // ── Human path ──────────────────────────────────────────────────────
  return resolveHumanTrust(deps, ownerId);
}

async function resolveOrgTrust(
  deps: GetOrganizerTrustProfileDeps,
  orgId: string,
): Promise<GetOrganizerTrustProfileOutput> {
  const org = await deps.repos.organizations.getById(orgId);
  if (!org) {
    throw fail("ORG_NOT_FOUND");
  }

  // Platform override
  if (
    org.trustTier === "CUSTOM" ||
    (org.trustTier !== "NEW" && org.trustBadgeLabel)
  ) {
    const tier = org.trustTier;
    const label = org.trustBadgeLabel ?? TIER_LABELS[tier] ?? null;
    const icon = org.trustBadgeIcon ?? TIER_ICONS[tier] ?? null;
    const stats = await deps.repos.organizations.getOrgTrustStats(orgId);

    deps.logger?.info("orgs.get_trust_profile", {
      orgId,
      tier,
      source: "override",
    });

    return {
      ownerType: "org",
      ownerId: orgId,
      tier,
      label: label || null,
      icon,
      completedEventCount: stats.completedEventCount,
      totalTicketsSold: stats.totalTicketsSold,
      accountAgeDays: stats.accountAgeDays,
      hasContactEmail: stats.hasContactEmail,
    };
  }

  // Compute from live stats
  const stats = await deps.repos.organizations.getOrgTrustStats(orgId);
  const computedTier = computeTrustTier(stats);

  deps.logger?.info("orgs.get_trust_profile", {
    orgId,
    tier: computedTier,
    source: "computed",
    stats: {
      completedEventCount: stats.completedEventCount,
      totalTicketsSold: stats.totalTicketsSold,
      disputeRate: stats.disputeRate,
      accountAgeDays: stats.accountAgeDays,
    },
  });

  return {
    ownerType: "org",
    ownerId: orgId,
    tier: computedTier,
    label: TIER_LABELS[computedTier] || null,
    icon: TIER_ICONS[computedTier] ?? null,
    completedEventCount: stats.completedEventCount,
    totalTicketsSold: stats.totalTicketsSold,
    accountAgeDays: stats.accountAgeDays,
    hasContactEmail: stats.hasContactEmail,
  };
}

async function resolveHumanTrust(
  deps: GetOrganizerTrustProfileDeps,
  humanId: string,
): Promise<GetOrganizerTrustProfileOutput> {
  const human = await deps.repos.humans.getById(humanId);
  if (!human) {
    throw fail("HUMAN_NOT_FOUND");
  }

  // Platform override
  if (
    human.trustTier === "CUSTOM" ||
    (human.trustTier !== "NEW" && human.trustBadgeLabel)
  ) {
    const tier = human.trustTier;
    const label = human.trustBadgeLabel ?? TIER_LABELS[tier] ?? null;
    const icon = human.trustBadgeIcon ?? TIER_ICONS[tier] ?? null;
    const stats = await deps.repos.humans.getHumanTrustStats(humanId);

    deps.logger?.info("humans.get_trust_profile", {
      humanId,
      tier,
      source: "override",
    });

    return {
      ownerType: "human",
      ownerId: humanId,
      tier,
      label: label || null,
      icon,
      completedEventCount: stats.completedEventCount,
      totalTicketsSold: stats.totalTicketsSold,
      accountAgeDays: stats.accountAgeDays,
      hasContactEmail: stats.hasContactEmail,
    };
  }

  // Compute from live stats
  const stats = await deps.repos.humans.getHumanTrustStats(humanId);
  const computedTier = computeTrustTier(stats);

  deps.logger?.info("humans.get_trust_profile", {
    humanId,
    tier: computedTier,
    source: "computed",
    stats: {
      completedEventCount: stats.completedEventCount,
      totalTicketsSold: stats.totalTicketsSold,
      disputeRate: stats.disputeRate,
      accountAgeDays: stats.accountAgeDays,
    },
  });

  return {
    ownerType: "human",
    ownerId: humanId,
    tier: computedTier,
    label: TIER_LABELS[computedTier] || null,
    icon: TIER_ICONS[computedTier] ?? null,
    completedEventCount: stats.completedEventCount,
    totalTicketsSold: stats.totalTicketsSold,
    accountAgeDays: stats.accountAgeDays,
    hasContactEmail: stats.hasContactEmail,
  };
}
