/**
 * Submission window (attendee-reviews FR-001): a scanned attendee may submit
 * from event end until end + 30 days, then the window closes for good.
 */
export const ATTENDEE_REVIEW_WINDOW_DAYS = 30;

export const ATTENDEE_REVIEW_WINDOW_MS =
  ATTENDEE_REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Max length of the PRIVATE organizer-facing comment (FR-001). */
export const ATTENDEE_REVIEW_TEXT_MAX_CHARS = 2000;
