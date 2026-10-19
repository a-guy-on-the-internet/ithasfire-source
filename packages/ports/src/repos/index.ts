import type { EntityEventNoticesRepo } from "./entity-event-notices";
import type { PayoutTermsRepo } from "./payout-terms";
// ── P4b (deal terms) ──
import type { DealsRepo } from "./deals";
import type { ApiKeysRepo } from "./api-keys";
import type { BansRepo } from "./bans";
import type { NetworkSightingsRepo } from "./network-sightings";
import type { AnnouncementsRepo } from "./announcements";
import type { AudioUploadsRepo } from "./audio-uploads";
import type { AuditRepo } from "./audit";
import type { AuthZRepo } from "./authz";
import type { EmbedsRepo } from "./embeds";
import type { CategoriesRepo } from "./categories";
import type { SearchDocumentsWriter } from "../search/multi-index.port";
import type { CategoryRequestsRepo } from "./category-requests";
import type { EventEditSuggestionsRepo } from "./event-edit-suggestions";
import type { EntityReportsRepo } from "./entity-reports";
import type { CommunityModeratorApplicationsRepo } from "./community-moderator-applications";
import type { EventRsvpsRepo } from "./event-rsvps";
import type { EventDatesRepo, EventDateRsvpRepo } from "./event-dates";
import type { EventSavesRepo } from "./event-saves";
import type { EventChangeNoticesRepo } from "./event-change-notices";
import type { RsvpNoticesRepo } from "./rsvp-notices";
import type { RsvpRemindersRepo } from "./rsvp-reminders";
import type { PostEventPromptsRepo } from "./post-event-prompts";
import type { AttendeeReviewsRepo } from "./attendee-reviews";
import type { ReviewAggregatesRepo } from "./review-aggregates";
import type { TagsRepo } from "./tags";
import type { PromosRepo } from "./promos";
import type { CreditsRepo } from "./credits";
import type {
  EventApplicationsRepo,
  EventInvitesRepo,
  EventWaitlistsRepo,
  EventsRepo,
  InviteListsRepo,
  ContactImportsRepo,
} from "./events";
import type { ImagesRepo } from "./images";
import type { FeaturedEventsRepo } from "./featured-events";
import type { FeaturedItemsRepo } from "./featured-items";
import type { EventHumansRepo } from "./event-humans";
import type { TicketAttributionsRepo } from "./ticket-attributions";
import type {
  EventSeriesOccurrencesRepo,
  EventSeriesRepo,
} from "./event-series";
import type { EventUnlocksRepo } from "./event-unlocks";
import type { EventInviteOptOutsRepo } from "./event-invite-opt-outs";
import type { EventInvitePausesRepo } from "./event-invite-pauses";
import type { FeePoliciesRepo } from "./fee-policies";
import type { FeeWaiversRepo } from "./fee-waivers";
import type { HumansRepo } from "./humans";
import type { HumanStatsRepo } from "./human-stats";
import type { HumanDelegatesRepo } from "./human-delegates";
import type { IdempotencyRepo } from "./idempotency";
import type { DisputesRepo } from "./disputes";
import type { DisputeEvidenceRepo } from "./dispute-evidence";
import type { EarlyFraudWarningsRepo } from "./early-fraud-warnings";
import type { MembershipTaxJurisdictionsRepo } from "./membership-tax-jurisdictions";
import type { MembershipStandingsRepo } from "./membership-standings";
import type { MembershipsRepo } from "./memberships";
import type { MembershipTiersRepo } from "./membership-tiers";
import type { ResaleListingsRepo } from "./resale-listings";
import type { ClaimsRepo } from "./claims";
import type { OrdersRepo } from "./orders";
import type { OrderItemsRepo } from "./order-items";
import type { OrderItemSettlementLinesRepo } from "./order-item-settlement-lines";
import type { OrganizationsRepo } from "./organizations";
import type { OrgStatsRepo } from "./org-stats";
import type { PayeeLedgerRepo } from "./payee-ledger";
import type { PayeesRepo } from "./payees";
import type { PlacesRepo } from "./places";
import type { PlaceMergeRepo } from "./place-merge";
import type { SpacesRepo } from "./spaces";
import type { ArrivalAreasRepo } from "./arrival-areas";
import type { CalendarsRepo } from "./calendars";
import type { PlaceWaiversRepo } from "./place-waivers";
import type { PlaceReviewsRepo, PlaceStatsRepo } from "./place-reviews";
import type { PlaceReviewSessionsRepo } from "./place-review-sessions";
import type { PlaceVerificationRequestsRepo } from "./place-verification-requests";
import type { PlaceVerificationDocumentsRepo } from "./place-verification-documents";
import type { PlaceClaimEmailChallengesRepo } from "./place-claim-email-challenges";
import type { SavedLocationsRepo } from "./saved-locations";
import type { SeatsRepo } from "./seats";
import type { PayoutsRepo } from "./payouts";
import type { PayoutItemsRepo } from "./payout-items";
import type { SettlementsRepo } from "./settlements";
import type { SettlementLinesRepo } from "./settlement-lines";
import type { SplitsRepo } from "./splits";
import type { TicketsRepo } from "./tickets";
import type { PendingTicketTransfersRepo } from "./pending-ticket-transfers";
import type { PendingObjectDeletionsRepo } from "./pending-object-deletions";
import type { JobCursorsRepo } from "./job-cursors";
import type { ImageModerationRecordsRepo } from "./image-moderation-records";
import type { EventTemplateRepo } from "./event-templates";
import type { TicketTypeTemplatesRepo } from "./ticket-type-templates";
import type { ApplicationFormTemplatesRepo } from "./application-form-templates";
import type { NotificationsRepo } from "./notifications";
import type { NotificationDigestsRepo } from "./notification-digests";
import type { NotificationPreferencesRepo } from "./notification-preferences";
import type { PushDevicesRepo } from "./push-devices";
import type { PushReceiptsRepo } from "./push-receipts";
import type {
  PlaceLayoutBlobRepo,
  PlaceLayoutRepo,
  PlaceLayoutStatusRepo,
} from "../place-layouts";
import type { PlatformSettingsRepo } from "./platform-settings";
import type { PosReadersRepo } from "./pos-readers";
import type { ResourceQuotasRepo } from "./resource-quotas";
import type { AnalyticsRepo } from "./analytics";
import type { EntityPagesRepo } from "./entity-pages";
import type { FollowsRepo } from "./follows";
import type {
  WaiverClausesRepo,
  WaiverTemplatesRepo,
  WaiverAcceptancesRepo,
  VolunteerWaiverAcceptancesRepo,
} from "./waivers";
import type { VolunteerRepo } from "./volunteering";
import type { ConsentRepo } from "./consent";
import type { AcceptanceRepo } from "./acceptances";
import type { SmsConsentRepo } from "./sms-consent";
import type { PerformerProfilesRepo } from "./performer-profiles";
import type { PerformerBookingDefaultsRepo } from "./performer-booking-defaults";
import type { BookingRequestsRepo } from "./booking-requests";
import type { BookingHoldsRepo } from "./booking-holds";
import type { BookingTagsRepo } from "./booking-tags";
import type { PlaceBookingGrantsRepo } from "./place-booking-grants";
import type { BookingRequestMessagesRepo } from "./booking-request-messages";
import type { BookingStandardsRepo } from "./booking-standards";
import type { SavedSnippetsRepo } from "./saved-snippets";
import type { AgreementsRepo } from "./agreements";
import type { SupportThreadRepository } from "./support";
import type { SearchReindexPendingRepo } from "./search-reindex-pending";
import type { SearchIndexStateRepo } from "./search-index-state";
export * from "./payout-terms";
// ── P4b (deal terms) ──
export * from "./deals";
export * from "./api-keys";
export * from "./bans";
export * from "./network-sightings";
export * from "./announcements";
export * from "./audit";
export * from "./authz";
export * from "./categories";
export * from "./category-requests";
export * from "./event-edit-suggestions";
export * from "./entity-reports";
export * from "./community-moderator-applications";
export * from "./event-rsvps";
export * from "./event-dates";
export * from "./event-saves";
export * from "./event-change-notices";
export * from "./rsvp-notices";
export * from "./rsvp-reminders";
export * from "./post-event-prompts";
export * from "./attendee-reviews";
export * from "./review-aggregates";
export * from "./tags";
export * from "./promos";
export * from "./credits";
export * from "./events";
export * from "./fee-policies";
export * from "./tickets";
export * from "./pending-ticket-transfers";
export * from "./pending-object-deletions";
export * from "./image-moderation-records";
export * from "./humans";
export * from "./human-stats";
export * from "./human-delegates";
export * from "./organizations";
export * from "./org-stats";
export * from "./payee-ledger";
export * from "./payees";
export * from "./disputes";
export * from "./dispute-evidence";
export * from "./early-fraud-warnings";
export * from "./orders";
export * from "./order-items";
export * from "./order-item-settlement-lines";
export * from "./places";
export * from "./place-merge";
export * from "./spaces";
export * from "./arrival-areas";
export * from "./calendars";
export * from "./place-waivers";
export * from "./place-reviews";
export * from "./place-review-sessions";
export * from "./place-verification-requests";
export * from "./place-verification-documents";
export * from "./place-claim-email-challenges";
export * from "./saved-locations";
export * from "./seats";
export * from "./splits";
export * from "./settlements";
export * from "./settlement-lines";
export * from "./payouts";
export * from "./payout-items";
export * from "./resale-listings";
export * from "./claims";
export * from "./idempotency";
export * from "./event-templates";
export * from "./ticket-type-templates";
export * from "./application-form-templates";
export * from "./event-humans";
export * from "./ticket-attributions";
export * from "./images";
export * from "./audio-uploads";
export * from "./event-series";
export * from "./event-unlocks";
export * from "./event-invite-opt-outs";
export * from "./event-invite-pauses";
export * from "./notifications";
export * from "./notification-digests";
export * from "./push-devices";
export * from "./push-receipts";
export * from "./notification-preferences";
export * from "./featured-events";
export * from "./featured-items";
export * from "./embeds";
export * from "./platform-settings";
export * from "./pos-readers";
export * from "./resource-quotas";
export * from "./analytics";
export * from "./entity-pages";
export * from "./follows";
export * from "./waivers";
export * from "./volunteering";
export * from "./consent";
export * from "./acceptances";
export * from "./sms-consent";
export * from "./performer-profiles";
export * from "./performer-booking-defaults";
export * from "./booking-requests";
export * from "./booking-holds";
export * from "./booking-tags";
export * from "./place-booking-grants";
export * from "./booking-request-messages";
export * from "./booking-standards";
export * from "./saved-snippets";
export * from "./agreements";
export * from "./support";
export * from "./search-reindex-pending";
export * from "./search-index-state";
export type {
  PlaceLayoutRepo,
  PlaceLayoutBlobRepo,
  PlaceLayoutStatusRepo,
} from "../place-layouts";

export type TxRepos = Omit<Repos, "tx">;

/**
 * Per-call overrides for one `repos.tx()` transaction. Both values are
 * milliseconds and must be finite and > 0; the adapter rejects anything
 * else instead of clamping.
 *
 * Defaults (Prisma adapter): `timeout` 30_000, `maxWait` 10_000. They are
 * deliberately NOT tunable globally.
 *
 * Why this exists (booking-accept spec 2026-09-05, P-3): so that a
 * transaction which genuinely cannot fit in 30s is a visible, deliberate
 * choice at ONE call site rather than a quietly raised default for every
 * caller. Rule: a caller passing a longer `timeout` must say why in a
 * comment next to the call (what work it holds open, and why it cannot be
 * split or moved out of the transaction).
 */
export interface TxOptions {
  /** Max time the interactive transaction may stay open, in ms. */
  timeout?: number;
  /** Max time to wait for a connection from the pool before starting, in ms. */
  maxWait?: number;
}

export interface Tx {
  <T>(fn: (tx: TxRepos) => Promise<T>, options?: TxOptions): Promise<T>;
}

export interface Repos {
  /**
   * The Postgres search table's document writes, bound to THIS repos
   * handle's connection: inside `repos.tx`, a write through it commits or
   * rolls back with the transaction. Used by the search index write fence
   * and the privacy scrub when the configured search port reports
   * `indexLivesInPrimaryDatabase` (see core `search/tx-bound-search.ts`).
   * Optional so a fake `Repos` without it simply takes the port's own
   * (non-transactional) path.
   */
  searchDocuments?: SearchDocumentsWriter;
  tx: Tx;
  /**
   * Durable "needs reindex" marks (edit-triggered batched search reindex).
   * Mark inside the edit's transaction; see core `search/search-reindex-marks.ts`.
   */
  searchReindexPending: SearchReindexPendingRepo;
  /** Search index format version + rebuild claim (singleton row). */
  searchIndexState: SearchIndexStateRepo;
  humans: HumansRepo;
  events: EventsRepo;
  images: ImagesRepo;
  audioUploads: AudioUploadsRepo;
  eventUnlocks: EventUnlocksRepo;
  eventInvites: EventInvitesRepo;
  /** "Stop invites from this organiser" opt-outs (gated-event invite links). */
  eventInviteOptOuts: EventInviteOptOutsRepo;
  /** Invite spam complaints + the per-organiser auto-pause (W4). */
  eventInvitePauses: EventInvitePausesRepo;
  featuredEvents: FeaturedEventsRepo;
  featuredItems: FeaturedItemsRepo;
  eventApplications: EventApplicationsRepo;
  eventWaitlists: EventWaitlistsRepo;
  inviteLists: InviteListsRepo;
  contactImports: ContactImportsRepo;
  categories: CategoriesRepo;
  categoryRequests: CategoryRequestsRepo;
  eventEditSuggestions: EventEditSuggestionsRepo;
  /**
   * EntityReport moderation queue (entity-report-intake spec). Core must
   * mutate via repos.tx() so report writes and audit rows commit atomically.
   */
  entityReports: EntityReportsRepo;
  communityModeratorApplications: CommunityModeratorApplicationsRepo;
  eventRsvps: EventRsvpsRepo;
  eventDates: EventDatesRepo;
  eventDateRsvps: EventDateRsvpRepo;
  eventSaves: EventSavesRepo;
  eventChangeNotices: EventChangeNoticesRepo;
  rsvpNotices: RsvpNoticesRepo;
  /**
   * Durable send-ledger for the 24h-before RSVP reminder. Read + claimed by
   * the `community.rsvp-reminders-24h` job only.
   */
  rsvpReminders: RsvpRemindersRepo;
  postEventPrompts: PostEventPromptsRepo;
  attendeeReviews: AttendeeReviewsRepo;
  reviewAggregates: ReviewAggregatesRepo;
  tags: TagsRepo;
  orders: OrdersRepo;
  orderItems: OrderItemsRepo;
  orderItemSettlementLines: OrderItemSettlementLinesRepo;
  tickets: TicketsRepo;
  pendingTicketTransfers: PendingTicketTransfersRepo;
  pendingObjectDeletions: PendingObjectDeletionsRepo;
  jobCursors: JobCursorsRepo;
  imageModerationRecords: ImageModerationRecordsRepo;
  payoutTerms: PayoutTermsRepo;
  // ── P4b (deal terms) ──
  deals: DealsRepo;
  feePolicies: FeePoliciesRepo;
  feeWaivers: FeeWaiversRepo;
  splits: SplitsRepo;
  payeeLedger: PayeeLedgerRepo;
  payees: PayeesRepo;
  disputes: DisputesRepo;
  disputeEvidence: DisputeEvidenceRepo;
  earlyFraudWarnings: EarlyFraudWarningsRepo;
  membershipTaxJurisdictions: MembershipTaxJurisdictionsRepo;
  memberships: MembershipsRepo;
  membershipStandings: MembershipStandingsRepo;
  membershipTiers: MembershipTiersRepo;
  payouts: PayoutsRepo;
  payoutItems: PayoutItemsRepo;
  settlements: SettlementsRepo;
  settlementLines: SettlementLinesRepo;
  resaleListings: ResaleListingsRepo;
  claims: ClaimsRepo;
  idempotency: IdempotencyRepo;
  audit: AuditRepo;
  authz: AuthZRepo;
  apiKeys: ApiKeysRepo;
  /**
   * Bans that stick (2026-09-29): hashed banned identities + the derived
   * "is this owner withheld because of a ban" lookup. See `./bans`.
   */
  bans: BansRepo;
  /** Hashed sign-up / sign-in network sightings, 30-day retention. */
  networkSightings: NetworkSightingsRepo;
  organizations: OrganizationsRepo;
  orgStats: OrgStatsRepo;
  humanDelegates: HumanDelegatesRepo;
  humanStats: HumanStatsRepo;
  places: PlacesRepo;
  /**
   * Merging two duplicate places (merge-duplicate-places spec, 2026-10-13).
   * Row mechanics only; decisions are core's `mergePlaces`.
   */
  placeMerge: PlaceMergeRepo;
  /**
   * Venue-hierarchy repos (docs/specs/2026-08-18/completed/venue-hierarchy-and-holds
   * .spec.yaml).
   */
  spaces: SpacesRepo;
  /** Parking, drop-off and load-in areas (arrival-areas spec, 2026-10-16). */
  arrivalAreas: ArrivalAreasRepo;
  calendars: CalendarsRepo;
  placeWaivers: PlaceWaiversRepo;
  placeReviews: PlaceReviewsRepo;
  placeReviewSessions: PlaceReviewSessionsRepo;
  placeStats: PlaceStatsRepo;
  placeVerificationRequests: PlaceVerificationRequestsRepo;
  placeVerificationDocuments: PlaceVerificationDocumentsRepo;
  placeClaimEmailChallenges: PlaceClaimEmailChallengesRepo;
  savedLocations: SavedLocationsRepo;
  seats: SeatsRepo;
  promos: PromosRepo;
  credits: CreditsRepo;
  eventTemplates: EventTemplateRepo;
  ticketTypeTemplates: TicketTypeTemplatesRepo;
  applicationFormTemplates: ApplicationFormTemplatesRepo;
  eventHumans: EventHumansRepo;
  ticketAttributions: TicketAttributionsRepo;
  series: EventSeriesRepo;
  seriesOccurrences: EventSeriesOccurrencesRepo;
  pushDevices: PushDevicesRepo;
  pushReceipts: PushReceiptsRepo;
  notificationPrefs: NotificationPreferencesRepo;
  notificationDigests: NotificationDigestsRepo;
  notifications?: NotificationsRepo;
  placeLayouts: PlaceLayoutRepo;
  placeLayoutBlobs: PlaceLayoutBlobRepo;
  placeLayoutStatuses: PlaceLayoutStatusRepo;
  analytics: AnalyticsRepo;
  entityPages: EntityPagesRepo;
  follows: FollowsRepo;
  entityEventNotices: EntityEventNoticesRepo;
  embeds: EmbedsRepo;
  platformSettings: PlatformSettingsRepo;
  posReaders: PosReadersRepo;
  resourceQuotas: ResourceQuotasRepo;
  announcements: AnnouncementsRepo;
  waiverClauses: WaiverClausesRepo;
  waiverTemplates: WaiverTemplatesRepo;
  waiverAcceptances: WaiverAcceptancesRepo;
  volunteerWaiverAcceptances: VolunteerWaiverAcceptancesRepo;
  volunteering: VolunteerRepo;
  consent: ConsentRepo;
  acceptances: AcceptanceRepo;
  smsConsent: SmsConsentRepo;
  performerProfiles: PerformerProfilesRepo;
  performerBookingDefaults: PerformerBookingDefaultsRepo;
  bookingRequests: BookingRequestsRepo;
  /**
   * Venue calendar holds on booking requests (booking-holds spec). Read only
   * by the FR-011..014 surfaces (NFR-001); every transition via repos.tx()
   * with CAS (NFR-002).
   */
  bookingHolds: BookingHoldsRepo;
  /**
   * Venue booking standards + example pitches, by (PLACE | CALENDAR) owner
   * (venue-booking-standards spec, 2026-09-25). Storage only — resolution is
   * core's `resolveBookingStandards`.
   */
  bookingStandards: BookingStandardsRepo;
  /** Org-scoped booking-request labels (booking-holds FR-017). */
  bookingTags: BookingTagsRepo;
  savedSnippets: SavedSnippetsRepo;
  /**
   * Per-place booking grants (venue-confirmation spec). Model + authz hook
   * only — read by `requirePlaceBookingAuthority`; no production writer yet.
   */
  placeBookingGrants: PlaceBookingGrantsRepo;
  /** Per-request conversation threads (venue-hierarchy FR-012). */
  bookingRequestMessages: BookingRequestMessagesRepo;
  agreements: AgreementsRepo;
  supportThreads: SupportThreadRepository;
}

export * from "./entity-event-notices";
