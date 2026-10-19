import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PlaceMergeRow } from "@th/ports/repos/place-merge";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  ADDRESS_GROUP_FIELDS,
  PAYOUT_DEFAULT_FIELDS,
  placeMergeBlockerSchema,
  placeMergeInputSchema,
  placeMergeWarningSchema,
  planOwnershipDrops,
  readPlaceMergePlan,
  type PlaceMergeFillField,
} from "./_shared/place-merge-plan";

// ─────────────────────────────────────────────────────────────────────────────
// previewPlaceMerge (merge-duplicate-places spec, FR-002). Read-only: both
// rows, what would move per table, which survivor fields would fill, and
// every reason the merge would be refused, and the warnings (what the merge
// will do to booking data that an admin should see). The /platform/places merge dialog
// renders it before the admin confirms; `mergePlaces` re-runs the same read
// under its lock, so a preview can never approve what the merge refuses.
// ─────────────────────────────────────────────────────────────────────────────

export const previewPlaceMergeInputSchema = placeMergeInputSchema;
export type PreviewPlaceMergeInput = z.infer<typeof previewPlaceMergeInputSchema>;

const FILL_FIELDS = [
  ...ADDRESS_GROUP_FIELDS,
  "capacity",
  "phone",
  "locationLabel",
  "website",
  "websiteSource",
  ...PAYOUT_DEFAULT_FIELDS,
] as const satisfies readonly PlaceMergeFillField[];

export const placeMergeRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    address: z.string(),
    addrLine1: z.string().nullable(),
    addrLine2: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postcode: z.string().nullable(),
    country: z.string().nullable(),
    addressHash: z.string().nullable(),
    capacity: z.number().int().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    phone: z.string().nullable(),
    website: z.string().nullable(),
    websiteSource: z.enum(["TRUSTED_IMPORT", "USER_STUB", "UNKNOWN"]),
    status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]),
    verification: z.enum(["UNVERIFIED", "VERIFIED", "PENDING", "REJECTED"]),
    timezone: z.string().nullable(),
    admissionTaxRateBps: z.number().int().nullable(),
    taxRateSource: z.string().nullable(),
    taxRateFetchedAt: z.date().nullable(),
    locationMode: z.enum(["EXACT", "OBSCURED"]),
    locationRadiusMeters: z.number().int().nullable(),
    locationLabel: z.string().nullable(),
    listedInDirectory: z.boolean(),
    acceptsBookingRequests: z.boolean(),
    acceptsCommunityListings: z.boolean(),
    attendeeReviewsPublic: z.boolean(),
    communityReviewsEnabled: z.boolean(),
    defaultPrimaryPayoutTermsId: z.string().nullable(),
    defaultResalePayoutTermsId: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict() satisfies z.ZodType<PlaceMergeRow>;

const count = z.number().int().min(0);

export const placeMergeMoveCountsSchema = z
  .object({
    events: count,
    venueConfirmedEvents: count,
    eventsOnDefaultCalendar: count,
    eventsOnMainSpace: count,
    attendeeReviews: count,
    postEventPrompts: count,
    membershipBenefits: count,
    savedLocations: count,
    placeReviews: count,
    placeReviewSessions: count,
    placeReviewSessionsDropped: count,
    volunteerAsks: count,
    entityReports: count,
    entityReportsDropped: count,
    featuredItems: count,
    featuredItemsDropped: count,
    embeds: count,
    verificationRequests: count,
    follows: count,
    followsDropped: count,
    eventNotices: count,
    eventNoticesDropped: count,
    pageSlugHistory: count,
    /** Ownership rows that move to the survivor. */
    ownerships: count,
    /** Ownership rows dropped because the same owner is on both sides. */
    ownershipsDropped: count,
    // ── Booking and operations rows (FR-003b, owner ruling 2026-10-15) ──
    bookingRequests: count,
    agreements: count,
    bookingGrants: count,
    waivers: count,
    posReaders: count,
    layouts: count,
    calendarAvailability: count,
    bookingHolds: count,
    /** Merged calendars / spaces that move whole to the survivor. */
    calendarsReparented: count,
    spacesReparented: count,
    /** 1 when the merged default calendar + Main Space fold into the survivor's. */
    defaultCalendarFolded: count,
    bookingStandardItems: count,
    bookingStandardItemsDropped: count,
    bookingPitchExamples: count,
    bookingPitchExamplesDropped: count,
    /** Location JSON rewritten from the merged place to the survivor. */
    series: count,
    templates: count,
    occurrences: count,
    /** Merged grants ended because the owners are not compatible. */
    bookingGrantsRevoked: count,
    /** Merged whole-place grants split per calendar the merged place brought. */
    bookingGrantsSplit: count,
    imageModerationRecords: count,
    /**
     * arrival-areas FR-012: the merged place's arrival areas, moved to the
     * survivor with their ids (event hides keep pointing at them).
     */
    arrivalAreas: count,
  })
  .strict();

export const placeMergeRenameSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["calendar", "space", "layout"]),
    from: z.object({ name: z.string(), slug: z.string().optional() }).strict(),
    to: z.object({ name: z.string(), slug: z.string().optional() }).strict(),
  })
  .strict();

const pageSchema = z.object({ id: z.string(), slug: z.string() }).strict();

export const previewPlaceMergeOutputSchema = z
  .object({
    survivor: placeMergeRowSchema,
    merged: placeMergeRowSchema,
    survivorPage: pageSchema.nullable(),
    mergedPage: pageSchema.nullable(),
    pageAction: z.enum(["MOVE_TO_SURVIVOR_PAGE", "TRANSFER_PAGE", "NONE"]),
    moves: placeMergeMoveCountsSchema,
    /** Survivor fields that would take the merged row's value (D2). */
    filledFields: z.array(z.enum(FILL_FIELDS)),
    blockers: z.array(placeMergeBlockerSchema),
    /** Never block; shown so the admin knows what the merge does (FR-002). */
    warnings: z.array(placeMergeWarningSchema),
    /** Moved calendars, spaces and seat maps whose name or slug was taken. */
    renames: z.array(placeMergeRenameSchema),
    canMerge: z.boolean(),
  })
  .strict();

export type PreviewPlaceMergeOutput = z.infer<
  typeof previewPlaceMergeOutputSchema
>;

export type PreviewPlaceMergeDeps = {
  repos: Pick<Repos, "placeMerge" | "arrivalAreas">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

/** Shared by both use cases: ADMIN staff only (spec D5). */
export async function requirePlaceMergeAdmin(
  authz: AuthZPort,
  actorHumanId: string,
): Promise<void> {
  const check = await authz.hasStaffRole({
    actorHumanId,
    requiredRoles: ["ADMIN"],
  });
  if (!check.allowed) throw fail("STAFF_ONLY");
}

export function assertDistinctPlaces(survivorId: string, mergedId: string) {
  if (survivorId === mergedId) {
    throw fail("INVALID_INPUT", {
      message: "A place cannot be merged into itself",
      meta: { field: "mergedId" },
    });
  }
}

export async function previewPlaceMerge(
  deps: PreviewPlaceMergeDeps,
  rawInput: unknown,
): Promise<PreviewPlaceMergeOutput> {
  const input = parseInput(previewPlaceMergeInputSchema, rawInput);
  await requirePlaceMergeAdmin(deps.authz, input.actorHumanId);
  assertDistinctPlaces(input.survivorId, input.mergedId);

  const plan = await readPlaceMergePlan(deps.repos, input);
  // Same rule `mergePlaces` applies; only the merged side's rows move.
  const ownershipDrops = new Set(planOwnershipDrops(plan.survivor, plan.merged));
  const mergedOwnerships = plan.merged.ownerships;
  const droppedOnMerged = mergedOwnerships.filter((o) =>
    ownershipDrops.has(o.id),
  ).length;

  return previewPlaceMergeOutputSchema.parse({
    survivor: plan.survivor.place,
    merged: plan.merged.place,
    survivorPage: plan.survivor.page,
    mergedPage: plan.merged.page,
    pageAction: plan.pageAction,
    moves: {
      ...plan.counts.moves,
      ownerships: mergedOwnerships.length - droppedOnMerged,
      ownershipsDropped: ownershipDrops.size,
      calendarsReparented: plan.reparent.calendars.length,
      spacesReparented: plan.reparent.spaces.length,
      defaultCalendarFolded: plan.reparent.fold ? 1 : 0,
      bookingStandardItems: plan.standards.itemsMoved,
      bookingStandardItemsDropped: plan.standards.itemsDropped,
      bookingPitchExamples: plan.standards.examplesMoved,
      bookingPitchExamplesDropped: plan.standards.examplesDropped,
      bookingGrantsRevoked: plan.grants.revoke
        ? plan.counts.operations.activeGrants.count
        : plan.grants.revokeWholePlace
          ? plan.counts.operations.wholePlaceGrants.count
          : 0,
      bookingGrantsSplit:
        !plan.grants.revoke && plan.grants.splitOnto.length > 0
          ? plan.counts.operations.wholePlaceGrants.count
          : 0,
      arrivalAreas: plan.arrivalAreas.merged.length,
    },
    filledFields: plan.fill.filledFields,
    blockers: plan.blockers,
    warnings: plan.warnings,
    renames: plan.reparent.renames,
    canMerge: plan.blockers.length === 0,
  });
}
