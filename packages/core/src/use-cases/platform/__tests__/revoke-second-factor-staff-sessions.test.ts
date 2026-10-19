import { describe, expect, it, vi } from "vitest";

import { SECOND_FACTOR_STAFF_ROLES } from "@th/ports/authz";

import {
  revokeSecondFactorStaffSessions,
  type RevokeSecondFactorStaffSessionsDeps,
} from "../revoke-second-factor-staff-sessions";
import { NOW, makeClock } from "./_fixtures";

const HOLDERS = [
  { humanId: "h-admin", authUserId: "a-admin", sessionCount: 2 },
  { humanId: "h-support", authUserId: "a-support", sessionCount: 0 },
  { humanId: "h-mod", authUserId: "a-mod", sessionCount: 3 },
];

function buildDeps(holders = HOLDERS) {
  const outsideList = vi.fn(async () => holders);
  const txList = vi.fn(async () => holders);
  const invalidateSessionsForAuthUsers = vi.fn(async (ids: string[]) => ({
    count: holders.find((h) => h.authUserId === ids[0])?.sessionCount ?? 0,
  }));
  const audit = { log: vi.fn(async () => {}) };
  const txRepos = {
    authz: { listSecondFactorStaffAuthUsers: txList },
    humans: { invalidateSessionsForAuthUsers },
    audit,
  };
  const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(txRepos));
  const deps = {
    repos: {
      authz: { listSecondFactorStaffAuthUsers: outsideList },
      tx,
    },
    clock: makeClock(),
  } as unknown as RevokeSecondFactorStaffSessionsDeps;
  return {
    deps,
    mocks: { outsideList, txList, invalidateSessionsForAuthUsers, audit, tx },
  };
}

describe("revokeSecondFactorStaffSessions", () => {
  it("dry run: counts holders and their sessions, writes nothing", async () => {
    const { deps, mocks } = buildDeps();

    const result = await revokeSecondFactorStaffSessions(deps, { dryRun: true });

    expect(result).toEqual({
      dryRun: true,
      humans: 3,
      sessionsFound: 5,
      sessionsRevoked: 0,
    });
    expect(mocks.outsideList).toHaveBeenCalledWith(SECOND_FACTOR_STAFF_ROLES);
    expect(mocks.tx).not.toHaveBeenCalled();
    expect(mocks.invalidateSessionsForAuthUsers).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("apply: selects every staff role (USER excluded) inside one transaction", async () => {
    const { deps, mocks } = buildDeps();

    await revokeSecondFactorStaffSessions(deps, { dryRun: false });

    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(mocks.outsideList).not.toHaveBeenCalled();
    const roles = mocks.txList.mock.calls[0]![0] as readonly string[];
    expect([...roles].sort()).toEqual(
      ["ADMIN", "COMMUNITY_MODERATOR", "DEVELOPER", "REVIEWER", "SUPPORT"].sort(),
    );
  });

  it("apply: signs each holder out and writes one audit row per human", async () => {
    const { deps, mocks } = buildDeps();

    const result = await revokeSecondFactorStaffSessions(deps, { dryRun: false });

    expect(result).toEqual({
      dryRun: false,
      humans: 3,
      sessionsFound: 5,
      sessionsRevoked: 5,
    });
    expect(mocks.invalidateSessionsForAuthUsers.mock.calls).toEqual([
      [["a-admin"]],
      [["a-support"]],
      [["a-mod"]],
    ]);
    expect(mocks.audit.log).toHaveBeenCalledTimes(3);
    expect(mocks.audit.log).toHaveBeenCalledWith({
      entity: "Human",
      entityId: "h-admin",
      action: "staff.sessions_revoked",
      data: {
        actorHumanId: null,
        source: "OPS_SCRIPT",
        reason: "second_factor_staff_sweep",
        authUserId: "a-admin",
        sessionsInvalidated: 2,
      },
      at: NOW,
    });
    // A holder with no session is still on record.
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "h-support",
        data: expect.objectContaining({ sessionsInvalidated: 0 }),
      }),
    );
  });

  it("apply with nobody to sign out: zero counts, no writes", async () => {
    const { deps, mocks } = buildDeps([]);

    const result = await revokeSecondFactorStaffSessions(deps, { dryRun: false });

    expect(result).toEqual({
      dryRun: false,
      humans: 0,
      sessionsFound: 0,
      sessionsRevoked: 0,
    });
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("a failed delete fails the whole run (the transaction rolls back)", async () => {
    const { deps, mocks } = buildDeps();
    mocks.invalidateSessionsForAuthUsers.mockRejectedValueOnce(
      new Error("db down"),
    );

    await expect(
      revokeSecondFactorStaffSessions(deps, { dryRun: false }),
    ).rejects.toThrow("db down");
  });

  it("rejects input without an explicit dryRun", async () => {
    const { deps } = buildDeps();
    await expect(revokeSecondFactorStaffSessions(deps, {})).rejects.toMatchObject(
      { code: "invalid_input" },
    );
    await expect(
      revokeSecondFactorStaffSessions(deps, { dryRun: false, extra: 1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
