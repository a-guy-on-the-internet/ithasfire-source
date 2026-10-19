import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { requirePlaceSwitchAuthority } from "./_shared/place-switch-authority";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const setPlaceAttendeeReviewsPublicInputSchema = z
  .object({
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    isPublic: z.boolean(),
  })
  .strict();

export const setPlaceAttendeeReviewsPublicOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    attendeeReviewsPublic: z.boolean(),
  })
  .strict();

export type SetPlaceAttendeeReviewsPublicInput = z.infer<
  typeof setPlaceAttendeeReviewsPublicInputSchema
>;
export type SetPlaceAttendeeReviewsPublicOutput = z.infer<
  typeof setPlaceAttendeeReviewsPublicOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type SetPlaceAttendeeReviewsPublicDeps = {
  repos: Pick<Repos, "places" | "authz" | "audit" | "tx">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Owner-controlled flip of `Place.attendeeReviewsPublic`
 * (venue-rating-block-and-owner-optin FR-004). When true, the ATTENDEE/customer
 * review aggregate is published on the public venue page; default false keeps it
 * PRIVATE owner feedback. This gate governs ONLY the attendee aggregate — never
 * performer (PlaceReview) data (FR-007).
 *
 * Ownership mirrors `setPlaceBookingAcceptance`, which is what FR-004 asks for:
 * a direct human owner of the place, or an OWNER/ADMIN of an owning org. Note
 * the second half — "owner-only" in the spec is not literally one human, since
 * an org ADMIN who owns nothing personally still qualifies. NARROWER than the
 * read that renders the control: `getPlaceForEdit` admits ANY org membership,
 * EDITOR/VIEWER/SCANNER/FINANCE included.
 *
 * Unlike booking acceptance there is NO verification gate — an owner may
 * publish (or hide) their attendee aggregate regardless of the place's
 * verification status. Idempotent — flipping to the current state writes
 * nothing but still emits an audit log.
 */
export async function setPlaceAttendeeReviewsPublic(
  deps: SetPlaceAttendeeReviewsPublicDeps,
  rawInput: unknown,
): Promise<SetPlaceAttendeeReviewsPublicOutput> {
  const input = parseInput(setPlaceAttendeeReviewsPublicInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Ownership check: actor must be a direct human owner, or hold OWNER/ADMIN
  // in an owning org. Same bar as `setPlaceBookingAcceptance` and
  // `setPlaceCommunityListingAcceptance` — FR-004 asks for exactly that, and
  // all three place switches share it. Plain membership is not enough: a
  // SCANNER, VIEWER, FINANCE or EDITOR role writes none of them.
  //
  // One shared predicate (`_shared/place-switch-authority`) for all three
  // switches AND for the `viewerCanManageSwitches` capability `getPlaceForEdit`
  // publishes, so the control the UI disables and the write that refuses can
  // never disagree.
  await requirePlaceSwitchAuthority(deps, place, input.actorHumanId);

  const now = deps.clock.now();

  // ONE column, as a compare-and-set, with its audit row in the same
  // transaction. Never a whole-row `places.upsert` rebuilt from the read
  // above: that would undo a moderator's concurrent name/address edit and
  // rewrite a NULL street line or country as "". `changed` comes from the
  // write, not the read, so the audit `previous` is what the row actually
  // held. Flipping to the current state writes nothing but still audits the
  // (idempotent) owner intent. No reindex: `attendeeReviewsPublic` is on no
  // search document.
  const { changed } = await deps.repos.tx(async (tx) => {
    const result = await tx.places.setFlag({
      placeId: place.id,
      flag: "attendeeReviewsPublic",
      value: input.isPublic,
    });
    // No change can also mean the row is gone (deleted or merged since the
    // read): that is not success.
    if (!result.changed && !(await tx.places.getById(place.id))) {
      throw fail("PLACE_NOT_FOUND");
    }
    await tx.audit.log({
      entity: "place",
      entityId: place.id,
      action: input.isPublic
        ? "place.attendee_reviews_published"
        : "place.attendee_reviews_unpublished",
      data: {
        previous: result.changed ? !input.isPublic : input.isPublic,
        next: input.isPublic,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });
    return result;
  });

  deps.logger?.info("places.set_attendee_reviews_public", {
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    attendeeReviewsPublic: input.isPublic,
    changed,
  });

  return setPlaceAttendeeReviewsPublicOutputSchema.parse({
    placeId: place.id,
    attendeeReviewsPublic: input.isPublic,
  });
}
