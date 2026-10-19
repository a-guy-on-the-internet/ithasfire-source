import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";

import { updateVolunteerHours } from "./manage-volunteer-hours";
import type { ManageVolunteerHoursDeps } from "./manage-volunteer-hours";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const eventSignup = {
  id: SIGNUP_ID,
  eventId: EVENT_ID,
  askId: null,
  roleId: "00000000-0000-4000-8000-000000000010",
  shiftId: null,
  groupId: null,
  humanId: null,
  contactEmail: "volunteer@example.com",
  status: "CHECKED_IN",
  hoursWorked: null,
} as unknown as VolunteerSignupRecord;

const askOnlySignup = {
  ...eventSignup,
  eventId: null,
  askId: ASK_ID,
} as unknown as VolunteerSignupRecord;

function makeDeps(overrides: Record<string, unknown> = {}) {
  const repos = {
    volunteering: {
      getSignup: vi.fn(async () => eventSignup),
      updateSignupHoursWorked: vi.fn(async (input: any) => ({
        ...eventSignup,
        hoursWorked: input.hoursWorked,
      })),
    },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
      })),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    ...overrides,
  };
  const deps: ManageVolunteerHoursDeps = {
    repos: repos as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, repos };
}

describe("updateVolunteerHours", () => {
  it("updates hours for an event signup (org editor)", async () => {
    const { deps, repos } = makeDeps();

    const result = await updateVolunteerHours(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      hoursWorked: 4.25,
    });

    expect(result.hoursWorked).toBe(4.25);
    expect(
      (repos.volunteering as any).updateSignupHoursWorked,
    ).toHaveBeenCalledWith({ id: SIGNUP_ID, hoursWorked: 4.25 });
  });

  it("anti-oracle: ask-only signups (null eventId) yield SIGNUP_NOT_FOUND, never a classification", async () => {
    const { deps, repos } = makeDeps();
    (repos.volunteering as any).getSignup = vi.fn(async () => askOnlySignup);

    await expect(
      updateVolunteerHours(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        hoursWorked: 4,
      }),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });
    expect(
      (repos.volunteering as any).updateSignupHoursWorked,
    ).not.toHaveBeenCalled();
  });

  it("throws SIGNUP_NOT_FOUND for a missing signup (same code as the ask-only guard)", async () => {
    const { deps } = makeDeps();
    ((deps.repos as any).volunteering as any).getSignup = vi.fn(
      async () => null,
    );

    await expect(
      updateVolunteerHours(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        hoursWorked: 4,
      }),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });
  });
});
