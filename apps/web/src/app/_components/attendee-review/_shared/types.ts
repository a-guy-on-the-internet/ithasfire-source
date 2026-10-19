import type { ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Attendee review form — small state bag. One submission maps directly to the
// attendeeReviews.submit contract (overall required; facets + text optional).
// ─────────────────────────────────────────────────────────────────────────────

export interface AttendeeFormData {
  /** 1-5, 0 = unset. Required. */
  overallRating: number;
  /** 1-5, 0 = unset. Optional. */
  soundQuality: number;
  /** 1-5, 0 = unset. Optional. */
  organization: number;
  /** 1-5, 0 = unset. Optional. */
  venueComfort: number;
  /** 1-5, 0 = unset. Optional. */
  valueForMoney: number;
  /** Private organizer-facing comment, ≤2000 chars. Optional. */
  text: string;
}

export const EMPTY: AttendeeFormData = {
  overallRating: 0,
  soundQuality: 0,
  organization: 0,
  venueComfort: 0,
  valueForMoney: 0,
  text: "",
};

// ─────────────────────────────────────────────────────────────────────────────
// Screen definitions
// ─────────────────────────────────────────────────────────────────────────────

export type ScreenPhase = "core" | "optional";

export interface ScreenDef {
  id: string;
  phase: ScreenPhase;
  question: string;
  helper?: string;
  /** Only `overall` is required — the server enforces the same. */
  required?: boolean;
  /** Return an error string if invalid, else undefined. */
  validate?: (d: AttendeeFormData) => string | undefined;
  render: (
    d: AttendeeFormData,
    onChange: (patch: Partial<AttendeeFormData>) => void,
    /** Advance to the next screen (used for auto-advance on rating pick). */
    advance: () => void,
  ) => ReactNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload — only send facets the attendee actually rated.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttendeeReviewPayload {
  eventId: string;
  overallRating: number;
  soundQuality?: number;
  venueComfort?: number;
  organization?: number;
  valueForMoney?: number;
  text?: string;
}

export function buildPayload(
  eventId: string,
  d: AttendeeFormData,
): AttendeeReviewPayload {
  const facet = (v: number) => (v >= 1 && v <= 5 ? v : undefined);
  const text = d.text.trim();
  return {
    eventId,
    overallRating: d.overallRating,
    soundQuality: facet(d.soundQuality),
    organization: facet(d.organization),
    venueComfort: facet(d.venueComfort),
    valueForMoney: facet(d.valueForMoney),
    text: text.length > 0 ? text.slice(0, 2000) : undefined,
  };
}
