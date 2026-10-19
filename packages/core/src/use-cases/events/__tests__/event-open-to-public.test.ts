import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import { ensureEventOpenToPublic } from "../_shared/event-open-to-public";
import { submitEventApplication } from "../submit-event-application";
import { submitVolunteerSignup } from "../../volunteering/volunteer-signups";
import { getSaveableEventOrThrow } from "../../event-saves/shared";
import { getPublicEventApplicationForm } from "../get-public-event-application-form";
import { listPublicEventVolunteerRoles } from "../../volunteering/list-public-event-volunteer-roles";

// Ban that sticks, review round 2: public WRITE paths (applications,
// volunteer signups, saves) refuse a banned owner's event with the SAME error
// each already gives an unpublished one, reading the event WITH the opt-in
// owner standing. Resale stays open (holder-to-holder, owner ruling).

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ROLE_ID = "22222222-2222-4222-8222-222222222222";

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: "33333333-3333-4333-8333-333333333333",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "APPLICATION",
    volunteeringEnabled: true,
    ownerBanned: true,
    ...overrides,
  } as EventRecord;
}

describe("ensureEventOpenToPublic", () => {
  it("reads with the owner standing and refuses a banned owner's event with the caller's unpublished error", async () => {
    const getById = vi.fn(async () => event());
    await expect(
      ensureEventOpenToPublic({ events: { getById } }, EVENT_ID, {
        code: "EVENT_NOT_PUBLISHED",
        opts: { category: "NOT_FOUND" },
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
    expect(getById).toHaveBeenCalledWith(EVENT_ID, { withOwnerStanding: true });
  });

  it("defaults to EVENT_NOT_FOUND, answers a missing event the same, and returns an open event", async () => {
    await expect(
      ensureEventOpenToPublic(
        { events: { getById: vi.fn(async () => event()) } },
        EVENT_ID,
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    await expect(
      ensureEventOpenToPublic(
        { events: { getById: vi.fn(async () => null) } },
        EVENT_ID,
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    const open = event({ ownerBanned: false });
    await expect(
      ensureEventOpenToPublic(
        { events: { getById: vi.fn(async () => open) } },
        EVENT_ID,
      ),
    ).resolves.toBe(open);
  });
});

describe("public write paths refuse a banned owner's event", () => {
  it("event application → EVENT_NOT_FOUND (its unpublished answer), before any other work", async () => {
    const getOrgMembership = vi.fn();
    const deps = {
      repos: {
        events: { getById: vi.fn(async () => event()) },
        authz: { getOrgMembership },
      },
      clock: { now: () => new Date("2026-09-29T12:00:00.000Z") },
    } as unknown as Parameters<typeof submitEventApplication>[0];
    await expect(
      submitEventApplication(deps, {
        eventId: EVENT_ID,
        contactEmail: "fan@example.com",
        answers: {},
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(getOrgMembership).not.toHaveBeenCalled();
  });

  it("volunteer signup (event path) → EVENT_NOT_FOUND, nothing written", async () => {
    const getEventRole = vi.fn();
    const txRepos = {
      events: { getById: vi.fn(async () => event()) },
      volunteering: { getEventRole },
    };
    const deps = {
      repos: {
        tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
      },
      clock: { now: () => new Date("2026-09-29T12:00:00.000Z") },
    } as unknown as Parameters<typeof submitVolunteerSignup>[0];
    await expect(
      submitVolunteerSignup(deps, {
        eventId: EVENT_ID,
        roleId: ROLE_ID,
        contactEmail: "helper@example.com",
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(txRepos.events.getById).toHaveBeenCalledWith(EVENT_ID, {
      withOwnerStanding: true,
    });
    expect(getEventRole).not.toHaveBeenCalled();
  });

  it("save → EVENT_NOT_PUBLISHED (its unpublished answer)", async () => {
    await expect(
      getSaveableEventOrThrow(
        { events: { getById: vi.fn(async () => event()) } } as never,
        EVENT_ID,
      ),
    ).rejects.toMatchObject({
      code: "EVENT_NOT_PUBLISHED",
      category: "NOT_FOUND",
    });
  });
});

// Review round 4: the READS that feed those writes use the same gate, so a
// form or role list is never shown for an event that would then refuse the
// submission; and an ask owned by a withheld org or human takes no signups.
describe("adjacent public reads agree with the writes", () => {
  it("public application form → EVENT_NOT_FOUND, form never read", async () => {
    const getForm = vi.fn();
    const deps = {
      repos: {
        events: { getById: vi.fn(async () => event()) },
        eventApplications: { getForm },
      },
    } as unknown as Parameters<typeof getPublicEventApplicationForm>[0];
    await expect(
      getPublicEventApplicationForm(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(deps.repos.events.getById).toHaveBeenCalledWith(EVENT_ID, {
      withOwnerStanding: true,
    });
    expect(getForm).not.toHaveBeenCalled();
  });

  it("public volunteer roles → EVENT_NOT_FOUND, roles never listed", async () => {
    const txRepos = {
      events: { getById: vi.fn(async () => event()) },
      volunteering: { listEventRoles: vi.fn() },
    };
    const deps = {
      repos: {
        tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
      },
    } as unknown as Parameters<typeof listPublicEventVolunteerRoles>[0];
    await expect(
      listPublicEventVolunteerRoles(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(txRepos.events.getById).toHaveBeenCalledWith(EVENT_ID, {
      withOwnerStanding: true,
    });
    expect(txRepos.volunteering.listEventRoles).not.toHaveBeenCalled();
  });

  it.each([
    ["ORG", { humanIds: [], orgIds: ["org-1"] }],
    ["HUMAN", { humanIds: ["human-1"], orgIds: [] }],
  ] as const)(
    "a signup on a withheld %s's ask answers like a missing ask, nothing written",
    async (subjectType, banned) => {
      const ASK_ID = "44444444-4444-4444-8444-444444444444";
      const subjectId = subjectType === "ORG" ? "org-1" : "human-1";
      const findBannedOwners = vi.fn(async () => banned);
      const getEventRole = vi.fn();
      const txRepos = {
        volunteering: {
          getAsk: vi.fn(async () => ({
            id: ASK_ID,
            subjectType,
            subjectId,
            status: "OPEN",
          })),
          getEventRole,
        },
        bans: { findBannedOwners },
      };
      const deps = {
        repos: {
          tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
            fn(txRepos),
          ),
        },
        clock: { now: () => new Date("2026-09-29T12:00:00.000Z") },
      } as unknown as Parameters<typeof submitVolunteerSignup>[0];
      await expect(
        submitVolunteerSignup(deps, {
          askId: ASK_ID,
          roleId: ROLE_ID,
          contactEmail: "helper@example.com",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
      expect(findBannedOwners).toHaveBeenCalledWith(
        subjectType === "ORG"
          ? { humanIds: [], orgIds: [subjectId] }
          : { humanIds: [subjectId], orgIds: [] },
      );
      expect(getEventRole).not.toHaveBeenCalled();
    },
  );
});
