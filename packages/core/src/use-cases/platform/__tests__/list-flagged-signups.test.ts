import { describe, expect, it, vi } from "vitest";

import { listFlaggedSignups } from "../list-flagged-signups";
import type { ListFlaggedSignupsDeps } from "../list-flagged-signups";
import { ACTOR_ID, NOW, TARGET_ID, makeStaffAuthz } from "./_fixtures";

const DAY = 24 * 60 * 60 * 1000;
const BANNED_ID = "33333333-3333-4333-8333-333333333333";

function makeDeps(roles: string[] = ["SUPPORT"]) {
  const listFlaggedSignups = vi.fn(async () => ({
    total: 1,
    items: [
      {
        humanId: TARGET_ID,
        authUserId: "auth-2",
        name: "New Account",
        email: "new@example.com",
        status: "ACTIVE" as const,
        signedUpAt: new Date(NOW.getTime() - DAY),
        country: "US",
        matches: [
          {
            bannedHumanId: BANNED_ID,
            bannedHumanName: "Banned Bob",
            bannedHumanStatus: "SUSPENDED" as const,
          },
        ],
      },
    ],
  }));
  const deps = {
    repos: { networkSightings: { listFlaggedSignups } },
    authz: makeStaffAuthz({ [ACTOR_ID]: roles }),
    clock: { now: () => NOW },
  } as unknown as ListFlaggedSignupsDeps;
  return { deps, listFlaggedSignups };
}

describe("listFlaggedSignups", () => {
  it("derives flags over the last 30 days against bans active NOW", async () => {
    const { deps, listFlaggedSignups: repoCall } = makeDeps();

    const result = await listFlaggedSignups(deps, {
      actorHumanId: ACTOR_ID,
      limit: 50,
      offset: 0,
    });

    expect(repoCall).toHaveBeenCalledWith({
      since: new Date(NOW.getTime() - 30 * DAY),
      now: NOW,
      limit: 50,
      offset: 0,
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        humanId: TARGET_ID,
        // The source's status rides along so the UI can say which.
        matches: [
          {
            bannedHumanId: BANNED_ID,
            bannedHumanName: "Banned Bob",
            bannedHumanStatus: "SUSPENDED",
          },
        ],
      }),
    ]);
    expect(result.pageInfo.total).toBe(1);
  });

  it("is staff-only", async () => {
    const { deps, listFlaggedSignups: repoCall } = makeDeps([]);
    await expect(
      listFlaggedSignups(deps, { actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repoCall).not.toHaveBeenCalled();
  });

  it("rejects unknown input keys", async () => {
    const { deps } = makeDeps();
    await expect(
      listFlaggedSignups(deps, { actorHumanId: ACTOR_ID, since: "1970" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
