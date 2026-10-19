import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { OrgVolunteerHoursRow } from "@th/ports/repos/volunteering";
import { getOrgVolunteerHoursSummary } from "./org-volunteer-hours";
import type { OrgVolunteerHoursDeps } from "./org-volunteer-hours";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const HUMAN_ID = "00000000-0000-4000-8000-000000000050";
const NOW = new Date("2026-06-10T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const sampleRows: OrgVolunteerHoursRow[] = [
  {
    volunteerKey: HUMAN_ID,
    humanId: HUMAN_ID,
    contactEmail: "linked@example.com",
    contactName: "Linked Volunteer",
    totalHours: 12.5,
    eventsCount: 3,
    signupsCount: 4,
    lastShiftAt: new Date("2026-05-30T18:00:00Z"),
  },
  {
    volunteerKey: "email:shadow@example.com",
    humanId: null,
    contactEmail: "shadow@example.com",
    contactName: null,
    totalHours: 4,
    eventsCount: 1,
    signupsCount: 1,
    lastShiftAt: new Date("2026-04-01T09:00:00Z"),
  },
];

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeDeps(overrides: Record<string, unknown> = {}) {
  const getOrgMembership = vi.fn(async () => ({ role: "ADMIN" }));
  const aggregateHoursByVolunteer = vi.fn(async () => sampleRows);
  const deps: OrgVolunteerHoursDeps = {
    repos: {
      authz: { getOrgMembership },
      volunteering: { aggregateHoursByVolunteer },
      ...overrides,
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, getOrgMembership, aggregateHoursByVolunteer };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getOrgVolunteerHoursSummary", () => {
  it("rejects invalid input", async () => {
    const { deps } = makeDeps();
    await expect(
      getOrgVolunteerHoursSummary(deps, {
        actorHumanId: ACTOR_ID,
        orgId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws forbidden when the actor is not an org member", async () => {
    const { deps, getOrgMembership, aggregateHoursByVolunteer } = makeDeps();
    getOrgMembership.mockResolvedValueOnce(
      null as unknown as { role: string },
    );
    await expect(
      getOrgVolunteerHoursSummary(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(aggregateHoursByVolunteer).not.toHaveBeenCalled();
  });

  it("allows read-only VIEWER (auditor) to view the summary", async () => {
    const { deps, getOrgMembership, aggregateHoursByVolunteer } = makeDeps();
    getOrgMembership.mockResolvedValueOnce({ role: "VIEWER" });
    const result = await getOrgVolunteerHoursSummary(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(aggregateHoursByVolunteer).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ orgId: ORG_ID, rows: sampleRows });
  });

  it("allows other non-edit member roles (SCANNER) to view the summary", async () => {
    const { deps, getOrgMembership, aggregateHoursByVolunteer } = makeDeps();
    getOrgMembership.mockResolvedValueOnce({ role: "SCANNER" });
    await getOrgVolunteerHoursSummary(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(aggregateHoursByVolunteer).toHaveBeenCalledTimes(1);
  });

  it("returns the repo rows verbatim and passes orgId + range through", async () => {
    const { deps, getOrgMembership, aggregateHoursByVolunteer } = makeDeps();
    const from = "2026-01-01T00:00:00.000Z";
    const to = "2027-01-01T00:00:00.000Z";

    const result = await getOrgVolunteerHoursSummary(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      from,
      to,
    });

    expect(getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });
    // z.coerce.date turns the ISO strings into Date instances.
    expect(aggregateHoursByVolunteer).toHaveBeenCalledWith(
      ORG_ID,
      { from: new Date(from), to: new Date(to) },
      { acceptedOnly: false },
    );
    expect(result).toEqual({ orgId: ORG_ID, rows: sampleRows });
  });

  it("passes a null range when from/to are omitted", async () => {
    const { deps, aggregateHoursByVolunteer } = makeDeps();
    const result = await getOrgVolunteerHoursSummary(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(aggregateHoursByVolunteer).toHaveBeenCalledWith(
      ORG_ID,
      { from: null, to: null },
      { acceptedOnly: false },
    );
    expect(result.rows).toBe(sampleRows);
  });

  it("passes acceptedOnly: true through to the repo (recognition view)", async () => {
    const { deps, aggregateHoursByVolunteer } = makeDeps();
    await getOrgVolunteerHoursSummary(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      acceptedOnly: true,
    });
    expect(aggregateHoursByVolunteer).toHaveBeenCalledWith(
      ORG_ID,
      { from: null, to: null },
      { acceptedOnly: true },
    );
  });

  it("defaults acceptedOnly to false when explicitly false", async () => {
    const { deps, aggregateHoursByVolunteer } = makeDeps();
    await getOrgVolunteerHoursSummary(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      acceptedOnly: false,
    });
    expect(aggregateHoursByVolunteer).toHaveBeenCalledWith(
      ORG_ID,
      { from: null, to: null },
      { acceptedOnly: false },
    );
  });
});
