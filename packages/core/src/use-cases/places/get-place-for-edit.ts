import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EntityPageRecord } from "@th/types/repos/entity-pages";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { resolvePlaceSwitchAuthority } from "./_shared/place-switch-authority";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getPlaceForEditInputSchema = z
  .object({
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    /**
     * Opt in to the `owners` projection (names + optional public page links).
     *
     * OFF by default because this is a SHARED read with several callers — the
     * public page's "Edit" button probe, the booking inbox, the verify and
     * page tabs — and only the edit surface renders owners. Resolving them
     * unconditionally would charge every one of those callers up to four extra
     * round-trips per fetch for a field they never read. Same reasoning that
     * split `getPlaceTitle` out of this read; here a flag beats a third
     * procedure because the payload is otherwise identical.
     */
    includeOwners: z.boolean().optional().default(false),
  })
  .strict();

/**
 * A resolved owner of the place, for the editor's "who owns this venue" panel.
 *
 * OWNER-GATED, NOT PUBLIC. `getPlaceForEdit` has already proven the caller may
 * MANAGE the place (`canManagePlace`: a verified direct human owner, or
 * OWNER/ADMIN/EDITOR in an owning org) before this is built, so the uniform
 * "never name an owner without a PUBLIC page" rule that
 * governs the anonymous claim read (`resolveOwnerDisplay` in
 * get-place-claim-eligibility.ts) does NOT apply here: an owner is ALWAYS
 * named. Only the LINK is conditional — `pageSlug` is non-null only when the
 * owner has an EntityPage that is PUBLIC with a non-empty slug, because the UI
 * turns it into `/orgs/{slug}` | `/humans/{slug}` and a slug that is not
 * publicly reachable would be a dead link. Please don't "fix" the name back to
 * the public rule; the two reads have different audiences.
 */
export const placeEditOwnerSchema = z
  .object({
    kind: z.enum(["ORGANIZATION", "HUMAN"]),
    /** `orgId` for ORGANIZATION, `humanId` for HUMAN. */
    id: z.string().uuid(),
    /** EntityPage `displayName` when set, else `Organization.name` / `Human.name`. */
    name: z.string().min(1),
    /** Public page slug, or null when the owner has no publicly linkable page. */
    pageSlug: z.string().nullable(),
  })
  .strict();

export type PlaceEditOwner = z.infer<typeof placeEditOwnerSchema>;

export const getPlaceForEditOutputSchema = z
  .object({
    place: z
      .object({
        placeId: z.string().uuid(),
        name: z.string(),
        formattedAddress: z.string().nullable(),
        addressLine1: z.string().nullable(),
        addressLine2: z.string().nullable(),
        city: z.string().nullable(),
        region: z.string().nullable(),
        postalCode: z.string().nullable(),
        countryCode: z.string().nullable(),
        capacity: z.number().int().nullable(),
        lat: z.number().nullable(),
        lng: z.number().nullable(),
        /**
         * ADDRESS PRIVACY, as STORED (place-address-withholding).
         *
         * OWNER-GATED and therefore UNREDACTED — the gate above has already
         * proven the caller owns this venue, and an owner editing their own
         * privacy setting has to see the setting. This is the one read that
         * exposes the raw triple; every public projection goes through
         * `redactPlaceLocation` instead.
         *
         * `locationLabel` is the STORED label, deliberately NOT the coalesced
         * `areaLabel` the public reads emit. Hydrating an editor's text field
         * from the coalesced value would persist "Nashville, TN" as an
         * explicit label the owner never typed, on their next unrelated save.
         */
        locationMode: z.enum(["EXACT", "OBSCURED"]),
        /** Obfuscation radius in metres; null = fully hidden (no public map). */
        locationRadiusMeters: z.number().int().nullable(),
        locationLabel: z.string().nullable(),
        phone: z.string().nullable(),
        website: z.string().nullable(),
        status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]),
        verificationStatus: z.enum([
          "UNVERIFIED",
          "VERIFIED",
          "PENDING",
          "REJECTED",
        ]),
        listedInDirectory: z.boolean(),
        acceptsBookingRequests: z.boolean(),
        // Owner opt-in that publishes the attendee rating summary on the public
        // page (venue-rating-block-and-owner-optin FR-004). Read-only here —
        // flipped via places.setAttendeeReviewsPublic; the editor seeds its
        // toggle from this value.
        attendeeReviewsPublic: z.boolean(),
        // The PERFORMER-tier switch (venue-track-record-and-review-switch
        // FR-005). Read-only here — flipped via
        // places.setCommunityReviewsEnabled; the editor seeds its toggle from
        // this value. Independent of `attendeeReviewsPublic` (FR-001).
        communityReviewsEnabled: z.boolean(),
        // Venue-owner consent to ownerless COMMUNITY listings at this place
        // (community-listings-at-claimed-venues FR-001). Read-only here —
        // flipped via places.setCommunityListingAcceptance. It rides the SAME
        // cache entry as acceptsBookingRequests so the two admin toggles and
        // the copy under them can never disagree for a round trip.
        acceptsCommunityListings: z.boolean(),
        /**
         * FR-007: how many published, upcoming COMMUNITY listings are attached
         * to this place RIGHT NOW, counted WITHOUT the confirmation filter —
         * so the toggle above is an informed decision ("accept the 3 listings
         * already claiming your room") rather than an abstract one. Zero is a
         * real and common answer today.
         *
         * Degrades to 0 on a failed count (see the use case): a number we
         * could not read must not be rendered as a number we did.
         */
        communityListingCount: z.number().int().nonnegative(),
        access: z.object({
          orgIds: z.array(z.string().uuid()),
          humanIds: z.array(z.string().uuid()),
        }),
        /**
         * DERIVED per request from this viewer and this place — never stored.
         * True when the viewer may flip the four place switches:
         * `acceptsBookingRequests`, `acceptsCommunityListings`,
         * `attendeeReviewsPublic`, `communityReviewsEnabled`. The bar is a
         * direct human owner, or OWNER/ADMIN in an owning org
         * (`_shared/place-switch-authority`, which the four writes call as
         * well — they cannot drift).
         *
         * THIS READ'S OWN GATE IS STILL BROADER, just not as broad as it was:
         * `canManagePlace` (OWNER/ADMIN/EDITOR, or a verified direct human
         * owner) opens the page, so an EDITOR sees the settings without being
         * able to commit the venue to them. That remaining gap is exactly why
         * this field exists — the UI disables the controls an EDITOR cannot
         * write, instead of letting them discover the boundary by hitting a
         * 403 toast.
         *
         * Three tiers, deliberately, and they are not collapsible:
         *   navigate            → any org member (`getPlaceTitle`)
         *   read/edit this page → `canManagePlace` (OWNER/ADMIN/EDITOR)
         *   flip these switches → `ORG_ADMIN_ROLES` (OWNER/ADMIN)
         *
         * The four writes that enforce the same bar:
         *  - `set-place-booking-acceptance.ts`
         *  - `set-place-community-listing-acceptance.ts`
         *  - `set-place-attendee-reviews-public.ts`
         *  - `set-place-community-reviews-enabled.ts`
         */
        viewerCanManageSwitches: z.boolean(),
        /**
         * `access` resolved to display data (names + optional public page
         * links). ORGANIZATION entries first, then HUMAN, each name-sorted.
         *
         * THREE distinguishable states, deliberately:
         *  - `undefined` → not requested (`includeOwners` false/omitted). No
         *    lookup ran, so this says nothing about the owners.
         *  - `[]`        → requested, and nothing resolved. ALWAYS an anomaly:
         *    the ownership gate above guarantees at least one owner id exists,
         *    so an empty array means either the lookup degraded
         *    (`resolveOwnersSafe`) or every owner was unnameable
         *    (`reportUnnameableOwner`). Both are reported.
         *  - non-empty   → the normal case.
         *
         * Do not collapse `undefined` into `[]`; the UI needs to tell "not
         * asked" from "asked and something is wrong".
         */
        owners: z.array(placeEditOwnerSchema).optional(),
      })
      .strict(),
  })
  .strict();

export type GetPlaceForEditInput = z.infer<typeof getPlaceForEditInputSchema>;
export type GetPlaceForEditOutput = z.infer<typeof getPlaceForEditOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPlaceForEditDeps = {
  repos: Pick<
    Repos,
    | "places"
    | "authz"
    | "organizations"
    | "humans"
    | "entityPages"
    | "events"
  >;
  /**
   * THE GATE for this read. `canManagePlace` is the same bar `getMyPage`,
   * `updatePage`, `managePageBlocks` and the page-image uploads already apply
   * to a PLACE, so the surfaces stacked on this payload cannot disagree about
   * who may open them. Required, never optional — an authorization dependency
   * that can be omitted is an authorization check that can be skipped.
   */
  authz: Pick<AuthZPort, "canManagePlace">;
  /**
   * Only used for the FR-007 community-listing count's "upcoming" floor.
   * Optional so every existing caller and test keeps working; absent falls
   * back to wall-clock, the same posture the rest of this read takes.
   */
  clock?: { now(): Date };
  logger?: LoggerPort;
  /**
   * Owner display resolution is decorative relative to the edit form: a
   * failure there degrades to `owners: []` rather than taking the whole editor
   * down. Per the repo's error convention that swallow MUST be reported.
   *
   * Also carries the "owner row exists but has no usable name" anomaly, which
   * would otherwise disappear as a silently-skipped row.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Owner resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Guarded report for the "owner row exists but has no name we can render"
 * anomaly. The row is skipped rather than labelled — display copy belongs in
 * the UI layer, not core — but skipping silently would make `owners: []`
 * indistinguishable from a degraded lookup, with nothing in Sentry either way.
 *
 * Reachable in practice: `HumanRecord.name` is nullable and the create path
 * stores null when no name is supplied, so a human owner with no EntityPage
 * `displayName` lands here. A whitespace-only org name does too.
 *
 * Guarded locally (not just by `resolveOwnersSafe`) so a throwing reporter
 * cannot convert one skipped row into a whole degraded read.
 */
function reportUnnameableOwner(
  deps: GetPlaceForEditDeps,
  placeId: string,
  kind: "ORGANIZATION" | "HUMAN",
  ownerId: string,
): void {
  try {
    deps.logger?.error?.("places.get_for_edit.owner_unnameable", {
      placeId,
      kind,
      ownerId,
    });
    deps.reportError?.(new Error("place_edit_owner_unnameable"), {
      tags: { useCase: "getPlaceForEdit", ownerKind: kind },
      extra: { placeId, kind, ownerId },
    });
  } catch {
    // Intentionally empty — reporting must never manufacture a new failure.
  }
}

/**
 * Resolve `orgIdsWithAccess` / `humanIdsWithAccess` into display rows.
 *
 * Cost: at most FOUR batched round-trips (org rows, human rows, org pages,
 * human pages), issued in parallel, and each one is skipped entirely when its
 * id list is empty — so a place with only org owners costs two. No per-owner
 * lookups. Only ever called when `includeOwners` is true.
 */
async function resolveOwners(
  deps: GetPlaceForEditDeps,
  placeId: string,
  orgIds: string[],
  humanIds: string[],
): Promise<PlaceEditOwner[]> {
  if (orgIds.length === 0 && humanIds.length === 0) return [];

  const [orgs, humans, orgPages, humanPages] = await Promise.all([
    orgIds.length > 0 ? deps.repos.organizations.getByIds(orgIds) : [],
    humanIds.length > 0 ? deps.repos.humans.getByIds(humanIds) : [],
    orgIds.length > 0
      ? deps.repos.entityPages.getByOwners("ORGANIZATION", orgIds)
      : [],
    humanIds.length > 0
      ? deps.repos.entityPages.getByOwners("HUMAN", humanIds)
      : [],
  ]);

  const orgNameById = new Map(orgs.map((o) => [o.id, o.name] as const));
  const humanNameById = new Map(humans.map((h) => [h.id, h.name] as const));
  const orgPageByOwnerId = new Map(orgPages.map((p) => [p.ownerId, p] as const));
  const humanPageByOwnerId = new Map(
    humanPages.map((p) => [p.ownerId, p] as const),
  );

  const build = (
    kind: "ORGANIZATION" | "HUMAN",
    ids: string[],
    nameById: Map<string, string | null>,
    pageByOwnerId: Map<string, EntityPageRecord>,
  ): PlaceEditOwner[] => {
    const rows: PlaceEditOwner[] = [];
    for (const id of ids) {
      // A deleted owner row is skipped rather than emitted as a placeholder —
      // `access` still carries the raw id for callers that need it. Not
      // reported: losing the row IS the expected outcome of a deletion.
      if (!nameById.has(id)) continue;
      const page = pageByOwnerId.get(id);

      // Name: page displayName wins when non-empty, else the entity's own
      // name. Unlike the public claim read, a missing/hidden page never
      // suppresses the name (see placeEditOwnerSchema).
      const name = page?.displayName?.trim() || nameById.get(id)?.trim() || "";
      // A row with no usable name at all (nameless human, no page) cannot
      // satisfy `name: z.string().min(1)`; drop it rather than 500 the editor
      // — but make the drop visible, since the row genuinely exists.
      if (!name) {
        reportUnnameableOwner(deps, placeId, kind, id);
        continue;
      }

      // Link only when the page is actually reachable at /orgs|/humans/{slug}.
      const slug = page?.slug?.trim();
      const pageSlug = page?.visibility === "PUBLIC" && slug ? slug : null;

      rows.push({ kind, id, name, pageSlug });
    }
    // Deterministic and locale-independent. Case-folded first so a raw
    // code-unit compare does not file every capitalised name ahead of every
    // lowercase one ("Zeta" before "alpha"); the raw name and then the id
    // break ties, so equal names never reorder between reads.
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort(
      (a, b) =>
        cmp(a.name.toLowerCase(), b.name.toLowerCase()) ||
        cmp(a.name, b.name) ||
        cmp(a.id, b.id),
    );
    return rows;
  };

  // ORGANIZATION block first, then HUMAN.
  return [
    ...build("ORGANIZATION", orgIds, orgNameById, orgPageByOwnerId),
    ...build("HUMAN", humanIds, humanNameById, humanPageByOwnerId),
  ];
}

/**
 * Best-effort wrapper around {@link resolveOwners}. Mirrors
 * `resolveOwnerDisplaySafe` in get-place-claim-eligibility.ts: on failure the
 * read degrades to `[]`, and the swallow is both logged at `error` (warn is
 * not captured by Sentry) and reported through `ReporterPort`.
 */
async function resolveOwnersSafe(
  deps: GetPlaceForEditDeps,
  placeId: string,
  orgIds: string[],
  humanIds: string[],
): Promise<PlaceEditOwner[]> {
  try {
    return await resolveOwners(deps, placeId, orgIds, humanIds);
  } catch (err) {
    // The log + report are themselves guarded: a throwing logger/reporter must
    // not turn a degraded read into a failed one (the composition roots already
    // wrap reporters in `safeReporter`; this holds standalone too).
    try {
      deps.logger?.error?.("places.get_for_edit.owner_resolution_failed", {
        err,
        placeId,
      });
      deps.reportError?.(err, {
        tags: { useCase: "getPlaceForEdit" },
        extra: { placeId, orgIds, humanIds },
      });
    } catch {
      // Intentionally empty — see above.
    }
    return [];
  }
}

/**
 * UNCONDITIONAL, unlike `includeOwners` above — a documented exception to that
 * flag's stated principle, not an oversight. The principle is about MAGNITUDE:
 * owner resolution costs up to four round-trips and only the edit surface reads
 * it, so every other caller (the public page's "Edit" probe, the booking inbox,
 * the verify tab) was charged for a field it never renders. This is ONE count
 * on a `placeId`-indexed column. It is left unconditional because the two admin
 * switches must read the SAME `getPlaceForEdit` cache entry — a per-caller flag
 * would give them different query keys, split the entry in two, and reintroduce
 * exactly the "the switch and the copy under it disagree for a round trip" bug
 * the shared entry exists to prevent. If a third caller ever makes this hurt,
 * the fix is a flag plus a single shared input shape, not a flag alone.
 *
 * FR-007's count, as a DELIBERATE SWALLOW: the number tells a venue owner what
 * they are being asked to accept, but it is decorative relative to the edit
 * form — a failed count must not take the whole editor down, exactly like the
 * owner-display resolution above.
 *
 * Degrades to 0 and REPORTS (repo error convention: a swallow that returns a
 * fallback declares `reportError` and calls it, guarded so a throwing reporter
 * never changes behaviour). 0 is the honest floor here: it is also the true
 * answer for almost every place today, and it renders as "no community
 * listings are attached yet", which understates rather than invents.
 */
async function countCommunityListingsSafe(
  deps: GetPlaceForEditDeps,
  placeId: string,
): Promise<number> {
  try {
    return await deps.repos.events.countCommunityListingsAtPlace({
      placeId,
      now: deps.clock?.now() ?? new Date(),
    });
  } catch (err) {
    // Log AND report inside ONE guard, exactly like `resolveOwnersSafe` above:
    // a throwing LOGGER is as capable of turning a degraded read into a failed
    // one as a throwing reporter, and this file's tests pin both.
    try {
      deps.logger?.error?.("places.community_listing_count_failed", {
        err,
        placeId,
      });
      deps.reportError?.(err, {
        tags: { useCase: "getPlaceForEdit", step: "countCommunityListings" },
        extra: { placeId },
      });
    } catch {
      // Intentionally empty — see above.
    }
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function getPlaceForEdit(
  deps: GetPlaceForEditDeps,
  rawInput: unknown,
): Promise<GetPlaceForEditOutput> {
  const input = parseInput(getPlaceForEditInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // AUTHORIZATION — a verified direct human owner of the place, or
  // OWNER/ADMIN/EDITOR in an owning org.
  //
  // This used to be "any membership in an owning org", and the looseness was
  // documented as deliberate. It was wrong. The payload below carries
  // `formattedAddress`, `postalCode`, `city`, `region`, the exact `lat`/`lng`,
  // the phone number and the full ownership list — so a door SCANNER (or a
  // VIEWER, or a FINANCE member) could pull the street address and precise
  // coordinates of every venue their org owns, and for a great many of these
  // venues that address is somebody's home. Seeing a venue's settings is not
  // the same as being allowed to see where it is.
  //
  // Navigation is NOT affected: the admin rail and the `[placeId]` layout gate
  // on `getPlaceTitle`, which stays open to any member and projects only
  // id/name/status/verification — nothing locational.
  const access = await deps.authz.canManagePlace({
    actorHumanId: input.actorHumanId,
    placeId: place.id,
  });
  if (!access.allowed) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }

  // Derived per request, never stored, and a STRICTLY NARROWER bar than the
  // gate above: an EDITOR opens this page but may not flip the four switches.
  // Do not collapse the two — read and write are different tiers on purpose.
  //
  // Short-circuits before any membership lookup for a direct human owner, and
  // again when the place has no owning orgs — so THIS CALL costs zero extra
  // round-trips on the owner path. That is a claim about the capability only,
  // not about the request: the `canManagePlace` gate above is not free. It
  // runs `getPlaceAccessContext` (a place lookup plus a `placeOwnership`
  // read — rows `places.getById` has already loaded) and then a SEQUENTIAL
  // `getOrgMembership` per owning org until one satisfies. Worth it for a
  // read that hands back a street address; worth knowing before adding a
  // sixth caller to this procedure.
  const viewerCanManageSwitches = await resolvePlaceSwitchAuthority(
    { repos: deps.repos },
    place,
    input.actorHumanId,
  );

  deps.logger?.info("places.get_for_edit", {
    placeId: place.id,
    actorHumanId: input.actorHumanId,
  });

  // Opt-in, and it runs AFTER the ownership gate above — the gate is what
  // licenses naming every owner unconditionally (see placeEditOwnerSchema).
  // When the flag is off this costs ZERO round-trips and the field is omitted
  // entirely (see the output schema's three-state note).
  const owners = input.includeOwners
    ? await resolveOwnersSafe(
        deps,
        place.id,
        place.orgIdsWithAccess,
        place.humanIdsWithAccess,
      )
    : undefined;

  const communityListingCount = await countCommunityListingsSafe(
    deps,
    place.id,
  );

  return getPlaceForEditOutputSchema.parse({
    place: {
      placeId: place.id,
      name: place.name,
      formattedAddress: place.formattedAddress,
      addressLine1: place.addressLine1,
      addressLine2: place.addressLine2,
      city: place.city,
      region: place.region,
      postalCode: place.postalCode,
      countryCode: place.countryCode,
      capacity: place.capacity,
      lat: place.lat,
      lng: place.lng,
      // Fail-closed against a repo row / test fake that predates the columns:
      // an unreadable mode reads as OBSCURED with a null radius (fully
      // hidden), so the editor opens on the withheld choice rather than
      // showing an owner "Exact address" for a venue whose state it could not
      // determine — and a blind save then persists the safe state, not a leak.
      locationMode: place.locationMode === "EXACT" ? "EXACT" : "OBSCURED",
      locationRadiusMeters:
        typeof place.locationRadiusMeters === "number" &&
        Number.isFinite(place.locationRadiusMeters)
          ? place.locationRadiusMeters
          : null,
      locationLabel: place.locationLabel ?? null,
      phone: place.phone,
      website: place.website,
      status: place.status,
      verificationStatus: place.verificationStatus,
      listedInDirectory: place.listedInDirectory,
      acceptsBookingRequests: place.acceptsBookingRequests,
      attendeeReviewsPublic: place.attendeeReviewsPublic,
      communityReviewsEnabled: place.communityReviewsEnabled,
      acceptsCommunityListings: place.acceptsCommunityListings,
      communityListingCount,
      access: {
        orgIds: place.orgIdsWithAccess,
        humanIds: place.humanIdsWithAccess,
      },
      viewerCanManageSwitches,
      ...(owners === undefined ? {} : { owners }),
    },
  });
}
