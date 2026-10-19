/**
 * Personal "I'm going" marker for a PUBLISHED RSVP event. Idempotent per
 * (eventId, humanId), reversible, and never exposed as a public count.
 */
export interface EventRsvpRecord {
  id: string;
  eventId: string;
  humanId: string;
  createdAt: Date;
}
