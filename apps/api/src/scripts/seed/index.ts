// Barrel re-export — gives consumers a single import path for seed helpers.

export { DEMO_IDS, DEV_LOGIN_USER, DEV_LOGIN_MXN_USER } from "./ids.js";

export {
  pMap,
  slugify,
  REGION_CENTERS,
  DEFAULT_REGION_CODE,
  seededCoordsForFixture,
  buildStartDate,
  createInMemoryIdempotency,
} from "./utils.js";
export type { LatLng } from "./utils.js";

export {
  DEMO_EVENT_IMAGES,
  SEED_BODY_TEMPLATES,
  SEED_CATEGORIES,
  SEED_TAG_GENRES,
  REGIONS,
  BUYER_FIXTURES,
  ADDITIONAL_HUMANS,
  ADDITIONAL_ORGS,
  PLACES,
  HUMAN_EVENT_FIXTURES,
  buildEventFixtures,
  buildSeedEventBody,
  inferCategorySlug,
} from "./fixtures.js";
export type {
  TicketFixture,
  EventSeedFixture,
  HumanEventFixture,
  AdditionalHumanFixture,
  AdditionalOrgFixture,
  PlaceFixture,
  TagGenreSeed,
} from "./fixtures.js";

export {
  ensureOrg,
  ensureDemoHuman,
  ensureDevLoginUser,
  ensureDevLoginMxnUser,
  ensureAdditionalHumans,
  ensurePerformerProfiles,
  ensurePerformerBookingDefaults,
  ensureAdditionalOrgs,
} from "./identity.js";

export { ensureFeaturedItems, FEATURED_EVENT_SLUGS } from "./featured-items.js";

export {
  ensurePayee,
  ensureAgreement,
  ensureDefaultAgreements,
  ensureFeePolicy,
} from "./finance.js";

export { ensureCategories } from "./categories.js";
export { ensureGenreTags } from "./tags.js";
export { ensurePlaces, backfillEventVenueDefaults } from "./places.js";
export {
  ensurePlaceLayouts,
  linkEventsToPlaceLayouts,
} from "./place-layouts.js";
export { ensureEventSeatSections } from "./seat-sections.js";
export { validatePlaceLayouts } from "./validate-layouts.js";
export type { LayoutValidationIssue } from "./validate-layouts.js";
export { validateLayoutRenderability } from "./validate-layout-renderability.js";
export type { RenderabilityIssue } from "./validate-layout-renderability.js";

export {
  upsertEventWithTickets,
  upsertHumanEventWithTickets,
  ensureEventImage,
} from "./events.js";

export {
  seedDemoOrders,
  seedDevLoginOrders,
  seedHumanEventOrders,
  seedDemoCashSales,
  seedDemoPosOrders,
} from "./orders.js";

export { seedDevLoginExtras } from "./extras.js";
export { seedAttendeeReviewShow } from "./attendee-review-fixture.js";
export { wipeSeedData } from "./wipe.js";
export { ensurePlatformWaivers } from "./waivers.js";
export { seedWaiverClauses } from "./waiver-clauses.js";
export { seedVolunteering } from "./volunteering.js";
export {
  ensureVolunteerPacks,
  encodeVolunteerPackRoles,
  LAUNCH_VOLUNTEER_PACKS,
} from "./volunteer-packs.js";
export {
  ensureTicketPacks,
  encodeTicketPackTemplates,
  LAUNCH_TICKET_PACKS,
} from "./ticket-packs.js";
export {
  ensureApplicationFormTemplates,
  encodeApplicationFormTemplate,
  applicationTemplateContentDiffers,
  LAUNCH_APPLICATION_FORM_TEMPLATES,
} from "./application-form-templates.js";
export { ensureDemoPromos } from "./promos.js";

export {
  seedAllEntityPages,
  seedOrgEntityPages,
  seedPlaceEntityPages,
  enrichHumanEntityPages,
} from "./entity-pages.js";

export { seedEntityFollows } from "./follows.js";
export { seedCommunityEditSuggestions } from "./community-suggestions.js";
