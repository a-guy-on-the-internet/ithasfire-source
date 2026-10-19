import type { HumanJob } from "@th/core/lib/human-jobs";

/**
 * Localized label keys for each HumanJob enum value (catalog: `account.sJob*`).
 *
 * Single source of truth for job-label i18n — consumed by the settings /
 * place-review `HumanJobsPicker` and by the public profile hero's role chips
 * (`HumanHero`). Keep in sync with `HUMAN_JOB_LABELS` in
 * `@th/core/lib/human-jobs` and with the Prisma enum.
 */
export const JOB_LABEL_KEYS: Record<HumanJob, string> = {
  MUSICIAN: "account.sJobMusician",
  DJ: "account.sJobDj",
  COMEDIAN: "account.sJobComedian",
  DANCER: "account.sJobDancer",
  VISUAL_ARTIST: "account.sJobVisualArtist",
  POET: "account.sJobPoet",
  MAGICIAN: "account.sJobMagician",
  SOUND_ENGINEER: "account.sJobSoundEngineer",
  LIGHTING_ENGINEER: "account.sJobLightingEngineer",
  PHOTOGRAPHER: "account.sJobPhotographer",
  VIDEOGRAPHER: "account.sJobVideographer",
  PROMOTER: "account.sJobPromoter",
  EVENT_ORGANIZER: "account.sJobEventOrganizer",
  BOOKING_AGENT: "account.sJobBookingAgent",
  OTHER: "account.sJobOther",
};
