import { router } from "./init";
import { healthRouter } from "./routers/health";
import { eventsRouter } from "./routers/events";
import { agreementsRouter } from "./routers/agreements";
import { apiKeysRouter } from "./routers/api-keys";
import { ordersRouter } from "./routers/orders";
import { humansRouter } from "./routers/humans";
import { orgsRouter } from "./routers/orgs";
import { eventTemplatesRouter } from "./routers/event-templates";
import { ticketTypeTemplatesRouter } from "./routers/ticket-type-templates";
import { applicationFormTemplatesRouter } from "./routers/application-form-templates";
import { eventHumansRouter } from "./routers/event-humans";
import { seriesRouter } from "./routers/series";
import { ticketTypesRouter } from "./routers/ticket-types";
import { ticketsRouter } from "./routers/tickets";
import { placeLayoutsRouter } from "./routers/place-layouts";
import { placesRouter } from "./routers/places";
import { entityPagesRouter } from "./routers/entity-pages";
import { eventSavesRouter } from "./routers/event-saves";
import { followsRouter } from "./routers/follows";
import { settlementsRouter } from "./routers/settlements";
import { splitsRouter } from "./routers/splits";
import { unifiedSearchRouter } from "./routers/unified-search";
import { stripeConnectRouter } from "./routers/stripe-connect";
import { commsRouter } from "./routers/comms";
import { categoriesRouter } from "./routers/categories";
import { communityRouter } from "./routers/community";
import { eventSuggestionsRouter } from "./routers/event-suggestions";
import { entityReportsRouter } from "./routers/entity-reports";
import { arrivalAreasRouter } from "./routers/arrival-areas";
import { moderatorApplicationsRouter } from "./routers/moderator-applications";
import { moderationRouter } from "./routers/moderation";
import { tagsRouter } from "./routers/tags";
import { delegatesRouter } from "./routers/delegates";
import { embedsRouter } from "./routers/embeds";
import { platformRouter } from "./routers/platform";
import { platformJobsRouter } from "./routers/platform-jobs";
import { platformResaleOpsRouter } from "./routers/platform-resale-ops";
import {
  invitePausesRouter,
  invitePausesStaffRouter,
} from "./routers/invite-pauses";
import { announcementsRouter } from "./routers/announcements";
import { quotasRouter } from "./routers/quotas";
import { promosRouter } from "./routers/promos";
import { creditsRouter } from "./routers/credits";
import { resaleRouter } from "./routers/resale";
import { routingRouter } from "./routers/routing";
import { featuresRouter } from "./routers/features";
import { analyticsRouter } from "./routers/analytics";
import { claimsRouter } from "./routers/claims";
import { compRouter } from "./routers/comp";
import { notificationsRouter } from "./routers/notifications";
import { notificationPreferencesRouter } from "./routers/notification-preferences";
import { waiversRouter } from "./routers/waivers";
import { volunteerRouter } from "./routers/volunteer";
import { volunteerPacksRouter } from "./routers/volunteer-packs";
import { scannerRouter } from "./routers/scanner";
import { consentRouter } from "./routers/consent";
import { scanRouter } from "./routers/scan";
import { posRouter } from "./routers/pos";
import { placeReviewsRouter } from "./routers/place-reviews";
import { attendeeReviewsRouter } from "./routers/attendee-reviews";
import { walletPassesRouter } from "./routers/wallet-passes";
import { featuredItemsRouter } from "./routers/featured-items";
import { payoutTermsRouter } from "./routers/payout-terms";
import { payoutsRouter } from "./routers/payouts";
import { performersRouter } from "./routers/performers";
import { bookingRequestsRouter } from "./routers/booking-requests";
import { bookingAgreementsRouter } from "./routers/booking-agreements";
// ── P4b (deal terms) ──
import { dealsRouter } from "./routers/deals";
import { bookingHoldsRouter } from "./routers/booking-holds";
import { venueConfirmationRouter } from "./routers/venue-confirmation";
import { bookingTagsRouter } from "./routers/booking-tags";
// ── booking-the-night P2d-1 (saved reasons) ──
import { savedSnippetsRouter } from "./routers/saved-snippets";
import { supportRouter } from "./routers/support";
import { spotifyRouter } from "./routers/spotify";
import { membershipsRouter } from "./routers/memberships";

export const appRouter = router({
  // Health is intentionally top-level (used by load balancers and generic probes).
  ...healthRouter,

  // Domain routers MUST be namespaced so the public contract is stable and we avoid
  // collisions as the API grows.
  events: router(eventsRouter),
  agreements: router(agreementsRouter),
  apiKeys: router(apiKeysRouter),
  orders: router(ordersRouter),
  humans: router(humansRouter),
  orgs: router(orgsRouter),
  ticketTypes: router(ticketTypesRouter),
  tickets: router(ticketsRouter),
  eventTemplates: router(eventTemplatesRouter),
  ticketTypeTemplates: router(ticketTypeTemplatesRouter),
  applicationFormTemplates: router(applicationFormTemplatesRouter),
  eventHumans: router(eventHumansRouter),
  series: router(seriesRouter),
  placeLayouts: router(placeLayoutsRouter),
  places: router(placesRouter),
  entityPages: router(entityPagesRouter),
  eventSaves: router(eventSavesRouter),
  follows: router(followsRouter),
  settlements: router(settlementsRouter),
  splits: router(splitsRouter),
  search: router(unifiedSearchRouter),
  stripeConnect: router(stripeConnectRouter),
  comms: router(commsRouter),
  categories: router(categoriesRouter),
  community: router(communityRouter),
  eventSuggestions: router(eventSuggestionsRouter),
  entityReports: router(entityReportsRouter),
  arrivalAreas: router(arrivalAreasRouter),
  moderatorApplications: router(moderatorApplicationsRouter),
  moderation: router(moderationRouter),
  tags: router(tagsRouter),
  delegates: router(delegatesRouter),
  embeds: router(embedsRouter),
  // `platform.invitePauses.*` mounts here (not in platform.ts) so it sits
  // under the wholesale `platform.*` staff second-factor gate.
  platform: router({
    ...platformRouter,
    invitePauses: router(invitePausesStaffRouter),
  }),
  invitePauses: router(invitePausesRouter),
  // `platformJobs.cancelLegacyResaleListings` mounts here so it sits under
  // the `platformJobs.*` staff second-factor gate and key denylist prefix.
  platformJobs: router({ ...platformJobsRouter, ...platformResaleOpsRouter }),
  announcements: router(announcementsRouter),
  quotas: router(quotasRouter),
  promos: router(promosRouter),
  credits: router(creditsRouter),
  resale: router(resaleRouter),
  routing: router(routingRouter),
  features: router(featuresRouter),
  analytics: router(analyticsRouter),
  claims: router(claimsRouter),
  comp: router(compRouter),
  notifications: router(notificationsRouter),
  notificationPreferences: router(notificationPreferencesRouter),
  waivers: router(waiversRouter),
  volunteer: router(volunteerRouter),
  volunteerPacks: router(volunteerPacksRouter),
  scanner: router(scannerRouter),
  consent: router(consentRouter),
  scan: router(scanRouter),
  pos: router(posRouter),
  placeReviews: router(placeReviewsRouter),
  attendeeReviews: router(attendeeReviewsRouter),
  walletPasses: router(walletPassesRouter),
  featuredItems: router(featuredItemsRouter),
  payoutTerms: router(payoutTermsRouter),
  payouts: router(payoutsRouter),
  performers: router(performersRouter),
  bookingRequests: router(bookingRequestsRouter),
  bookingAgreements: router(bookingAgreementsRouter),
  // ── P4b (deal terms) ──
  deals: router(dealsRouter),
  bookingHolds: router(bookingHoldsRouter),
  venueConfirmation: router(venueConfirmationRouter),
  bookingTags: router(bookingTagsRouter),
  // ── booking-the-night P2d-1 (saved reasons) ──
  savedSnippets: router(savedSnippetsRouter),
  support: router(supportRouter),
  spotify: router(spotifyRouter),
  memberships: router(membershipsRouter),
});
export type AppRouter = typeof appRouter;
