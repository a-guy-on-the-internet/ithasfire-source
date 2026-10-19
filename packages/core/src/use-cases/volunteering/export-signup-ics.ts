import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { generateSingleEventIcs, type ICalEvent } from "../../lib/ical";
import { parseInput } from "../../lib/io";
import { volunteerMayReceiveAddress } from "../../lib/location/holder-eligibility";
import {
  holderAddressLine,
  resolveHolderAddress,
} from "../../lib/location/resolve-holder-address";
import { slugSegment } from "../../lib/slug-utils";
import { venueConfirmationArm } from "../../lib/venue-confirmation";
import { requireCoordinatorOrOwner } from "./_shared/require-coordinator-or-owner";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { exportSignupIcsInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ExportSignupIcsDeps = {
  repos: Repos;
  clock: ClockPort;
  appBaseUrl: string;
  logger?: LoggerPort;
};

export type ExportSignupIcsOutput = {
  icsBody: string;
  filename: string;
};

/**
 * UID domain suffix — matches the existing calendar surfaces
 * (`apps/api/src/routes/ical.ts` uses `<id>@ithasfire.com`).
 */
export const VOLUNTEER_ICS_UID_DOMAIN = "ithasfire.com";

/**
 * Per-signup `.ics` download (FR-012, `ics_export` decision).
 *
 * Authorization — the signup's own volunteer OR the owner/coordinator gate:
 * - the signup's linked human (`humanId` match) always may export their own;
 * - otherwise `requireCoordinatorOrOwner` (A4's trust gate) when the signup
 *   hangs off an ask; legacy pre-backfill event rows without an `askId`
 *   fall back to the EVENT-subject ownership leg of `resolveAskOwnership`.
 *   Strangers get the same uniform denial as every signup-level action.
 *
 * Time source (spec `scheduling_window_only`):
 * - event-path signups use their SHIFT window;
 * - shiftless signups fall back to the ASK's startsAt/endsAt window;
 * - neither → CONFLICT `signup_not_time_bound` (a calendar entry needs a
 *   start; mirrors the feed's windowless-row exclusion).
 *
 * REJECTED / WITHDRAWN signups refuse to export (CONFLICT
 * `signup_not_active`) — checked after authz so status never doubles as an
 * existence probe. PENDING is allowed: a volunteer holding an application
 * may legitimately pencil in the slot (the feed stays accepted-only). A
 * PENDING (or NO_SHOW) file carries NO location, though: the address goes to
 * accepted volunteers only (APPROVED / CHECKED_IN), whoever downloads it.
 */
export async function exportSignupIcs(
  deps: ExportSignupIcsDeps,
  rawInput: unknown,
): Promise<ExportSignupIcsOutput> {
  const input = parseInput(exportSignupIcsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const signup = await tx.volunteering.getSignup(input.signupId);
    if (!signup) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    const ask = signup.askId
      ? await tx.volunteering.getAsk(signup.askId)
      : null;

    // ── Authorize ─────────────────────────────────────────────────────
    const isOwnSignup =
      signup.humanId !== null && signup.humanId === input.actorHumanId;
    if (!isOwnSignup) {
      if (ask) {
        await requireCoordinatorOrOwner(
          tx,
          { ask, signupGroupId: signup.groupId },
          input.actorHumanId,
        );
      } else if (signup.eventId) {
        // Legacy event row without an ask — same EVENT ownership leg the
        // ask gate would have used.
        await resolveAskOwnership(
          tx,
          { subjectType: "EVENT", subjectId: signup.eventId, orgId: null },
          input.actorHumanId,
        );
      } else {
        // No container at all (corrupt row) — uniform not-found.
        throw fail("SIGNUP_NOT_FOUND");
      }
    }

    if (signup.status === "REJECTED" || signup.status === "WITHDRAWN") {
      throw fail("CONFLICT", {
        message: "signup_not_active",
        meta: { reason: "signup_not_active" },
      });
    }

    // ── Resolve the time window + display fields ──────────────────────
    let startsAt: Date | null = null;
    let endsAt: Date | null = null;
    let shiftLabel: string | null = null;

    if (signup.shiftId) {
      const shift = await tx.volunteering.getShift(signup.shiftId);
      if (shift) {
        startsAt = shift.startsAt;
        endsAt = shift.endsAt;
        shiftLabel = shift.label ?? null;
      }
    }
    if (!startsAt && ask?.startsAt) {
      startsAt = ask.startsAt;
      endsAt = ask.endsAt ?? null;
    }
    if (!startsAt) {
      throw fail("CONFLICT", {
        message: "signup_not_time_bound",
        meta: { reason: "signup_not_time_bound" },
      });
    }

    let title: string | null = null;
    let location: string | null = null;
    let url: string | null = null;
    if (signup.eventId) {
      const event = await tx.events.getById(signup.eventId);
      if (event) {
        title = event.title;
        // LOCATION is gated like a ticket holder's address: no street before
        // the event's reveal, none ever for NEVER, and the Place's street for
        // a venue that withholds its address, only when that venue vouched
        // for the event. This file is downloaded ONCE and never refreshed, so
        // a pre-reveal download keeps the coarse label; the subscribed feed
        // (`exportMyVolunteeringIcs`) is what picks the address up after the
        // reveal. An event with no stored address still exports no LOCATION,
        // and neither does a signup that is not accepted (the holder is the
        // SIGNUP here, whether the volunteer or a coordinator downloads it).
        if (event.addressText && volunteerMayReceiveAddress(signup.status)) {
          const placeId = event.placeId;
          const place = placeId ? await tx.places.getById(placeId) : null;
          location = holderAddressLine(
            resolveHolderAddress({
              event,
              place,
              venueConfirmationArm: venueConfirmationArm(event, place),
              activeHolder: true,
              actOnBill: false,
              now: deps.clock.now(),
            }),
          );
        }
        url = event.slug ? `${deps.appBaseUrl}/events/${event.slug}` : null;
      }
    }
    if (!title) {
      title = ask?.title ?? "Volunteering";
    }

    const role = await tx.volunteering.getEventRole(signup.roleId);
    const roleName = role?.name ?? "Volunteer";

    const descriptionParts = [`Volunteer role: ${roleName}`];
    if (shiftLabel) descriptionParts.push(`Shift: ${shiftLabel}`);

    const icalEvent: ICalEvent = {
      uid: `volunteer-signup-${signup.id}@${VOLUNTEER_ICS_UID_DOMAIN}`,
      title: `${title} — ${roleName}`,
      startsAt,
      endsAt,
      location,
      description: descriptionParts.join("\n"),
      url,
    };

    return {
      icsBody: generateSingleEventIcs(icalEvent),
      filename: `${slugSegment(title, "volunteering", 60)}-volunteering.ics`,
    };
  });
}
