import type { FormData, ScreenDef } from "../_shared/types";
import { getScreenStatus } from "../_shared/types";
import {
  getReviewTier,
  GENRE_JOBS,
  PERFORMER_JOBS,
} from "@th/core/lib/human-jobs";
import {
  isScreenVisible,
  getScreenOverride,
  getPerformerCopy,
  MERCH_JOBS,
} from "@th/core/lib/review-tier-questions";
import { ABOUT_YOU_SCREEN, buildAboutYouScreen } from "./about-you";
import { CORE_SCREENS } from "./core";
import { OPTIONAL_SCREENS } from "./optional";
import { CONNECT_SCREENS } from "./connect";
import { buildReviewScreen } from "./review";
import { GIG_TIME_SCREEN } from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// Bridge screen — pure transition, no input
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_SCREEN: ScreenDef = {
  id: "bridge",
  phase: "bridge",
  question: "Solid — that helps other artists a lot.",
  helper:
    "Want to share more? It only takes another minute. Everything below is optional — skip any time.",
  autoAdvance: true,
  render: () => null,
};

// ─────────────────────────────────────────────────────────────────────────────
// All base screens (before tier filtering)
// ─────────────────────────────────────────────────────────────────────────────

// Insert gig time-of-day screen after the existing dayOfWeek screen
const PATCHED_OPTIONAL_SCREENS: ScreenDef[] = OPTIONAL_SCREENS.flatMap((s) => {
  if (s.id === "dayOfWeek") {
    return [s, GIG_TIME_SCREEN];
  }
  return [s];
});

// Add nudge text at strategic intervals (every ~4th question)
function addNudges(screens: ScreenDef[]): ScreenDef[] {
  const nudges: Record<string, string> = {
    promotion:
      "You're almost halfway. This is the stuff that actually matters.",
    playAgain: "Core questions done. You're helping someone avoid a bad gig.",
    booker: "You went full depth. Other artists owe you a beer.",
  };
  return screens.map((s) => {
    const nudge = nudges[s.id];
    return nudge ? { ...s, nudgeText: nudge } : s;
  });
}

const ALL_BASE_SCREENS: ScreenDef[] = addNudges([
  ABOUT_YOU_SCREEN,
  ...CORE_SCREENS,
  BRIDGE_SCREEN,
  ...PATCHED_OPTIONAL_SCREENS,
  ...CONNECT_SCREENS,
]);

// Same flow, minus "Where did you play?" — for callers that already know the
// venue (place page block, ?placeId= deep link). Asking again would be asking
// the user to re-state something they navigated through to get here. The
// anonymity promise the venue screen carried moves onto About You.
const KNOWN_PLACE_BASE_SCREENS: ScreenDef[] = addNudges([
  buildAboutYouScreen({ knownPlace: true }),
  ...CORE_SCREENS.filter((s) => s.id !== "venue"),
  BRIDGE_SCREEN,
  ...PATCHED_OPTIONAL_SCREENS,
  ...CONNECT_SCREENS,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic screen builder — filters and rewords based on human jobs
// ─────────────────────────────────────────────────────────────────────────────

export type BuildScreensOptions = {
  /** The venue is already known from context — drop the venue picker screen. */
  knownPlace?: boolean;
};

export function buildScreensForJobs(
  jobs: string[],
  { knownPlace = false }: BuildScreensOptions = {},
): ScreenDef[] {
  const tier = getReviewTier(jobs);
  const baseScreens = knownPlace ? KNOWN_PLACE_BASE_SCREENS : ALL_BASE_SCREENS;

  // If no tier yet (no jobs selected), show all screens (performer baseline)
  if (!tier) {
    return [...baseScreens, buildReviewScreen(baseScreens)];
  }

  // Get the primary performer job (first one in the PERFORMER_JOBS set)
  const primaryJob =
    jobs.find((j) => PERFORMER_JOBS.has(j as any)) ?? "MUSICIAN";

  // Filter based on tier
  const filtered = baseScreens.filter((screen) => {
    // Always-visible screens
    if (screen.id === "aboutYou" || screen.id === "bridge") return true;
    // Completion incentive always shown
    if (screen.id === "completionIncentive") return true;
    // Gig time-of-day screen always visible in optional phase
    if (screen.id === "gigTimeOfDay") return true;
    // genre screen: only visible if user has a GENRE_JOBS member
    if (screen.id === "genre")
      return jobs.some((j) => GENRE_JOBS.has(j as any));
    // merch screen: only visible if user has a MERCH_JOBS member
    if (screen.id === "merch")
      return jobs.some((j) => MERCH_JOBS.has(j as any));
    // Everything else: check tier config
    return isScreenVisible(tier, screen.id);
  });

  // Apply rewords from tier config
  let reworded = filtered.map((screen) => {
    const override = getScreenOverride(tier, screen.id);
    if (override?.visibility !== "reword") return screen;
    return {
      ...screen,
      question: override.question ?? screen.question,
      helper: override.helper ?? screen.helper,
    };
  });

  // Apply performer copy variants
  if (tier === "performer") {
    const copy = getPerformerCopy(primaryJob);
    reworded = reworded.map((screen) => {
      if (screen.id === "playAgain") {
        return {
          ...screen,
          question: `Would you ${copy.playAgainVerb} here again?`,
        };
      }
      if (screen.id === "audience") {
        return { ...screen, question: copy.audienceQuestion };
      }
      if (screen.id === "sound") {
        return {
          ...screen,
          question: copy.soundQuestion,
          helper: copy.soundHelper,
        };
      }
      if (screen.id === "equipment") {
        return {
          ...screen,
          question: copy.equipmentQuestion,
          helper: copy.equipmentHelper,
        };
      }
      return screen;
    });
  }

  return [...reworded, buildReviewScreen(reworded)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Static default export — performer baseline for backwards compat
// ─────────────────────────────────────────────────────────────────────────────

export const SCREENS: ScreenDef[] = buildScreensForJobs([]);

export const TOTAL_SCREENS = SCREENS.length;

/** Index of the review screen (last) */
export const REVIEW_IDX = SCREENS.findIndex((s) => s.phase === "review");

// ─────────────────────────────────────────────────────────────────────────────
// Status summary — DEPRECATED: uses static SCREENS, not tier-filtered list.
// The review screen's closure in review.tsx is the correct implementation.
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use buildScreensForJobs() and the review screen's internal getStatusSummary instead. */
export function getStatusSummary(d: FormData): {
  answered: number;
  total: number;
  requiredMissing: number;
} {
  let answered = 0;
  let total = 0;
  let requiredMissing = 0;
  for (const s of SCREENS) {
    if (s.phase === "bridge" || s.phase === "review") continue;
    total++;
    const status = getScreenStatus(s.id, d);
    if (status === "complete") answered++;
    if (status === "required-empty") requiredMissing++;
  }
  return { answered, total, requiredMissing };
}
