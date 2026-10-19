import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  HoursReportRow,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

/**
 * Admin override for a volunteer's hours worked.
 *
 * Hours are computed from the shift's scheduled duration by default
 * (`shift.endsAt - shift.startsAt`). The override exists for the
 * common case where a volunteer worked partial / extra time and the
 * admin wants the per-event hours CSV to reflect reality. Passing
 * `null` clears the override and reverts to scheduled hours.
 */
export const updateVolunteerHoursInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupId: z.string().uuid(),
  /** Set explicitly in hours (0.25 increments recommended). `null` clears. */
  hoursWorked: z.number().min(0).max(99).nullable(),
});

export type UpdateVolunteerHoursInput = z.infer<
  typeof updateVolunteerHoursInputSchema
>;

export type ManageVolunteerHoursDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function updateVolunteerHours(
  deps: ManageVolunteerHoursDeps,
  rawInput: unknown,
): Promise<VolunteerSignupRecord> {
  const input = parseInput(updateVolunteerHoursInputSchema, rawInput);

  const signup = await deps.repos.volunteering.getSignup(input.signupId);
  if (!signup) {
    throw fail("SIGNUP_NOT_FOUND");
  }

  // Authz: the actor must be an editor on the event's owning org.
  // Personal-owned events skip the membership check and use the
  // owner-match check inline because volunteer mgmt isn't currently
  // surfaced on personal events, but we don't want this to throw
  // silently if it ever is.
  //
  // `eventId` is nullable since generic asks — this override stays an
  // event-scoped surface (ask-path hours come from check-in defaultHours
  // stamping). SIGNUP_NOT_FOUND, not EVENT_NOT_FOUND: revealing "this
  // signup exists but isn't event-owned" would let anyone probe ids and
  // classify them (same anti-oracle rule as review/check-in).
  if (!signup.eventId) {
    throw fail("SIGNUP_NOT_FOUND");
  }
  const event = await deps.repos.events.getById(signup.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(
      deps.repos.authz,
      event.humanId,
      input.actorHumanId,
    );
  }

  const updated = await deps.repos.volunteering.updateSignupHoursWorked({
    id: input.signupId,
    hoursWorked: input.hoursWorked,
  });

  deps.logger?.info("volunteering.hours_updated", {
    signupId: input.signupId,
    actorHumanId: input.actorHumanId,
    hoursWorked: input.hoursWorked,
  });

  return updated;
}

/**
 * Per-event hours report. Returns a flat row per signup, ready for CSV
 * serialisation in the transport layer. Includes everyone (not just
 * CHECKED_IN) so the admin can spot NO_SHOWs and rejected applicants
 * in one place — the consumer filters as needed.
 */
export const exportEventVolunteerHoursInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
});

export type ExportEventVolunteerHoursInput = z.infer<
  typeof exportEventVolunteerHoursInputSchema
>;

export type ExportEventVolunteerHoursOutput = {
  eventId: string;
  eventTitle: string;
  rows: HoursReportRow[];
};

export async function exportEventVolunteerHours(
  deps: ManageVolunteerHoursDeps,
  rawInput: unknown,
): Promise<ExportEventVolunteerHoursOutput> {
  const input = parseInput(exportEventVolunteerHoursInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(
      deps.repos.authz,
      event.humanId,
      input.actorHumanId,
    );
  }

  const rows = await deps.repos.volunteering.listSignupsForHoursReport(
    input.eventId,
  );
  return { eventId: event.id, eventTitle: event.title, rows };
}
