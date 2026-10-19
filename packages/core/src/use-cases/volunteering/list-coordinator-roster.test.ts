import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";

import { listCoordinatorRoster } from "./list-coordinator-roster";
import type { ListCoordinatorRosterDeps } from "./list-coordinator-roster";

const COORDINATOR_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_COORDINATOR_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const ASK_ID = "00000000-0000-4000-8000-000000000004";
const OWN_GROUP_ID = "00000000-0000-4000-8000-000000000005";
const OTHER_GROUP_ID = "00000000-0000-4000-8000-000000000006";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const baseAsk = {
  id: ASK_ID,
  subjectType: "ORG" as const,
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Standing bar crew",
  description: null,
  status: "OPEN" as const,
  cadence: "ONGOING" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const ownGroup = {
  id: OWN_GROUP_ID,
  askId: ASK_ID,
  name: "Door team",
  description: null,
  capacity: null,
  coordinatorHumanId: COORDINATOR_ID,
  createdAt: NOW,
  updatedAt: NOW,
  memberCount: 1,
  coordinator: { humanId: COORDINATOR_ID, name: "Me" },
};

const otherGroup = {
  ...ownGroup,
  id: OTHER_GROUP_ID,
  name: "Bar team",
  coordinatorHumanId: OTHER_COORDINATOR_ID,
  coordinator: { humanId: OTHER_COORDINATOR_ID, name: "Them" },
};

const ownMember = {
  id: "00000000-0000-4000-8000-000000000007",
  askId: ASK_ID,
  eventId: null,
  groupId: OWN_GROUP_ID,
  status: "APPROVED",
  contactEmail: "mine@example.com",
} as unknown as VolunteerSignupRecord;

const GRANTED_MEMBER_ID = "00000000-0000-4000-8000-000000000008";
const REDEEMED_MEMBER_ID = "00000000-0000-4000-8000-000000000009";
const REVOKED_MEMBER_ID = "00000000-0000-4000-8000-00000000000a";
const NO_GRANT_MEMBER_ID = "00000000-0000-4000-8000-00000000000b";

const member = (id: string) =>
  ({
    ...(ownMember as unknown as Record<string, unknown>),
    id,
    contactEmail: `${id}@example.com`,
  }) as unknown as VolunteerSignupRecord;

const page = (
  items: VolunteerSignupRecord[],
  nextCursor: string | null = null,
) => ({
  items,
  nextCursor,
});

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = {
    // The coordinator seat needs a verified email (B2); every actor here is
    // verified unless a test says otherwise.
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
    },
    volunteering: {
      getAsk: vi.fn(async () => baseAsk),
      listGroupsByAsk: vi.fn(async () => [ownGroup, otherGroup]),
      listSignupsByAskCursor: vi.fn(async () => page([ownMember])),
      // Default: no grants → every signup badge stays silent (absent).
      listRewardGrantStatusesBySignupIds: vi.fn(async () => []),
    },
    ...txOverrides,
  };
  const deps: ListCoordinatorRosterDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

describe("listCoordinatorRoster", () => {
  it("returns ONLY the actor's group with its signups", async () => {
    const { deps } = makeDeps();

    const result = await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe(OWN_GROUP_ID);
    expect(result.groups[0].signups).toEqual([ownMember]);
    expect(result.nextCursor).toBeNull();
  });

  it("B2: an unverified coordinator reads no roster (volunteer contacts)", async () => {
    const { deps, txRepos } = makeDeps({
      humans: {
        getByIdWithIdentity: vi.fn(async () => ({
          identity: { emailVerified: false },
        })),
      },
    });

    await expect(
      listCoordinatorRoster(deps, {
        actorHumanId: COORDINATOR_ID,
        askId: ASK_ID,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(
      (txRepos as any).volunteering.listSignupsByAskCursor,
    ).not.toHaveBeenCalled();
  });

  it("NFR-003: every signup read is scoped to the actor's own groupId — no broader read", async () => {
    const { deps, txRepos } = makeDeps();

    await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
    });

    const calls = (txRepos.volunteering as any).listSignupsByAskCursor.mock
      .calls;
    expect(calls).toHaveLength(1);
    for (const [askId, opts] of calls) {
      expect(askId).toBe(ASK_ID);
      // The group filter must ALWAYS be the actor's own group — never
      // omitted (whole-ask read) and never another group's id.
      expect(opts.groupId).toBe(OWN_GROUP_ID);
    }
  });

  it("forbids an actor who coordinates no group on the ask", async () => {
    const { deps, txRepos } = makeDeps();

    await expect(
      listCoordinatorRoster(deps, {
        actorHumanId: "00000000-0000-4000-8000-000000000099",
        askId: ASK_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (txRepos.volunteering as any).listSignupsByAskCursor,
    ).not.toHaveBeenCalled();
  });

  it("404s when the ask is missing", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => null);

    await expect(
      listCoordinatorRoster(deps, {
        actorHumanId: COORDINATOR_ID,
        askId: ASK_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
  });

  it("returns multiple groups when the actor coordinates more than one", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listGroupsByAsk = vi.fn(async () => [
      ownGroup,
      { ...otherGroup, coordinatorHumanId: COORDINATOR_ID },
    ]);

    const result = await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
    });

    expect(result.groups.map((g) => g.id)).toEqual([
      OWN_GROUP_ID,
      OTHER_GROUP_ID,
    ]);
    const calls = (txRepos.volunteering as any).listSignupsByAskCursor.mock
      .calls;
    expect(calls.map(([, opts]: any[]) => opts.groupId)).toEqual([
      OWN_GROUP_ID,
      OTHER_GROUP_ID,
    ]);
  });

  // ── Cursor pagination ─────────────────────────────────────────────────────

  it("returns a group-prefixed nextCursor when a group still has members", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listSignupsByAskCursor = vi.fn(async () =>
      page([ownMember], "2026-07-01T12:00:00.000Z|last-id"),
    );

    const result = await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
      limit: 1,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.nextCursor).toBe(
      `${OWN_GROUP_ID}|2026-07-01T12:00:00.000Z|last-id`,
    );
  });

  it("round-trips the cursor: page 2 resumes INSIDE the cursor group with the signup cursor", async () => {
    const { deps, txRepos } = makeDeps();
    const read = vi.fn(async () => page([ownMember]));
    (txRepos.volunteering as any).listSignupsByAskCursor = read;

    await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
      cursor: `${OWN_GROUP_ID}|2026-07-01T12:00:00.000Z|last-id`,
      limit: 10,
    });

    expect(read).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({
        groupId: OWN_GROUP_ID,
        cursor: "2026-07-01T12:00:00.000Z|last-id",
        limit: 10,
      }),
    );
  });

  it("walks across groups: an exhausted group hands the remaining budget to the next one", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listGroupsByAsk = vi.fn(async () => [
      ownGroup,
      { ...otherGroup, coordinatorHumanId: COORDINATOR_ID },
    ]);
    const read = vi.fn(async (_askId: string, opts: any) =>
      opts.groupId === OWN_GROUP_ID
        ? page([member(GRANTED_MEMBER_ID)]) // 1 row, exhausted
        : page([member(NO_GRANT_MEMBER_ID)]),
    );
    (txRepos.volunteering as any).listSignupsByAskCursor = read;

    const result = await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
      limit: 5,
    });

    expect(read).toHaveBeenCalledTimes(2);
    // Second group only gets the LEFTOVER budget (5 - 1 = 4).
    expect(read.mock.calls[1]![1]).toMatchObject({
      groupId: OTHER_GROUP_ID,
      cursor: null,
      limit: 4,
    });
    expect(result.groups.map((g) => g.id)).toEqual([
      OWN_GROUP_ID,
      OTHER_GROUP_ID,
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("points nextCursor at the NEXT group's top when the page fills exactly at a group boundary", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listGroupsByAsk = vi.fn(async () => [
      ownGroup,
      { ...otherGroup, coordinatorHumanId: COORDINATOR_ID },
    ]);
    const read = vi.fn(async () => page([member(GRANTED_MEMBER_ID)]));
    (txRepos.volunteering as any).listSignupsByAskCursor = read;

    const result = await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
      limit: 1, // filled by the first group's single row
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(result.nextCursor).toBe(OTHER_GROUP_ID);
  });

  it("a stale cursor naming a group the actor no longer coordinates restarts from page 1", async () => {
    const { deps, txRepos } = makeDeps();
    const read = vi.fn(async () => page([ownMember]));
    (txRepos.volunteering as any).listSignupsByAskCursor = read;

    const result = await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
      cursor: `${OTHER_GROUP_ID}|whatever`, // not the actor's group
      limit: 10,
    });

    // Restarted at the actor's own first group, from the top.
    expect(read).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({ groupId: OWN_GROUP_ID, cursor: null }),
    );
    expect(result.groups[0].id).toBe(OWN_GROUP_ID);
  });

  it("rejects a limit above the 200 max (invalid_input)", async () => {
    const { deps } = makeDeps();

    await expect(
      listCoordinatorRoster(deps, {
        actorHumanId: COORDINATOR_ID,
        askId: ASK_ID,
        limit: 201,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("FR-006: attaches the per-signup rewardStatus (GRANTED/REDEEMED/REVOKED), absent when no grant", async () => {
    const { deps, txRepos } = makeDeps();
    const members = [
      member(GRANTED_MEMBER_ID),
      member(REDEEMED_MEMBER_ID),
      member(REVOKED_MEMBER_ID),
      member(NO_GRANT_MEMBER_ID),
    ];
    (txRepos.volunteering as any).listSignupsByAskCursor = vi.fn(async () =>
      page(members),
    );
    // The primitive returns rows ONLY for signups that have a grant — the
    // NO_GRANT member is deliberately absent.
    (txRepos.volunteering as any).listRewardGrantStatusesBySignupIds = vi.fn(
      async () => [
        { signupId: GRANTED_MEMBER_ID, status: "GRANTED" },
        { signupId: REDEEMED_MEMBER_ID, status: "REDEEMED" },
        { signupId: REVOKED_MEMBER_ID, status: "REVOKED" },
      ],
    );

    const result = await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
    });

    const signups = result.groups[0].signups;
    const byId = new Map(signups.map((s) => [s.id, s]));
    expect(byId.get(GRANTED_MEMBER_ID)?.rewardStatus).toBe("GRANTED");
    expect(byId.get(REDEEMED_MEMBER_ID)?.rewardStatus).toBe("REDEEMED");
    expect(byId.get(REVOKED_MEMBER_ID)?.rewardStatus).toBe("REVOKED");
    // No grant → the field is absent entirely (badge stays silent).
    expect(byId.get(NO_GRANT_MEMBER_ID)?.rewardStatus).toBeUndefined();
    expect("rewardStatus" in (byId.get(NO_GRANT_MEMBER_ID) as object)).toBe(
      false,
    );
  });

  it("NFR-003: the reward-status read is batched over EXACTLY the scoped signup ids — no broad read", async () => {
    const { deps, txRepos } = makeDeps();
    const members = [member(GRANTED_MEMBER_ID), member(NO_GRANT_MEMBER_ID)];
    (txRepos.volunteering as any).listSignupsByAskCursor = vi.fn(async () =>
      page(members),
    );
    const statusRead = vi.fn(async () => [
      { signupId: GRANTED_MEMBER_ID, status: "GRANTED" },
    ]);
    (txRepos.volunteering as any).listRewardGrantStatusesBySignupIds =
      statusRead;

    await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
    });

    // ONE batched call, carrying exactly the ids already in the coordinator's
    // authorized result set — never a broader per-ask or per-org read.
    expect(statusRead).toHaveBeenCalledTimes(1);
    expect(statusRead.mock.calls[0][0]).toEqual([
      GRANTED_MEMBER_ID,
      NO_GRANT_MEMBER_ID,
    ]);
  });

  it("skips the reward-status read entirely when no signups are in scope", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listSignupsByAskCursor = vi.fn(async () =>
      page([]),
    );
    const statusRead = vi.fn(async () => []);
    (txRepos.volunteering as any).listRewardGrantStatusesBySignupIds =
      statusRead;

    const result = await listCoordinatorRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
    });

    expect(result.groups[0].signups).toEqual([]);
    expect(statusRead).not.toHaveBeenCalled();
  });
});
