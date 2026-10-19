import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { requirePlaceSwitchAuthority } from "./_shared/place-switch-authority";
import type { NotifyAvailabilitySetupNeededFn } from "./notify-availability-setup-needed";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const setPlaceBookingAcceptanceInputSchema = z
  .object({
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    accepts: z.boolean(),
  })
  .strict();

export const setPlaceBookingAcceptanceOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    acceptsBookingRequests: z.boolean(),
  })
  .strict();

export type SetPlaceBookingAcceptanceInput = z.infer<
  typeof setPlaceBookingAcceptanceInputSchema
>;
export type SetPlaceBookingAcceptanceOutput = z.infer<
  typeof setPlaceBookingAcceptanceOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type SetPlaceBookingAcceptanceDeps = {
  repos: Pick<Repos, "places" | "authz" | "audit" | "tx">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Availability-onboarding FR-003 trigger (docs/specs/2026-08-31): when
   * acceptance transitions OFF→ON, nudge the acting staff human IF the place
   * has zero CalendarAvailability rows. The hook owns BOTH the unconfigured
   * suppression and the durable once-per-place idempotency; composed at the
   * transport layer (same pattern as `notifyBookingRequestReceived`).
   * Optional so existing callers/tests keep working; runs AFTER the write and
   * is a deliberate swallow — a throwing notifier never fails the toggle.
   */
  notifyAvailabilitySetupNeeded?: NotifyAvailabilitySetupNeededFn;
  /** Best-effort reporter for the notification swallow branch. */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Venue-owner-only flip of `Place.acceptsBookingRequests`. When true, the
 * venue opts in to receiving inbound booking requests from performers. Enabling
 * requires the place to be VERIFIED (FR-001); public booking surfaces also
 * re-check verification as defense in depth.
 *
 * Ownership: a direct human owner of the place, or an OWNER/ADMIN of an owning
 * org. Deliberately NARROWER than the READ that renders this toggle —
 * `getPlaceForEdit` admits ANY org membership, VIEWER/SCANNER/FINANCE included
 * — because seeing the venue's settings is not the same as committing the
 * venue to inbound booking requests. Idempotent — flipping to the current
 * state writes nothing but still emits an audit log capturing that intent.
 */
export async function setPlaceBookingAcceptance(
  deps: SetPlaceBookingAcceptanceDeps,
  rawInput: unknown,
): Promise<SetPlaceBookingAcceptanceOutput> {
  const input = parseInput(setPlaceBookingAcceptanceInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Ownership check: actor must be a direct human owner, or hold OWNER/ADMIN
  // in an owning org.
  //
  // WHY ORG_ADMIN_ROLES and not "any membership": the flag commits the venue
  // to receiving — and being expected to answer — inbound booking requests. It
  // is a statement about what the business takes on, not content work, so it
  // sits at the same bar as org settings. A SCANNER on the door, a VIEWER, a
  // FINANCE role and even an EDITOR are all deliberately excluded.
  //
  // The predicate itself lives in `_shared/place-switch-authority` because its
  // two siblings (`setPlaceCommunityListingAcceptance`,
  // `setPlaceAttendeeReviewsPublic`) and the read that RENDERS all three
  // (`getPlaceForEdit`, for its `viewerCanManageSwitches` capability) must
  // never drift from it.
  await requirePlaceSwitchAuthority(deps, place, input.actorHumanId);

  // Verification gate (FR-001): enabling requires a VERIFIED place.
  //
  // Checked against the read, with no claim lock: a verification revoke that
  // lands between this check and the write leaves `true` on an unverified
  // place, which is the same state an enable followed by a revoke already
  // produces (a revoke does not clear the flag). `createBookingRequest`
  // re-checks VERIFIED before taking a request, so the flag alone admits
  // nothing.
  if (input.accepts && place.verificationStatus !== "VERIFIED") {
    throw fail("PLACE_NOT_VERIFIED");
  }

  const now = deps.clock.now();

  // ONE column, as a compare-and-set, with its audit row in the same
  // transaction. Never a whole-row `places.upsert` rebuilt from the read
  // above: that would undo a moderator's concurrent name/address edit and
  // rewrite a NULL street line or country as "". `changed` comes from the
  // write, not the read, so the audit `previous` is what the row actually
  // held. Flipping to the current state writes nothing but still audits the
  // (idempotent) owner intent. No reindex: `acceptsBookingRequests` is on no
  // search document.
  const { changed } = await deps.repos.tx(async (tx) => {
    const result = await tx.places.setFlag({
      placeId: place.id,
      flag: "acceptsBookingRequests",
      value: input.accepts,
    });
    // No change can also mean the row is gone (deleted or merged since the
    // read): that is not success.
    if (!result.changed && !(await tx.places.getById(place.id))) {
      throw fail("PLACE_NOT_FOUND");
    }
    await tx.audit.log({
      entity: "place",
      entityId: place.id,
      action: input.accepts
        ? "place.booking_acceptance_enabled"
        : "place.booking_acceptance_disabled",
      data: {
        previous: result.changed ? !input.accepts : input.accepts,
        next: input.accepts,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });
    return result;
  });

  // ── Availability-onboarding FR-003: OFF→ON on an unconfigured place ──────
  // Post-write, best-effort. The hook itself re-checks "unconfigured" and
  // holds the durable `availability-setup:{placeId}` claim, so calling it on
  // every real OFF→ON transition cannot spam. "Real" = THIS write flipped it
  // (`changed`), not what the earlier read said.
  const turnedOn = input.accepts && changed;
  if (turnedOn && deps.notifyAvailabilitySetupNeeded) {
    try {
      await deps.notifyAvailabilitySetupNeeded({
        placeId: place.id,
        actorHumanId: input.actorHumanId,
      });
    } catch (error) {
      deps.logger?.error("places.availability_setup_notify_failed", {
        placeId: place.id,
        actorHumanId: input.actorHumanId,
        err: error,
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "setPlaceBookingAcceptance" },
          extra: { placeId: place.id, actorHumanId: input.actorHumanId },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never fail the
        // committed toggle.
      }
    }
  }

  deps.logger?.info("places.set_booking_acceptance", {
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    acceptsBookingRequests: input.accepts,
    changed,
  });

  return setPlaceBookingAcceptanceOutputSchema.parse({
    placeId: place.id,
    acceptsBookingRequests: input.accepts,
  });
}
