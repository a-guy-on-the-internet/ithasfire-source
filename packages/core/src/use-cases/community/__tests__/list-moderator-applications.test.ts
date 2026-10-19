import { describe, expect, it, vi } from "vitest";

import {
  listModeratorApplications,
  type ListModeratorApplicationsDeps,
} from "../list-moderator-applications";
import type { CommunityModeratorApplicationRecord } from "@th/ports/repos/community-moderator-applications";
import {
  ADMIN_ID,
  APPLICATION_ID,
  MODERATOR_ID,
  OWNER_ID,
  USER_ID,
  makeApplication,
  makeStaffAuthz,
} from "./helpers";

const SECOND_APPLICATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THIRD_APPLICATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function buildDeps(
  overrides: {
    applications?: CommunityModeratorApplicationRecord[];
    /** humanId → name; an id absent from the map is a deleted human. */
    humans?: Record<string, string | null>;
  } = {},
) {
  const applications = overrides.applications ?? [makeApplication()];
  const humans = overrides.humans ?? { [USER_ID]: "Rosa Diaz" };

  const listPending = vi.fn(async () => ({
    items: applications,
    nextCursor: "cursor-2",
  }));
  const getByIds = vi.fn(async (ids: string[]) =>
    ids
      .filter((id) => id in humans)
      .map((id) => ({ id, name: humans[id] ?? null })),
  );

  const deps: ListModeratorApplicationsDeps = {
    repos: {
      communityModeratorApplications: { listPending },
      humans: { getByIds },
    } as unknown as ListModeratorApplicationsDeps["repos"],
    authz: makeStaffAuthz({ [ADMIN_ID]: ["ADMIN"] }),
  };

  return { deps, listPending, getByIds };
}

describe("listModeratorApplications", () => {
  it("returns the PENDING page with each applicant's name", async () => {
    const { deps, listPending } = buildDeps();

    const result = await listModeratorApplications(deps, {
      actorHumanId: ADMIN_ID,
      limit: 25,
    });

    expect(listPending).toHaveBeenCalledWith({ cursor: null, limit: 25 });
    expect(result.nextCursor).toBe("cursor-2");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: APPLICATION_ID,
      applicantHumanId: USER_ID,
      applicantName: "Rosa Diaz",
      applicantMissing: false,
    });
  });

  it("resolves every applicant on the page in ONE batched read, deduped", async () => {
    const { deps, getByIds } = buildDeps({
      applications: [
        makeApplication({ id: APPLICATION_ID, applicantHumanId: USER_ID }),
        makeApplication({
          id: SECOND_APPLICATION_ID,
          applicantHumanId: OWNER_ID,
        }),
        makeApplication({
          id: THIRD_APPLICATION_ID,
          applicantHumanId: USER_ID,
        }),
      ],
      humans: { [USER_ID]: "Rosa Diaz", [OWNER_ID]: "Sam Ortiz" },
    });

    const result = await listModeratorApplications(deps, {
      actorHumanId: ADMIN_ID,
    });

    expect(getByIds).toHaveBeenCalledTimes(1);
    expect(getByIds).toHaveBeenCalledWith([USER_ID, OWNER_ID]);
    expect(result.items.map((item) => item.applicantName)).toEqual([
      "Rosa Diaz",
      "Sam Ortiz",
      "Rosa Diaz",
    ]);
  });

  it("flags a deleted applicant as missing, with no name", async () => {
    const { deps } = buildDeps({ humans: {} });

    const result = await listModeratorApplications(deps, {
      actorHumanId: ADMIN_ID,
    });

    expect(result.items[0]).toMatchObject({
      applicantName: null,
      applicantMissing: true,
    });
  });

  it("keeps an unnamed applicant as present (name null, not missing)", async () => {
    const { deps } = buildDeps({ humans: { [USER_ID]: "   " } });

    const result = await listModeratorApplications(deps, {
      actorHumanId: ADMIN_ID,
    });

    expect(result.items[0]).toMatchObject({
      applicantName: null,
      applicantMissing: false,
    });
  });

  it("skips the human read on an empty page", async () => {
    const { deps, getByIds } = buildDeps({ applications: [] });

    const result = await listModeratorApplications(deps, {
      actorHumanId: ADMIN_ID,
    });

    expect(result.items).toEqual([]);
    expect(getByIds).not.toHaveBeenCalled();
  });

  it("rejects non-ADMIN staff before reading anything", async () => {
    const { deps, listPending, getByIds } = buildDeps();
    deps.authz = makeStaffAuthz({ [MODERATOR_ID]: ["COMMUNITY_MODERATOR"] });

    await expect(
      listModeratorApplications(deps, { actorHumanId: MODERATOR_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(listPending).not.toHaveBeenCalled();
    expect(getByIds).not.toHaveBeenCalled();
  });

  it("rejects unknown input keys (strict boundary)", async () => {
    const { deps, listPending } = buildDeps();

    await expect(
      listModeratorApplications(deps, {
        actorHumanId: ADMIN_ID,
        status: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(listPending).not.toHaveBeenCalled();
  });
});
