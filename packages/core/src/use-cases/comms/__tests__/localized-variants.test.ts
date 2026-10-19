import { describe, expect, it } from "vitest";

import { LOCALIZED_VARIANTS, type LocalizedVariant } from "../copy";
import { NOTIFICATION_LOCALES } from "../locale";
import { getNotificationRenderer, renderNotification } from "../renderers";

/**
 * One payload per localized variant, FROZEN as `notify` stored it the day the
 * variant joined `LOCALIZED_VARIANTS`. These are the contract: rows like these
 * sit in the database and are re-rendered on every inbox read.
 *
 * NEVER edit an entry to make a failing test pass. A failure here means a
 * schema change broke stored rows: make the change backward compatible, or
 * bump `IN_APP_TEMPLATE_VERSION` (see the comment on `renderNotification`)
 * and ADD a fixture for the new version alongside.
 */
const STORED_PAYLOADS: { readonly [V in LocalizedVariant]: unknown } = {
  // Stored since 2026-10-03.
  "rsvp.confirmed": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventTitle: "Open Mic Night",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    endsAtIso: null,
    timezone: "America/Chicago",
    venueName: "The Hall",
    addressText: "123 Main St",
    heroImageUrl: null,
    eventUrl: "https://ithas.fire/e/open-mic-night",
    manageRsvpsUrl: "https://ithas.fire/my-rsvps",
  },
  // Stored since 2026-10-04, as is every entry below this one.
  "rsvp.date_cancelled": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventDateId: "4a2d9e3f-5c6b-4d7e-8f90-0b1c2d3e4f5a",
    eventTitle: "Weekly Open Mic",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    venueName: "The Hall",
    heroImageUrl: null,
    eventUrl: "https://ithas.fire/e/weekly-open-mic",
  },
  "rsvp.reminder": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventDateId: null,
    eventTitle: "Open Mic Night",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    endsAtIso: null,
    timezone: "America/Chicago",
    venueName: "The Hall",
    addressText: "123 Main St",
    heroImageUrl: null,
    eventUrl: "https://ithas.fire/e/open-mic-night",
    manageRsvpsUrl: "https://ithas.fire/my-rsvps",
  },
  "settlement.payout-completed": {
    payeeId: "10000000-0000-4000-8000-000000000001",
    payoutId: "20000000-0000-4000-8000-000000000002",
    payoutItemId: "30000000-0000-4000-8000-000000000003",
    amountCents: 12500,
    currency: "usd",
    settlementCount: 2,
    kind: "payout",
    payoutDateIso: "2026-09-20T05:00:03.000Z",
    payoutsUrl: "https://ithas.fire/admin/acme/payments",
  },
  "order.confirmed": {
    orderId: "11111111-0000-4000-8000-000000000001",
    eventId: "22222222-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    ticketCount: 2,
    amountCents: 5000,
    currency: "usd",
  },
  "order.refund-processed": {
    orderId: "11111111-0000-4000-8000-000000000001",
    refundId: "re_123",
    eventId: "22222222-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    amountCents: 1000,
    currency: "usd",
    status: "PART_REFUNDED",
  },
  "resale.purchase-confirmed": {
    orderId: "11111111-0000-4000-8000-000000000001",
    eventId: "22222222-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    amountCents: 4000,
    currency: "usd",
  },
  // Stored since 2026-10-05, as is every entry below this one: the producers
  // (events/*, event-humans/*, booking-requests/notify-booking-lineup-*) pass
  // exactly these keys through `notify`.
  "event.application-received": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventTitle: "Rooftop Showcase",
    submissionId: "7d5a2162-8f9e-4a01-9bc3-3e4f5a6b7c8d",
    eventUrl: "https://ithas.fire/e/rooftop-showcase",
    appliedAtIso: "2026-10-04T15:00:00.000Z",
    timezone: "America/Chicago",
  },
  "event.application-approved": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventTitle: "Rooftop Showcase",
    submissionId: "7d5a2162-8f9e-4a01-9bc3-3e4f5a6b7c8d",
    approvalToken: "tok_9f8e7d6c5b4a",
    approvalUrl:
      "https://ithas.fire/api/events/3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f/claim?token=tok_9f8e7d6c5b4a",
    expiresAtIso: "2026-10-11T15:00:00.000Z",
    eventUrl: "https://ithas.fire/e/rooftop-showcase",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
  },
  "event.application-rejected": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventTitle: "Rooftop Showcase",
    submissionId: "7d5a2162-8f9e-4a01-9bc3-3e4f5a6b7c8d",
    decisionReason: "We're full this season",
    organizerEventsUrl: "https://ithas.fire/o/rooftop-collective",
  },
  "event.application-waitlisted": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventTitle: "Rooftop Showcase",
    submissionId: "7d5a2162-8f9e-4a01-9bc3-3e4f5a6b7c8d",
    eventUrl: "https://ithas.fire/e/rooftop-showcase",
  },
  "event.application-back-in-review": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventTitle: "Rooftop Showcase",
    submissionId: "7d5a2162-8f9e-4a01-9bc3-3e4f5a6b7c8d",
    eventUrl: "https://ithas.fire/e/rooftop-showcase",
  },
  "event.lineup-added": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventHumanId: "5b3e0f40-6d7c-4e8f-9fa1-1c2d3e4f5a6b",
    eventTitle: "Friday Night Sessions",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    roleLabel: "Performer",
    addedByName: "Sam Rivera",
    lineupsUrl: "https://ithas.fire/my-lineups",
    publiclyListed: true,
    eventEnded: false,
    organiserWillBeTold: true,
  },
  "event.lineup-left": {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventHumanId: "5b3e0f40-6d7c-4e8f-9fa1-1c2d3e4f5a6b",
    eventTitle: "Friday Night Sessions",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    personName: "Jo Park",
    lineupUrl:
      "https://ithas.fire/admin/events/3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f/edit?section=lineup",
    wasPubliclyListed: true,
  },
  "booking.lineup-answered": {
    bookingRequestId: "8e6b3273-9fa0-4b12-8cd4-4f5a6b7c8d9e",
    actId: "9f7c4384-a0b1-4c23-9de5-5a6b7c8d9e0f",
    humanId: "10000000-0000-4000-8000-000000000001",
    actName: "Paper Moth",
    venueName: "The Corner Stage",
    answer: "joined",
    targetUrl: "https://ithas.fire/admin/corner-booking/bookings",
  },
  "booking.lineup-request-closed": {
    bookingRequestId: "8e6b3273-9fa0-4b12-8cd4-4f5a6b7c8d9e",
    actId: "9f7c4384-a0b1-4c23-9de5-5a6b7c8d9e0f",
    humanId: "10000000-0000-4000-8000-000000000001",
    senderName: "Corner Booking Collective",
    venueName: "The Corner Stage",
    asGroupName: "Paper Moth",
    preferredDates: ["2026-08-14T20:00"],
    targetUrl:
      "https://ithas.fire/bookings/acts/8e6b3273-9fa0-4b12-8cd4-4f5a6b7c8d9e",
  },
  "booking.lineup-removed": {
    bookingRequestId: "8e6b3273-9fa0-4b12-8cd4-4f5a6b7c8d9e",
    actId: "9f7c4384-a0b1-4c23-9de5-5a6b7c8d9e0f",
    humanId: "10000000-0000-4000-8000-000000000001",
    senderName: "Corner Booking Collective",
    venueName: "The Corner Stage",
    preferredDates: ["2026-08-14"],
  },
  // Booking requests / asks / holds — stored since 2026-10-05. Shapes follow
  // booking-requests/notify-*.ts and booking-holds/notify-booking-hold-intents.ts
  // (`buildMessage` + the per-recipient base: ids, placeName, date, timezone,
  // targetUrl).
  "booking.request-received": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    placeId: "a2000000-0000-4000-8000-000000000002",
    placeName: "The Corner Stage",
    actName: "Los Lobos Chicos",
    contactName: null,
    contactEmail: null,
    message: "We'd love a Friday in August.",
    preferredDates: ["2026-08-14", "2026-08-21"],
    source: "PLATFORM",
    inboxUrl:
      "https://ithas.fire/admin/corner/places/a2000000-0000-4000-8000-000000000002/bookings",
  },
  "booking.lineup-invited": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    humanId: "10000000-0000-4000-8000-000000000001",
    senderName: "Corner Booking Collective",
    venueName: "The Corner Stage",
    preferredDates: ["2026-08-14T20:00"],
    targetUrl: "https://ithas.fire/lineup-invite/a1000000",
  },
  "booking.organizer-request-received": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    orgName: "Acme Presents",
    message: "Come play our summer series.",
    preferredDates: ["2026-08-14"],
    attachedEventTitle: "Sunset Sessions",
    requestsUrl: "https://ithas.fire/account/settings/booking-requests",
  },
  "booking.request-responded": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    responderName: "The Corner Stage",
    action: "declined",
    reason: "We're booked through September.",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
  },
  "booking.booking-cancelled": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    cancelledByName: "The Corner Stage",
    cancelledBy: "place",
    date: "2026-08-14",
    reason: "The room flooded.",
    eventCancelled: true,
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
  },
  "booking.ask-received": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    askId: "a3000000-0000-4000-8000-000000000003",
    venueName: "The Corner Stage",
    kind: "FILE",
    label: "Stage plot",
    note: "A PDF is fine.",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
  },
  "booking.ask-answered": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    askId: "a3000000-0000-4000-8000-000000000003",
    answeredByName: "Los Lobos Chicos",
    kind: "FILE",
    label: "Stage plot",
    targetUrl:
      "https://ithas.fire/admin/corner/places/a2000000-0000-4000-8000-000000000002/bookings",
  },
  "booking.hold-placed": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
    position: 2,
  },
  "booking.hold-placed-batch": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
    dates: [
      { date: "2026-08-14", position: 1 },
      { date: "2026-08-21", position: 2 },
    ],
  },
  "booking.hold-position-changed": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
    position: 1,
  },
  // The challenged act: no `audience` (the schema defaults it to "act").
  "booking.hold-challenged": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
    position: 1,
    respondByISO: "2026-08-12T23:00:00.000Z",
    keepWill: "book_now",
  },
  "booking.hold-challenge-extended": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
    position: 1,
    respondByISO: "2026-08-13T23:00:00.000Z",
  },
  "booking.hold-challenge-answered": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl:
      "https://ithas.fire/admin/corner/places/a2000000-0000-4000-8000-000000000002/bookings",
    audience: "staff",
    answer: "kept",
    actName: "Los Lobos Chicos",
  },
  "booking.hold-released": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
    reason: "MANUAL",
  },
  "booking.hold-lost-date": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
  },
  "booking.hold-expired": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
    audience: "act",
  },
  "booking.hold-confirmed": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    holdId: "a4000000-0000-4000-8000-000000000004",
    placeName: "The Corner Stage",
    date: "2026-08-14",
    timezone: "America/Chicago",
    targetUrl: "https://ithas.fire/account/settings/booking-requests",
  },
  // notifyBookingRequestMessage: { bookingRequestId, messageId, senderLabel,
  // preview } plus the per-recipient threadUrl.
  "booking.message-received": {
    bookingRequestId: "a1000000-0000-4000-8000-000000000001",
    messageId: "a5000000-0000-4000-8000-000000000005",
    senderLabel: "Corner Booking Collective",
    preview: "Can you load in at 5 instead of 6?",
    threadUrl: "https://ithas.fire/account/settings/booking-requests",
  },
  // Stored since 2026-10-05: the direct-write resale / dispute / listing-report
  // rows (direct-money-safety-renderers.ts), shaped exactly as their producers
  // build them.
  // notifyListingCreated (resale/notify-resale-events.ts).
  "resale.listing-created": {
    listingId: "b1000000-0000-4000-8000-000000000001",
    eventTitle: "Sunset Sessions",
    askPriceCents: 2500,
    currency: "usd",
    listingUrl: "https://ithas.fire/my/resale",
  },
  // notifyClaimOpened: `deadline` is create-claim's ISO string.
  "resale.claim-opened": {
    claimId: "b2000000-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    claimKind: "entry_denied",
    deadlineIso: "2026-09-13T12:00:00.000Z",
    claimUrl:
      "https://ithas.fire/my/resale/claims/b2000000-0000-4000-8000-000000000002",
  },
  // notifyClaimResolved, buyer side (the seller side is in the extras).
  "resale.claim-resolved": {
    claimId: "b2000000-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    audience: "buyer",
    status: "approved",
    resolution: "full_refund",
    claimUrl:
      "https://ithas.fire/my/resale/claims/b2000000-0000-4000-8000-000000000002",
  },
  // Stored since 2026-10-07: notifyClaimRefunded
  // (resale/notify-claim-refunded.ts).
  "resale.claim-refunded": {
    claimId: "b2000000-0000-4000-8000-000000000002",
    orderId: "b3000000-0000-4000-8000-000000000003",
    eventTitle: "Sunset Sessions",
    amountCents: 5500,
    currency: "usd",
    orderUrl:
      "https://ithas.fire/my-tickets/b3000000-0000-4000-8000-000000000003",
  },
  // notifyResaleSellerSold (resale/notify-resale-seller-sold.ts).
  "resale.seller-sold": {
    listingId: "b1000000-0000-4000-8000-000000000001",
    orderId: "b3000000-0000-4000-8000-000000000003",
    eventTitle: "Sunset Sessions",
    amountCents: 4250,
    currency: "usd",
    resaleUrl: "https://ithas.fire/my/resale",
  },
  // Stored since 2026-10-13: cancelLegacyResaleListings
  // (resale/cancel-legacy-resale-listings.ts).
  "resale.listing-closed-relist": {
    listingId: "b1000000-0000-4000-8000-000000000001",
    eventTitle: "Sunset Sessions",
    askPriceCents: 5000,
    currency: "usd",
    resaleUrl: "https://ithas.fire/sell/listings/new",
  },
  // Stored since 2026-10-13: a refund unwind that closed a listing priced
  // under the removed markup split (resale/_shared/send-legacy-relist-notices.ts).
  "resale.sale-refunded-listing-closed": {
    listingId: "b1000000-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    askPriceCents: 5000,
    currency: "usd",
    resaleUrl: "https://ithas.fire/sell/listings/new",
  },
  // notifyDisputeLifecycle's risk-owner notice, opened (disputes/).
  "dispute.risk-owner-notice": {
    disputeId: "b4000000-0000-4000-8000-000000000004",
    notice: "opened",
    eventTitle: "Sunset Sessions",
    isMembership: false,
    evidenceDueIso: "2026-09-24T12:00:00.000Z",
    lostOutcome: null,
  },
  // notifyEntityReportSubmitted (entity-reports/_shared/).
  "entity-report.submitted": {
    reportId: "b5000000-0000-4000-8000-000000000005",
    subjectType: "PLACE",
    subjectId: "b6000000-0000-4000-8000-000000000006",
    reason: "CLOSED_OR_GONE",
  },
  // notifyEntityReportReviewed: the reviewer's note is verbatim free text.
  "entity-report.reviewed": {
    reportId: "b5000000-0000-4000-8000-000000000005",
    subjectType: "PLACE",
    subjectId: "b6000000-0000-4000-8000-000000000006",
    verdict: "RESOLVED",
    reviewNote: "Marked closed.",
  },
  // Stored since 2026-10-05, as is every entry below this one. In-app-only
  // variants whose producers write the row themselves
  // (places/_shared/claim-notifications.ts,
  // volunteering/send-volunteer-shift-reminders.ts,
  // community/_shared/suggestion-notifications.ts).
  "place.claim-received": {
    placeId: "c2000000-0000-4000-8000-000000000002",
    placeName: "The Corner Stage",
    requestId: "c3000000-0000-4000-8000-000000000003",
    source: "OWNERSHIP_CLAIM",
  },
  "place.claim-decided": {
    placeId: "c2000000-0000-4000-8000-000000000002",
    placeName: "The Corner Stage",
    decision: "APPROVED",
    reviewerNotes: null,
  },
  "place.dispute-decided": {
    placeId: "c2000000-0000-4000-8000-000000000002",
    placeName: "The Corner Stage",
    decision: "APPROVED",
    reviewerNotes: null,
  },
  "place.ownership-transferred": {
    placeId: "c2000000-0000-4000-8000-000000000002",
    placeName: "The Corner Stage",
    requestId: "c3000000-0000-4000-8000-000000000003",
  },
  "place.dispute-filed": {
    placeId: "c2000000-0000-4000-8000-000000000002",
    placeName: "The Corner Stage",
    requestId: "c3000000-0000-4000-8000-000000000003",
  },
  "volunteer.shift-reminder-in-app": {
    signupId: "c4000000-0000-4000-8000-000000000004",
    eventId: "c5000000-0000-4000-8000-000000000005",
    eventTitle: "Summer Fest",
    roleName: "Security",
    shiftLabel: "Morning",
    kind: "REMINDER_24H",
    manageUrl:
      "https://ithas.fire/events/summer-fest/volunteer?signup=c4000000-0000-4000-8000-000000000004",
  },
  // Stored since 2026-10-17.
  "volunteer.start-reminder-in-app": {
    signupId: "c4000000-0000-4000-8000-000000000004",
    anchor: "ASK_START",
    eventId: null,
    askId: "c7000000-0000-4000-8000-000000000007",
    title: "River cleanup day",
    roleName: "Litter picker",
    kind: "REMINDER_24H",
    startsAtIso: "2026-11-14T15:00:00.000Z",
    timezone: "America/Chicago",
    manageUrl: "https://ithas.fire/v/c7000000-0000-4000-8000-000000000007",
  },
  "community.suggestion-received": {
    eventId: "c5000000-0000-4000-8000-000000000005",
    suggestionId: "c6000000-0000-4000-8000-000000000006",
    eventTitle: "Jazz Brunch",
    moderatorQueue: true,
  },
  "community.suggestion-reviewed": {
    eventId: "c5000000-0000-4000-8000-000000000005",
    suggestionId: "c6000000-0000-4000-8000-000000000006",
    eventTitle: "Jazz Brunch",
    eventRoute: "/events/jazz-brunch",
    decision: "APPROVE",
    reviewNote: "Thanks!",
    conflictedFields: ["title"],
  },
  // Invite complaint auto-pause notices (W4), frozen 2026-10-07, shaped as
  // events/invites/invite-pause-notifications.ts writes them.
  "invite-pause.opened": {
    pauseId: "a7000000-0000-4000-8000-000000000001",
    ownerKind: "ORG",
    organiserName: "Acme Presents",
    reason: "COMPLAINT_COUNT",
    complaintCount: 3,
    recipientCount: 120,
    windowDays: 30,
    actionRoute:
      "/admin/acme/events/a7000000-0000-4000-8000-000000000002/edit?section=settings",
    linksToEvent: true,
  },
  "invite-pause.decided": {
    pauseId: "a7000000-0000-4000-8000-000000000001",
    ownerKind: "ORG",
    organiserName: "Acme Presents",
    decision: "KEPT",
    note: "Three more complaints came in after your request.",
    actionRoute:
      "/admin/acme/events/a7000000-0000-4000-8000-000000000002/edit?section=settings",
    linksToEvent: true,
  },
  // Stored since 2026-10-05: the volunteer signup notices, shaped as
  // volunteering/*.ts passes them to notify.
  "volunteer.signup-received": {
    eventId: "c5000000-0000-4000-8000-000000000005",
    eventTitle: "Summer Fest",
    roleId: "d1000000-0000-4000-8000-000000000001",
    roleName: "Security",
    signupId: "c4000000-0000-4000-8000-000000000004",
    status: "PENDING",
    shiftLabel: "Morning",
    shiftStartsAtIso: "2026-11-14T14:00:00.000Z",
    shiftEndsAtIso: "2026-11-14T18:00:00.000Z",
    accountCompletionUrl: null,
  },
  "volunteer.signup-approved": {
    eventId: "c5000000-0000-4000-8000-000000000005",
    eventTitle: "Summer Fest",
    roleId: "d1000000-0000-4000-8000-000000000001",
    roleName: "Security",
    signupId: "c4000000-0000-4000-8000-000000000004",
    shiftLabel: "Morning",
    shiftStartsAtIso: "2026-11-14T14:00:00.000Z",
    shiftEndsAtIso: "2026-11-14T18:00:00.000Z",
    reviewerName: "Sam Rivera",
    destinationUrl: "https://ithas.fire/events/summer-fest",
  },
  "volunteer.signup-rejected": {
    eventId: "c5000000-0000-4000-8000-000000000005",
    eventTitle: "Summer Fest",
    roleId: "d1000000-0000-4000-8000-000000000001",
    roleName: "Security",
    signupId: "c4000000-0000-4000-8000-000000000004",
    reviewerName: "Sam Rivera",
    rejectionNote: "We are full this time.",
  },
  "volunteer.spot-opened": {
    eventId: "c5000000-0000-4000-8000-000000000005",
    eventTitle: "Summer Fest",
    roleId: "d1000000-0000-4000-8000-000000000001",
    roleName: "Security",
    shiftId: "d2000000-0000-4000-8000-000000000002",
    shiftLabel: "Morning",
    pendingCount: 2,
    withdrawnSignupId: "c4000000-0000-4000-8000-000000000004",
    signupsUrl: "https://ithas.fire/org/summer-fest/volunteers",
  },
  "volunteer.group-coordinator-assigned": {
    askId: "d3000000-0000-4000-8000-000000000003",
    askTitle: "Festival Crew",
    groupId: "d4000000-0000-4000-8000-000000000004",
    groupName: "Setup",
    coordinateUrl:
      "https://ithas.fire/volunteers/coordinate/d3000000-0000-4000-8000-000000000003",
    accountCompletionUrl: null,
    assignerName: "Sam Rivera",
  },
  "volunteer.pool-signup-received": {
    askId: "d3000000-0000-4000-8000-000000000003",
    askTitle: "Festival Crew",
    signupId: "c4000000-0000-4000-8000-000000000004",
    roleId: "d1000000-0000-4000-8000-000000000001",
    roleName: "Security",
    status: "PENDING",
    coordinateUrl:
      "https://ithas.fire/volunteers/coordinate/d3000000-0000-4000-8000-000000000003",
  },
  "volunteer.group-signup-assigned": {
    askId: "d3000000-0000-4000-8000-000000000003",
    askTitle: "Festival Crew",
    groupId: "d4000000-0000-4000-8000-000000000004",
    groupName: "Setup",
    signupId: "c4000000-0000-4000-8000-000000000004",
    roleName: "Security",
    volunteerName: "Alex Kim",
    coordinateUrl:
      "https://ithas.fire/volunteers/coordinate/d3000000-0000-4000-8000-000000000003",
  },
  "volunteer.occurrence-cancelled": {
    askId: "d3000000-0000-4000-8000-000000000003",
    askTitle: "Festival Crew",
    occurrenceId: "d5000000-0000-4000-8000-000000000005",
    roleName: "Security",
    startsAtIso: "2026-11-14T14:00:00.000Z",
    endsAtIso: "2026-11-14T18:00:00.000Z",
    askUrl: "https://ithas.fire/v/d3000000-0000-4000-8000-000000000003",
  },
  // Stored since 2026-10-05 (copy/events.ts, copy/moderation.ts).
  "entity.new-event": {
    entityPageId: "e4000000-0000-4000-8000-000000000004",
    entityName: "The Hall",
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    eventUrl: "https://ithas.fire/events/night-market",
    manageFollowingUrl: "https://ithas.fire/following",
  },
  "event.application-submission-received": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    submissionId: "e5000000-0000-4000-8000-000000000005",
    applicantName: "Ana Ruiz",
    queueUrl: "https://ithas.fire/admin/@sam/events/night-market/applications",
  },
  "event.attendee-feedback-request": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    eventEndsAtIso: "2026-11-14T05:00:00.000Z",
    organizerName: "The Hall",
    orderId: "e7000000-0000-4000-8000-000000000007",
    requestId: "e8000000-0000-4000-8000-000000000008",
    feedbackUrl: "https://ithas.fire/feedback/abc",
  },
  "event.cancelled": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    startsAt: "2026-11-14T01:30:00.000Z",
    refund: { status: "refunded", amountCents: 2500, currency: "usd" },
    eventUrl: "https://ithas.fire/events/night-market",
  },
  "event.changed": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    changeType: "RESCHEDULED",
    newStartsAt: "2026-11-21T01:30:00.000Z",
    newEndsAt: null,
    eventUrl: "https://ithas.fire/events/night-market",
  },
  "event.location-revealed": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    address: "123 Main St, Minneapolis, MN",
    venueName: "The Hall",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    mapUrl: null,
    directionsUrl: "https://maps.example.com/dir/123",
    eventUrl: "https://ithas.fire/events/night-market",
    eventShortUrl: null,
  },
  "event.unlisted": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
  },
  "event.venue-confirmed": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    placeId: "e2000000-0000-4000-8000-000000000002",
    placeName: "The Hall",
    bookingRequestId: "e3000000-0000-4000-8000-000000000003",
    targetUrl: "https://ithas.fire/admin/@sam/events/night-market",
  },
  "event.venue-confirmation-withdrawn": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    placeId: "e2000000-0000-4000-8000-000000000002",
    placeName: "The Hall",
    bookingRequestId: "e3000000-0000-4000-8000-000000000003",
    targetUrl: "https://ithas.fire/admin/@sam/events/night-market",
    reason: "We double-booked that night.",
  },
  "image.moderation.held": {
    recordId: "e6000000-0000-4000-8000-000000000006",
    kind: "EVENT_HERO",
    subjectType: "EVENT",
    subjectId: "e1000000-0000-4000-8000-000000000001",
    imageUrl: "https://cdn.ithas.fire/img/e6.jpg",
    subjectTitle: "Night Market Sessions",
    subjectUrl: "https://ithas.fire/events/night-market",
    helpUrl: "https://ithas.fire/help",
  },
  "image.moderation.approved": {
    recordId: "e6000000-0000-4000-8000-000000000006",
    kind: "EVENT_HERO",
    subjectType: "EVENT",
    subjectId: "e1000000-0000-4000-8000-000000000001",
    imageUrl: "https://cdn.ithas.fire/img/e6.jpg",
    subjectTitle: "Night Market Sessions",
    subjectUrl: "https://ithas.fire/events/night-market",
    helpUrl: "https://ithas.fire/help",
    note: null,
  },
  "image.moderation.rejected": {
    recordId: "e6000000-0000-4000-8000-000000000006",
    kind: "EVENT_HERO",
    subjectType: "EVENT",
    subjectId: "e1000000-0000-4000-8000-000000000001",
    imageUrl: "https://cdn.ithas.fire/img/e6.jpg",
    subjectTitle: "Night Market Sessions",
    subjectUrl: "https://ithas.fire/events/night-market",
    helpUrl: "https://ithas.fire/help",
    note: "Contains a watermark.",
  },
  "place.availability-setup-needed": {
    placeId: "e2000000-0000-4000-8000-000000000002",
    placeName: "The Hall",
    calendarsUrl: "https://ithas.fire/admin/the-hall/calendars",
  },
  "post-event.attendee-review-prompt": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    placeName: "The Hall",
    reviewUrl:
      "https://ithas.fire/review-event/e1000000-0000-4000-8000-000000000001",
  },
  "post-event.performer-review-prompt": {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    placeId: "e2000000-0000-4000-8000-000000000002",
    placeName: "The Hall",
    reviewUrl: "https://ithas.fire/review-a-place?placeId=e2000000",
  },
  // Open-call notices (open calls v1 step 7), frozen 2026-10-07.
  "open-call.picked": {
    submissionId: "f1000000-0000-4000-8000-000000000001",
    formId: "f2000000-0000-4000-8000-000000000002",
    callTitle: "Friday Night Sessions",
    actName: null,
    firstPick: true,
    dates: [{ startsAtIso: "2026-11-14T02:00:00.000Z", timezone: "America/Chicago" }],
    payKind: "DOOR_SPLIT",
    payDetails: "70/30 after costs",
    actionUrl: "https://ithas.fire/my-applications",
    dropOutUrl: "https://ithas.fire/my-lineups",
    makePageUrl: null,
  },
  "open-call.not-this-time": {
    submissionId: "f1000000-0000-4000-8000-000000000001",
    formId: "f2000000-0000-4000-8000-000000000002",
    callTitle: "Friday Night Sessions",
    actName: null,
    note: "Loved it. Next season for sure.",
    actionUrl: "https://ithas.fire/my-applications",
  },
  "open-call.pulled": {
    submissionId: "f1000000-0000-4000-8000-000000000001",
    formId: "f2000000-0000-4000-8000-000000000002",
    callTitle: "Friday Night Sessions",
    actionUrl: "https://ithas.fire/my-applications",
  },
  "open-call.message-received": {
    submissionId: "f1000000-0000-4000-8000-000000000001",
    formId: "f2000000-0000-4000-8000-000000000002",
    messageId: "f3000000-0000-4000-8000-000000000003",
    callTitle: "Friday Night Sessions",
    recipientSide: "ORGANIZER",
    authorName: "The Moths",
    preview: "Can we bring our own amp?",
    actionUrl:
      "https://ithas.fire/admin/acme/events/e1000000-0000-4000-8000-000000000001/open-call?application=f1000000-0000-4000-8000-000000000001",
  },
  "open-call.dropped-out": {
    submissionId: "f1000000-0000-4000-8000-000000000001",
    formId: "f2000000-0000-4000-8000-000000000002",
    callTitle: "Friday Night Sessions",
    actName: "The Moths",
    dates: [{ startsAtIso: "2026-11-14T02:00:00.000Z", timezone: "America/Chicago" }],
    actionUrl:
      "https://ithas.fire/admin/acme/events/e1000000-0000-4000-8000-000000000001/open-call?application=f1000000-0000-4000-8000-000000000001",
  },
  "open-call.application-received": {
    submissionId: "f1000000-0000-4000-8000-000000000001",
    formId: "f2000000-0000-4000-8000-000000000002",
    callTitle: "Friday Night Sessions",
    // Re-frozen 2026-10-07 (statusUrl → actionUrl, before any row was
    // stored): a stored payload never carries a status token (NFR-001).
    actionUrl: "https://ithas.fire/my-applications",
  },
  // A change to a frozen deal (freeze-the-deal FR-006), frozen 2026-10-14.
  "deal.frozen-change": {
    dealChangeId: "d1000000-0000-4000-8000-000000000001",
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    actorName: "Sam Rivera",
    changedAtIso: "2026-11-02T18:30:00.000Z",
    timezone: "America/Chicago",
    dealUrl: null,
    lines: [
      {
        section: "TICKETS",
        payeeName: "Paper Moth",
        label: null,
        before: {
          kind: "SHARE",
          amountType: "PERCENT",
          amountCents: null,
          percent: 30,
          basis: "GROSS",
          resolution: null,
          capPercent: null,
        },
        after: {
          kind: "SHARE",
          amountType: "PERCENT",
          amountCents: null,
          percent: 20,
          basis: "GROSS",
          resolution: null,
          capPercent: null,
        },
      },
      {
        section: "RESALE",
        payeeName: null,
        label: null,
        before: { kind: "RESALE_SHARE", type: "PERCENT", bps: 500, cents: null, payer: "SELLER" },
        after: { kind: "RESALE_SHARE", type: "PERCENT", bps: 250, cents: null, payer: "BUYER" },
      },
    ],
    moreLines: 0,
  },
};

/**
 * Variants whose in-app body is the sender's own free text, verbatim by rule,
 * so it can never differ from English. Their title (and action label) must.
 */
const USER_TEXT_BODY_VARIANTS: ReadonlySet<string> = new Set([
  "booking.message-received",
  "open-call.message-received",
]);

/**
 * Further frozen payloads for variants whose producer stores more than one
 * shape. Same rule as above: never edit one to make a test pass.
 */
/**
 * Frozen rows whose producer stored an English FALLBACK word in a name field
 * because no name resolved ("The venue", "Someone", "a venue", ...; the list
 * is in comms/copy/common.ts). Same rule: never edit one to pass a test.
 * Stored since the producers existed; frozen 2026-10-05.
 */
const FALLBACK_NAME_PAYLOADS: ReadonlyArray<{
  readonly name: string;
  readonly variant: LocalizedVariant;
  readonly payload: unknown;
}> = [
  {
    name: "booking.request-responded (fallback: The venue)",
    variant: "booking.request-responded",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      responderName: "The venue",
      action: "accepted",
      acceptedNext: "terms_coming",
      targetUrl: "https://ithas.fire/account/settings/booking-requests",
    },
  },
  {
    name: "booking.booking-cancelled (fallback: The act)",
    variant: "booking.booking-cancelled",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      cancelledByName: "The act",
      cancelledBy: "sender",
      date: "2026-08-14",
      reason: "Our van broke down.",
      eventCancelled: false,
      targetUrl: "https://ithas.fire/account/settings/booking-requests",
    },
  },
  {
    name: "event.venue-confirmed (fallback: The venue, Your event)",
    variant: "event.venue-confirmed",
    payload: {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Your event",
      placeId: "e2000000-0000-4000-8000-000000000002",
      placeName: "The venue",
      bookingRequestId: "e3000000-0000-4000-8000-000000000003",
      targetUrl: "https://ithas.fire/admin/@sam/events/night-market",
    },
  },
  {
    name: "event.venue-confirmation-withdrawn (fallback: The venue, Your event)",
    variant: "event.venue-confirmation-withdrawn",
    payload: {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Your event",
      placeId: "e2000000-0000-4000-8000-000000000002",
      placeName: "The venue",
      bookingRequestId: "e3000000-0000-4000-8000-000000000003",
      targetUrl: "https://ithas.fire/admin/@sam/events/night-market",
      reason: "We double-booked that night.",
    },
  },
  {
    name: "booking.lineup-invited (fallback: Someone, a venue)",
    variant: "booking.lineup-invited",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      humanId: "10000000-0000-4000-8000-000000000001",
      senderName: "Someone",
      venueName: "a venue",
      preferredDates: ["2026-08-14T20:00"],
      targetUrl: "https://ithas.fire/lineup-invite/a1000000",
    },
  },
  // Producers store "The place" / "a place" from 2026-10-17 (copy says
  // "place", never "venue"); the "The venue" / "a venue" rows above stay.
  {
    name: "booking.request-responded (fallback: The place)",
    variant: "booking.request-responded",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      responderName: "The place",
      action: "accepted",
      acceptedNext: "terms_coming",
      targetUrl: "https://ithas.fire/account/settings/booking-requests",
    },
  },
  {
    name: "booking.lineup-invited (fallback: Someone, a place)",
    variant: "booking.lineup-invited",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      humanId: "10000000-0000-4000-8000-000000000001",
      senderName: "Someone",
      venueName: "a place",
      preferredDates: ["2026-08-14T20:00"],
      targetUrl: "https://ithas.fire/lineup-invite/a1000000",
    },
  },
  {
    name: "booking.lineup-removed (fallback: Someone, a venue)",
    variant: "booking.lineup-removed",
    payload: {
      bookingRequestId: "8e6b3273-9fa0-4b12-8cd4-4f5a6b7c8d9e",
      actId: "9f7c4384-a0b1-4c23-9de5-5a6b7c8d9e0f",
      humanId: "10000000-0000-4000-8000-000000000001",
      senderName: "Someone",
      venueName: "a venue",
      preferredDates: ["2026-08-14"],
    },
  },
  {
    name: "booking.lineup-request-closed (fallback: Someone, a venue)",
    variant: "booking.lineup-request-closed",
    payload: {
      bookingRequestId: "8e6b3273-9fa0-4b12-8cd4-4f5a6b7c8d9e",
      actId: "9f7c4384-a0b1-4c23-9de5-5a6b7c8d9e0f",
      humanId: "10000000-0000-4000-8000-000000000001",
      senderName: "Someone",
      venueName: "a venue",
      preferredDates: ["2026-08-14T20:00"],
      targetUrl:
        "https://ithas.fire/bookings/acts/8e6b3273-9fa0-4b12-8cd4-4f5a6b7c8d9e",
    },
  },
  {
    name: "booking.lineup-answered (fallback: An artist, a venue)",
    variant: "booking.lineup-answered",
    payload: {
      bookingRequestId: "8e6b3273-9fa0-4b12-8cd4-4f5a6b7c8d9e",
      actId: "9f7c4384-a0b1-4c23-9de5-5a6b7c8d9e0f",
      humanId: "10000000-0000-4000-8000-000000000001",
      actName: "An artist",
      venueName: "a venue",
      answer: "passed",
      targetUrl: "https://ithas.fire/admin/corner-booking/bookings",
    },
  },
  {
    name: "booking.request-received (fallback: A performer)",
    variant: "booking.request-received",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      placeId: "a2000000-0000-4000-8000-000000000002",
      placeName: "The Corner Stage",
      actName: "A performer",
      contactName: null,
      contactEmail: null,
      message: "We'd love a Friday in August.",
      preferredDates: ["2026-08-14"],
      source: "PLATFORM",
      inboxUrl:
        "https://ithas.fire/admin/corner/places/a2000000-0000-4000-8000-000000000002/bookings",
    },
  },
  {
    name: "booking.message-received (fallback: Your booking contact)",
    variant: "booking.message-received",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      messageId: "a5000000-0000-4000-8000-000000000005",
      senderLabel: "Your booking contact",
      preview: "Can you load in at 5 instead of 6?",
      threadUrl: "https://ithas.fire/account/settings/booking-requests",
    },
  },
  {
    name: "booking.organizer-request-received (fallback: An organizer)",
    variant: "booking.organizer-request-received",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      orgName: "An organizer",
      message: "Come play our summer series.",
      preferredDates: ["2026-08-14"],
      requestsUrl: "https://ithas.fire/account/settings/booking-requests",
    },
  },
  {
    name: "event.lineup-added (fallback: Someone, role Other)",
    variant: "event.lineup-added",
    payload: {
      eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
      eventHumanId: "5b3e0f40-6d7c-4e8f-9fa1-1c2d3e4f5a6b",
      eventTitle: "Friday Night Sessions",
      startsAtIso: "2026-11-14T01:30:00.000Z",
      timezone: "America/Chicago",
      roleLabel: "Other",
      addedByName: "Someone",
      lineupsUrl: "https://ithas.fire/my-lineups",
      publiclyListed: true,
      eventEnded: false,
      organiserWillBeTold: true,
    },
  },
  {
    name: "event.lineup-added (fallback: The organiser)",
    variant: "event.lineup-added",
    payload: {
      eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
      eventHumanId: "5b3e0f40-6d7c-4e8f-9fa1-1c2d3e4f5a6b",
      eventTitle: "Friday Night Sessions",
      startsAtIso: "2026-11-14T01:30:00.000Z",
      timezone: "America/Chicago",
      roleLabel: "Performer",
      addedByName: "The organiser",
      lineupsUrl: "https://ithas.fire/my-lineups",
      publiclyListed: true,
      eventEnded: false,
      organiserWillBeTold: true,
    },
  },
  {
    name: "event.lineup-left (fallback: Someone)",
    variant: "event.lineup-left",
    payload: {
      eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
      eventHumanId: "5b3e0f40-6d7c-4e8f-9fa1-1c2d3e4f5a6b",
      eventTitle: "Friday Night Sessions",
      startsAtIso: "2026-11-14T01:30:00.000Z",
      timezone: "America/Chicago",
      personName: "Someone",
      lineupUrl:
        "https://ithas.fire/admin/events/3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f/edit?section=lineup",
      wasPubliclyListed: false,
    },
  },
  {
    name: "event.application-submission-received (fallback: Someone)",
    variant: "event.application-submission-received",
    payload: {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Night Market Sessions",
      submissionId: "e5000000-0000-4000-8000-000000000005",
      applicantName: "Someone",
      queueUrl: "https://ithas.fire/admin/@sam/events/night-market/applications",
    },
  },
];

const EXTRA_STORED_PAYLOADS: ReadonlyArray<{
  readonly name: string;
  readonly variant: LocalizedVariant;
  readonly payload: unknown;
}> = [
  ...FALLBACK_NAME_PAYLOADS,
  // Stored since 2026-10-05 (direct-money-safety-renderers.ts).
  {
    name: "resale.claim-resolved (seller, denied, event gone)",
    variant: "resale.claim-resolved",
    payload: {
      claimId: "b2000000-0000-4000-8000-000000000002",
      eventTitle: null,
      audience: "seller",
      status: "denied",
      resolution: null,
      claimUrl:
        "https://ithas.fire/my/resale/claims/b2000000-0000-4000-8000-000000000002",
    },
  },
  {
    name: "dispute.risk-owner-notice (lost, membership, fee only)",
    variant: "dispute.risk-owner-notice",
    payload: {
      disputeId: "b4000000-0000-4000-8000-000000000004",
      notice: "lost",
      eventTitle: null,
      isMembership: true,
      evidenceDueIso: null,
      lostOutcome: "membership_fee_debited",
    },
  },
  {
    name: "entity-report.reviewed (dismissed, no note)",
    variant: "entity-report.reviewed",
    payload: {
      reportId: "b5000000-0000-4000-8000-000000000005",
      subjectType: "ORGANIZATION",
      subjectId: "b6000000-0000-4000-8000-000000000006",
      verdict: "DISMISSED",
      reviewNote: null,
    },
  },
  // Stored since 2026-10-04. What `notifyPayoutCompleted` actually stores: the
  // bare amounts plus its enrichment (`settlements/notify-payout-completed.ts`,
  // `Enrichment`), including the nulls a best-effort read leaves behind.
  {
    name: "settlement.payout-completed (enriched payout)",
    variant: "settlement.payout-completed",
    payload: {
      payeeId: "10000000-0000-4000-8000-000000000001",
      payoutId: "20000000-0000-4000-8000-000000000002",
      payoutItemId: "30000000-0000-4000-8000-000000000003",
      amountCents: 12500,
      currency: "usd",
      settlementCount: 2,
      kind: "payout",
      payoutDateIso: "2026-09-20T05:00:03.000Z",
      orgName: "Acme Presents",
      displayTimezone: "America/Chicago",
      lines: [
        {
          eventTitle: "Sunset Sessions",
          eventStartsAtIso: "2026-09-12T01:00:00.000Z",
          eventTimezone: "America/Chicago",
          ticketCount: 3,
          amountCents: 9000,
          orderId: "11111111-0000-4000-8000-000000000001",
        },
        {
          eventTitle: null,
          eventStartsAtIso: null,
          eventTimezone: null,
          ticketCount: null,
          amountCents: 4000,
          orderId: null,
        },
      ],
      recoveredDebtCents: 0,
      connectAccountFeeCents: 200,
      reserveHeldCents: 300,
      reserveReleasedCents: 0,
      otherSalesCount: 0,
      otherSalesCents: 0,
      balanceAfterCents: null,
      nextPayableAtIso: null,
      bankDelayDays: 2,
      stripeDashboardUrl: "https://connect.stripe.com/express_login",
      payoutsUrl: "https://ithas.fire/admin/acme/payments",
    },
  },
  {
    name: "settlement.payout-completed (enriched reserved)",
    variant: "settlement.payout-completed",
    payload: {
      payeeId: "10000000-0000-4000-8000-000000000001",
      payoutId: "20000000-0000-4000-8000-000000000002",
      payoutItemId: "30000000-0000-4000-8000-000000000004",
      amountCents: 4000,
      currency: "usd",
      settlementCount: 1,
      kind: "reserved",
      payoutDateIso: "2026-09-20T05:00:03.000Z",
      orgName: null,
      // enrich() takes the first line's zone.
      displayTimezone: "America/Chicago",
      lines: [
        {
          eventTitle: "Sunset Sessions",
          eventStartsAtIso: "2026-09-12T01:00:00.000Z",
          eventTimezone: "America/Chicago",
          ticketCount: 1,
          amountCents: 4000,
          orderId: "11111111-0000-4000-8000-000000000001",
        },
      ],
      recoveredDebtCents: 0,
      connectAccountFeeCents: 0,
      reserveHeldCents: 4000,
      reserveReleasedCents: 0,
      otherSalesCount: 0,
      otherSalesCents: 0,
      balanceAfterCents: 0,
      // Maturities are only read when a balance remains.
      nextPayableAtIso: null,
      bankDelayDays: null,
      stripeDashboardUrl: "https://connect.stripe.com/express_login",
    },
  },
  // Booking — stored since 2026-10-05. The other shapes each producer
  // stores (notify-booking-hold-intents `buildMessage`: staff audiences carry
  // `actName`; act audiences never do).
  {
    name: "booking.request-responded (accepted, organizer's request)",
    variant: "booking.request-responded",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      responderName: "Los Lobos Chicos",
      action: "accepted",
      acceptedNext: "agreement_ready",
      agreementId: "a5000000-0000-4000-8000-000000000005",
      targetUrl: "https://ithas.fire/admin/acme/agreements/a5000000",
    },
  },
  {
    name: "booking.hold-challenged (staff)",
    variant: "booking.hold-challenged",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      holdId: "a4000000-0000-4000-8000-000000000004",
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl:
        "https://ithas.fire/admin/corner/places/a2000000-0000-4000-8000-000000000002/bookings",
      audience: "staff",
      position: 1,
      respondByISO: "2026-08-12T23:00:00.000Z",
      actName: "Los Lobos Chicos",
    },
  },
  {
    name: "booking.hold-challenged (act next in line)",
    variant: "booking.hold-challenged",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      holdId: "a4000000-0000-4000-8000-000000000004",
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl: "https://ithas.fire/account/settings/booking-requests",
      position: 2,
      respondByISO: "2026-08-12T23:00:00.000Z",
    },
  },
  {
    name: "booking.hold-challenge-answered (keeper, awaiting terms)",
    variant: "booking.hold-challenge-answered",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      holdId: "a4000000-0000-4000-8000-000000000004",
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl: "https://ithas.fire/account/settings/booking-requests",
      audience: "act",
      answer: "kept",
      awaitingTerms: true,
      respondByISO: "2026-08-16T23:00:00.000Z",
    },
  },
  {
    name: "booking.hold-challenge-answered (act next in line: first hold stands)",
    variant: "booking.hold-challenge-answered",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      holdId: "a4000000-0000-4000-8000-000000000004",
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl: "https://ithas.fire/account/settings/booking-requests",
      audience: "act",
      answer: "kept",
    },
  },
  {
    name: "booking.hold-challenge-answered (staff, released)",
    variant: "booking.hold-challenge-answered",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      holdId: "a4000000-0000-4000-8000-000000000004",
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl:
        "https://ithas.fire/admin/corner/places/a2000000-0000-4000-8000-000000000002/bookings",
      audience: "staff",
      answer: "released",
      actName: "Los Lobos Chicos",
    },
  },
  {
    name: "booking.hold-released (staff, event scheduled)",
    variant: "booking.hold-released",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      holdId: "a4000000-0000-4000-8000-000000000004",
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl:
        "https://ithas.fire/admin/corner/places/a2000000-0000-4000-8000-000000000002/bookings",
      reason: "EVENT_SCHEDULED",
      audience: "staff",
      actName: "Los Lobos Chicos",
    },
  },
  {
    name: "booking.hold-expired (staff)",
    variant: "booking.hold-expired",
    payload: {
      bookingRequestId: "a1000000-0000-4000-8000-000000000001",
      holdId: "a4000000-0000-4000-8000-000000000004",
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl:
        "https://ithas.fire/admin/corner/places/a2000000-0000-4000-8000-000000000002/bookings",
      audience: "staff",
      actName: "Los Lobos Chicos",
    },
  },
  // Stored since 2026-10-05: the other branches of the in-app-only claim,
  // shift-reminder and suggestion variants.
  {
    name: "place.claim-received (dispute)",
    variant: "place.claim-received",
    payload: {
      placeId: "c2000000-0000-4000-8000-000000000002",
      placeName: "The Corner Stage",
      requestId: "c3000000-0000-4000-8000-000000000003",
      source: "OWNERSHIP_DISPUTE",
    },
  },
  {
    name: "place.claim-decided (rejected, note)",
    variant: "place.claim-decided",
    payload: {
      placeId: "c2000000-0000-4000-8000-000000000002",
      placeName: "The Corner Stage",
      decision: "REJECTED",
      reviewerNotes: "Proof didn't match.",
    },
  },
  {
    name: "place.dispute-decided (rejected, note)",
    variant: "place.dispute-decided",
    payload: {
      placeId: "c2000000-0000-4000-8000-000000000002",
      placeName: "The Corner Stage",
      decision: "REJECTED",
      reviewerNotes: "Lease expired.",
    },
  },
  {
    name: "volunteer.shift-reminder-in-app (1h, no label)",
    variant: "volunteer.shift-reminder-in-app",
    payload: {
      signupId: "c4000000-0000-4000-8000-000000000004",
      eventId: "c5000000-0000-4000-8000-000000000005",
      eventTitle: "Summer Fest",
      roleName: "Security",
      shiftLabel: null,
      kind: "REMINDER_1H",
      manageUrl:
        "https://ithas.fire/volunteer?signup=c4000000-0000-4000-8000-000000000004",
    },
  },
  // Grouped reminders (volunteer-ask-reminders R12), stored since 2026-10-18.
  {
    name: "volunteer.shift-reminder-in-app (grouped shifts)",
    variant: "volunteer.shift-reminder-in-app",
    payload: {
      signupId: "c4000000-0000-4000-8000-000000000004",
      eventId: "c5000000-0000-4000-8000-000000000005",
      eventTitle: "Summer Fest",
      roleName: "Security",
      shiftLabel: "Gate A",
      kind: "REMINDER_24H",
      manageUrl: "https://ithas.fire/events/summer-fest",
      roles: [
        { roleName: "Security", shiftLabel: "Gate A" },
        { roleName: "Bar", shiftLabel: null },
      ],
      signupIds: [
        "c4000000-0000-4000-8000-000000000004",
        "c4000000-0000-4000-8000-000000000014",
      ],
    },
  },
  {
    name: "volunteer.start-reminder-in-app (grouped ask roles)",
    variant: "volunteer.start-reminder-in-app",
    payload: {
      signupId: "c4000000-0000-4000-8000-000000000004",
      anchor: "ASK_START",
      eventId: null,
      askId: "c7000000-0000-4000-8000-000000000007",
      title: "River cleanup day",
      roleName: "Litter picker",
      kind: "REMINDER_1H",
      startsAtIso: "2026-11-14T15:00:00.000Z",
      timezone: "America/Chicago",
      manageUrl: "https://ithas.fire/v/c7000000-0000-4000-8000-000000000007",
      roleNames: ["Litter picker", "Check-in table", "Water station"],
      signupIds: [
        "c4000000-0000-4000-8000-000000000004",
        "c4000000-0000-4000-8000-000000000014",
        "c4000000-0000-4000-8000-000000000024",
      ],
    },
  },
  {
    name: "volunteer.start-reminder-in-app (event start, 1h, fallback role)",
    variant: "volunteer.start-reminder-in-app",
    payload: {
      signupId: "c4000000-0000-4000-8000-000000000004",
      anchor: "EVENT_START",
      eventId: "c5000000-0000-4000-8000-000000000005",
      askId: null,
      title: "Summer Fest",
      roleName: "Volunteer",
      kind: "REMINDER_1H",
      startsAtIso: "2026-11-14T01:30:00.000Z",
      timezone: "America/New_York",
      manageUrl:
        "https://ithas.fire/events/summer-fest/volunteer?signup=c4000000-0000-4000-8000-000000000004",
    },
  },
  {
    name: "community.suggestion-received (owned event, no action)",
    variant: "community.suggestion-received",
    payload: {
      eventId: "c5000000-0000-4000-8000-000000000005",
      suggestionId: "c6000000-0000-4000-8000-000000000006",
      eventTitle: "Jazz Brunch",
      moderatorQueue: false,
    },
  },
  {
    name: "community.suggestion-reviewed (rejected, no slug)",
    variant: "community.suggestion-reviewed",
    payload: {
      eventId: "c5000000-0000-4000-8000-000000000005",
      suggestionId: "c6000000-0000-4000-8000-000000000006",
      eventTitle: "Jazz Brunch",
      eventRoute: null,
      decision: "REJECT",
      reviewNote: null,
      conflictedFields: [],
    },
  },
  // Invite complaint auto-pause (W4), frozen 2026-10-07: the other shapes.
  {
    name: "invite-pause.opened (rate, person-owned)",
    variant: "invite-pause.opened",
    payload: {
      pauseId: "a7000000-0000-4000-8000-000000000001",
      ownerKind: "HUMAN",
      organiserName: null,
      reason: "COMPLAINT_RATE",
      complaintCount: 1,
      recipientCount: 40,
      windowDays: 30,
      actionRoute: "/admin/@jamie/events",
    },
  },
  {
    name: "invite-pause.decided (lifted, no note)",
    variant: "invite-pause.decided",
    payload: {
      pauseId: "a7000000-0000-4000-8000-000000000001",
      ownerKind: "HUMAN",
      organiserName: null,
      decision: "LIFTED",
      note: null,
      actionRoute: "/admin/@jamie/events",
      linksToEvent: false,
    },
  },
  // Stored since 2026-10-05: the other shapes the volunteer, post-event,
  // event-change and image-moderation producers pass through `notify`.
  // Ask path (volunteering/volunteer-signups.ts): eventId null, askId set,
  // eventTitle carries the ask title.
  {
    name: "volunteer.signup-approved (ask path)",
    variant: "volunteer.signup-approved",
    payload: {
      askId: "d3000000-0000-4000-8000-000000000003",
      eventId: null,
      eventTitle: "Festival Crew",
      roleId: "d1000000-0000-4000-8000-000000000001",
      roleName: "Security",
      signupId: "c4000000-0000-4000-8000-000000000004",
      shiftLabel: null,
      shiftStartsAtIso: null,
      shiftEndsAtIso: null,
      reviewerName: "Sam Rivera",
      destinationUrl:
        "https://ithas.fire/v/d3000000-0000-4000-8000-000000000003",
    },
  },
  {
    name: "volunteer.signup-rejected (ask path)",
    variant: "volunteer.signup-rejected",
    payload: {
      askId: "d3000000-0000-4000-8000-000000000003",
      eventId: null,
      eventTitle: "Festival Crew",
      roleId: "d1000000-0000-4000-8000-000000000001",
      roleName: "Security",
      signupId: "c4000000-0000-4000-8000-000000000004",
      reviewerName: "Sam Rivera",
      rejectionNote: null,
    },
  },
  // dispatch-post-event-prompts.ts omits placeName when no place resolves.
  {
    name: "post-event.attendee-review-prompt (no place)",
    variant: "post-event.attendee-review-prompt",
    payload: {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Night Market Sessions",
      reviewUrl:
        "https://ithas.fire/review-event/e1000000-0000-4000-8000-000000000001",
    },
  },
  // dispatch-event-change-notifications.ts: pending-refund buyers and the
  // plain (refund: null) cohort.
  {
    name: "event.cancelled (refund pending)",
    variant: "event.cancelled",
    payload: {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Night Market Sessions",
      startsAt: "2026-11-14T01:30:00.000Z",
      eventUrl: "https://ithas.fire/events/night-market",
      refund: { status: "pending" },
    },
  },
  {
    name: "event.cancelled (no refund)",
    variant: "event.cancelled",
    payload: {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Night Market Sessions",
      startsAt: "2026-11-14T01:30:00.000Z",
      eventUrl: "https://ithas.fire/events/night-market",
      refund: null,
    },
  },
  {
    name: "event.changed (venue changed)",
    variant: "event.changed",
    payload: {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Night Market Sessions",
      changeType: "VENUE_CHANGED",
      newStartsAt: null,
      newEndsAt: null,
      eventUrl: "https://ithas.fire/events/night-market",
    },
  },
  // drain-image-moderations.ts: subject lookup failed, so the subject fields
  // are null (and so is helpUrl when there is no base URL).
  {
    name: "image.moderation.held (null subject)",
    variant: "image.moderation.held",
    payload: {
      recordId: "e6000000-0000-4000-8000-000000000006",
      kind: "EVENT_HERO",
      subjectType: null,
      subjectId: null,
      subjectTitle: null,
      subjectUrl: null,
      imageUrl: null,
      helpUrl: null,
    },
  },
  {
    name: "image.moderation.rejected (null subject)",
    variant: "image.moderation.rejected",
    payload: {
      recordId: "e6000000-0000-4000-8000-000000000006",
      kind: "EVENT_HERO",
      subjectType: null,
      subjectId: null,
      subjectTitle: null,
      subjectUrl: null,
      imageUrl: null,
      helpUrl: null,
      note: null,
    },
  },
  // Stored since 2026-10-05: the producers add the zone the time reads in
  // (dispatch-event-change-notifications.ts: the event's; manage-shift-
  // occurrences.ts: the ask's place's). The fixtures above keep the old shape.
  {
    name: "event.changed (rescheduled, with timezone)",
    variant: "event.changed",
    payload: {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Night Market Sessions",
      changeType: "RESCHEDULED",
      newStartsAt: "2026-11-21T01:30:00.000Z",
      newEndsAt: null,
      eventUrl: "https://ithas.fire/events/night-market",
      timezone: "America/Chicago",
    },
  },
  {
    name: "volunteer.occurrence-cancelled (with timezone)",
    variant: "volunteer.occurrence-cancelled",
    payload: {
      askId: "d3000000-0000-4000-8000-000000000003",
      askTitle: "Festival Crew",
      occurrenceId: "d5000000-0000-4000-8000-000000000005",
      roleName: "Security",
      startsAtIso: "2026-11-14T14:00:00.000Z",
      endsAtIso: "2026-11-14T18:00:00.000Z",
      askUrl: "https://ithas.fire/v/d3000000-0000-4000-8000-000000000003",
      timezone: "America/Chicago",
    },
  },
];

const ALL_STORED_PAYLOADS = [
  ...(Object.keys(STORED_PAYLOADS) as LocalizedVariant[]).map((variant) => ({
    name: variant as string,
    variant,
    payload: STORED_PAYLOADS[variant],
  })),
  ...EXTRA_STORED_PAYLOADS,
];

const NOW = new Date("2026-11-01T12:00:00Z");

describe("LOCALIZED_VARIANTS", () => {
  it("has a frozen stored-payload fixture for every member (and nothing else)", () => {
    expect(Object.keys(STORED_PAYLOADS).sort()).toEqual(
      [...LOCALIZED_VARIANTS].sort(),
    );
  });

  it.each(ALL_STORED_PAYLOADS)(
    "$name: the stored payload still parses",
    ({ variant, payload }) => {
      const renderer = getNotificationRenderer(variant);
      expect(renderer).not.toBeNull();
      const parsed = renderer!.schema.safeParse(payload);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    },
  );

  it.each(ALL_STORED_PAYLOADS)(
    "$name: renders in-app copy in every locale, and no locale's copy is English",
    ({ variant, payload }) => {
      const en = renderNotification(variant, payload, {
        now: NOW,
        locale: "en",
      }).inApp;
      expect(en).toBeDefined();

      for (const locale of NOTIFICATION_LOCALES) {
        const out = renderNotification(variant, payload, { now: NOW, locale })
          .inApp;
        expect(out, `${variant} / ${locale}`).toBeDefined();
        expect(out!.body.length).toBeGreaterThan(0);
        if (locale === "en") continue;
        expect(out!.title, `${variant} / ${locale} title`).not.toBe(en!.title);
        if (USER_TEXT_BODY_VARIANTS.has(variant)) {
          expect(out!.body, `${variant} / ${locale} body is verbatim`).toBe(
            en!.body,
          );
        } else {
          expect(out!.body, `${variant} / ${locale} body`).not.toBe(en!.body);
        }
        if (en!.action) {
          expect(out!.action?.label).not.toBe(en!.action.label);
        }
      }
    },
  );
});

/** Every English fallback word a producer may store (comms/copy/common.ts). */
const ENGLISH_FALLBACK_WORDS =
  /\b(The place|The venue|The act|Someone|a place|a venue|A performer|An artist|Your booking contact|An organizer|The organiser|Your event)\b/;

describe("stored English fallback names", () => {
  it.each(FALLBACK_NAME_PAYLOADS)(
    "$name: Spanish copy carries none of the English fallback words",
    ({ variant, payload }) => {
      const en = renderNotification(variant, payload, { now: NOW, locale: "en" })
        .inApp!;
      expect(`${en.title} ${en.body}`).toMatch(ENGLISH_FALLBACK_WORDS);
      const es = renderNotification(variant, payload, { now: NOW, locale: "es" })
        .inApp!;
      expect(es.title).not.toMatch(ENGLISH_FALLBACK_WORDS);
      expect(es.body).not.toMatch(ENGLISH_FALLBACK_WORDS);
    },
  );
});
