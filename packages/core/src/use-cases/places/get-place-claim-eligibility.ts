import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PlaceOwnershipRecord } from "@th/types/repos/place-verification";
import type { PlaceRecord } from "@th/types/repos/places";

import { parseInput } from "../../lib/io";
import {
  isFreeEmailDomain,
  registrableDomainFromWebsite,
} from "./_shared/claim";
import { z } from "zod";

export const getPlaceClaimEligibilityInputSchema = z
  .object({
    placeId: z.string().uuid(),
  })
  .strict();

/**
 * PUBLIC-SAFE owner projection (FR-007 / NFR-003).
 *
 * This schema IS the security boundary: the procedure that returns it is a
 * `publicProcedure` reachable by anonymous visitors, so it deliberately carries
 * a display name and a public page slug and NOTHING else — no email, no phone,
 * no owner id, no contact info, no claim proof. Do not widen it without
 * re-reading NFR-003.
 */
export const placeClaimOwnerSchema = z
  .object({
    type: z.enum(["HUMAN", "ORGANIZATION"]),
    /** Public display name — the same string the owner's own page renders. */
    displayName: z.string().min(1),
    /**
     * EntityPage slug for the owner's own PUBLIC page — the UI links
     * `/orgs/{slug}` | `/humans/{slug}`. Never nullable: under the uniform
     * naming rule an owner is named ONLY when they have a public page, so
     * "named" and "linkable" are the same condition (see resolveOwnerDisplay).
     */
    pageSlug: z.string().min(1),
  })
  .strict();

export const getPlaceClaimEligibilityOutputSchema = z
  .object({
    /**
     * Drives the public-page CTA:
     *  - claimable      → show "Claim this venue"
     *  - pending        → show "Claim pending review" badge
     *  - already_claimed→ show "Already claimed" + Dispute action
     *  - not_eligible   → no CTA (archived / not found)
     */
    state: z.enum(["claimable", "pending", "already_claimed", "not_eligible"]),
    reasons: z.array(z.string()),
    /**
     * Whether the email-domain proof path is offerable (place has a non-free
     * website domain). UI can still fall back to challenge/document proofs.
     */
    domainProofAvailable: z.boolean(),
    /** True when a matching domain-match claim would auto-verify (FR-010). */
    fastTrackEligible: z.boolean(),
    /**
     * The claimed venue's verified owner, for public display (FR-007/FR-008).
     * ALWAYS null unless `state === "already_claimed"`, and null even then when
     * the owner cannot be named publicly (see `resolveOwnerDisplay`).
     */
    owner: placeClaimOwnerSchema.nullable(),
  })
  .strict();

export type GetPlaceClaimEligibilityInput = z.infer<
  typeof getPlaceClaimEligibilityInputSchema
>;
export type GetPlaceClaimEligibilityOutput = z.infer<
  typeof getPlaceClaimEligibilityOutputSchema
>;
export type PlaceClaimOwner = z.infer<typeof placeClaimOwnerSchema>;

export type GetPlaceClaimEligibilityDeps = {
  repos: Pick<
    Repos,
    | "places"
    | "placeVerificationRequests"
    | "organizations"
    | "humans"
    | "entityPages"
  >;
  logger?: LoggerPort;
  /**
   * Owner-name resolution is best-effort: a failure there degrades to
   * `owner: null` rather than failing the whole claim-state read (which gates
   * the claim / dispute CTAs). Per the repo's error convention that swallow
   * MUST be reported.
   */
  reportError?: ReporterPort;
};

/**
 * Resolve the PUBLIC display name (+ public page slug) of a verified owner.
 * Returns null whenever the owner cannot be named publicly.
 *
 * ONE uniform rule for BOTH owner types (NFR-003): an owner is named only when
 * they have an EntityPage with `visibility === "PUBLIC"` — i.e. the name is
 * already published on their own public profile, and the same condition that
 * makes the name a link makes it renderable at all. No page, UNLISTED, or
 * PRIVATE ⇒ `null`, and the UI falls back to an unnamed "Verified owner" row.
 *
 * The rule is deliberately uniform rather than lenient-for-ORG. An org name is
 * only *usually* public (it rides along on published events); a sole operator
 * can create a self-identifying org ("Jane Doe Presents"), keep its page
 * private, publish no events, and claim a venue — and this `publicProcedure`
 * would then be the FIRST public surface for that person's name. Fail-safe
 * beats special-cased, and it costs no extra query: the EntityPage is already
 * fetched for `pageSlug`.
 *
 * `Organization.name` / `Human.name` are used only as a fallback for a PUBLIC
 * page whose own `displayName` is null — never to name a hidden owner.
 */
async function resolveOwnerDisplay(
  deps: GetPlaceClaimEligibilityDeps,
  ownership: PlaceOwnershipRecord,
): Promise<PlaceClaimOwner | null> {
  const type = ownership.ownerType;
  const page = await deps.repos.entityPages.getByOwner(type, ownership.ownerId);
  if (page?.visibility !== "PUBLIC") return null;

  // Defensive: a slugless page could never be linked, and under the uniform
  // rule "named" and "linked" are the same condition — so drop the owner
  // entirely rather than emit a value the output schema would reject (this is
  // a public read; a malformed row must degrade, not 500).
  const pageSlug = page.slug?.trim();
  if (!pageSlug) return null;

  const displayName =
    page.displayName?.trim() ||
    (type === "HUMAN"
      ? (await deps.repos.humans.getById(ownership.ownerId))?.name?.trim()
      : (
          await deps.repos.organizations.getById(ownership.ownerId)
        )?.name?.trim());

  if (!displayName) return null;
  return { type, displayName, pageSlug };
}

/**
 * Best-effort wrapper around {@link resolveOwnerDisplay}. The claim state is
 * the load-bearing part of this read; a name lookup failure must not take the
 * dispute CTA down with it.
 */
async function resolveOwnerDisplaySafe(
  deps: GetPlaceClaimEligibilityDeps,
  ownership: PlaceOwnershipRecord | null,
): Promise<PlaceClaimOwner | null> {
  if (!ownership) return null;
  try {
    return await resolveOwnerDisplay(deps, ownership);
  } catch (err) {
    // The log + report are themselves guarded: a throwing logger/reporter must
    // not turn a degraded read into a failed one (the composition roots already
    // wrap reporters in `safeReporter`; this holds standalone too).
    try {
      deps.logger?.error?.("place_claim_owner_display_failed", { err });
      deps.reportError?.(err, {
        tags: {
          useCase: "getPlaceClaimEligibility",
          ownerType: ownership.ownerType,
        },
        extra: { placeId: ownership.placeId, ownershipId: ownership.id },
      });
    } catch {
      // Intentionally empty — see above.
    }
    return null;
  }
}

export type PlaceClaimState = GetPlaceClaimEligibilityOutput["state"];

export type ResolvePlaceClaimStateDeps = {
  repos: Pick<Repos, "places" | "placeVerificationRequests">;
};

export type ResolvedPlaceClaimState = {
  state: PlaceClaimState;
  /** Machine reason codes, exactly as `getPlaceClaimEligibility` emits them. */
  reasons: string[];
  /**
   * The verified, non-revoked ownership row when one exists (looked up for
   * every ACTIVE place), else null. Callers that name the owner do so
   * themselves; this helper never resolves display names.
   */
  verifiedOwner: PlaceOwnershipRecord | null;
};

/**
 * THE claim-state decision for an existing place, shared by the public
 * eligibility read ({@link getPlaceClaimEligibility}) and the entity-page
 * loader's `claimable` hint, so the server-rendered "Claim this place" chip and
 * the client query cannot disagree.
 *
 *  - status not ACTIVE                         → not_eligible
 *  - VERIFIED, or a verified owner exists      → already_claimed
 *  - PENDING status, or an active claim exists → pending
 *  - otherwise (UNVERIFIED / REJECTED)         → claimable
 *
 * Nothing is caught: a repo failure propagates to the caller.
 */
export async function resolvePlaceClaimState(
  deps: ResolvePlaceClaimStateDeps,
  place: Pick<PlaceRecord, "id" | "status" | "verificationStatus">,
): Promise<ResolvedPlaceClaimState> {
  // Neither an archived NOR a suspended venue is claimable, and neither may
  // resolve an owner name: this is a public read keyed only on a placeId, so a
  // venue that has been pulled from public life must not keep publishing who
  // runs it to anyone holding that id. ACTIVE is the only status that proceeds.
  if (place.status !== "ACTIVE") {
    return {
      state: "not_eligible",
      reasons: [
        place.status === "ARCHIVED" ? "place_archived" : "place_suspended",
      ],
      verifiedOwner: null,
    };
  }

  // Already owned / verified → dispute path. The ownership lookup sits AHEAD
  // of the `VERIFIED` short-circuit so a place that is verified AND has an
  // ownership row can still name its owner (FR-007). The repo method itself is
  // the exclusion point for revoked / unverified rows: it filters on
  // `verified = true AND revokedAt IS NULL`, so neither can ever surface here.
  const verifiedOwner = await deps.repos.places.getVerifiedOwnershipForPlace(
    place.id,
  );
  if (place.verificationStatus === "VERIFIED" || verifiedOwner) {
    return {
      state: "already_claimed",
      reasons: [
        place.verificationStatus === "VERIFIED"
          ? "place_verified"
          : "verified_owner_exists",
      ],
      verifiedOwner,
    };
  }

  // A claim already in flight → pending.
  if (place.verificationStatus === "PENDING") {
    return {
      state: "pending",
      reasons: ["verification_pending"],
      verifiedOwner: null,
    };
  }
  const activeClaim =
    await deps.repos.placeVerificationRequests.getActiveClaimForPlace(
      place.id,
    );
  if (activeClaim) {
    return {
      state: "pending",
      reasons: ["claim_in_review"],
      verifiedOwner: null,
    };
  }

  // UNVERIFIED / REJECTED, no owner, no active claim → claimable.
  return { state: "claimable", reasons: [], verifiedOwner: null };
}

/**
 * Public read that returns the claim CTA state for a place (FR-001 / FR-008 /
 * FR-009). No auth — it only exposes coarse claimability, never PII.
 */
export async function getPlaceClaimEligibility(
  deps: GetPlaceClaimEligibilityDeps,
  rawInput: unknown,
): Promise<GetPlaceClaimEligibilityOutput> {
  const input = parseInput(getPlaceClaimEligibilityInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    return getPlaceClaimEligibilityOutputSchema.parse({
      state: "not_eligible",
      reasons: ["place_not_found"],
      domainProofAvailable: false,
      fastTrackEligible: false,
      owner: null,
    });
  }

  const websiteDom = registrableDomainFromWebsite(place.website);
  const domainProofAvailable =
    websiteDom !== null && !isFreeEmailDomain(websiteDom);
  const fastTrackEligible =
    domainProofAvailable && place.websiteSource === "TRUSTED_IMPORT";

  const claim = await resolvePlaceClaimState(deps, place);
  return getPlaceClaimEligibilityOutputSchema.parse({
    state: claim.state,
    reasons: claim.reasons,
    domainProofAvailable,
    fastTrackEligible,
    // Owner naming is the use case's job, and only for a claimed place. The
    // helper hands back the verified ownership row; it never resolves names.
    owner:
      claim.state === "already_claimed"
        ? await resolveOwnerDisplaySafe(deps, claim.verifiedOwner)
        : null,
  });
}
