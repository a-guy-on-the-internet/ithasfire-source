import type { ReactNode } from "react";
import type { HumanJob } from "@th/core/lib/human-jobs";

// ─────────────────────────────────────────────────────────────────────────────
// Form data — the complete state bag for a single review
// ─────────────────────────────────────────────────────────────────────────────

export interface FormData {
  placeId: string;
  placeName: string;
  placeCity: string;
  placeCountry: string;
  placeState: string;
  payoutRange: string;
  payoutCents: string;
  paymentMethods: string[];
  paymentMethodOther: string;
  paymentMethodDetail: string;
  venuePromoted: string;
  venuePromotedDetail: string;
  soundQuality: string;
  soundQualityDetail: string;
  audienceFit: string;
  audienceFitDetail: string;
  wouldPlayAgain: string;
  wouldPlayAgainDetail: string;
  stageEquipment: string;
  stageEquipmentDetail: string;
  parkingLoadIn: string;
  parkingLoadInDetail: string;
  bookerRating: string;
  bookerRatingDetail: string;
  genreTags: string[];
  dayOfWeek: number | null;
  merchAllowed: string;
  merchCutPct: string;
  staffSupport: string;
  staffSupportDetail: string;
  independentVenue: string;
  estimatedDraw: string;
  totalAttendance: string;
  comment: string;
  soundDetail: string;
  anonymousEmail: string;
  anonymousName: string;
  // About You (human job identity)
  humanJobs: HumanJob[];
  humanOtherJobDescription: string;
  // New conversational fields (stored in existing detail columns)
  fohRating: string;
  fohDetail: string;
  loadInEarliest: string;
  loadOutLatest: string;
  securityFrontDoor: string;
  securityLoadIn: string;
  gigDate: string;
  gigTimeOfDay: string;
  gigTimeExact: string;
}

export const EMPTY: FormData = {
  placeId: "",
  placeName: "",
  placeCity: "",
  placeCountry: "",
  placeState: "",
  payoutRange: "",
  payoutCents: "",
  paymentMethods: [],
  paymentMethodOther: "",
  paymentMethodDetail: "",
  venuePromoted: "",
  venuePromotedDetail: "",
  soundQuality: "",
  soundQualityDetail: "",
  audienceFit: "",
  audienceFitDetail: "",
  wouldPlayAgain: "",
  wouldPlayAgainDetail: "",
  stageEquipment: "",
  stageEquipmentDetail: "",
  parkingLoadIn: "",
  parkingLoadInDetail: "",
  bookerRating: "",
  bookerRatingDetail: "",
  genreTags: [],
  dayOfWeek: null,
  merchAllowed: "",
  merchCutPct: "",
  staffSupport: "",
  staffSupportDetail: "",
  independentVenue: "",
  estimatedDraw: "",
  totalAttendance: "",
  comment: "",
  soundDetail: "",
  anonymousEmail: "",
  anonymousName: "",
  humanJobs: [],
  humanOtherJobDescription: "",
  fohRating: "",
  fohDetail: "",
  loadInEarliest: "",
  loadOutLatest: "",
  securityFrontDoor: "",
  securityLoadIn: "",
  gigDate: "",
  gigTimeOfDay: "",
  gigTimeExact: "",
};

// ─────────────────────────────────────────────────────────────────────────────
// Screen definitions
// ─────────────────────────────────────────────────────────────────────────────

export type ScreenPhase = "core" | "bridge" | "optional" | "connect" | "review";

export interface ScreenDef {
  id: string;
  phase: ScreenPhase;
  question: string;
  helper?: string;
  required?: boolean;
  /** Return error string if invalid, or undefined if OK */
  validate?: (d: FormData) => string | undefined;
  /**
   * Auto-advance after the user makes a selection.
   * `true` = always auto-advance once the screen has a value.
   * `(d: FormData) => boolean` = conditionally auto-advance.
   * Used for single-select ChipGroups and bridge screens so the user
   * doesn't have to press CONTINUE for one-tap questions.
   */
  autoAdvance?: boolean | ((d: FormData) => boolean);
  /**
   * Custom auto-advance delay in ms. If omitted, the orchestrator picks
   * a default based on screen phase (bridge = 2800, regular = 800).
   */
  autoAdvanceDelay?: number;
  /** Short motivational line shown after answering — appears at steps 4, 7, 11. */
  nudgeText?: string;
  render: (
    d: FormData,
    onChange: (patch: Partial<FormData>) => void,
    error: string | undefined,
    /** Callback to jump to a specific screen index (used by ReviewScreen) */
    jumpTo?: (idx: number) => void,
  ) => ReactNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen status helpers
// ─────────────────────────────────────────────────────────────────────────────

export type ScreenStatus = "complete" | "empty" | "required-empty";

export function getScreenStatus(id: string, d: FormData): ScreenStatus {
  switch (id) {
    case "aboutYou":
      return d.humanJobs.length > 0 ? "complete" : "required-empty";
    case "venue":
      return d.placeId || (d.placeName && d.placeCity)
        ? "complete"
        : "required-empty";
    case "payout":
      return d.payoutRange ? "complete" : "required-empty";
    case "paymentMethod":
      return d.paymentMethods.length > 0 ? "complete" : "required-empty";
    case "promotion":
      return d.venuePromoted ? "complete" : "required-empty";
    case "sound":
      return d.soundQuality ? "complete" : "required-empty";
    case "audience":
      return d.audienceFit ? "complete" : "required-empty";
    case "playAgain":
      return d.wouldPlayAgain ? "complete" : "required-empty";
    case "genre":
      return d.genreTags.length > 0 ? "complete" : "required-empty";
    case "draw":
      return d.estimatedDraw ? "complete" : "empty";
    case "totalAttendance":
      return d.totalAttendance ? "complete" : "empty";
    case "gigDate":
    case "dayOfWeek":
      return d.dayOfWeek !== null || d.gigDate ? "complete" : "empty";
    case "gigTimeOfDay":
      return d.gigTimeOfDay ? "complete" : "empty";
    case "completionIncentive":
      return "complete";
    case "equipment":
      return d.stageEquipment ? "complete" : "empty";
    case "parking":
      return d.parkingLoadIn ? "complete" : "empty";
    case "booker":
      return d.bookerRating ? "complete" : "empty";
    case "merch":
      return d.merchAllowed ? "complete" : "empty";
    case "staff":
      return d.staffSupport ? "complete" : "empty";
    case "independent":
      return d.independentVenue ? "complete" : "empty";
    case "foh":
      return d.fohRating ? "complete" : "empty";
    case "loadIn":
      return d.loadInEarliest || d.loadOutLatest ? "complete" : "empty";
    case "security":
      return d.securityFrontDoor && d.securityLoadIn ? "complete" : "empty";
    case "comment":
      return d.comment.trim() ? "complete" : "empty";
    case "connectName":
      return d.anonymousName.trim() ? "complete" : "empty";
    case "connectEmail":
      return d.anonymousEmail.trim() ? "complete" : "empty";
    default:
      return "empty";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout range → midpoint conversion
// ─────────────────────────────────────────────────────────────────────────────

export function rangeToMidpointCents(rangeKey: string): number | undefined {
  switch (rangeKey) {
    case "UNPAID":
      return 0;
    case "RANGE_1_100":
      return 50_00;
    case "RANGE_100_250":
      return 175_00;
    case "RANGE_250_500":
      return 375_00;
    case "RANGE_500_1000":
      return 750_00;
    case "RANGE_1000_PLUS":
      return 1500_00;
    default:
      return undefined;
  }
}
