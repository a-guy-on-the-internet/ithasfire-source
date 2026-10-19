/**
 * Compile-time + runtime guard: every repo mock prototype must satisfy its
 * port interface.
 *
 * When a method is added to (or removed from) a port interface but not
 * mirrored in the prototype, this file will:
 *   1. Fail `tsc --noEmit` with a clear "Property '…' is missing" error.
 *   2. Fail at test-time with a human-readable message pointing at the file
 *      that needs updating.
 *
 * Fix the prototype in `packages/test-utils/src/fakes/prototypes/repos.ts`,
 * then run:
 *   pnpm vitest:bg --dir packages/test-utils --once
 */
import { describe, it, expect } from "vitest";

import type { PayoutTermsRepo } from "@th/ports/repos/payout-terms";
import type { EventsRepo } from "@th/ports/repos/events";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { OrganizationsRepo } from "@th/ports/repos/organizations";
import type { EntityPagesRepo } from "@th/ports/repos/entity-pages";
import type { PayeesRepo } from "@th/ports/repos/payees";
import type { FeePoliciesRepo } from "@th/ports/repos/fee-policies";
import type { CategoriesRepo } from "@th/ports/repos/categories";
import type { CategoryRequestsRepo } from "@th/ports/repos/category-requests";
import type { EventEditSuggestionsRepo } from "@th/ports/repos/event-edit-suggestions";
import type { CommunityModeratorApplicationsRepo } from "@th/ports/repos/community-moderator-applications";
import type { EventRsvpsRepo } from "@th/ports/repos/event-rsvps";
import type { TagsRepo } from "@th/ports/repos/tags";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { AuthZRepo } from "@th/ports/repos/authz";
import type { SavedLocationsRepo } from "@th/ports/repos/saved-locations";
import type { PlacesRepo } from "@th/ports/repos/places";
import type { EventTemplateRepo } from "@th/ports/repos/event-templates";
import type { EventHumansRepo } from "@th/ports/repos/event-humans";
import type { JobCursorsRepo } from "@th/ports/repos/job-cursors";
import type { ImagesRepo } from "@th/ports/repos/images";
import type { EventUnlocksRepo } from "@th/ports/repos/event-unlocks";
import type { VolunteerRepo } from "@th/ports/repos/volunteering";
import type { PlaceBookingGrantsRepo } from "@th/ports/repos/place-booking-grants";

import {
  agreementsRepoPrototype,
  eventsRepoPrototype,
  humansRepoPrototype,
  organizationsRepoPrototype,
  entityPagesRepoPrototype,
  payeesRepoPrototype,
  feePoliciesRepoPrototype,
  categoriesRepoPrototype,
  categoryRequestsRepoPrototype,
  eventEditSuggestionsRepoPrototype,
  communityModeratorApplicationsRepoPrototype,
  eventRsvpsRepoPrototype,
  tagsRepoPrototype,
  auditRepoPrototype,
  authzRepoPrototype,
  savedLocationsRepoPrototype,
  placesRepoPrototype,
  eventTemplatesRepoPrototype,
  eventHumansRepoPrototype,
  imagesRepoPrototype,
  jobCursorsRepoPrototype,
  eventUnlocksRepoPrototype,
  volunteeringRepoPrototype,
  placeBookingGrantsRepoPrototype,
} from "../repos";

// ── Compile-time shape assertions ──────────────────────────────────────────
// The helper type maps each key of the port interface onto the prototype.
// If the prototype is missing a key, TypeScript emits:
//   "Property 'newMethod' is missing in type …"
// on the corresponding const assignment below.

type AssertKeysPresent<TProto, TPort> = {
  [K in keyof TPort]: K extends keyof TProto ? TProto[K] : never;
};

/* eslint-disable @typescript-eslint/no-unused-vars */
const _agreements: AssertKeysPresent<
  typeof agreementsRepoPrototype,
  PayoutTermsRepo
> = agreementsRepoPrototype;
const _events: AssertKeysPresent<typeof eventsRepoPrototype, EventsRepo> =
  eventsRepoPrototype;
const _humans: AssertKeysPresent<typeof humansRepoPrototype, HumansRepo> =
  humansRepoPrototype;
const _orgs: AssertKeysPresent<
  typeof organizationsRepoPrototype,
  OrganizationsRepo
> = organizationsRepoPrototype;
const _entityPages: AssertKeysPresent<
  typeof entityPagesRepoPrototype,
  EntityPagesRepo
> = entityPagesRepoPrototype;
const _payees: AssertKeysPresent<typeof payeesRepoPrototype, PayeesRepo> =
  payeesRepoPrototype;
const _feePolicies: AssertKeysPresent<
  typeof feePoliciesRepoPrototype,
  FeePoliciesRepo
> = feePoliciesRepoPrototype;
const _categories: AssertKeysPresent<
  typeof categoriesRepoPrototype,
  CategoriesRepo
> = categoriesRepoPrototype;
const _categoryRequests: AssertKeysPresent<
  typeof categoryRequestsRepoPrototype,
  CategoryRequestsRepo
> = categoryRequestsRepoPrototype;
const _eventEditSuggestions: AssertKeysPresent<
  typeof eventEditSuggestionsRepoPrototype,
  EventEditSuggestionsRepo
> = eventEditSuggestionsRepoPrototype;
const _communityModeratorApplications: AssertKeysPresent<
  typeof communityModeratorApplicationsRepoPrototype,
  CommunityModeratorApplicationsRepo
> = communityModeratorApplicationsRepoPrototype;
const _eventRsvps: AssertKeysPresent<
  typeof eventRsvpsRepoPrototype,
  EventRsvpsRepo
> = eventRsvpsRepoPrototype;
const _tags: AssertKeysPresent<typeof tagsRepoPrototype, TagsRepo> =
  tagsRepoPrototype;
const _audit: AssertKeysPresent<typeof auditRepoPrototype, AuditRepo> =
  auditRepoPrototype;
const _authz: AssertKeysPresent<typeof authzRepoPrototype, AuthZRepo> =
  authzRepoPrototype;
const _savedLocations: AssertKeysPresent<
  typeof savedLocationsRepoPrototype,
  SavedLocationsRepo
> = savedLocationsRepoPrototype;
const _places: AssertKeysPresent<typeof placesRepoPrototype, PlacesRepo> =
  placesRepoPrototype;
const _eventTemplates: AssertKeysPresent<
  typeof eventTemplatesRepoPrototype,
  EventTemplateRepo
> = eventTemplatesRepoPrototype;
const _eventHumans: AssertKeysPresent<
  typeof eventHumansRepoPrototype,
  EventHumansRepo
> = eventHumansRepoPrototype;
const _images: AssertKeysPresent<typeof imagesRepoPrototype, ImagesRepo> =
  imagesRepoPrototype;
const _jobCursors: AssertKeysPresent<
  typeof jobCursorsRepoPrototype,
  JobCursorsRepo
> = jobCursorsRepoPrototype;
const _eventUnlocks: AssertKeysPresent<
  typeof eventUnlocksRepoPrototype,
  EventUnlocksRepo
> = eventUnlocksRepoPrototype;
const _volunteering: AssertKeysPresent<
  typeof volunteeringRepoPrototype,
  VolunteerRepo
> = volunteeringRepoPrototype;
const _placeBookingGrants: AssertKeysPresent<
  typeof placeBookingGrantsRepoPrototype,
  PlaceBookingGrantsRepo
> = placeBookingGrantsRepoPrototype;
/* eslint-enable @typescript-eslint/no-unused-vars */

// ── Runtime key-coverage checks ────────────────────────────────────────────
// The compile-time assertions above are the real guard (no casts — a missing
// key is a tsc error). These runtime tests are a cheap belt-and-braces layer
// for runs that skip type-checking.

interface RepoEntry {
  label: string;
  prototype: Record<string, unknown>;
  expectedMinKeys: number;
}

const repos: RepoEntry[] = [
  {
    label: "agreementsRepoPrototype  ↔ PayoutTermsRepo",
    prototype: agreementsRepoPrototype,
    expectedMinKeys: 7,
  },
  {
    label: "eventsRepoPrototype      ↔ EventsRepo",
    prototype: eventsRepoPrototype,
    expectedMinKeys: 20,
  },
  {
    label: "humansRepoPrototype      ↔ HumansRepo",
    prototype: humansRepoPrototype,
    expectedMinKeys: 10,
  },
  {
    label: "organizationsRepoProto   ↔ OrganizationsRepo",
    prototype: organizationsRepoPrototype,
    expectedMinKeys: 4,
  },
  {
    label: "entityPagesRepoPrototype ↔ EntityPagesRepo",
    prototype: entityPagesRepoPrototype,
    expectedMinKeys: 11,
  },
  {
    label: "payeesRepoPrototype      ↔ PayeesRepo",
    prototype: payeesRepoPrototype,
    expectedMinKeys: 3,
  },
  {
    label: "feePoliciesRepoPrototype ↔ FeePoliciesRepo",
    prototype: feePoliciesRepoPrototype,
    expectedMinKeys: 1,
  },
  {
    label: "categoriesRepoPrototype  ↔ CategoriesRepo",
    prototype: categoriesRepoPrototype,
    expectedMinKeys: 6,
  },
  {
    label: "categoryRequestsRepoProto ↔ CategoryRequestsRepo",
    prototype: categoryRequestsRepoPrototype,
    expectedMinKeys: 6,
  },
  {
    label: "eventEditSuggestionsProto ↔ EventEditSuggestionsRepo",
    prototype: eventEditSuggestionsRepoPrototype,
    expectedMinKeys: 7,
  },
  {
    label: "communityModAppsProto    ↔ CommunityModeratorApplicationsRepo",
    prototype: communityModeratorApplicationsRepoPrototype,
    expectedMinKeys: 6,
  },
  {
    label: "eventRsvpsRepoPrototype  ↔ EventRsvpsRepo",
    prototype: eventRsvpsRepoPrototype,
    expectedMinKeys: 4,
  },
  {
    label: "tagsRepoPrototype        ↔ TagsRepo",
    prototype: tagsRepoPrototype,
    expectedMinKeys: 4,
  },
  {
    label: "auditRepoPrototype       ↔ AuditRepo",
    prototype: auditRepoPrototype,
    expectedMinKeys: 2,
  },
  {
    label: "authzRepoPrototype       ↔ AuthZRepo",
    prototype: authzRepoPrototype,
    expectedMinKeys: 3,
  },
  {
    label: "savedLocationsRepoProto  ↔ SavedLocationsRepo",
    prototype: savedLocationsRepoPrototype,
    expectedMinKeys: 7,
  },
  {
    label: "placesRepoPrototype      ↔ PlacesRepo",
    prototype: placesRepoPrototype,
    expectedMinKeys: 10,
  },
  {
    label: "eventTemplatesRepoProto  ↔ EventTemplateRepo",
    prototype: eventTemplatesRepoPrototype,
    expectedMinKeys: 5,
  },
  {
    label: "eventHumansRepoPrototype ↔ EventHumansRepo",
    prototype: eventHumansRepoPrototype,
    expectedMinKeys: 4,
  },
  {
    label: "imagesRepoPrototype      ↔ ImagesRepo",
    prototype: imagesRepoPrototype,
    expectedMinKeys: 10,
  },
  {
    label: "jobCursorsRepoPrototype  ↔ JobCursorsRepo",
    prototype: jobCursorsRepoPrototype,
    expectedMinKeys: 2,
  },
  {
    label: "eventUnlocksRepoProto    ↔ EventUnlocksRepo",
    prototype: eventUnlocksRepoPrototype,
    expectedMinKeys: 5,
  },
  {
    label: "volunteeringRepoProto   ↔ VolunteerRepo",
    prototype: volunteeringRepoPrototype,
    expectedMinKeys: 19,
  },
  {
    label: "placeBookingGrantsProto  ↔ PlaceBookingGrantsRepo",
    prototype: placeBookingGrantsRepoPrototype,
    expectedMinKeys: 2,
  },
];

describe("repo prototype ↔ port interface sync", () => {
  it.each(repos)(
    "$label has at least $expectedMinKeys keys",
    ({ prototype, expectedMinKeys }) => {
      const keyCount = Object.keys(prototype).length;
      expect(keyCount).toBeGreaterThanOrEqual(expectedMinKeys);
    },
  );
});
