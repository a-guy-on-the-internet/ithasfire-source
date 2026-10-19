import type { NotificationRendererVariant } from "../renderers";

// ─────────────────────────────────────────────────────────────────────────────
// The variants whose in-app copy exists in every `NotificationLocale`.
//
// `notify` stores the render payload for EVERY variant, but the inbox only
// re-renders rows whose variant is listed here: an unconverted variant would
// re-render to the same English it already stores, so re-rendering it is pure
// cost — and a stored payload it can no longer parse would be reported for no
// gain.
//
// Adding a variant here is a promise, pinned by
// `__tests__/localized-variants.test.ts`: a frozen stored payload for it still
// parses, and it renders in every locale with text that differs from English.
// ─────────────────────────────────────────────────────────────────────────────

const LOCALIZED_VARIANT_LIST = [
  "rsvp.confirmed",
  "rsvp.date_cancelled",
  "rsvp.reminder",
  "settlement.payout-completed",
  "order.confirmed",
  "order.refund-processed",
  "resale.purchase-confirmed",
  "event.application-received",
  "event.application-approved",
  "event.application-rejected",
  "event.application-waitlisted",
  "event.application-back-in-review",
  "event.lineup-added",
  "event.lineup-left",
  "booking.lineup-answered",
  "booking.lineup-request-closed",
  "booking.lineup-removed",
  // Open-call notices (copy/open-calls.ts). open-call.message-received's
  // body is the sender's own words (verbatim by rule), like
  // booking.message-received: localized-variants.test.ts exempts its body.
  "open-call.picked",
  "open-call.not-this-time",
  "open-call.pulled",
  "open-call.message-received",
  "open-call.dropped-out",
  "open-call.application-received",
  // Booking requests, asks and holds (copy/booking.ts, copy/booking-holds.ts).
  // Not here: the folded booking.organizer-request-responded (nothing sends
  // it any more). booking.message-received IS here though its body is the
  // sender's own words (verbatim by rule): its title and label localize, and
  // localized-variants.test.ts exempts it from the body-differs check.
  "booking.request-received",
  "booking.lineup-invited",
  "booking.organizer-request-received",
  "booking.request-responded",
  "booking.booking-cancelled",
  "booking.message-received",
  "booking.ask-received",
  "booking.ask-answered",
  "booking.hold-placed",
  "booking.hold-placed-batch",
  "booking.hold-position-changed",
  "booking.hold-challenged",
  "booking.hold-challenge-extended",
  "booking.hold-challenge-answered",
  "booking.hold-released",
  "booking.hold-lost-date",
  "booking.hold-expired",
  "booking.hold-confirmed",
  // In-app-only variants for resale, dispute and listing-report notices whose
  // producers write the row directly and store the template themselves
  // (direct-money-safety-renderers.ts; copy in copy/resale-direct.ts,
  // copy/disputes.ts, copy/entity-reports.ts).
  "resale.listing-created",
  "resale.claim-opened",
  "resale.claim-resolved",
  "resale.claim-refunded",
  "resale.seller-sold",
  "resale.listing-closed-relist",
  "resale.sale-refunded-listing-closed",
  "dispute.risk-owner-notice",
  "entity-report.submitted",
  "entity-report.reviewed",
  // In-app-only variants whose producers write their own inbox row and store
  // the template themselves (direct-community-renderers.ts; copy in
  // copy/places-claims.ts, copy/volunteering.ts, copy/community-suggestions.ts).
  "place.claim-received",
  "place.claim-decided",
  "place.dispute-decided",
  "place.ownership-transferred",
  "place.dispute-filed",
  "volunteer.shift-reminder-in-app",
  "volunteer.start-reminder-in-app",
  "community.suggestion-received",
  "community.suggestion-reviewed",
  // Invite complaint auto-pause notices (W4), written directly by
  // events/invites/invite-pause-notifications.ts (copy/invite-pauses.ts).
  "invite-pause.opened",
  "invite-pause.decided",
  // Volunteer signup notices written through notify (copy/volunteer-signups.ts).
  // Not here: volunteer.broadcast (title and body are all organizer text, so
  // nothing localizes), volunteer.shift-reminder (nothing sends it).
  "volunteer.signup-received",
  "volunteer.signup-approved",
  "volunteer.signup-rejected",
  "volunteer.spot-opened",
  "volunteer.group-coordinator-assigned",
  "volunteer.pool-signup-received",
  "volunteer.group-signup-assigned",
  "volunteer.occurrence-cancelled",
  // Event, moderation, venue-confirmation, review-prompt and follow notices
  // written through notify (copy/events.ts, copy/moderation.ts). Not here:
  // event.attendee-reminder (its title and body are the organizer's own text),
  // notification.generic.
  "entity.new-event",
  "event.application-submission-received",
  "event.attendee-feedback-request",
  "event.cancelled",
  "event.changed",
  "event.location-revealed",
  "event.unlisted",
  "event.venue-confirmed",
  "event.venue-confirmation-withdrawn",
  "image.moderation.held",
  "image.moderation.approved",
  "image.moderation.rejected",
  "place.availability-setup-needed",
  "post-event.attendee-review-prompt",
  "post-event.performer-review-prompt",
  // A change to a frozen deal (copy/deals.ts, freeze-the-deal FR-006).
  "deal.frozen-change",
] as const satisfies readonly NotificationRendererVariant[];

export type LocalizedVariant = (typeof LOCALIZED_VARIANT_LIST)[number];

export const LOCALIZED_VARIANTS: ReadonlySet<string> = new Set(
  LOCALIZED_VARIANT_LIST,
);

export function isLocalizedVariant(variant: string): variant is LocalizedVariant {
  return LOCALIZED_VARIANTS.has(variant);
}
