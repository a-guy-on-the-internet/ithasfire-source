import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { VolunteerAskRecord } from "@th/ports/repos/volunteering";

import { assignWaiverToAsk } from "./assign-waiver-to-ask";
import type { AssignWaiverToAskDeps } from "./assign-waiver-to-ask";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const PLACE_ID = "00000000-0000-4000-8000-000000000005";
const PLACE_OWNER_ID = "00000000-0000-4000-8000-000000000006";
const EVENT_ID = "00000000-0000-4000-8000-000000000007";
const ASK_ID = "00000000-0000-4000-8000-000000000010";
const ORG_TEMPLATE_ID = "00000000-0000-4000-8000-000000000060";
const HUMAN_TEMPLATE_ID = "00000000-0000-4000-8000-000000000061";
const PLATFORM_TEMPLATE_ID = "00000000-0000-4000-8000-000000000062";
const NOW = new Date("2026-07-07T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const orgAsk: VolunteerAskRecord = {
  id: ASK_ID,
  subjectType: "ORG",
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Standing bar crew",
  description: null,
  status: "OPEN",
  cadence: "ONGOING",
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: true,
  waiverTemplateId: null,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const placeAsk: VolunteerAskRecord = {
  ...orgAsk,
  subjectType: "PLACE",
  subjectId: PLACE_ID,
};

const humanAsk: VolunteerAskRecord = {
  ...orgAsk,
  subjectType: "HUMAN",
  subjectId: ACTOR_ID,
  orgId: null,
};

const eventAsk: VolunteerAskRecord = {
  ...orgAsk,
  subjectType: "EVENT",
  subjectId: EVENT_ID,
};

/** Place owned by an org AND a direct human owner (union owner set). */
const place = {
  id: PLACE_ID,
  name: "The Hall",
  humanIdsWithAccess: [PLACE_OWNER_ID],
  orgIdsWithAccess: [ORG_ID],
};

const orgTemplate = {
  id: ORG_TEMPLATE_ID,
  orgId: ORG_ID,
  humanId: null,
  name: "Org Volunteer Waiver",
  body: "Org waiver body.",
  version: 1,
  isDefault: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const humanTemplate = {
  ...orgTemplate,
  id: HUMAN_TEMPLATE_ID,
  orgId: null,
  humanId: ACTOR_ID,
  name: "Personal Waiver",
};

const platformTemplate = {
  ...orgTemplate,
  id: PLATFORM_TEMPLATE_ID,
  orgId: null,
  humanId: null,
  name: "Standard Volunteer Waiver",
  isDefault: true,
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos: Record<string, unknown> = {
    volunteering: {
      getAsk: vi.fn(async () => orgAsk),
      setAskWaiverTemplate: vi.fn(
        async (input: { askId: string; waiverTemplateId: string | null }) => ({
          ...orgAsk,
          id: input.askId,
          waiverTemplateId: input.waiverTemplateId,
          updatedAt: NOW,
        }),
      ),
    },
    waiverTemplates: {
      getById: vi.fn(async () => orgTemplate),
    },
    places: { getById: vi.fn(async () => place) },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
      })),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "ADMIN" })),
      getOrgMemberships: vi.fn(async () => [{ orgId: ORG_ID, role: "ADMIN" }]),
    },
    humanDelegates: { getDelegation: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => undefined) },
    ...txOverrides,
  };
  const deps: AssignWaiverToAskDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

const validInput = {
  actorHumanId: ACTOR_ID,
  askId: ASK_ID,
  waiverTemplateId: ORG_TEMPLATE_ID,
};

// ══════════════════════════════════════════════════════════════════════════════
// assignWaiverToAsk
// ══════════════════════════════════════════════════════════════════════════════

describe("assignWaiverToAsk — happy paths per subject type", () => {
  it("ORG subject: assigns an org-owned template and audits with the previous value", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await assignWaiverToAsk(deps, validInput);

    expect(result).toEqual({
      ask: { id: ASK_ID, waiverTemplateId: ORG_TEMPLATE_ID },
    });
    expect(
      (txRepos.volunteering as any).setAskWaiverTemplate,
    ).toHaveBeenCalledWith({
      askId: ASK_ID,
      waiverTemplateId: ORG_TEMPLATE_ID,
    });
    expect((txRepos.audit as any).log).toHaveBeenCalledWith({
      entity: "volunteer_ask",
      entityId: ASK_ID,
      action: "waiver_assigned",
      data: {
        actorHumanId: ACTOR_ID,
        subjectType: "ORG",
        subjectId: ORG_ID,
        waiverTemplateId: ORG_TEMPLATE_ID,
        previousWaiverTemplateId: null,
      },
      at: NOW,
    });
  });

  it("PLACE subject: allows a template owned by one of the place's owning orgs", async () => {
    const { deps, txRepos } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => placeAsk),
        setAskWaiverTemplate: vi.fn(async () => ({
          ...placeAsk,
          waiverTemplateId: ORG_TEMPLATE_ID,
        })),
      },
    });

    const result = await assignWaiverToAsk(deps, validInput);

    expect(result.ask.waiverTemplateId).toBe(ORG_TEMPLATE_ID);
    // Ownership re-derived from the live place row, not the actor's orgs.
    expect((txRepos.places as any).getById).toHaveBeenCalledWith(PLACE_ID);
  });

  it("PLACE subject: allows a template owned by a direct human owner of the place", async () => {
    const placeOwnerTemplate = {
      ...humanTemplate,
      humanId: PLACE_OWNER_ID,
    };
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => placeAsk),
        setAskWaiverTemplate: vi.fn(async () => ({
          ...placeAsk,
          waiverTemplateId: placeOwnerTemplate.id,
        })),
      },
      waiverTemplates: { getById: vi.fn(async () => placeOwnerTemplate) },
    });

    const result = await assignWaiverToAsk(deps, {
      ...validInput,
      waiverTemplateId: placeOwnerTemplate.id,
    });

    expect(result.ask.waiverTemplateId).toBe(placeOwnerTemplate.id);
  });

  it("HUMAN subject: the subject human assigns their own template", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => humanAsk),
        setAskWaiverTemplate: vi.fn(async () => ({
          ...humanAsk,
          waiverTemplateId: HUMAN_TEMPLATE_ID,
        })),
      },
      waiverTemplates: { getById: vi.fn(async () => humanTemplate) },
    });

    const result = await assignWaiverToAsk(deps, {
      ...validInput,
      waiverTemplateId: HUMAN_TEMPLATE_ID,
    });

    expect(result.ask.waiverTemplateId).toBe(HUMAN_TEMPLATE_ID);
  });
});

describe("assignWaiverToAsk — clearing", () => {
  it("clears to null without any template lookup", async () => {
    const { deps, txRepos } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => ({
          ...orgAsk,
          waiverTemplateId: ORG_TEMPLATE_ID,
        })),
        setAskWaiverTemplate: vi.fn(async () => ({
          ...orgAsk,
          waiverTemplateId: null,
        })),
      },
    });

    const result = await assignWaiverToAsk(deps, {
      ...validInput,
      waiverTemplateId: null,
    });

    expect(result.ask.waiverTemplateId).toBeNull();
    expect((txRepos.waiverTemplates as any).getById).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).setAskWaiverTemplate,
    ).toHaveBeenCalledWith({ askId: ASK_ID, waiverTemplateId: null });
    // The audit trail still records what the gate pointed at before.
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "waiver_assigned",
        data: expect.objectContaining({
          waiverTemplateId: null,
          previousWaiverTemplateId: ORG_TEMPLATE_ID,
        }),
      }),
    );
  });
});

describe("assignWaiverToAsk — platform template", () => {
  it.each([
    ["ORG", orgAsk],
    ["PLACE", placeAsk],
    ["HUMAN", humanAsk],
  ] as const)("is allowed on a %s-subject ask", async (_label, ask) => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => ask),
        setAskWaiverTemplate: vi.fn(async () => ({
          ...ask,
          waiverTemplateId: PLATFORM_TEMPLATE_ID,
        })),
      },
      waiverTemplates: { getById: vi.fn(async () => platformTemplate) },
    });

    const result = await assignWaiverToAsk(deps, {
      ...validInput,
      waiverTemplateId: PLATFORM_TEMPLATE_ID,
    });

    expect(result.ask.waiverTemplateId).toBe(PLATFORM_TEMPLATE_ID);
  });
});

describe("assignWaiverToAsk — rejections", () => {
  it("rejects EVENT-subject asks — the event stays the source of truth", async () => {
    const { deps, txRepos } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => eventAsk),
        setAskWaiverTemplate: vi.fn(),
      },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "event_asks_use_event_waiver",
    });
    expect(
      (txRepos.volunteering as any).setAskWaiverTemplate,
    ).not.toHaveBeenCalled();
  });

  it("rejects a missing template", async () => {
    const { deps, txRepos } = makeDeps({
      waiverTemplates: { getById: vi.fn(async () => null) },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "WAIVER_TEMPLATE_NOT_FOUND",
    });
    expect(
      (txRepos.volunteering as any).setAskWaiverTemplate,
    ).not.toHaveBeenCalled();
  });

  it("rejects another org's template on an ORG ask", async () => {
    const { deps } = makeDeps({
      waiverTemplates: {
        getById: vi.fn(async () => ({ ...orgTemplate, orgId: OTHER_ORG_ID })),
      },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "WAIVER_TEMPLATE_NOT_ACCESSIBLE",
    });
  });

  it("rejects a personal (human-owned) template on an ORG ask", async () => {
    const { deps } = makeDeps({
      waiverTemplates: { getById: vi.fn(async () => humanTemplate) },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "WAIVER_TEMPLATE_NOT_ACCESSIBLE",
    });
  });

  it("rejects another human's template on a HUMAN ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => humanAsk),
        setAskWaiverTemplate: vi.fn(),
      },
      waiverTemplates: {
        getById: vi.fn(async () => ({
          ...humanTemplate,
          humanId: OTHER_HUMAN_ID,
        })),
      },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "WAIVER_TEMPLATE_NOT_ACCESSIBLE",
    });
  });

  it("rejects an org template on a HUMAN ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => humanAsk),
        setAskWaiverTemplate: vi.fn(),
      },
      waiverTemplates: { getById: vi.fn(async () => orgTemplate) },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "WAIVER_TEMPLATE_NOT_ACCESSIBLE",
    });
  });

  it("rejects a template from an unrelated owner on a PLACE ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => placeAsk),
        setAskWaiverTemplate: vi.fn(),
      },
      waiverTemplates: {
        getById: vi.fn(async () => ({ ...orgTemplate, orgId: OTHER_ORG_ID })),
      },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "WAIVER_TEMPLATE_NOT_ACCESSIBLE",
    });
  });

  it("rejects a non-editor actor before touching subject state", async () => {
    const { deps, txRepos } = makeDeps({
      authz: {
        getOrgMembership: vi.fn(async () => ({
          orgId: ORG_ID,
          role: "VIEWER",
        })),
        getOrgMemberships: vi.fn(async () => [
          { orgId: ORG_ID, role: "VIEWER" },
        ]),
      },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect((txRepos.waiverTemplates as any).getById).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).setAskWaiverTemplate,
    ).not.toHaveBeenCalled();
  });

  it("collapses a missing ask to ask_not_found", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => null),
        setAskWaiverTemplate: vi.fn(),
      },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "ask_not_found",
    });
  });

  it("treats ARCHIVED asks as terminal (conflict)", async () => {
    const { deps, txRepos } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => ({ ...orgAsk, status: "ARCHIVED" })),
        setAskWaiverTemplate: vi.fn(),
      },
    });

    await expect(assignWaiverToAsk(deps, validInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "ask_archived",
    });
    expect(
      (txRepos.volunteering as any).setAskWaiverTemplate,
    ).not.toHaveBeenCalled();
  });

  it("rejects malformed input at parse time", async () => {
    const { deps } = makeDeps();

    await expect(
      assignWaiverToAsk(deps, { ...validInput, askId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // .strict(): unknown keys are rejected, not stripped.
    await expect(
      assignWaiverToAsk(deps, { ...validInput, extra: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
