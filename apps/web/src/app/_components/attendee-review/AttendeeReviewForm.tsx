"use client";

import { AttendeeReviewFormOrchestrator } from "./AttendeeReviewFormOrchestrator";

export interface AttendeeReviewFormProps {
  eventId: string;
  eventSlug?: string | null;
  campaign?: string;
  onSubmitted?: () => void;
}

/**
 * Verified attendee review form. A small conversational, one-question-per-screen
 * flow (house pattern; see place-review). Eligibility is gated by the hosting
 * page — this component assumes the viewer is an eligible scanned attendee and
 * the server re-enforces every rule on submit.
 */
export function AttendeeReviewForm({
  eventId,
  eventSlug,
  campaign,
  onSubmitted,
}: AttendeeReviewFormProps) {
  return (
    <AttendeeReviewFormOrchestrator
      eventId={eventId}
      eventSlug={eventSlug}
      campaign={campaign}
      onSubmitted={onSubmitted}
    />
  );
}
