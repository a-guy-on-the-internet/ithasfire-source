import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { ListOrgMembersResult } from "@th/ports/repos/organizations";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { listOrgMembers, type ListOrgMembersDeps } from "../list-org-members";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const MEMBERS_RESULT: ListOrgMembersResult = {
  items: [
    {
      humanId: "11111111-1111-4111-8111-111111111111",
      name: "Alice",
      email: "alice@example.com",
      role: "OWNER",
      joinedAt: new Date("2025-01-01T00:00:00Z"),
    },
    {
      humanId: "22222222-2222-4222-8222-222222222222",
      name: "Bob",
      email: "bob@example.com",
      role: "EDITOR",
      joinedAt: new Date("2025-02-01T00:00:00Z"),
    },
  ],
  total: 2,
};

function createDeps(overrides?: { authzError?: unknown }) {
  const listMembers = vi.fn(async () => MEMBERS_RESULT);

  const repos = {
    organizations: { listMembers },
  } as unknown as Repos;

  const authz: AuthZPort = {
    hasOrgRole: vi.fn(),
    requireOrgRole: overrides?.authzError
      ? vi.fn(async () => {
          throw overrides.authzError;
        })
      : vi.fn(async () => {}),
    canEditEvent: vi.fn(),
    canManagePlace: vi.fn(),
    canFinanceOrg: vi.fn(),
    hasStaffRole: vi.fn(async () => ({ allowed: false })),
  };

  const logger = createTestLogger();
  const deps: ListOrgMembersDeps = { repos, authz, logger };

  return { deps, listMembers, authz };
}

describe("listOrgMembers", () => {
  it("returns paginated member list for authorized actor", async () => {
    const { deps, listMembers } = createDeps();

    const result = await listOrgMembers(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.items[0]!.name).toBe("Alice");
    expect(listMembers).toHaveBeenCalledWith({
      orgId: ORG_ID,
      limit: 50,
      offset: 0,
    });
  });

  it("passes through default limit/offset", async () => {
    const { deps, listMembers } = createDeps();

    await listOrgMembers(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(listMembers).toHaveBeenCalledWith({
      orgId: ORG_ID,
      limit: 50,
      offset: 0,
    });
  });

  it("throws when actor lacks org membership", async () => {
    const { deps } = createDeps({
      authzError: { code: "forbidden", message: "not_org_member" },
    });

    await expect(
      listOrgMembers(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("throws invalid_input on bad input", async () => {
    const { deps } = createDeps();

    await expect(
      listOrgMembers(deps, { actorHumanId: "not-uuid", orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
