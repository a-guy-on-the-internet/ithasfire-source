import { makeEntityEventNoticesRepo } from "./entity-event-notices";
import { PrismaClient } from "@prisma/client";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos/index";

import { makeAuditRepo } from "./audit";
import { makePlaceMergeRepo } from "./place-merge";
import { makeAnnouncementsRepo } from "./announcements";
import {
  makeWaiverClausesRepo,
  makeWaiverTemplatesRepo,
  makeWaiverAcceptancesRepo,
  makeVolunteerWaiverAcceptancesRepo,
} from "./waivers";
import { makePayoutTermsRepo } from "./payout-terms";
// ── P4b (deal terms) ──
import { makeDealsRepo } from "./deals";
import { makeAudioUploadsRepo } from "./audio-uploads";
import { makeAuthZRepo } from "./authz";
import { makeApiKeysRepo } from "./api-keys";
import { makeBansRepo } from "./bans";
import { makeNetworkSightingsRepo } from "./network-sightings";
import { makeCategoriesRepo } from "./categories";
import { makeCategoryRequestsRepo } from "./category-requests";
import { makeCommunityModeratorApplicationsRepo } from "./community-moderator-applications";
import { makeEventEditSuggestionsRepo } from "./event-edit-suggestions";
import { makeEntityReportsRepo } from "./entity-reports";
import { makeEventRsvpsRepo } from "./event-rsvps";
import { makeEventDatesRepo } from "./event-dates";
import { makeEventDateRsvpsRepo } from "./event-date-rsvps";
import { makeTagsRepo } from "./tags";
import { makeEventsRepo } from "./events";
import { makeEventApplicationsRepo } from "./event-applications";
import { makeImagesRepo } from "./images";
import { makeFeaturedEventsRepo } from "./featured-events";
import { makeFeaturedItemsRepo } from "./featured-items";
import { makeEventHumansRepo } from "./event-humans";
import { makeTicketAttributionsRepo } from "./ticket-attributions";
import { makeHumansRepo } from "./humans";
import { makeHumanStatsRepo } from "./human-stats";
import { makeIdempotencyRepo } from "./idempotency";
import { makeDisputesRepo } from "./disputes";
import { makeDisputeEvidenceRepo } from "./dispute-evidence";
import { makeEarlyFraudWarningsRepo } from "./early-fraud-warnings";
import { makeMembershipTaxJurisdictionsRepo } from "./membership-tax-jurisdictions";
import { makeMembershipStandingsRepo } from "./membership-standings";
import { makeMembershipsRepo } from "./memberships";
import { makeMembershipTiersRepo } from "./membership-tiers";
import { makeResaleListingsRepo } from "./resale-listings";
import { makeClaimsRepo } from "./claims";
import { makeOrdersRepo } from "./orders";
import { makeOrderItemsRepo } from "./order-items";
import { makeOrderItemSettlementLinesRepo } from "./order-item-settlement-lines";
import { makePayeeLedgerRepo } from "./payee-ledger";
import { makePayeesRepo } from "./payees";
import { makePayoutsRepo } from "./payouts";
import { makeSettlementLinesRepo } from "./settlement-lines";
import { makeSettlementsRepo } from "./settlements";
import { makeSplitsRepo } from "./splits";
import { makeTicketsRepo } from "./tickets";
import { makePendingTicketTransfersRepo } from "./pending-ticket-transfers";
import { makePendingObjectDeletionsRepo } from "./pending-object-deletions";
import { makeSearchReindexPendingRepo } from "./search-reindex-pending";
import { makeSearchIndexStateRepo } from "./search-index-state";
import { makeJobCursorsRepo } from "./job-cursors";
import { makeImageModerationRecordsRepo } from "./image-moderation-records";
import { makeOrganizationsRepo } from "./organizations";
import { makeOrgStatsRepo } from "./org-stats";
import { makeHumanDelegatesRepo } from "./human-delegates";
import { makePlacesRepo } from "./places";
import { makeSpacesRepo } from "./spaces";
import { makeArrivalAreasRepo } from "./arrival-areas";
import { makeCalendarsRepo } from "./calendars";
import { makePlaceWaiversRepo } from "./place-waivers";
import { makePlaceReviewsRepo, makePlaceStatsRepo } from "./place-reviews";
import { makePlaceReviewSessionsRepo } from "./place-review-sessions";
import { makeSavedLocationsRepo } from "./saved-locations";
import { makeFeePoliciesRepo } from "./fee-policies";
import { makeFeeWaiversRepo } from "./fee-waivers";
import { makeSeatsRepo } from "./seats";
import { makePromosRepo } from "./promos";
import { makeCreditsRepo } from "./credits";
import { makeEventTemplatesRepo } from "./event-templates";
import { makeTicketTypeTemplatesRepo } from "./ticket-type-templates";
import { makeApplicationFormTemplatesRepo } from "./application-form-templates";
import {
  makeEventSeriesRepo,
  makeEventSeriesOccurrencesRepo,
} from "./event-series";
import { makeEventWaitlistsRepo } from "./event-waitlists";
import { makePushDevicesRepo } from "./push-devices";
import { makePushReceiptsRepo } from "./push-receipts";
import { makeNotificationDigestsRepo } from "./notification-digests";
import { makeNotificationsRepo } from "./notifications";
import {
  makePlaceLayoutsRepo,
  makePlaceLayoutStatusesRepo,
} from "./place-layouts";
import { makeInviteListsRepo } from "./invite-lists";
import { makeContactImportsRepo } from "./contact-imports";
import { makeEventInvitesRepo } from "./event-invites";
import { makeEventInviteOptOutsRepo } from "./event-invite-opt-outs";
import { makeEventInvitePausesRepo } from "./event-invite-pauses";
import { makeEventSavesRepo } from "./event-saves";
import { makeEventChangeNoticesRepo } from "./event-change-notices";
import { makeRsvpNoticesRepo } from "./rsvp-notices";
import { makeRsvpRemindersRepo } from "./rsvp-reminders";
import { makePostEventPromptsRepo } from "./post-event-prompts";
import { makeAttendeeReviewsRepo } from "./attendee-reviews";
import { makeReviewAggregatesRepo } from "./review-aggregates";
import { makeEventUnlocksRepo } from "./event-unlocks";
import { makeAnalyticsRepo } from "./analytics";
import { makeEmbedsRepo } from "./embeds";
import { makeEntityPagesRepo } from "./entity-pages";
import { makeFollowsRepo } from "./follows";
import { makeNotificationPreferencesRepo } from "./notification-preferences";
import { makePayoutItemsRepo } from "./payout-items";
import { makePlatformSettingsRepo } from "./platform-settings";
import { makePosReadersRepo } from "./pos-readers";
import { makeResourceQuotasRepo } from "./resource-quotas";
import { makePlaceVerificationRequestsRepo } from "./place-verification-requests";
import { makePlaceClaimEmailChallengesRepo } from "./place-claim-email-challenges";
import { makePlaceVerificationDocumentsRepo } from "./place-verification-documents";
import { makeVolunteeringRepo } from "./volunteering";
import { makeConsentRepo } from "./consent";
import { makeAcceptancesRepo } from "./acceptances";
import { makeSmsConsentRepo } from "./sms-consent";
import { makePerformerProfilesRepo } from "./performer-profiles";
import { makePerformerBookingDefaultsRepo } from "./performer-booking-defaults";
import { makeBookingRequestsRepo } from "./booking-requests";
import { makeBookingHoldsRepo } from "./booking-holds";
import { makeBookingStandardsRepo } from "./booking-standards";
import { makeBookingTagsRepo } from "./booking-tags";
import { makeSavedSnippetsRepo } from "./saved-snippets";
import { makePlaceBookingGrantsRepo } from "./place-booking-grants";
import { makeBookingRequestMessagesRepo } from "./booking-request-messages";
import { makeAgreementsRepo } from "./agreements";
import { makeSupportThreadRepo } from "./support";
import type { PrismaClientOrTx } from "./types";
import { makeSearchDocumentsWriter } from "./search-documents";

/**
 * Optional non-Prisma repos (e.g. object-storage-backed blob repos) that get
 * merged into every `TxRepos` object. These are not transactional themselves
 * but live on the `TxRepos` interface so use cases can access them uniformly.
 */
export type ExtraTxRepos = Partial<Pick<TxRepos, "placeLayoutBlobs">>;

export function makeTxRepos(
  p: PrismaClientOrTx,
  extras?: ExtraTxRepos,
): TxRepos {
  // `satisfies` (instead of a blanket `as TxRepos` on the whole object) makes
  // a missing repo a typecheck failure. `placeLayoutBlobs` is the ONE
  // deliberate gap: it is object-storage-backed and only supplied via
  // `extras` by callers that mount it, so the base object is checked against
  // TxRepos minus that key and the final cast below only papers over it.
  const base = {
    humans: makeHumansRepo(p),
    events: makeEventsRepo(p),
    images: makeImagesRepo(p),
    audioUploads: makeAudioUploadsRepo(p),
    eventApplications: makeEventApplicationsRepo(p),
    eventWaitlists: makeEventWaitlistsRepo(p),
    featuredEvents: makeFeaturedEventsRepo(p),
    featuredItems: makeFeaturedItemsRepo(p),
    categories: makeCategoriesRepo(p),
    categoryRequests: makeCategoryRequestsRepo(p),
    eventEditSuggestions: makeEventEditSuggestionsRepo(p),
    entityReports: makeEntityReportsRepo(p),
    communityModeratorApplications: makeCommunityModeratorApplicationsRepo(p),
    eventRsvps: makeEventRsvpsRepo(p),
    eventDates: makeEventDatesRepo(p),
    eventDateRsvps: makeEventDateRsvpsRepo(p),
    tags: makeTagsRepo(p),
    orders: makeOrdersRepo(p),
    orderItems: makeOrderItemsRepo(p),
    orderItemSettlementLines: makeOrderItemSettlementLinesRepo(p),
    tickets: makeTicketsRepo(p),
    pendingTicketTransfers: makePendingTicketTransfersRepo(p),
    pendingObjectDeletions: makePendingObjectDeletionsRepo(p),
    searchReindexPending: makeSearchReindexPendingRepo(p),
    searchIndexState: makeSearchIndexStateRepo(p),
    jobCursors: makeJobCursorsRepo(p),
    imageModerationRecords: makeImageModerationRecordsRepo(p),
    payoutTerms: makePayoutTermsRepo(p),
    // ── P4b (deal terms) ──
    deals: makeDealsRepo(p),
    feePolicies: makeFeePoliciesRepo(p),
    feeWaivers: makeFeeWaiversRepo(p),
    splits: makeSplitsRepo(p),
    payeeLedger: makePayeeLedgerRepo(p),
    payees: makePayeesRepo(p),
    disputes: makeDisputesRepo(p),
    disputeEvidence: makeDisputeEvidenceRepo(p),
    earlyFraudWarnings: makeEarlyFraudWarningsRepo(p),
    membershipTaxJurisdictions: makeMembershipTaxJurisdictionsRepo(p),
    memberships: makeMembershipsRepo(p),
    membershipStandings: makeMembershipStandingsRepo(p),
    membershipTiers: makeMembershipTiersRepo(p),
    payouts: makePayoutsRepo(p),
    payoutItems: makePayoutItemsRepo(p),
    settlements: makeSettlementsRepo(p),
    settlementLines: makeSettlementLinesRepo(p),
    resaleListings: makeResaleListingsRepo(p),
    claims: makeClaimsRepo(p),
    idempotency: makeIdempotencyRepo(p),
    audit: makeAuditRepo(p),
    authz: makeAuthZRepo(p),
    apiKeys: makeApiKeysRepo(p),
    bans: makeBansRepo(p),
    networkSightings: makeNetworkSightingsRepo(p),
    organizations: makeOrganizationsRepo(p),
    orgStats: makeOrgStatsRepo(p),
    humanDelegates: makeHumanDelegatesRepo(p),
    humanStats: makeHumanStatsRepo(p),
    places: makePlacesRepo(p),
    spaces: makeSpacesRepo(p),
    arrivalAreas: makeArrivalAreasRepo(p),
    calendars: makeCalendarsRepo(p),
    placeWaivers: makePlaceWaiversRepo(p),
    placeReviews: makePlaceReviewsRepo(p),
    placeReviewSessions: makePlaceReviewSessionsRepo(p),
    placeStats: makePlaceStatsRepo(p),
    savedLocations: makeSavedLocationsRepo(p),
    seats: makeSeatsRepo(p),
    promos: makePromosRepo(p),
    credits: makeCreditsRepo(p),
    eventTemplates: makeEventTemplatesRepo(p),
    ticketTypeTemplates: makeTicketTypeTemplatesRepo(p),
    applicationFormTemplates: makeApplicationFormTemplatesRepo(p),
    eventHumans: makeEventHumansRepo(p),
    ticketAttributions: makeTicketAttributionsRepo(p),
    series: makeEventSeriesRepo(p),
    seriesOccurrences: makeEventSeriesOccurrencesRepo(p),
    inviteLists: makeInviteListsRepo(p),
    contactImports: makeContactImportsRepo(p),
    eventInvites: makeEventInvitesRepo(p),
    eventInviteOptOuts: makeEventInviteOptOutsRepo(p),
    eventInvitePauses: makeEventInvitePausesRepo(p),
    eventSaves: makeEventSavesRepo(p),
    eventChangeNotices: makeEventChangeNoticesRepo(p),
    rsvpNotices: makeRsvpNoticesRepo(p),
    rsvpReminders: makeRsvpRemindersRepo(p),
    postEventPrompts: makePostEventPromptsRepo(p),
    attendeeReviews: makeAttendeeReviewsRepo(p),
    reviewAggregates: makeReviewAggregatesRepo(p),
    eventUnlocks: makeEventUnlocksRepo(p),
    pushDevices: makePushDevicesRepo(p),
    pushReceipts: makePushReceiptsRepo(p),
    notificationDigests: makeNotificationDigestsRepo(p),
    notifications: makeNotificationsRepo(p),
    placeLayouts: makePlaceLayoutsRepo(p),
    placeLayoutStatuses: makePlaceLayoutStatusesRepo(p),
    analytics: makeAnalyticsRepo(p),
    embeds: makeEmbedsRepo(p),
    entityPages: makeEntityPagesRepo(p),
    follows: makeFollowsRepo(p),
    entityEventNotices: makeEntityEventNoticesRepo(p),
    platformSettings: makePlatformSettingsRepo(p),
    posReaders: makePosReadersRepo(p),
    resourceQuotas: makeResourceQuotasRepo(p),
    placeVerificationRequests: makePlaceVerificationRequestsRepo(p),
    placeVerificationDocuments: makePlaceVerificationDocumentsRepo(p),
    placeClaimEmailChallenges: makePlaceClaimEmailChallengesRepo(p),
    placeMerge: makePlaceMergeRepo(p),
    announcements: makeAnnouncementsRepo(p),
    waiverClauses: makeWaiverClausesRepo(p),
    waiverTemplates: makeWaiverTemplatesRepo(p),
    waiverAcceptances: makeWaiverAcceptancesRepo(p),
    volunteerWaiverAcceptances: makeVolunteerWaiverAcceptancesRepo(p),
    notificationPrefs: makeNotificationPreferencesRepo(p),
    volunteering: makeVolunteeringRepo(p),
    consent: makeConsentRepo(p),
    acceptances: makeAcceptancesRepo(p),
    smsConsent: makeSmsConsentRepo(p),
    performerProfiles: makePerformerProfilesRepo(p),
    performerBookingDefaults: makePerformerBookingDefaultsRepo(p),
    bookingRequests: makeBookingRequestsRepo(p),
    bookingHolds: makeBookingHoldsRepo(p),
    bookingTags: makeBookingTagsRepo(p),
    savedSnippets: makeSavedSnippetsRepo(p),
    placeBookingGrants: makePlaceBookingGrantsRepo(p),
    bookingRequestMessages: makeBookingRequestMessagesRepo(p),
    bookingStandards: makeBookingStandardsRepo(p),
    agreements: makeAgreementsRepo(p),
    supportThreads: makeSupportThreadRepo(p),
    // Search documents written on this client — inside `repos.tx`, part of
    // the transaction (see ./search-documents.ts).
    searchDocuments: makeSearchDocumentsWriter(p),
  } satisfies Omit<TxRepos, "placeLayoutBlobs">;

  return { ...base, ...extras } as TxRepos;
}

// Default Prisma interactive-transaction timeout is 5s, which is too
// tight for our heavier write paths — event upserts with sections /
// seats, full event seeding, refund settlements. 30s leaves headroom
// without masking pathologically slow queries (those will still time
// out with a clear P2028). maxWait covers connection-pool contention.
//
// These are the ONLY defaults. A caller that needs more passes it per
// call via `TxOptions` (booking-accept spec 2026-09-05, P-3) and says why
// in a comment at the call site — never raise these.
export const DEFAULT_TX_TIMEOUT_MS = 30_000;
export const DEFAULT_TX_MAX_WAIT_MS = 10_000;

function assertPositiveMs(name: "timeout" | "maxWait", value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `repos.tx(): ${name} must be a finite number of milliseconds > 0, got ${String(value)}`,
    );
  }
}

/**
 * Resolve per-call `TxOptions` against the defaults. Programmer errors
 * (non-finite, zero, negative) throw a `RangeError` rather than being
 * clamped, so a typo'd timeout fails loudly in tests instead of silently
 * running at some other bound.
 */
export function resolveTxOptions(options?: TxOptions): {
  timeout: number;
  maxWait: number;
} {
  const timeout = options?.timeout ?? DEFAULT_TX_TIMEOUT_MS;
  const maxWait = options?.maxWait ?? DEFAULT_TX_MAX_WAIT_MS;
  assertPositiveMs("timeout", timeout);
  assertPositiveMs("maxWait", maxWait);
  return { timeout, maxWait };
}

export function createPrismaRepos(
  prisma: PrismaClient,
  extras?: ExtraTxRepos,
): Repos {
  const base = makeTxRepos(prisma, extras);

  // NOTE: `base.searchDocuments` here writes on the ROOT client (autocommit,
  // not transactional); only the one inside `tx` below joins a transaction.
  return {
    ...base,
    // Plain passthrough: no try/catch here. Errors thrown inside `fn`
    // propagate and roll the transaction back (see 979840b4 for why a
    // swallowed DB error inside a tx condemns it).
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>, options?: TxOptions) => {
      const { timeout, maxWait } = resolveTxOptions(options);
      return prisma.$transaction(
        (txClient) => fn(makeTxRepos(txClient, extras)),
        { maxWait, timeout },
      );
    },
  };
}
