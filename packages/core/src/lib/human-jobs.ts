export const HUMAN_JOB_VALUES = [
  "MUSICIAN",
  "DJ",
  "COMEDIAN",
  "DANCER",
  "VISUAL_ARTIST",
  "POET",
  "MAGICIAN",
  "SOUND_ENGINEER",
  "LIGHTING_ENGINEER",
  "PHOTOGRAPHER",
  "VIDEOGRAPHER",
  "PROMOTER",
  "EVENT_ORGANIZER",
  "BOOKING_AGENT",
  "OTHER",
] as const;

export type HumanJob = (typeof HUMAN_JOB_VALUES)[number];

/**
 * Job types for which the genre tag picker is contextually relevant.
 * Currently musicians only. Add to this set to expand genre prompting.
 */
export const GENRE_JOBS = new Set(["MUSICIAN"] as const);

/**
 * Review tiers collapse 15 job types into 3 buckets that control which
 * PlaceReview form questions are shown / hidden / reworded.
 *
 * - Performer: creative talent that performs live or on-stage
 * - Crew: technical / production support roles
 * - Industry: business / organizational roles
 */
export type ReviewTier = "performer" | "crew" | "industry";

export const PERFORMER_JOBS = new Set([
  "MUSICIAN",
  "DJ",
  "COMEDIAN",
  "DANCER",
  "VISUAL_ARTIST",
  "POET",
  "MAGICIAN",
] as const);

export const CREW_JOBS = new Set([
  "SOUND_ENGINEER",
  "LIGHTING_ENGINEER",
  "PHOTOGRAPHER",
  "VIDEOGRAPHER",
] as const);

export const INDUSTRY_JOBS = new Set([
  "PROMOTER",
  "EVENT_ORGANIZER",
  "BOOKING_AGENT",
  "OTHER",
] as const);

/**
 * Determine the review tier for a set of jobs. When a user holds jobs across
 * multiple tiers, the most "creative" tier wins (performer > crew > industry).
 * Returns null when jobs is empty so callers can prompt the user to pick a job first.
 */
export function getReviewTier(jobs: readonly string[]): ReviewTier | null {
  if (jobs.length === 0) return null;
  // TODO: typed sets should accept string to avoid cast; safe because callers pass validated HumanJob values
  if (jobs.some((j) => PERFORMER_JOBS.has(j as any))) return "performer";
  if (jobs.some((j) => CREW_JOBS.has(j as any))) return "crew";
  return "industry";
}

/**
 * Human-readable labels for each HumanJob value.
 * Used by UI pickers — keep in sync with the Prisma enum.
 */
export const HUMAN_JOB_LABELS: Record<HumanJob, string> = {
  MUSICIAN: "Musician",
  DJ: "DJ",
  COMEDIAN: "Comedian",
  DANCER: "Dancer",
  VISUAL_ARTIST: "Visual Artist",
  POET: "Poet",
  MAGICIAN: "Magician",
  SOUND_ENGINEER: "Sound Engineer",
  LIGHTING_ENGINEER: "Lighting Engineer",
  PHOTOGRAPHER: "Photographer",
  VIDEOGRAPHER: "Videographer",
  PROMOTER: "Promoter",
  EVENT_ORGANIZER: "Event Organizer",
  BOOKING_AGENT: "Booking Agent",
  OTHER: "Other",
};

export function isHumanJob(value: string): value is HumanJob {
  return value in HUMAN_JOB_LABELS;
}
