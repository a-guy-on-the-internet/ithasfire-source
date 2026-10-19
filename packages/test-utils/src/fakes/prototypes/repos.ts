import { vi } from "vitest";

export const agreementsRepoPrototype = {
  getById: vi.fn(),
  listByEvent: vi.fn(),
  listByEventIds: vi.fn(),
  listLinesByTermsIds: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  activate: vi.fn(),
  archive: vi.fn(),
  replaceLines: vi.fn(),
  seedLinesIfEmpty: vi.fn(),
  listLines: vi.fn(),
  pinFeePolicy: vi.fn(),
  provisionDefaultPrimary: vi.fn(),
  getLineById: vi.fn(),
  updateLineConfirmation: vi.fn(),
  clone: vi.fn(),
  markNotDefault: vi.fn(),
};

/**
 * Two-party booking `Agreement` repo (`Repos["agreements"]`) — distinct from
 * `agreementsRepoPrototype` above, which fakes the PayoutTerms repo (it
 * predates the booking Agreement model and kept the legacy name).
 */
export const bookingAgreementsRepoPrototype = {
  getById: vi.fn(),
  getByEventId: vi.fn(),
  findByLinkedEventId: vi.fn(),
  findManyByLinkedEventIds: vi.fn(async () => []),
  findManyByIds: vi.fn(),
  getByPayoutTermsId: vi.fn(),
  create: vi.fn(),
  updateHeader: vi.fn(),
  listByParty: vi.fn(),
  updateStatus: vi.fn(),
};

export const eventsRepoPrototype = {
  getById: vi.fn(),
  listByEvent: vi.fn(),
  listTicketTypes: vi.fn(),
  listTicketTypesForEventIds: vi.fn(),
  ensureHostPermission: vi.fn(),
  getBody: vi.fn(),
  getContent: vi.fn(),
  listMediaReferenceSets: vi.fn(async () => []),
  updateBody: vi.fn(),
  updateContent: vi.fn(),
  upsertDraft: vi.fn(),
  lockLocationsAtPlace: vi.fn(async () => undefined),
  lockRows: vi.fn(async () => undefined),
  hasOwnedLiveEventsAtPlace: vi.fn(async () => false),
  countLiveCommunityListingsAtPlace: vi.fn(async () => 0),
  reprojectLocationForPlace: vi.fn(async () => [] as string[]),
  followPlaceAddress: vi.fn(async () => ({
    followedIds: [] as string[],
    skippedIds: [] as string[],
  })),
  publish: vi.fn(),
  setCategory: vi.fn(),
  filterByCategory: vi.fn(),
  countIndexableByCategory: vi.fn(async () => 0),
  listPublished: vi.fn(),
  getPopularityStats: vi.fn(),
  listPublishedByPlace: vi.fn(),
  listPublishedByPlaceIds: vi.fn(async () => []),
  countCommunityListingsAtPlace: vi.fn(async () => 0),
  listPublishedOccurrencesByPlace: vi.fn(async () => []),
  listPublishedByOrg: vi.fn(),
  listPublishedByRegion: vi.fn(),
  listPublishedByCountry: vi.fn(),
  setListingPriority: vi.fn(),
  searchPublished: vi.fn(),
  pickRandomEvent: vi.fn(),
  listPublishedForSitemap: vi.fn(),
  updateVisibility: vi.fn(),
  updateGateType: vi.fn(),
  updatePassword: vi.fn(),
  updateWaitlistSettings: vi.fn(),
  getGateSettings: vi.fn(),
  assignSlug: vi.fn(),
  updateSlug: vi.fn(),
  listSluggedPage: vi.fn(async () => []),
  getSlugDateRow: vi.fn(async () => null),
  setSlugOnly: vi.fn(),
  recordSlugHistory: vi.fn(),
  resolveBySlug: vi.fn(),
  resolveByShortId: vi.fn(),
  getSlugContext: vi.fn(),
  linkSavedLocation: vi.fn(),
  findByPayoutTermsId: vi.fn(),
  findManyByIds: vi.fn(),
  listAllByPlace: vi.fn(),
  listByOwner: vi.fn(),
  cancel: vi.fn(),
  createCommunityListing: vi.fn(),
  applyCommunityEdit: vi.fn(),
  publishCommunityListingIfDraft: vi.fn(),
  createAttestation: vi.fn(),
  unpublish: vi.fn(),
  complete: vi.fn(),
  archive: vi.fn(),
  delete: vi.fn(),
  setWaiverTemplate: vi.fn(),
  enumerateGeoCategoryCombos: vi.fn(),
  listPublishedByCategoryAndCity: vi.fn(),
  countPublishedByCategoryAndCityRegionCode: vi.fn(async () => 0),
  getStatsForPlace: vi.fn(),
  getUpcomingStatsForOwners: vi.fn(),
  updateTaxRate: vi.fn(),
  fillTaxRateIfUnset: vi.fn(),
  replaceTaxRateIfUnchanged: vi.fn(),
  linkPayoutTerms: vi.fn(),
  updateRefundCutoff: vi.fn(),
  updateInstructionalAdmission: vi.fn(),
  updateVolunteerSettings: vi.fn(),
  listRecurringEventIds: vi.fn(),
  listCommunityListingsForPlatform: vi.fn(async () => ({
    items: [],
    nextCursor: null,
  })),
  findObscuredEventsCrossingReveal: vi.fn(),
  findObscuredPlaceEventsStartingIn: vi.fn(),
  markAddressRevealNotified: vi.fn(),
  // Venue confirmation (venue-confirmation-and-booking-intents spec).
  setVenueConfirmation: vi.fn(),
  withdrawVenueConfirmation: vi.fn(),
  // holds-without-a-request FR-012: the shared note.
  setNote: vi.fn(async () => ({ status: "not_found" as const })),
};

export const organizationsRepoPrototype = {
  getById: vi.fn(),
  getByIds: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setDefaultPrimaryPayoutTermsIdIfNull: vi.fn(async () => true),
  addMember: vi.fn(),
  countMembersByRole: vi.fn(),
  listActive: vi.fn(),
  listMembers: vi.fn(),
  removeMember: vi.fn(),
  createInvitation: vi.fn(),
  isMemberByEmail: vi.fn(async () => false),
  getInvitationByToken: vi.fn(),
  getInvitationByOrgAndEmail: vi.fn(),
  listInvitations: vi.fn(),
  updateInvitationStatus: vi.fn(),
  getOrgTrustStats: vi.fn(),
  acceptChargebackTerms: vi.fn(),
  isSoleOwnerOfAnyOrg: vi.fn(),
};

export const humanDelegatesRepoPrototype = {
  addDelegate: vi.fn(),
  getDelegation: vi.fn(),
  listPrincipalsForDelegate: vi.fn(async () => []),
  listDelegates: vi.fn(),
  removeDelegate: vi.fn(),
  countDelegatesByRole: vi.fn(),
};

export const humansRepoPrototype = {
  getById: vi.fn(),
  getByIds: vi.fn(),
  getByIdWithIdentity: vi.fn(),
  getAccountCreatedAt: vi.fn(),
  stampFirstSignInIfUnset: vi.fn(async () => undefined),
  getByEmail: vi.fn(),
  getByPhone: vi.fn(),
  getByUsername: vi.fn(),
  lockForAuthUser: vi.fn(async () => undefined),
  getHumanIdForAuthUserId: vi.fn(),
  getAuthActorForAuthUserId: vi.fn(),
  getAuthUserById: vi.fn(),
  linkAuthUserToHuman: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setDefaultPrimaryPayoutTermsIdIfNull: vi.fn(async () => true),
  setThemeMode: vi.fn(async () => undefined),
  ensureByProvider: vi.fn(),
  ensureGuestHuman: vi.fn(),
  listForSearchIndex: vi.fn(),
  batchLookupHumanIdsByEmail: vi.fn(),
  searchByQuery: vi.fn(),
  acceptChargebackTerms: vi.fn(),
  acknowledgeScannerTerms: vi.fn(),
  updateJobs: vi.fn(),
  listAllWithMemberships: vi.fn(),
  listAuthAccounts: vi.fn(),
  listEmailVerifiedIds: vi.fn(async () => []),
  unlinkAuthAccount: vi.fn(),
  hasPasswordCredential: vi.fn(),
  hasSecondFactorEnrolled: vi.fn(),
  verifyPassword: vi.fn(),
  forceVerifyEmail: vi.fn(),
  getSignInFootprint: vi.fn(),
  holdsEmailAttachedRows: vi.fn(async () => false),
  listHumanIdsHoldingEmailAttachedRows: vi.fn(async () => []),
  invalidateAllSessions: vi.fn(),
  deleteHuman: vi.fn(),
  hasDeletionBlockingHistory: vi.fn(),
  getHumanTrustStats: vi.fn(),
};

export const entityPagesRepoPrototype = {
  getByOwner: vi.fn(),
  getByOwners: vi.fn(),
  getBySlug: vi.fn(),
  upsert: vi.fn(),
  bulkCreate: vi.fn(),
  isSlugAvailable: vi.fn(),
  resolveSlugHistory: vi.fn(),
  recordSlugHistory: vi.fn(),
  getTheme: vi.fn(),
  upsertTheme: vi.fn(),
  listBlocks: vi.fn(),
  listBlocksByPageIds: vi.fn(),
  createBlock: vi.fn(),
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  reorderBlocks: vi.fn(),
  getById: vi.fn(),
  updateFollowSettings: vi.fn(),
  deleteByOwner: vi.fn(),
  applyTemplateSeed: vi.fn(),
  getDraft: vi.fn(),
  lockDraftForUpdate: vi.fn(),
  writeDraft: vi.fn(),
  clearDraft: vi.fn(),
};

export const payeesRepoPrototype = {
  getById: vi.fn(),
  getBySubject: vi.fn(),
  getByStripeAccountId: vi.fn(),
  syncCapabilities: vi.fn(),
  getByIds: vi.fn(),
  upsertForSubject: vi.fn(),
  markDeauthorized: vi.fn(),
  updateResaleFinanceState: vi.fn(),
};

export const feePoliciesRepoPrototype = {
  getById: vi.fn(),
  getByIds: vi.fn(),
  resolveEffective: vi.fn(),
  resolveEffectiveForScopes: vi.fn(),
  upsert: vi.fn(),
};

export const categoriesRepoPrototype = {
  listActive: vi.fn(),
  listActiveWithUpcomingEvents: vi.fn(),
  listActiveWithListedEvents: vi.fn(),
  listAll: vi.fn(),
  getBySlug: vi.fn(),
  getById: vi.fn(),
  findSlug: vi.fn(),
  findSlugsBySlug: vi.fn(),
  listSlugs: vi.fn(),
  listAllSlugs: vi.fn(),
  listCurrentSlugs: vi.fn(),
  setCurrentSlug: vi.fn(),
  create: vi.fn(),
  upsertSeed: vi.fn(),
  deleteById: vi.fn(),
  setSeoType: vi.fn(),
  rename: vi.fn(),
  setNameTranslations: vi.fn(),
  listPublishedEventIds: vi.fn(),
  setActive: vi.fn(),
  lockSortOrder: vi.fn(),
  lockNaming: vi.fn(),
  setSortOrders: vi.fn(),
};

export const categoryRequestsRepoPrototype = {
  create: vi.fn(),
  findPending: vi.fn(),
  listPendingBySlug: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  claimPendingForReview: vi.fn(),
  markReviewed: vi.fn(),
};

export const eventEditSuggestionsRepoPrototype = {
  create: vi.fn(),
  getById: vi.fn(),
  listPending: vi.fn(),
  listPendingReferenceFields: vi.fn(async () => []),
  claimPendingForReview: vi.fn(),
  markReviewed: vi.fn(),
  countPendingByIp: vi.fn(async () => 0),
  countPendingByEvent: vi.fn(async () => 0),
  listBySubmitter: vi.fn(),
};

export const communityModeratorApplicationsRepoPrototype = {
  create: vi.fn(),
  getById: vi.fn(),
  findPendingByApplicant: vi.fn(async () => null),
  listPending: vi.fn(),
  claimPendingForReview: vi.fn(),
  markReviewed: vi.fn(),
};

export const eventRsvpsRepoPrototype = {
  upsert: vi.fn(),
  delete: vi.fn(async () => {}),
  existsForUser: vi.fn(async () => false),
  listForUser: vi.fn(async () => ({ items: [], nextCursor: null })),
  listUpcomingEventsForUser: vi.fn(async () => []),
  listHumanIdsForEvent: vi.fn(async () => [] as string[]),
};

export const tagsRepoPrototype = {
  getBySlug: vi.fn(),
  findOrCreate: vi.fn(),
  search: vi.fn(),
  setEventTags: vi.fn(),
  getEventTags: vi.fn(),
};

export const auditRepoPrototype = {
  log: vi.fn(),
  list: vi.fn(async () => ({ items: [], total: 0 })),
  listForEntity: vi.fn(async () => []),
};

export const authzRepoPrototype = {
  getOrgMembership: vi.fn(),
  getOrgMemberships: vi.fn(),
  listOrgMembershipsByHumanId: vi.fn(),
  getStaffRolesForHumanId: vi.fn(),
  grantHumanRole: vi.fn(async () => ({ granted: true })),
  revokeHumanRole: vi.fn(async () => ({ revoked: true })),
  getEventOrgId: vi.fn(),
  getEventHumanId: vi.fn(),
  getPlaceAccessContext: vi.fn(),
  isPlaceVerifiedForOrg: vi.fn(),
  getHumanDelegation: vi.fn(),
  listHumanIdsByStaffRole: vi.fn(),
  lockAdminRoleGuard: vi.fn(),
};

export const savedLocationsRepoPrototype = {
  getById: vi.fn(),
  getByIds: vi.fn(),
  getAccessibleByOrg: vi.fn(),
  getAccessibleByHuman: vi.fn(),
  incrementUsage: vi.fn(),
  create: vi.fn(),
  findByOwnerAndAddress: vi.fn(),
  updateTaxRate: vi.fn(),
  fillTaxRateIfUnset: vi.fn(),
};

export const placesRepoPrototype = {
  getById: vi.fn(),
  getByIds: vi.fn(),
  getBySlug: vi.fn(),
  upsert: vi.fn(),
  listAccessibleByHuman: vi.fn(),
  listOwnedBySubject: vi.fn(async () => []),
  listWithheldOwnedNearPoint: vi.fn(async () => []),
  listForSearchIndex: vi.fn(),
  listForSitemap: vi.fn(),
  countDirectory: vi.fn(async () => 0),
  getSlugContext: vi.fn(),
  assignSlug: vi.fn(),
  recordSlugHistory: vi.fn(),
  resolveBySlug: vi.fn(),
  updateTaxRate: vi.fn(),
  fillTaxRateIfUnset: vi.fn(),
  listAll: vi.fn(),
  deletePlace: vi.fn(),
  bulkCreate: vi.fn(),
  getVerifiedOwnershipForPlace: vi.fn(),
  lockPlaceForClaim: vi.fn(),
  findActiveExactByNormalizedName: vi.fn(async () => []),
  lockPlaceName: vi.fn(async () => undefined),
  setStatus: vi.fn(),
  compareAndSetStatus: vi.fn(),
  setDirectoryListing: vi.fn(),
  setVerificationStatus: vi.fn(),
  setFlag: vi.fn(),
  setCommunityListingAcceptance: vi.fn(),
  getOwnershipById: vi.fn(),
  listActiveOwnershipsForPlace: vi.fn(),
  createVerifiedOwnership: vi.fn(),
  createProvisionalOwnership: vi.fn(),
  verifyOwnership: vi.fn(),
  revokeOwnership: vi.fn(),
  lockClaimsByActor: vi.fn(async () => undefined),
};

export const eventTemplatesRepoPrototype = {
  getById: vi.fn(),
  findByName: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  list: vi.fn(),
};

export const eventHumansRepoPrototype = {
  attach: vi.fn(),
  detach: vi.fn(),
  listByEvent: vi.fn(),
  reorder: vi.fn(),
  getById: vi.fn(),
  linkHuman: vi.fn(),
};

export const imagesRepoPrototype = {
  create: vi.fn(),
  getById: vi.fn(),
  resolveByIds: vi.fn(),
  markUploaded: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  softDelete: vi.fn(),
  softDeleteIfUnfinalized: vi.fn(),
  listByOwner: vi.fn(),
  getPrimaryImageRefs: vi.fn(),
  listByEventId: vi.fn(),
  listSweepCandidates: vi.fn(),
  listSoftDeleted: vi.fn(),
  hardDelete: vi.fn(),
};

export const jobCursorsRepoPrototype = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => undefined),
};

export const pendingObjectDeletionsRepoPrototype = {
  enqueueMany: vi.fn(async () => {}),
  enqueueOnce: vi.fn(async () => ({ inserted: true as const })),
  getById: vi.fn(async () => null),
  listDue: vi.fn(async () => []),
  markDeleted: vi.fn(async () => 1),
  markFailed: vi.fn(async () => {}),
  markDead: vi.fn(async () => {}),
  // Ops read behind the moderation dashboard's "rejected but not deleted"
  // tile. Defaults to a HEALTHY outbox so existing tests that never look at it
  // keep passing; anything asserting on it must stub a non-zero answer, which
  // is the direction that fails loudly rather than quietly.
  countOutboxHealth: vi.fn(async () => ({ dead: 0, overdue: 0 })),
  cancelPending: vi.fn(async () => 0),
};

export const eventUnlocksRepoPrototype = {
  upsert: vi.fn(),
  isUnlocked: vi.fn(),
  get: vi.fn(),
  revoke: vi.fn(),
  revokeBySubmission: vi.fn(),
  revokeByInvite: vi.fn(async () => 0),
  repointInvite: vi.fn(async () => false),
  listByEventId: vi.fn(),
  listByHumanId: vi.fn(),
};

export const volunteeringRepoPrototype = {
  // Generic asks (2026-06-29 generic-volunteering-asks spec)
  createAsk: vi.fn(),
  createAskIfAbsent: vi.fn(async () => {}),
  updateAsk: vi.fn(),
  // Ask-level waiver assignment (ask-level-volunteer-waivers spec) —
  // dedicated setter, never part of updateAsk.
  setAskWaiverTemplate: vi.fn(),
  getAsk: vi.fn(async () => null),
  listAskOwnersByIds: vi.fn(async () => [] as unknown[]),
  listAsksBySubject: vi.fn(async () => [] as unknown[]),
  listAsksByOrg: vi.fn(async () => [] as unknown[]),
  // Volunteer groups
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  getGroup: vi.fn(async () => null),
  listGroupsByAsk: vi.fn(async () => [] as unknown[]),
  setGroupCoordinator: vi.fn(),
  setGroupCoordinatorIfCurrent: vi.fn(),
  deleteGroup: vi.fn(async () => {}),
  // Ask-scoped roles / signups
  listRolesByAsk: vi.fn(async () => [] as unknown[]),
  listSignupsByAsk: vi.fn(async () => ({
    items: [] as unknown[],
    pageInfo: {
      total: 0,
      count: 0,
      limit: 25,
      offset: 0,
      hasNextPage: false,
      nextOffset: null,
    },
  })),
  // Keyset roster read — one empty page, exhausted.
  listSignupsByAskCursor: vi.fn(async () => ({
    items: [] as unknown[],
    nextCursor: null,
  })),
  assignSignupToGroup: vi.fn(),
  // Roster broadcasts
  createBroadcast: vi.fn(),
  getBroadcast: vi.fn(async () => null),
  listBroadcastsByAsk: vi.fn(async () => [] as unknown[]),
  listBroadcastRecipients: vi.fn(async () => [] as unknown[]),
  // "My volunteering" .ics feed
  // Set-if-absent write — `true` = this call won and stored the token.
  setVolunteerIcsFeedToken: vi.fn(async () => true),
  // Unconditional overwrite (rotation) — `true` = the human row exists.
  replaceVolunteerIcsFeedToken: vi.fn(async () => true),
  getVolunteerIcsFeedToken: vi.fn(async () => null),
  findHumanIdByIcsFeedToken: vi.fn(async () => null),
  listUpcomingSignupsForFeed: vi.fn(async () => [] as unknown[]),
  // "My volunteering" page — every signup the human holds, any status.
  listCommitmentsByHuman: vi.fn(async () => [] as unknown[]),
  // Role templates
  createRoleTemplate: vi.fn(),
  updateRoleTemplate: vi.fn(),
  archiveRoleTemplate: vi.fn(),
  listRoleTemplates: vi.fn(),
  getRoleTemplate: vi.fn(),
  getRoleTemplateUsableBy: vi.fn(),
  // Role-template shift presets
  upsertRoleTemplateShifts: vi.fn(),
  listRoleTemplateShifts: vi.fn(),
  getRoleTemplateWithShifts: vi.fn(),
  listRoleTemplateShiftsByTemplateIds: vi.fn(),
  // Event volunteer roles
  createEventRole: vi.fn(),
  updateEventRole: vi.fn(),
  deleteEventRole: vi.fn(),
  listEventRoles: vi.fn(),
  getEventRole: vi.fn(),
  // Shifts
  createShift: vi.fn(),
  getShift: vi.fn(),
  updateShift: vi.fn(),
  deleteShift: vi.fn(),
  listShifts: vi.fn(),
  // Signups
  createSignup: vi.fn(),
  updateSignupStatus: vi.fn(),
  updateSignupContactPrefs: vi.fn(),
  getSignup: vi.fn(),
  getSignupByEmail: vi.fn(),
  listSignups: vi.fn(),
  listSignupsByHuman: vi.fn(),
  // Idempotent bulk opt-out — resolves to the number of signups updated.
  clearSmsOptInByPhone: vi.fn(async () => 0),
  countByRole: vi.fn(),
  countByShift: vi.fn(),
  countByShiftForEvent: vi.fn(async () => ({}) as Record<string, number>),
  countAcceptedOccupancy: vi.fn(async () => 0),
  countPendingSignups: vi.fn(async () => 0),
  countAcceptedByRole: vi.fn(async () => ({}) as Record<string, number>),
  countAcceptedByShiftForEvent: vi.fn(
    async () => ({}) as Record<string, number>,
  ),
  countByEventsAndStatus: vi.fn(
    async () => ({}) as Record<string, Record<string, number>>,
  ),
  // Shift occurrences + claims (generic-volunteer-shifts-occurrences phase A)
  createOccurrence: vi.fn(),
  getOccurrence: vi.fn(async () => null),
  // FOR UPDATE lock + fresh re-read — the claim-gate serialization point.
  getOccurrenceForUpdate: vi.fn(async () => null),
  updateOccurrence: vi.fn(),
  listOccurrencesByAsk: vi.fn(async () => [] as unknown[]),
  // Lock-then-count claim gate — defaults to an empty occurrence.
  countActiveOccurrenceClaims: vi.fn(async () => 0),
  createOccurrenceClaim: vi.fn(),
  getOccurrenceClaim: vi.fn(async () => null),
  getClaimByOccurrenceAndSignup: vi.fn(async () => null),
  updateOccurrenceClaim: vi.fn(),
  listClaimsByOccurrence: vi.fn(async () => [] as unknown[]),
  // Signup-withdrawal cascade — resolves to the number of claims flipped.
  withdrawFutureClaimsBySignup: vi.fn(async () => 0),
  // Shift reminders
  findShiftsNeedingReminder: vi.fn(async () => [] as unknown[]),
  findEventIdsStillOn: vi.fn(async (ids: string[]) => ids),
  // Event-start and ask-start reminders (volunteer-ask-reminders)
  findEventStartReminderCandidates: vi.fn(async () => [] as unknown[]),
  findAskStartReminderCandidates: vi.fn(async () => [] as unknown[]),
  findAskIdsStillRemindable: vi.fn(async (ids: string[]) => ids),
  // `true` = this call claimed the (signupId, kind, channel) ledger row.
  recordShiftNotification: vi.fn(async () => true),
  deleteShiftNotification: vi.fn(async () => {}),
  // Hours tracking
  updateSignupHoursWorked: vi.fn(),
  listSignupsForHoursReport: vi.fn(async () => [] as unknown[]),
  aggregateHoursByVolunteer: vi.fn(async () => [] as unknown[]),
  // Comp-ticket rewards (2026-06-29 volunteer-comp-tickets spec)
  upsertReward: vi.fn(),
  getReward: vi.fn(async () => null),
  listRewardsByAsk: vi.fn(async () => [] as unknown[]),
  getRewardForSignup: vi.fn(async () => null),
  getRewardForUpdate: vi.fn(async () => null),
  incrementGrantsUsed: vi.fn(async () => {}),
  decrementGrantsUsed: vi.fn(async () => {}),
  createGrant: vi.fn(),
  getGrant: vi.fn(async () => null),
  getGrantByRewardAndSignup: vi.fn(async () => null),
  listGrantsBySignup: vi.fn(async () => [] as unknown[]),
  listRewardGrantStatusesBySignupIds: vi.fn(async () => [] as unknown[]),
  listGrantsByAsk: vi.fn(async () => [] as unknown[]),
  updateGrantStatus: vi.fn(),
};

/**
 * Human-profile-keyed volunteer waiver acceptances (Gap 3).
 * `findCurrentForHuman` defaults to null — "nothing on file" — so the
 * waiver gate in submitVolunteerSignup requires acceptance unless a test
 * overrides it.
 */
export const volunteerWaiverAcceptancesRepoPrototype = {
  create: vi.fn(),
  findCurrentForHuman: vi.fn(async () => null),
};

/** `Repos["bookingHolds"]` — booking-holds spec 2026-08-25 (Step 1). */
export const bookingHoldsRepoPrototype = {
  create: vi.fn(),
  createRequestless: vi.fn(),
  getById: vi.fn(async () => null),
  listForRequest: vi.fn(async () => []),
  listLiveForRequests: vi.fn(async () => []),
  listRequestIdsWithConfirmedHold: vi.fn(async () => []),
  lockLine: vi.fn(async () => {}),
  lockRequestBooking: vi.fn(async () => {}),
  listLine: vi.fn(async () => []),
  listLineWithTerms: vi.fn(async () => []),
  listLiveForPlaceRange: vi.fn(async () => []),
  listLiveForCalendarRange: vi.fn(async () => []),
  listForRequester: vi.fn(async () => []),
  updateStatus: vi.fn(),
  renumberLine: vi.fn(async () => []),
  setRespondBy: vi.fn(),
  setNote: vi.fn(async () => ({ status: "not_found" as const })),
  listLiveForGrant: vi.fn(async () => []),
  convertBookerHoldToPlace: vi.fn(async () => null),
  clearPlaceHolder: vi.fn(async () => null),
};

/**
 * `Repos["placeBookingGrants"]` — holds-without-a-request FR-002 / FR-003.
 * Every lookup defaults to "no grant", so authority checks fall through to
 * place-owner / org-EDITOR unless a test seeds one. For real behaviour use
 * `createFakePlaceBookingGrantsRepo` (fakes/place-booking-grants.ts).
 */
export const placeBookingGrantsRepoPrototype = {
  findActiveForActor: vi.fn(async () => null),
  listActiveForActor: vi.fn(async () => []),
  getForPlace: vi.fn(async () => null),
  getForGrantee: vi.fn(async () => null),
  lockSharedAtPlace: vi.fn(async () => null),
  create: vi.fn(),
  lockPlace: vi.fn(async () => {}),
  accept: vi.fn(),
  decline: vi.fn(),
  update: vi.fn(async () => null),
  revoke: vi.fn(async () => null),
  listForPlace: vi.fn(async () => []),
  listForGrantee: vi.fn(async () => []),
  listExpiring: vi.fn(async () => []),
  markExpiryWarned: vi.fn(async () => false),
};

/** `Repos["bookingTags"]` — booking-holds spec FR-017. */
export const bookingTagsRepoPrototype = {
  listForOrg: vi.fn(async () => []),
  create: vi.fn(),
  update: vi.fn(async () => null),
  delete: vi.fn(async () => false),
  setForRequest: vi.fn(async () => []),
  listForRequests: vi.fn(async () => []),
};

/**
 * `Repos["savedSnippets"]` — booking-the-night FR-013. For real behaviour
 * use `createFakeSavedSnippets` (fakes/saved-snippets.ts).
 */
export const savedSnippetsRepoPrototype = {
  listByOwner: vi.fn(async () => []),
  create: vi.fn(),
  update: vi.fn(async () => null),
  delete: vi.fn(async () => false),
  reorder: vi.fn(async () => []),
  lockList: vi.fn(async () => ({ startersCopiedAt: null })),
  getListState: vi.fn(async () => null),
  markStartersCopied: vi.fn(async () => {}),
  deleteByOwner: vi.fn(async () => ({ deleted: 0 })),
};
