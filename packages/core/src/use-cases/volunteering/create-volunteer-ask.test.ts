import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { VolunteerAskRecord } from "@th/ports/repos/volunteering";

import { createVolunteerAsk } from "./create-volunteer-ask";
import type { CreateVolunteerAskDeps } from "./create-volunteer-ask";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000006";
const PLACE_ID = "00000000-0000-4000-8000-000000000003";
const EVENT_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000005";
const ASK_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-07-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const basePlace = {
  id: PLACE_ID,
  name: "The Hall",
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  humanIdsWithAccess: [ACTOR_ID],
  orgIdsWithAccess: [],
} as unknown as PlaceRecord;

const orgOwnedPlace = {
  ...basePlace,
  humanIdsWithAccess: [],
  orgIdsWithAccess: [ORG_ID],
} as unknown as PlaceRecord;

const baseEvent = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Night Market",
  status: "PUBLISHED",
} as unknown as EventRecord;

const baseAsk: VolunteerAskRecord = {
  id: ASK_ID,
  subjectType: "PLACE",
  subjectId: PLACE_ID,
  orgId: null,
  title: "Standing door help",
  description: null,
  status: "DRAFT",
  cadence: "ONGOING",
  startsAt: null,
  endsAt: null,
  timezone: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    places: { getById: vi.fn(async () => basePlace) },
    events: { getById: vi.fn(async () => baseEvent) },
    organizations: {
      getById: vi.fn(async () => ({
        id: ORG_ID,
        slug: "night-org",
        status: "ACTIVE",
      })),
    },
    humans: {
      getById: vi.fn(async () => ({ id: ACTOR_ID, status: "ACTIVE" })),
    },
    humanDelegates: { getDelegation: vi.fn(async () => null) },
    authz: {
      getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "EDITOR" })),
      getOrgMemberships: vi.fn(async () => [{ orgId: ORG_ID, role: "EDITOR" }]),
    },
    volunteering: {
      createAsk: vi.fn(async (input: any) => ({
        ...baseAsk,
        ...input,
        id: ASK_ID,
      })),
      listAsksBySubject: vi.fn(async () => []),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDepsWithMocks(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: CreateVolunteerAskDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

// ══════════════════════════════════════════════════════════════════════════════

describe("createVolunteerAsk", () => {
  const placeInput = {
    actorHumanId: ACTOR_ID,
    subjectType: "PLACE",
    subjectId: PLACE_ID,
    title: "Standing door help",
    cadence: "ONGOING",
  };

  it("creates a PLACE ask for a direct human owner (orgId null)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await createVolunteerAsk(deps, placeInput);

    expect(result).toEqual({ askId: ASK_ID });
    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        orgId: null,
        title: "Standing door help",
      }),
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "volunteer_ask", action: "created" }),
    );
  });

  it("denormalizes the actor's granting org for an org-owned PLACE (org-EDITOR creator)", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      places: { getById: vi.fn(async () => orgOwnedPlace) },
    });
    await createVolunteerAsk(deps, placeInput);

    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });

  it("stamps the actor's OWN granting org on a multi-org PLACE, not the first in the list", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      places: {
        getById: vi.fn(async () => ({
          ...orgOwnedPlace,
          orgIdsWithAccess: [OTHER_ORG_ID, ORG_ID],
        })),
      },
      // The actor is an EDITOR of ORG_ID only — never OTHER_ORG_ID, even
      // though that org sits at index 0 of orgIdsWithAccess.
      authz: {
        getOrgMemberships: vi.fn(async () => [
          { orgId: ORG_ID, role: "EDITOR" },
        ]),
      },
    });
    await createVolunteerAsk(deps, placeInput);

    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });

  it("stamps null for a direct human place owner even when orgs also have access", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      places: {
        getById: vi.fn(async () => ({
          ...basePlace,
          humanIdsWithAccess: [ACTOR_ID],
          orgIdsWithAccess: [ORG_ID],
        })),
      },
    });
    await createVolunteerAsk(deps, placeInput);

    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: null }),
    );
  });

  it("creates an ORG ask (orgId = subject) for an org EDITOR", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await createVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      subjectType: "ORG",
      subjectId: ORG_ID,
      title: "Street team",
    });

    expect(result).toEqual({ askId: ASK_ID });
    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "ORG", orgId: ORG_ID }),
    );
  });

  it("creates a HUMAN ask for the human themselves (orgId null)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await createVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      subjectType: "HUMAN",
      subjectId: ACTOR_ID,
      title: "Living-room series hands",
    });

    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "HUMAN", orgId: null }),
    );
  });

  it("allows an edit-capable delegate to create a HUMAN ask on the principal's behalf", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      humans: {
        getById: vi.fn(async () => ({ id: OTHER_HUMAN_ID, status: "ACTIVE" })),
      },
      humanDelegates: {
        getDelegation: vi.fn(async () => ({
          id: "d1",
          principalId: OTHER_HUMAN_ID,
          delegateId: ACTOR_ID,
          role: "ADMIN",
          createdAt: NOW,
        })),
      },
    });
    await createVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      subjectType: "HUMAN",
      subjectId: OTHER_HUMAN_ID,
      title: "Series hands",
    });

    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalled();
  });

  it("rejects acting for another human without a delegation", async () => {
    const { deps } = makeDepsWithMocks();
    await expect(
      createVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        subjectType: "HUMAN",
        subjectId: OTHER_HUMAN_ID,
        title: "Series hands",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("creates an EVENT ask denormalizing the event's org", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await createVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      subjectType: "EVENT",
      subjectId: EVENT_ID,
      title: "Night Market volunteering",
    });

    expect(
      (txRepos.volunteering as any).listAsksBySubject,
    ).toHaveBeenCalledWith("EVENT", EVENT_ID);
    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "EVENT", orgId: ORG_ID }),
    );
  });

  it("pre-checks the one-EVENT-ask rule (friendly conflict)", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      volunteering: {
        createAsk: vi.fn(),
        listAsksBySubject: vi.fn(async () => [
          { ...baseAsk, subjectType: "EVENT", subjectId: EVENT_ID },
        ]),
      },
    });
    await expect(
      createVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        subjectType: "EVENT",
        subjectId: EVENT_ID,
        title: "Second ask",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "duplicate_event_ask",
    });
    expect((txRepos.volunteering as any).createAsk).not.toHaveBeenCalled();
  });

  it("propagates the adapter's duplicate_event_ask race conflict untouched", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        listAsksBySubject: vi.fn(async () => []),
        createAsk: vi.fn(async () => {
          throw {
            code: "duplicate_event_ask",
            message: "duplicate_event_ask",
          };
        }),
      },
    });
    await expect(
      createVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        subjectType: "EVENT",
        subjectId: EVENT_ID,
        title: "Racing ask",
      }),
    ).rejects.toMatchObject({ code: "duplicate_event_ask" });
  });

  it("rejects an org VIEWER on an ORG subject", async () => {
    const { deps } = makeDepsWithMocks({
      authz: {
        getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "VIEWER" })),
      },
    });
    await expect(
      createVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        subjectType: "ORG",
        subjectId: ORG_ID,
        title: "Street team",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it.each([
    ["PLACE", PLACE_ID, { places: { getById: vi.fn(async () => null) } }, "PLACE_NOT_FOUND"],
    ["EVENT", EVENT_ID, { events: { getById: vi.fn(async () => null) } }, "EVENT_NOT_FOUND"],
    ["ORG", ORG_ID, { organizations: { getById: vi.fn(async () => null) } }, "ORGANIZATION_NOT_FOUND"],
    ["HUMAN", ACTOR_ID, { humans: { getById: vi.fn(async () => null) } }, "HUMAN_NOT_FOUND"],
  ] as const)(
    "rejects a missing %s subject",
    async (subjectType, subjectId, overrides, code) => {
      const { deps } = makeDepsWithMocks(overrides as Record<string, unknown>);
      await expect(
        createVolunteerAsk(deps, {
          actorHumanId: ACTOR_ID,
          subjectType,
          subjectId,
          title: "Anything",
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("rejects an archived PLACE subject", async () => {
    const { deps } = makeDepsWithMocks({
      places: {
        getById: vi.fn(async () => ({ ...basePlace, status: "ARCHIVED" })),
      },
    });
    await expect(createVolunteerAsk(deps, placeInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "place_not_active",
    });
  });

  it("rejects an inactive ORG subject", async () => {
    const { deps } = makeDepsWithMocks({
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, status: "SUSPENDED" })),
      },
    });
    await expect(
      createVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        subjectType: "ORG",
        subjectId: ORG_ID,
        title: "Street team",
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_INACTIVE" });
  });

  it("rejects a suspended HUMAN subject", async () => {
    const { deps } = makeDepsWithMocks({
      humans: {
        getById: vi.fn(async () => ({ id: ACTOR_ID, status: "SUSPENDED" })),
      },
    });
    await expect(
      createVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        subjectType: "HUMAN",
        subjectId: ACTOR_ID,
        title: "Series hands",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "human_not_active" });
  });

  it("rejects an ARCHIVED EVENT subject", async () => {
    const { deps } = makeDepsWithMocks({
      events: {
        getById: vi.fn(async () => ({ ...baseEvent, status: "ARCHIVED" })),
      },
    });
    await expect(
      createVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        subjectType: "EVENT",
        subjectId: EVENT_ID,
        title: "Anything",
      }),
    ).rejects.toMatchObject({ code: "EVENT_ARCHIVED" });
  });

  it("rejects an inverted scheduling window at the schema", async () => {
    const { deps } = makeDepsWithMocks();
    await expect(
      createVolunteerAsk(deps, {
        ...placeInput,
        startsAt: "2026-07-10T18:00:00.000Z",
        endsAt: "2026-07-10T17:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("saves the stated IANA zone with the window and records it in the audit row", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await createVolunteerAsk(deps, {
      ...placeInput,
      startsAt: "2026-07-10T23:00:00.000Z",
      endsAt: "2026-07-11T02:00:00.000Z",
      timezone: "America/Chicago",
    });

    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/Chicago" }),
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ timezone: "America/Chicago" }),
      }),
    );
  });

  it("stores the canonical IANA spelling of the stated zone", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await createVolunteerAsk(deps, {
      ...placeInput,
      timezone: "america/chicago",
    });

    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/Chicago" }),
    );
  });

  it("stores null when no zone is stated", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await createVolunteerAsk(deps, placeInput);

    expect((txRepos.volunteering as any).createAsk).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: null }),
    );
  });

  it.each(["Mars/Olympus_Mons", "not a zone", ""])(
    "rejects an invalid zone %j at the schema without writing",
    async (timezone) => {
      const { deps, txRepos } = makeDepsWithMocks();
      await expect(
        createVolunteerAsk(deps, { ...placeInput, timezone }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect((txRepos.volunteering as any).createAsk).not.toHaveBeenCalled();
    },
  );
});
