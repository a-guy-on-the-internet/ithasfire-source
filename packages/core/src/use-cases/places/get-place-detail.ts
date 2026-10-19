import { z } from "zod";

import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { linkablePageSlug } from "../../lib/entity-page-visibility";
import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const STAFF_REVIEWER_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

/** Cap the verification history surfaced in the detail panel. */
const HISTORY_LIMIT = 10;

const VERIFICATION_REQUEST_STATUSES = [
  "PENDING",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
] as const;

// ─── Schemas ──────────────────────────────────────────────────────────────

export const getPlaceDetailInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
  })
  .strict();

const verificationDocumentSchema = z
  .object({
    id: z.string().uuid(),
    fileName: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    deletedAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .strict();

const verificationRequestSummarySchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(VERIFICATION_REQUEST_STATUSES),
    submittedAt: z.date(),
    // Null when the submitting account has been deleted (submitter detached).
    submittedById: z.string().uuid().nullable(),
    submittedByName: z.string().nullable(),
    acknowledgedAt: z.date().nullable(),
    acknowledgedById: z.string().uuid().nullable(),
    acknowledgedByName: z.string().nullable(),
    reviewedAt: z.date().nullable(),
    reviewerId: z.string().uuid().nullable(),
    reviewerName: z.string().nullable(),
    reviewerNotes: z.string().nullable(),
    documents: z.array(verificationDocumentSchema),
  })
  .strict();

export const getPlaceDetailOutputSchema = z
  .object({
    place: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        /**
         * The place's `EntityPage.slug` — what `/p/[slug]` and
         * `/places/[slug]` actually resolve on, and the only value the admin
         * "Public page" action may open.
         *
         * Null when the venue has no entity page yet (bulk-imported venues,
         * and places created before `upsertPlace` auto-provisioned one) OR
         * when that page is PRIVATE, which 404s for everyone including its
         * owner. The UI must then fall back to `/places/id/{placeId}` rather
         * than link to a 404.
         */
        pageSlug: z.string().nullable(),
        status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]),
        verificationStatus: z.enum([
          "UNVERIFIED",
          "VERIFIED",
          "PENDING",
          "REJECTED",
        ]),
        formattedAddress: z.string().nullable(),
        addressLine1: z.string().nullable(),
        addressLine2: z.string().nullable(),
        city: z.string().nullable(),
        region: z.string().nullable(),
        postalCode: z.string().nullable(),
        countryCode: z.string().nullable(),
        lat: z.number().nullable(),
        lng: z.number().nullable(),
        capacity: z.number().int().nullable(),
        phone: z.string().nullable(),
        website: z.string().nullable(),
        listedInDirectory: z.boolean(),
        defaultPrimaryPayoutTermsId: z.string().uuid().nullable(),
        defaultPrimaryPayoutTermsLabel: z.string().nullable(),
        defaultResalePayoutTermsId: z.string().uuid().nullable(),
        defaultResalePayoutTermsLabel: z.string().nullable(),
      })
      .strict(),
    eventStats: z
      .object({
        total: z.number().int().nonnegative(),
        upcoming: z.number().int().nonnegative(),
        past: z.number().int().nonnegative(),
        nextEventAt: z.date().nullable(),
      })
      .strict(),
    verification: z
      .object({
        currentStatus: z.enum([
          "UNVERIFIED",
          "VERIFIED",
          "PENDING",
          "REJECTED",
        ]),
        activeRequest: verificationRequestSummarySchema.nullable(),
        history: z.array(verificationRequestSummarySchema),
      })
      .strict(),
    ownership: z
      .object({
        orgIds: z.array(z.string().uuid()),
        humanIds: z.array(z.string().uuid()),
      })
      .strict(),
  })
  .strict();

export type GetPlaceDetailInput = z.infer<typeof getPlaceDetailInputSchema>;
export type GetPlaceDetailOutput = z.infer<typeof getPlaceDetailOutputSchema>;

// ─── Deps ─────────────────────────────────────────────────────────────────

export type GetPlaceDetailDeps = {
  repos: Pick<
    Repos,
    | "places"
    | "events"
    | "humans"
    // `authz` is gone: the owner arm is the AuthZPort probe below, not a
    // hand-rolled membership lookup. Narrowing the Pick is the point — it
    // makes re-growing a local role check a deliberate act, not a one-liner.
    | "payoutTerms"
    | "placeVerificationRequests"
    | "placeVerificationDocuments"
    | "entityPages"
  >;
  /**
   * TWO arms, and they are not interchangeable.
   *
   * `canManagePlace` is the OWNER arm — a verified direct human owner, or
   * OWNER/ADMIN/EDITOR in an owning org. Same bar as `getPlaceForEdit`, and
   * required for the same reason: the projection below returns the venue's
   * street address (including `addressLine2` and `postalCode`, which
   * `getPlaceForEdit` does not even carry), its exact coordinates, its phone
   * number and its full ownership list.
   *
   * `hasStaffRole` is the PLATFORM arm — ADMIN/REVIEWER. It is NOT a fallback
   * for a weak owner check; a reviewer processing a verification request
   * genuinely needs the address they are verifying.
   */
  authz: Pick<AuthZPort, "hasStaffRole" | "canManagePlace">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─── Use case ─────────────────────────────────────────────────────────────

export async function getPlaceDetail(
  deps: GetPlaceDetailDeps,
  rawInput: unknown,
): Promise<GetPlaceDetailOutput> {
  const input = parseInput(getPlaceDetailInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // AUTH: place MANAGER (`canManagePlace`) OR platform staff (ADMIN/REVIEWER).
  //
  // The owner arm used to be "any membership in an owning org", the same bar
  // `getPlaceForEdit` carried and for the same stated reason. It was wrong in
  // the same way, and worse here: this payload is a strict SUPERSET of that
  // one — `formattedAddress`, `addressLine1`, `addressLine2`, `city`,
  // `region`, `postalCode`, `countryCode`, `lat`, `lng`, `phone` and
  // `ownership`, with no `redactPlaceLocation` anywhere in this file. Closing
  // `getPlaceForEdit` while leaving this open would have moved a door, not
  // locked one: a SCANNER refused there could read MORE here, and needed no
  // crafted request to do it — the admin places table renders
  // `PlaceDetailPanel` off exactly this query, one row click away.
  //
  // Navigation is unaffected: `getPlaceTitle` still admits any member and
  // projects only id/name/status/verification.
  const access = await deps.authz.canManagePlace({
    actorHumanId: input.actorHumanId,
    placeId: place.id,
  });
  const hasOwnerAccess = access.allowed;

  if (!hasOwnerAccess) {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...STAFF_REVIEWER_ROLES],
    });
    if (!staff.allowed) {
      throw fail("NOT_AUTHORIZED");
    }
  }

  // Hydrate event stats, verification history, payout-terms labels in parallel.
  const now = deps.clock.now();
  const [eventStats, requests, primaryTerms, resaleTerms, entityPage] =
    await Promise.all([
      deps.repos.events.getStatsForPlace({ placeId: place.id, now }),
      deps.repos.placeVerificationRequests.listForPlace(place.id),
      place.defaultPrimaryPayoutTermsId
        ? deps.repos.payoutTerms.getById(place.defaultPrimaryPayoutTermsId)
        : Promise.resolve(null),
      place.defaultResalePayoutTermsId
        ? deps.repos.payoutTerms.getById(place.defaultResalePayoutTermsId)
        : Promise.resolve(null),
      // The venue's public page slug — `/p/[slug]` resolves on
      // `EntityPage.slug`, which is the venue's ONLY addressable slug.
      deps.repos.entityPages.getByOwner("PLACE", place.id),
    ]);

  // History is the most recent N. Active request (PENDING | IN_REVIEW) — at
  // most one — is surfaced separately so the UI can render queue position
  // and reviewer hints without scanning the timeline.
  const history = requests.slice(0, HISTORY_LIMIT);
  const activeRequest =
    requests.find((r) => r.status === "PENDING" || r.status === "IN_REVIEW") ??
    null;

  // Collect all human IDs we need names for, in one batch.
  const humanIds = new Set<string>();
  for (const r of history) {
    if (r.submittedById) humanIds.add(r.submittedById);
    if (r.acknowledgedBy) humanIds.add(r.acknowledgedBy);
    if (r.reviewerHumanId) humanIds.add(r.reviewerHumanId);
  }
  const humans = humanIds.size
    ? await deps.repos.humans.getByIds([...humanIds])
    : [];
  const humanNameById = new Map<string, string | null>(
    humans.map((h) => [h.id, h.name ?? null]),
  );

  // Documents for every request in history (including the active one) in one query.
  const requestIds = history.map((r) => r.id);
  const allDocs = requestIds.length
    ? await deps.repos.placeVerificationDocuments.listByRequestIds(requestIds)
    : [];
  const docsByRequestId = new Map<string, typeof allDocs>();
  for (const doc of allDocs) {
    const list = docsByRequestId.get(doc.requestId) ?? [];
    list.push(doc);
    docsByRequestId.set(doc.requestId, list);
  }

  const summarizeRequest = (r: (typeof requests)[number]) => ({
    id: r.id,
    status: r.status,
    submittedAt: r.createdAt,
    submittedById: r.submittedById,
    submittedByName: r.submittedById
      ? (humanNameById.get(r.submittedById) ?? null)
      : null,
    acknowledgedAt: r.acknowledgedAt,
    acknowledgedById: r.acknowledgedBy,
    acknowledgedByName: r.acknowledgedBy
      ? (humanNameById.get(r.acknowledgedBy) ?? null)
      : null,
    reviewedAt: r.reviewedAt,
    reviewerId: r.reviewerHumanId,
    reviewerName: r.reviewerHumanId
      ? (humanNameById.get(r.reviewerHumanId) ?? null)
      : null,
    reviewerNotes: r.reviewerNotes,
    documents: (docsByRequestId.get(r.id) ?? []).map((doc) => ({
      id: doc.id,
      fileName: doc.fileName,
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes,
      deletedAt: doc.deletedAt,
      createdAt: doc.createdAt,
    })),
  });

  deps.logger?.info("places.get_detail", {
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    historyCount: history.length,
    isStaffAccess: !hasOwnerAccess,
  });

  return getPlaceDetailOutputSchema.parse({
    place: {
      id: place.id,
      name: place.name,
      // `linkablePageSlug`, not `crawlablePageSlug`: this panel is the owner's
      // own authenticated admin view and IS the link, so an UNLISTED page
      // ("only people with the link") is exactly the case it was made for.
      // PRIVATE still 404s for everyone, owner included, so it falls back to
      // `/places/id/{placeId}`. See lib/entity-page-visibility.
      pageSlug: linkablePageSlug(entityPage),
      status: place.status,
      verificationStatus: place.verificationStatus,
      formattedAddress: place.formattedAddress,
      addressLine1: place.addressLine1,
      addressLine2: place.addressLine2,
      city: place.city,
      region: place.region,
      postalCode: place.postalCode,
      countryCode: place.countryCode,
      lat: place.lat,
      lng: place.lng,
      capacity: place.capacity,
      phone: place.phone,
      website: place.website,
      listedInDirectory: place.listedInDirectory,
      defaultPrimaryPayoutTermsId: place.defaultPrimaryPayoutTermsId,
      defaultPrimaryPayoutTermsLabel: primaryTerms
        ? formatPayoutTermsLabel(primaryTerms)
        : null,
      defaultResalePayoutTermsId: place.defaultResalePayoutTermsId,
      defaultResalePayoutTermsLabel: resaleTerms
        ? formatPayoutTermsLabel(resaleTerms)
        : null,
    },
    eventStats,
    verification: {
      currentStatus: place.verificationStatus,
      activeRequest: activeRequest ? summarizeRequest(activeRequest) : null,
      history: history.map(summarizeRequest),
    },
    ownership: {
      orgIds: place.orgIdsWithAccess,
      humanIds: place.humanIdsWithAccess,
    },
  });
}

function formatPayoutTermsLabel(terms: {
  kind: string;
  version: number;
}): string {
  const kindLabel =
    terms.kind === "PRIMARY"
      ? "Primary"
      : terms.kind === "RESALE"
        ? "Resale"
        : terms.kind;
  return `${kindLabel} v${terms.version}`;
}
