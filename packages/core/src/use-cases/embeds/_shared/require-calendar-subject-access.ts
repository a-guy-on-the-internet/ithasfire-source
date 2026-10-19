import type { CalendarRow, CalendarsRepo } from "@th/ports/repos/calendars";
import type { AuthZRepo } from "@th/ports/repos/authz";
import type { PlacesRepo } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import { ORG_EDIT_ROLES } from "../../../lib/rbac";
import { requirePlaceOwnership } from "../../booking-requests/_shared/place-access";

/**
 * Authorization gate for the `calendar` embed subject (venue-hierarchy FR-010;
 * docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml).
 *
 * A calendar is a child of a Place, so managing a calendar-subject embed
 * requires PLACE-EDIT access on the calendar's OWN place — the exact venue-
 * owner gate the `place` subject (booking button) uses: direct human owner,
 * or owning-org member with an edit-level role. Access always derives from
 * the calendar row's `placeId`, never from anything the client supplies.
 *
 * Like the `place` subject, this deliberately does NOT gate on the place's
 * verification status — owners may register domains while verification is
 * pending; the PUBLIC widget read (`getCalendarEventsPublic`) is what gates
 * on VERIFIED + ACTIVE.
 *
 * Returns the calendar row so callers that need it (none today) don't
 * re-fetch.
 *
 * @throws `CALENDAR_NOT_FOUND` when the calendar does not exist.
 * @throws `PLACE_NOT_FOUND` when its place no longer exists (orphan row).
 * @throws `INSUFFICIENT_ROLE` / `NOT_RESOURCE_OWNER` per `requirePlaceOwnership`.
 */
export async function requireCalendarSubjectAccess(
  repos: {
    calendars: Pick<CalendarsRepo, "findById">;
    places: Pick<PlacesRepo, "getById">;
    authz: Pick<AuthZRepo, "getOrgMemberships">;
  },
  calendarId: string,
  actorHumanId: string,
): Promise<CalendarRow> {
  const calendar = await repos.calendars.findById(calendarId);
  if (!calendar) {
    throw fail("CALENDAR_NOT_FOUND");
  }
  const place = await repos.places.getById(calendar.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  await requirePlaceOwnership(repos, place, actorHumanId, {
    requiredOrgRoles: ORG_EDIT_ROLES,
  });
  return calendar;
}
