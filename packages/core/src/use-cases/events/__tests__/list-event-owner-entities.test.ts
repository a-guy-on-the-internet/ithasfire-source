import { describe, expect, it } from "vitest";

import { listEventOwnerEntities } from "../list-event-owner-entities";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type { EntityPageRecord } from "@th/types/repos/entity-pages";
import { makeCreateEventTestContext } from "@th/test-utils/fakes/create-event-deps";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const buildEntityPage = (
  overrides: Partial<EntityPageRecord> &
    Pick<EntityPageRecord, "ownerType" | "ownerId">,
): EntityPageRecord => ({
  id: `page-${overrides.ownerId}`,
  slug: `slug-${overrides.ownerId}`,
  displayName: null,
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC",
  allowFollows: true,
  showFollowerCount: false,
  category: null,
  templateAppliedCategories: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const buildDeps = (options?: {
  humanExists?: boolean;
  memberships?: OrgMembership[];
  orgsById?: Record<string, OrganizationRecord | null>;
  humanPage?: EntityPageRecord | null;
  orgPages?: EntityPageRecord[];
}) => {
  const memberships = options?.memberships ?? [];
  const orgsById = options?.orgsById ?? {};
  const humanPage = options?.humanPage ?? null;
  const orgPages = options?.orgPages ?? [];

  const ctx = makeCreateEventTestContext({
    actorHumanId: ACTOR_ID,
    human: options?.humanExists === false ? null : { id: ACTOR_ID },
    identity: { email: "actor@example.com" },
    membership: null,
  });

  // Override behavior just for this use case.
  // `mocks.authz`'s exported type may lag behind the repo contract; cast locally.
  (
    ctx.mocks.authz as unknown as {
      listOrgMembershipsByHumanId: {
        mockImplementation: (fn: () => unknown) => void;
      };
    }
  ).listOrgMembershipsByHumanId.mockImplementation(async () => memberships);
  ctx.mocks.organizations.getById.mockImplementation(
    async (id: string) => orgsById[id] ?? null,
  );

  // entityPages.getByOwner resolves the human's profile slug + avatar; getByOwners
  // batch-resolves org logos/avatars.
  (ctx.deps.repos as { entityPages: Record<string, unknown> }).entityPages = {
    ...ctx.deps.repos.entityPages,
    getByOwner: async () => humanPage,
    getByOwners: async () => orgPages,
  };

  return { repos: ctx.deps.repos, logger: ctx.deps.logger };
};

describe("listEventOwnerEntities", () => {
  it("includes self as first owner", async () => {
    const { repos, logger } = buildDeps();

    const result = await listEventOwnerEntities(
      { repos, logger },
      { actorHumanId: ACTOR_ID },
    );

    expect(result.owners[0]).toEqual({
      kind: "human",
      humanId: ACTOR_ID,
      humanName: "actor@example.com",
      humanUsername: null,
      humanProfileSlug: null,
      avatarUrl: null,
    });
  });

  it("returns orgs for allowed roles", async () => {
    const orgId = "22222222-2222-4222-8222-222222222222";
    const { repos, logger } = buildDeps({
      memberships: [{ orgId, humanId: ACTOR_ID, role: "ADMIN" }],
      orgsById: {
        [orgId]: {
          id: orgId,
          name: "My Org",
          slug: "my-org",
          status: "ACTIVE",
          defaultLocale: null,
          trustTier: "NEW",
          trustBadgeLabel: null,
          trustBadgeIcon: null,
          createdAt: new Date(),
        },
      },
    });

    const result = await listEventOwnerEntities(
      { repos, logger },
      { actorHumanId: ACTOR_ID },
    );

    expect(result.owners).toEqual([
      {
        kind: "human",
        humanId: ACTOR_ID,
        humanName: "actor@example.com",
        humanUsername: null,
        humanProfileSlug: null,
        avatarUrl: null,
      },
      {
        kind: "org",
        orgId,
        orgName: "My Org",
        orgSlug: "my-org",
        role: "ADMIN",
        avatarUrl: null,
      },
    ]);
  });

  it("resolves avatar URLs from each entity's EntityPage", async () => {
    const orgId = "33333333-3333-4333-8333-333333333333";
    const { repos, logger } = buildDeps({
      memberships: [{ orgId, humanId: ACTOR_ID, role: "OWNER" }],
      orgsById: {
        [orgId]: {
          id: orgId,
          name: "Logo Org",
          slug: "logo-org",
          status: "ACTIVE",
          defaultLocale: null,
          trustTier: "NEW",
          trustBadgeLabel: null,
          trustBadgeIcon: null,
          createdAt: new Date(),
        },
      },
      humanPage: buildEntityPage({
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        slug: "me",
        avatarUrl: "https://cdn.example.com/human-avatar.jpg",
      }),
      orgPages: [
        buildEntityPage({
          ownerType: "ORGANIZATION",
          ownerId: orgId,
          slug: "logo-org",
          avatarUrl: "https://cdn.example.com/org-logo.png",
        }),
      ],
    });

    const result = await listEventOwnerEntities(
      { repos, logger },
      { actorHumanId: ACTOR_ID },
    );

    expect(result.owners).toEqual([
      {
        kind: "human",
        humanId: ACTOR_ID,
        humanName: "actor@example.com",
        humanUsername: null,
        humanProfileSlug: "me",
        avatarUrl: "https://cdn.example.com/human-avatar.jpg",
      },
      {
        kind: "org",
        orgId,
        orgName: "Logo Org",
        orgSlug: "logo-org",
        role: "OWNER",
        avatarUrl: "https://cdn.example.com/org-logo.png",
      },
    ]);
  });

  it("throws not_found when actor human missing", async () => {
    const { repos, logger } = buildDeps({ humanExists: false });

    await expect(
      listEventOwnerEntities({ repos, logger }, { actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });
});
