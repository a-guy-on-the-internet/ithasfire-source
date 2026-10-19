import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerAskStatus,
} from "@th/ports/repos/volunteering";

import { updateVolunteerAsk } from "./update-volunteer-ask";
import type { UpdateVolunteerAskDeps } from "./update-volunteer-ask";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ASK_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-07-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseAsk: VolunteerAskRecord = {
  id: ASK_ID,
  subjectType: "ORG",
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Street team",
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
    authz: {
      getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "ADMIN" })),
      getOrgMemberships: vi.fn(async () => [{ orgId: ORG_ID, role: "ADMIN" }]),
    },
    volunteering: {
      getAsk: vi.fn(async () => baseAsk),
      updateAsk: vi.fn(async (id: string, input: any) => ({
        ...baseAsk,
        ...Object.fromEntries(
          Object.entries(input).filter(([, v]) => v !== undefined),
        ),
        id,
        updatedAt: NOW,
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDepsWithMocks(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: UpdateVolunteerAskDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

function withStatus(status: VolunteerAskStatus) {
  return {
    volunteering: {
      getAsk: vi.fn(async () => ({ ...baseAsk, status })),
      updateAsk: vi.fn(async (id: string, input: any) => ({
        ...baseAsk,
        status,
        ...Object.fromEntries(
          Object.entries(input).filter(([, v]) => v !== undefined),
        ),
        id,
      })),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════

describe("updateVolunteerAsk", () => {
  it("patches fields and audits", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      title: "Door + bar help",
      capacity: 12,
    });

    expect(result.title).toBe("Door + bar help");
    expect((txRepos.volunteering as any).updateAsk).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({ title: "Door + bar help", capacity: 12 }),
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "volunteer_ask", action: "updated" }),
    );
  });

  it.each([
    ["DRAFT", "OPEN"],
    ["OPEN", "PAUSED"],
    ["PAUSED", "OPEN"],
    ["OPEN", "CLOSED"],
    ["PAUSED", "CLOSED"],
    ["CLOSED", "ARCHIVED"],
  ] as const)("allows %s → %s", async (from, to) => {
    const { deps } = makeDepsWithMocks(withStatus(from));
    const result = await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      status: to,
    });
    expect(result.status).toBe(to);
  });

  it("audits status transitions as status_changed", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      status: "OPEN",
    });
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "status_changed",
        data: expect.objectContaining({ from: "DRAFT", to: "OPEN" }),
      }),
    );
  });

  it.each([
    ["CLOSED", "OPEN"],
    ["DRAFT", "PAUSED"],
    ["CLOSED", "PAUSED"],
  ] as const)("rejects %s → %s", async (from, to) => {
    const { deps } = makeDepsWithMocks(withStatus(from));
    await expect(
      updateVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        status: to,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "invalid_status_transition",
    });
  });

  it("treats a same-status patch as a no-transition update", async () => {
    const { deps } = makeDepsWithMocks(withStatus("OPEN"));
    const result = await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      status: "OPEN",
      title: "Still open",
    });
    expect(result.status).toBe("OPEN");
  });

  it("rejects ANY patch on an ARCHIVED ask (terminal — no reopen)", async () => {
    const { deps } = makeDepsWithMocks(withStatus("ARCHIVED"));
    await expect(
      updateVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        status: "OPEN",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "ask_archived" });

    await expect(
      updateVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        title: "Rename attempt",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "ask_archived" });
  });

  it("rejects when the ask does not exist", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: { getAsk: vi.fn(async () => null), updateAsk: vi.fn() },
    });
    await expect(
      updateVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        title: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a VIEWER on the owning org", async () => {
    const { deps } = makeDepsWithMocks({
      authz: {
        getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "VIEWER" })),
      },
    });
    await expect(
      updateVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        title: "x",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects an effective window where endsAt <= stored startsAt", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => ({
          ...baseAsk,
          startsAt: new Date("2026-08-01T18:00:00.000Z"),
          endsAt: null,
        })),
        updateAsk: vi.fn(),
      },
    });
    await expect(
      updateVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        endsAt: "2026-08-01T17:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "ends_before_starts",
    });
  });

  it("allows clearing one side of the window with null", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => ({
          ...baseAsk,
          startsAt: new Date("2026-08-01T18:00:00.000Z"),
          endsAt: new Date("2026-08-01T22:00:00.000Z"),
        })),
        updateAsk: vi.fn(async (id: string, input: any) => ({
          ...baseAsk,
          id,
          ...input,
        })),
      },
    });
    await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      endsAt: null,
    });
    expect((txRepos.volunteering as any).updateAsk).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({ endsAt: null }),
    );
  });

  it("sets a stated zone and audits the change", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      timezone: "America/New_York",
    });

    expect(result.timezone).toBe("America/New_York");
    expect((txRepos.volunteering as any).updateAsk).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({ timezone: "America/New_York" }),
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          timezone: { from: null, to: "America/New_York" },
        }),
      }),
    );
  });

  it("canonicalises the zone on update", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      timezone: "europe/berlin",
    });
    expect((txRepos.volunteering as any).updateAsk).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({ timezone: "Europe/Berlin" }),
    );
  });

  it("clears a stated zone with null", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => ({ ...baseAsk, timezone: "Europe/Berlin" })),
        updateAsk: vi.fn(async (id: string, input: any) => ({
          ...baseAsk,
          id,
          ...input,
        })),
      },
    });
    const result = await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      timezone: null,
    });

    expect(result.timezone).toBeNull();
    expect((txRepos.volunteering as any).updateAsk).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({ timezone: null }),
    );
  });

  it("leaves the zone untouched when the patch omits it", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await updateVolunteerAsk(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      title: "Renamed",
    });
    const patch = (txRepos.volunteering as any).updateAsk.mock.calls[0][1];
    expect(patch.timezone).toBeUndefined();
    const auditData = (txRepos.audit as any).log.mock.calls[0][0].data;
    expect(auditData).not.toHaveProperty("timezone");
  });

  it("rejects an invalid zone at the schema without writing", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await expect(
      updateVolunteerAsk(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        timezone: "Atlantis/Lost_City",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((txRepos.volunteering as any).updateAsk).not.toHaveBeenCalled();
  });
});
