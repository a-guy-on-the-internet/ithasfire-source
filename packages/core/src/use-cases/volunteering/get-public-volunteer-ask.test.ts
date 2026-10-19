import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerAskRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";

import {
  getPublicVolunteerAsk,
  type GetPublicVolunteerAskDeps,
} from "./get-public-volunteer-ask";

// ── Constants ────────────────────────────────────────────────────────────────

const ASK_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const ROLE_ID_2 = "00000000-0000-4000-8000-000000000011";
const NOW = new Date("2026-07-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseAsk: VolunteerAskRecord = {
  id: ASK_ID,
  subjectType: "ORG",
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Standing bar crew",
  description: "Help us pour",
  status: "OPEN",
  cadence: "ONGOING",
  startsAt: new Date("2026-08-01T18:00:00.000Z"),
  endsAt: new Date("2026-08-01T23:00:00.000Z"),
  timezone: "America/Chicago",
  capacity: 20,
  autoApprove: true,
  waiverRequired: true,
  smsOptInEnabled: true,
  formSchema: { questions: [{ id: "q1", label: "Why?" }] },
  createdAt: NOW,
  updatedAt: NOW,
};

const baseRole: EventVolunteerRoleWithShiftsRecord = {
  id: ROLE_ID,
  eventId: null,
  askId: ASK_ID,
  templateId: "00000000-0000-4000-8000-0000000000aa",
  name: "Door",
  description: "Check wristbands",
  capacity: 5,
  autoApprove: true,
  defaultHours: 3.5,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const secondRole: EventVolunteerRoleWithShiftsRecord = {
  ...baseRole,
  id: ROLE_ID_2,
  name: "Bar",
  description: null,
  capacity: null,
  defaultHours: null,
  sortOrder: 1,
};

const page = (items: VolunteerSignupRecord[], total: number) => ({
  items,
  pageInfo: {
    total,
    count: items.length,
    limit: 1,
    offset: 0,
    hasNextPage: false,
    nextOffset: null,
  },
});

// ── Mock builder ─────────────────────────────────────────────────────────────

type TxOverrides = {
  ask?: VolunteerAskRecord | null;
  roles?: EventVolunteerRoleWithShiftsRecord[];
  /** `roleId:status` → total (defaults to 0). */
  counts?: Record<string, number>;
  /** Ban that sticks: owners `bans.findBannedOwners` reports as withheld. */
  banned?: { humanIds: string[]; orgIds: string[] };
  /** EVENT asks: the subject event's derived owner standing (null = gone). */
  event?: { id: string; ownerBanned: boolean } | null;
};

function makeDeps(overrides: TxOverrides = {}) {
  const ask = overrides.ask === undefined ? baseAsk : overrides.ask;
  const roles = overrides.roles ?? [baseRole, secondRole];
  const counts = overrides.counts ?? {};
  const banned = overrides.banned ?? { humanIds: [], orgIds: [] };
  const event = overrides.event === undefined ? null : overrides.event;

  const txRepos = {
    volunteering: {
      getAsk: vi.fn(async () => ask),
      listRolesByAsk: vi.fn(async () => roles),
      listSignupsByAsk: vi.fn(async (_askId: string, opts: any) =>
        page([], counts[`${opts?.roleId}:${opts?.status}`] ?? 0),
      ),
    },
    bans: {
      findBannedOwners: vi.fn(async () => banned),
    },
    events: {
      getById: vi.fn(async () => event),
    },
  };

  const txSpy = vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
    fn(txRepos as unknown as TxRepos),
  );

  const deps: GetPublicVolunteerAskDeps = {
    repos: { tx: txSpy } as unknown as Repos,
  };

  return { deps, txRepos, txSpy };
}

// ══════════════════════════════════════════════════════════════════════════════
// Visibility gate
// ══════════════════════════════════════════════════════════════════════════════

describe("getPublicVolunteerAsk — visibility gate", () => {
  const validInput = { askId: ASK_ID };

  it("throws not_found when the ask does not exist", async () => {
    const { deps } = makeDeps({ ask: null });
    await expect(getPublicVolunteerAsk(deps, validInput)).rejects.toMatchObject(
      { code: "NOT_FOUND", message: "ask_not_found" },
    );
  });

  it("throws not_found for a DRAFT ask (no existence oracle)", async () => {
    const { deps } = makeDeps({ ask: { ...baseAsk, status: "DRAFT" } });
    await expect(getPublicVolunteerAsk(deps, validInput)).rejects.toMatchObject(
      { code: "NOT_FOUND", message: "ask_not_found" },
    );
  });

  it("throws not_found for an ARCHIVED ask (no existence oracle)", async () => {
    const { deps } = makeDeps({ ask: { ...baseAsk, status: "ARCHIVED" } });
    await expect(getPublicVolunteerAsk(deps, validInput)).rejects.toMatchObject(
      { code: "NOT_FOUND", message: "ask_not_found" },
    );
  });

  it("returns PAUSED asks with their status (friendly closed page)", async () => {
    const { deps } = makeDeps({ ask: { ...baseAsk, status: "PAUSED" } });
    const result = await getPublicVolunteerAsk(deps, validInput);
    expect(result.ask.status).toBe("PAUSED");
  });

  it("returns CLOSED asks with their status (friendly closed page)", async () => {
    const { deps } = makeDeps({ ask: { ...baseAsk, status: "CLOSED" } });
    const result = await getPublicVolunteerAsk(deps, validInput);
    expect(result.ask.status).toBe("CLOSED");
  });

  it("throws not_found for an ORG ask whose owner is withheld (ban that sticks)", async () => {
    const { deps, txRepos } = makeDeps({
      banned: { humanIds: [], orgIds: [ORG_ID] },
    });
    await expect(getPublicVolunteerAsk(deps, validInput)).rejects.toMatchObject(
      { code: "NOT_FOUND", message: "ask_not_found" },
    );
    expect(txRepos.bans.findBannedOwners).toHaveBeenCalledWith({
      humanIds: [],
      orgIds: [ORG_ID],
    });
    expect(txRepos.volunteering.listRolesByAsk).not.toHaveBeenCalled();
  });

  it("throws not_found for a HUMAN ask whose owner is withheld", async () => {
    const HUMAN_ID = "00000000-0000-4000-8000-000000000003";
    const { deps, txRepos } = makeDeps({
      ask: { ...baseAsk, subjectType: "HUMAN", subjectId: HUMAN_ID, orgId: null },
      banned: { humanIds: [HUMAN_ID], orgIds: [] },
    });
    await expect(getPublicVolunteerAsk(deps, validInput)).rejects.toMatchObject(
      { code: "NOT_FOUND", message: "ask_not_found" },
    );
    expect(txRepos.bans.findBannedOwners).toHaveBeenCalledWith({
      humanIds: [HUMAN_ID],
      orgIds: [],
    });
  });

  describe("EVENT-subject ask (ask-owned roles never touch the event path)", () => {
    const EVENT_ID = "00000000-0000-4000-8000-000000000004";
    const eventAsk: VolunteerAskRecord = {
      ...baseAsk,
      subjectType: "EVENT",
      subjectId: EVENT_ID,
    };

    it("throws not_found when the event's owner is withheld", async () => {
      const { deps, txRepos } = makeDeps({
        ask: eventAsk,
        event: { id: EVENT_ID, ownerBanned: true },
      });
      await expect(
        getPublicVolunteerAsk(deps, validInput),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
      expect(txRepos.events.getById).toHaveBeenCalledWith(EVENT_ID, {
        withOwnerStanding: true,
      });
      expect(txRepos.bans.findBannedOwners).not.toHaveBeenCalled();
      expect(txRepos.volunteering.listRolesByAsk).not.toHaveBeenCalled();
    });

    it("returns the ask when the event's owner is in good standing", async () => {
      const { deps } = makeDeps({
        ask: eventAsk,
        event: { id: EVENT_ID, ownerBanned: false },
      });
      const result = await getPublicVolunteerAsk(deps, validInput);
      expect(result.ask.id).toBe(ASK_ID);
    });
  });

  it("returns the ask when its owner is not withheld", async () => {
    const { deps, txRepos } = makeDeps();
    const result = await getPublicVolunteerAsk(deps, validInput);
    expect(result.ask.id).toBe(ASK_ID);
    expect(txRepos.bans.findBannedOwners).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid input at the boundary", async () => {
    const { deps } = makeDeps();
    await expect(
      getPublicVolunteerAsk(deps, { askId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Happy path
// ══════════════════════════════════════════════════════════════════════════════

describe("getPublicVolunteerAsk — happy path", () => {
  const validInput = { askId: ASK_ID };

  it("returns the public ask fields and role list", async () => {
    const { deps } = makeDeps();
    const result = await getPublicVolunteerAsk(deps, validInput);

    expect(result.ask).toEqual({
      id: ASK_ID,
      title: "Standing bar crew",
      description: "Help us pour",
      status: "OPEN",
      cadence: "ONGOING",
      startsAt: baseAsk.startsAt,
      endsAt: baseAsk.endsAt,
      timezone: "America/Chicago",
      capacity: 20,
      waiverRequired: true,
      smsOptInEnabled: true,
      // ONGOING: no reminder is sent, so no text opt-in, whatever the
      // organiser's old switch says (volunteer-ask-reminders R1, R5).
      textRemindersOffered: false,
      formSchema: { questions: [{ id: "q1", label: "Why?" }] },
    });
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0]).toMatchObject({
      id: ROLE_ID,
      name: "Door",
      description: "Check wristbands",
      capacity: 5,
      defaultHours: 3.5,
      sortOrder: 0,
    });
  });

  it.each([
    ["a ONE_TIME ask with a start", { cadence: "ONE_TIME" }, true],
    // The organiser's switch is off and the texts are still offered (R5).
    ["…with the organiser's old switch off", { cadence: "ONE_TIME", smsOptInEnabled: false }, true],
    ["a ONE_TIME ask without a start", { cadence: "ONE_TIME", startsAt: null }, false],
    ["a RECURRING ask", { cadence: "RECURRING" }, false],
  ] as const)(
    "textRemindersOffered: %s → %s",
    async (_name, over, expected) => {
      const { deps } = makeDeps({ ask: { ...baseAsk, ...over } });
      const result = await getPublicVolunteerAsk(deps, validInput);
      expect(result.ask.textRemindersOffered).toBe(expected);
    },
  );

  it("does NOT expose internal fields on the ask or roles", async () => {
    const { deps } = makeDeps();
    const result = await getPublicVolunteerAsk(deps, validInput);

    // Ownership internals + admin knobs must not be present on the ask.
    expect(result.ask).not.toHaveProperty("subjectType");
    expect(result.ask).not.toHaveProperty("subjectId");
    expect(result.ask).not.toHaveProperty("orgId");
    expect(result.ask).not.toHaveProperty("autoApprove");
    expect(result.ask).not.toHaveProperty("createdAt");
    expect(result.ask).not.toHaveProperty("updatedAt");

    const role = result.roles[0]!;
    expect(role).not.toHaveProperty("autoApprove");
    expect(role).not.toHaveProperty("templateId");
    expect(role).not.toHaveProperty("eventId");
    expect(role).not.toHaveProperty("askId");
    expect(role).not.toHaveProperty("shifts");
    expect(role).not.toHaveProperty("createdAt");
    expect(role).not.toHaveProperty("updatedAt");
  });

  it("sums accepted counts from APPROVED + CHECKED_IN totals per role", async () => {
    const { deps, txRepos } = makeDeps({
      counts: {
        [`${ROLE_ID}:APPROVED`]: 3,
        [`${ROLE_ID}:CHECKED_IN`]: 1,
        [`${ROLE_ID_2}:APPROVED`]: 0,
      },
    });
    const result = await getPublicVolunteerAsk(deps, validInput);

    expect(result.roles[0]!.acceptedCount).toBe(4);
    expect(result.roles[1]!.acceptedCount).toBe(0);
    // PENDING is never queried — capacity gates acceptance, not application.
    const statuses = txRepos.volunteering.listSignupsByAsk.mock.calls.map(
      ([, opts]: [string, { status?: string }]) => opts?.status,
    );
    expect(statuses).not.toContain("PENDING");
  });

  it("runs all reads inside a single repos.tx()", async () => {
    const { deps, txSpy } = makeDeps();
    await getPublicVolunteerAsk(deps, validInput);
    expect(txSpy).toHaveBeenCalledTimes(1);
  });
});
