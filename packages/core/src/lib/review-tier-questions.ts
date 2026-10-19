import type { ReviewTier } from "./human-jobs";

// ─────────────────────────────────────────────────────────────────────────────
// Review Tier Question Config
//
// Controls which PlaceReview questions are shown, hidden, or reworded based on
// the reviewer's HumanJob tier. Pure data — no UI or React dependencies.
//
// Screen IDs match the `id` field on each `ScreenDef` in the review form.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a screen behaves for a given tier.
 * - "show"  — render as normal (default if not in the config)
 * - "hide"  — skip entirely
 * - "reword" — render with alternative copy (question / helper / placeholder)
 */
export type ScreenVisibility = "show" | "hide" | "reword";

export interface TierScreenOverride {
  visibility: ScreenVisibility;
  /** Replacement question text when visibility is "reword". */
  question?: string;
  /** Replacement helper text when visibility is "reword". */
  helper?: string;
  /** Replacement detail placeholder when visibility is "reword". */
  detailPlaceholder?: string;
}

/**
 * Per-screen overrides for a single tier. Screens NOT listed here default
 * to "show" with no copy changes.
 */
export type TierConfig = Partial<Record<string, TierScreenOverride>>;

// ─── Per-job copy variants (within performer tier) ───────────────────────────

/**
 * Job-specific copy overrides that apply WITHIN the performer tier.
 * Used when the tier is "performer" but the wording should change based
 * on the reviewer's primary job (first PERFORMER_JOBS member in their list).
 */
export interface PerformerCopyVariant {
  /** The verb used in "Would you ____ here again?" */
  playAgainVerb: string;
  /** Audience fit question phrasing */
  audienceQuestion: string;
  /** Sound quality question phrasing */
  soundQuestion: string;
  /** Sound helper text */
  soundHelper: string;
  /** Equipment question phrasing */
  equipmentQuestion: string;
  /** Equipment helper text */
  equipmentHelper: string;
}

export const PERFORMER_COPY_VARIANTS: Record<string, PerformerCopyVariant> = {
  MUSICIAN: {
    playAgainVerb: "play",
    audienceQuestion: "Was it your crowd?",
    soundQuestion: "How was the PA / sound system?",
    soundHelper:
      "The house system — speakers, monitors, the room sound. Not the engineer (we'll ask that next).",
    equipmentQuestion: "What gear was waiting for you?",
    equipmentHelper:
      "Amps, drums, monitors — what was already on stage when you showed up?",
  },
  DJ: {
    playAgainVerb: "play",
    audienceQuestion: "Was it your crowd?",
    soundQuestion: "How was the sound system?",
    soundHelper: "The house PA, speakers, subs — the rig you played through.",
    equipmentQuestion: "What DJ setup was provided?",
    equipmentHelper:
      "CDJs, mixer, booth monitors — what was in the booth when you arrived?",
  },
  COMEDIAN: {
    playAgainVerb: "perform",
    audienceQuestion: "Was the crowd into it?",
    soundQuestion: "How was the mic?",
    soundHelper:
      "Could the room hear you clearly? Mic quality, monitors, room acoustics.",
    equipmentQuestion: "What was the stage setup?",
    equipmentHelper: "Mic stand, stool, spotlight — the basics for your set.",
  },
  DANCER: {
    playAgainVerb: "perform",
    audienceQuestion: "Was it the right audience for your style?",
    soundQuestion: "How was the sound system?",
    soundHelper:
      "Could you hear your music clearly on stage? Quality of the PA and monitors.",
    equipmentQuestion: "How was the stage/floor space?",
    equipmentHelper:
      "Floor quality, space, lighting — what did the performance area look like?",
  },
  VISUAL_ARTIST: {
    playAgainVerb: "show",
    audienceQuestion: "Was the crowd into your work?",
    soundQuestion: "How was the sound system?",
    soundHelper:
      "General room audio — was it listenable while people viewed your work?",
    equipmentQuestion: "What display setup was provided?",
    equipmentHelper:
      "Tables, easels, hanging hardware, lighting — what was available?",
  },
  POET: {
    playAgainVerb: "perform",
    audienceQuestion: "Was the crowd listening?",
    soundQuestion: "How was the mic?",
    soundHelper: "Could the room hear you? Mic quality and room acoustics.",
    equipmentQuestion: "What was the stage setup?",
    equipmentHelper: "Mic stand, stool, lighting — the basics for your set.",
  },
  MAGICIAN: {
    playAgainVerb: "perform",
    audienceQuestion: "Was the crowd into it?",
    soundQuestion: "How was the mic?",
    soundHelper: "Could the room hear you? Mic quality and room acoustics.",
    equipmentQuestion: "What was the stage setup?",
    equipmentHelper: "Mic stand, table, lighting — the basics for your set.",
  },
};

// ─── Tier configs ────────────────────────────────────────────────────────────

/**
 * Performer tier: all questions shown. Genre is handled separately by GENRE_JOBS.
 * Copy variations come from PERFORMER_COPY_VARIANTS above.
 * Merch is only shown for MUSICIAN (handled by MERCH_JOBS below).
 */
const PERFORMER_CONFIG: TierConfig = {
  // All screens shown by default — performer is the baseline.
  // Specific copy swaps are driven by PERFORMER_COPY_VARIANTS, not by overrides here.
};

const CREW_CONFIG: TierConfig = {
  // ── Hidden for crew ───────────────────────────────────────────────────
  audience: { visibility: "hide" },
  genre: { visibility: "hide" },
  draw: { visibility: "hide" },
  totalAttendance: { visibility: "hide" },
  merch: { visibility: "hide" },

  // ── Reworded for crew ─────────────────────────────────────────────────
  sound: {
    visibility: "reword",
    question: "Rate the house technical setup",
    helper:
      "Console quality, power, cabling, monitor rig — how was the gear you had to work with?",
    detailPlaceholder: "e.g. analog console, clean power, snake issues…",
  },
  equipment: {
    visibility: "reword",
    question: "What production gear was on-site?",
    helper:
      "Rigging points, power distro, lighting inventory — what was already there?",
    detailPlaceholder:
      "e.g. 32-channel digital board, LED pars, no follow spot…",
  },
  foh: {
    visibility: "reword",
    question: "How was the house crew?",
    helper:
      "Did the place provide a tech or stagehand? Were they helpful or in the way?",
  },
  playAgain: {
    visibility: "reword",
    question: "Would you work here again?",
    helper: "As a professional — was this a good place to crew?",
  },
  promotion: {
    visibility: "hide",
  },
};

const INDUSTRY_CONFIG: TierConfig = {
  // ── Hidden for industry ───────────────────────────────────────────────
  sound: { visibility: "hide" },
  equipment: { visibility: "hide" },
  foh: { visibility: "hide" },
  audience: { visibility: "hide" },
  genre: { visibility: "hide" },
  draw: { visibility: "hide" },
  totalAttendance: { visibility: "hide" },
  merch: { visibility: "hide" },
  loadIn: { visibility: "hide" },
  security: { visibility: "hide" },
  staff: { visibility: "hide" },

  // ── Reworded for industry ─────────────────────────────────────────────
  playAgain: {
    visibility: "reword",
    question: "Would you book or work with this place again?",
    helper: "As a business partner — was this a good place to work with?",
  },
  parking: {
    visibility: "reword",
    question: "How was access and logistics?",
    helper: "Loading, parking, access for your team or talent.",
  },
};

/**
 * Master lookup: tier → screen overrides.
 */
export const TIER_CONFIGS: Record<ReviewTier, TierConfig> = {
  performer: PERFORMER_CONFIG,
  crew: CREW_CONFIG,
  industry: INDUSTRY_CONFIG,
};

// ─── Merch visibility ────────────────────────────────────────────────────────

/**
 * Jobs for which the merch question is shown. Within the performer tier,
 * only musicians typically sell merch at shows.
 */
export const MERCH_JOBS = new Set(["MUSICIAN"] as const);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the screen override for a given tier + screen ID.
 * Returns undefined if the screen should render with no changes.
 */
export function getScreenOverride(
  tier: ReviewTier,
  screenId: string,
): TierScreenOverride | undefined {
  return TIER_CONFIGS[tier]?.[screenId];
}

/**
 * Whether a screen should be shown for a given tier.
 * Screens not mentioned in the tier config default to visible.
 */
export function isScreenVisible(tier: ReviewTier, screenId: string): boolean {
  const override = getScreenOverride(tier, screenId);
  return override?.visibility !== "hide";
}

/**
 * Get the performer copy variant for a specific job.
 * Falls back to MUSICIAN defaults if no variant is defined.
 */
export function getPerformerCopy(primaryJob: string): PerformerCopyVariant {
  const fallback = PERFORMER_COPY_VARIANTS.MUSICIAN;
  if (!fallback) {
    throw new Error("Missing MUSICIAN performer copy variant");
  }
  return PERFORMER_COPY_VARIANTS[primaryJob] ?? fallback;
}
