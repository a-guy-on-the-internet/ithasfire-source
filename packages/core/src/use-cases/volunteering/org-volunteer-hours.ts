import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrgVolunteerHoursRow } from "@th/ports/repos/volunteering";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_ANY_ROLE } from "../../lib/rbac";
import { getOrgVolunteerHoursSummaryInputSchema } from "./schemas";

export type OrgVolunteerHoursDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type GetOrgVolunteerHoursSummaryOutput = {
  orgId: string;
  rows: OrgVolunteerHoursRow[];
};

/**
 * Org-wide cross-event volunteer hours summary (Gap 7).
 *
 * Answers "how many hours has this person volunteered this year?" for
 * recognition programs and nonprofit grant reporting: one row per
 * distinct volunteer (keyed by `humanId`, falling back to lowercased
 * `contactEmail` for shadow-only signups) with total hours, distinct
 * events count, and last shift date.
 *
 * Hours semantics match the per-event export
 * (`exportEventVolunteerHours`) exactly — `hoursWorked` override when
 * set, else the shift's scheduled duration, all statuses included — so
 * the org totals always reconcile against the sum of per-event CSVs.
 * The consumer filters by status/date and serialises CSV client-side,
 * mirroring the per-event export's division of labor.
 *
 * `acceptedOnly` flips to the recognition / grant-reporting view: only
 * APPROVED | CHECKED_IN signups contribute, so a withdrawn volunteer's
 * scheduled hours no longer inflate their total. That view deliberately
 * does NOT reconcile with the all-statuses per-event exports.
 *
 * Read-only; the single grouped repo query needs no transaction.
 * Authz: any org member on the org itself — read-only auditor roles
 * (VIEWER, FINANCE, SCANNER) can view this aggregate alongside the
 * edit roles. Unlike the per-event flows there is no personal-owner
 * fallback, because the aggregate is inherently org-scoped.
 */
export async function getOrgVolunteerHoursSummary(
  deps: OrgVolunteerHoursDeps,
  rawInput: unknown,
): Promise<GetOrgVolunteerHoursSummaryOutput> {
  const input = parseInput(getOrgVolunteerHoursSummaryInputSchema, rawInput);

  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ANY_ROLE,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const rows = await deps.repos.volunteering.aggregateHoursByVolunteer(
    input.orgId,
    { from: input.from ?? null, to: input.to ?? null },
    { acceptedOnly: input.acceptedOnly ?? false },
  );

  return { orgId: input.orgId, rows };
}
