import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { makeVolunteeringRepo } from "../prisma/volunteering";

/**
 * Unit coverage for the hours-report projection (mocked Prisma — the full
 * integration path runs under the Docker-gated suite). Pins the Gap 3
 * contract: the signup → VolunteerWaiverAcceptance 1:1 relation is selected
 * in the same query (no N+1) and surfaces as `waiverAcceptedAt`.
 */
describe("makeVolunteeringRepo.listSignupsForHoursReport", () => {
  const EVENT_ID = "00000000-0000-4000-8000-000000000003";
  const ACCEPTED_AT = new Date("2026-06-11T09:30:00.000Z");

  const baseRow = {
    id: "signup-1",
    contactName: "Volunteer User",
    contactEmail: "volunteer@example.com",
    status: "CHECKED_IN",
    checkedInAt: new Date("2026-07-01T09:00:00.000Z"),
    hoursWorked: null,
    notes: null,
    role: { name: "Security" },
    shift: {
      label: "Morning",
      startsAt: new Date("2026-07-01T09:00:00.000Z"),
      endsAt: new Date("2026-07-01T13:00:00.000Z"),
    },
  };

  function makeRepo(rows: unknown[]) {
    const findMany = vi.fn(async (_args: unknown) => rows);
    const prisma = {
      volunteerSignup: { findMany },
    } as unknown as PrismaClient;
    return { repo: makeVolunteeringRepo(prisma), findMany };
  }

  it("selects the waiver acceptance in the same query and maps waiverAcceptedAt", async () => {
    const { repo, findMany } = makeRepo([
      { ...baseRow, waiverAcceptance: { acceptedAt: ACCEPTED_AT } },
    ]);

    const rows = await repo.listSignupsForHoursReport(EVENT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signupId: "signup-1",
      roleName: "Security",
      scheduledHours: 4,
      actualHours: 4,
      waiverAcceptedAt: ACCEPTED_AT,
    });

    // Single query — the relation is part of the select, not a follow-up.
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as
      | { select?: Record<string, unknown> }
      | undefined;
    expect(args?.select?.waiverAcceptance).toEqual({
      select: { acceptedAt: true },
    });
  });

  it("maps waiverAcceptedAt to null for signups without an acceptance", async () => {
    const { repo } = makeRepo([{ ...baseRow, waiverAcceptance: null }]);

    const rows = await repo.listSignupsForHoursReport(EVENT_ID);

    expect(rows[0]?.waiverAcceptedAt).toBeNull();
  });
});
