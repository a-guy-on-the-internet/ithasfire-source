import { describe, expect, it, vi } from "vitest";

import { adminDeleteHuman } from "../admin-delete-human";
import type { AdminDeleteHumanDeps } from "../admin-delete-human";
import {
  ACTOR_ID,
  TARGET_ID,
  TARGET_EMAIL,
  makeHumanFixture,
  type HumanFixture,
} from "./_fixtures";
import {
  expectOuterHandleUnused,
  makeOuterHandle,
} from "../../orgs/__tests__/outer-handle";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    allowed?: boolean;
    target?: HumanFixture | null;
    hasDeletionBlockingHistory?: boolean;
    isSoleOwnerOfAnyOrg?: boolean;
    entityPage?: {
      id: string;
      ownerType: "HUMAN";
      ownerId: string;
      slug: string;
      displayName: string | null;
      bio: string | null;
      avatarUrl: string | null;
      bannerUrl: string | null;
      visibility: "PUBLIC";
      allowFollows: boolean;
      showFollowerCount: boolean;
      createdAt: Date;
      updatedAt: Date;
    } | null;
  } = {},
): AdminDeleteHumanDeps & {
  txRepos: AdminDeleteHumanDeps["repos"];
  outer: ReturnType<typeof makeOuterHandle>;
} {
  const allowed = overrides.allowed ?? true;
  const target =
    overrides.target !== undefined ? overrides.target : makeHumanFixture();

  const humans = {
    getByIdWithIdentity: vi.fn(async () => target),
    deleteHuman: vi.fn(),
    hasDeletionBlockingHistory: vi.fn(
      async () => overrides.hasDeletionBlockingHistory ?? false,
    ),
  };

  const audit = { log: vi.fn() };

  const supportThreads = {
    scrubHumanSupportContent: vi.fn(async () => ({
      messagesScrubbed: 2,
      authorLinksCleared: 1,
    })),
  };

  const organizations = {
    lockOwnerRostersForMember: vi.fn(async () => {}),
    isSoleOwnerOfAnyOrg: vi.fn(
      async () => overrides.isSoleOwnerOfAnyOrg ?? false,
    ),
  };

  const entityPages = {
    getByOwner: vi.fn(async () => overrides.entityPage ?? null),
    deleteByOwner: vi.fn(),
  };

  const pendingObjectDeletions = {
    enqueueMany: vi.fn(),
  };

  const resourceQuotas = {
    deleteUsage: vi.fn(),
  };

  const savedSnippets = {
    deleteByOwner: vi.fn(async () => ({ deleted: 0 })),
  };

  // The transaction's handle: `repos.tx` passes these mocks to its callback
  // and nothing else reaches them, apart from the reads named below.
  const txRepos = {
    humans,
    audit,
    supportThreads,
    organizations,
    entityPages,
    pendingObjectDeletions,
    resourceQuotas,
    savedSnippets,
  };

  // What the use case reads before its transaction. Every other method on
  // the outer handle throws.
  const outer = makeOuterHandle(txRepos, {
    humans: { getByIdWithIdentity: humans.getByIdWithIdentity },
  });

  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn(txRepos),
  );

  return {
    repos: { ...outer, tx } as unknown as AdminDeleteHumanDeps["repos"],
    // Not deps: the two handles, for assertions.
    txRepos: txRepos as unknown as AdminDeleteHumanDeps["repos"],
    outer,
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as AdminDeleteHumanDeps["authz"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("adminDeleteHuman", () => {
  it("deletes a human with correct confirmation phrase", async () => {
    const deps = buildDeps();
    const result = await adminDeleteHuman(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      confirmationPhrase: TARGET_EMAIL,
    });

    expect(result.deleted).toBe(true);
    expect(result.humanId).toBe(TARGET_ID);

    // Audit log should be created BEFORE deletion
    expect(deps.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "Human",
        entityId: TARGET_ID,
        action: "admin.deleteHuman",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          deletedEmail: TARGET_EMAIL,
          deletedName: "Jane Doe",
        }),
      }),
    );

    expect(deps.txRepos.humans.deleteHuman).toHaveBeenCalledWith(TARGET_ID);
  });

  it("accepts confirmation phrase with different casing", async () => {
    const deps = buildDeps();
    const result = await adminDeleteHuman(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      confirmationPhrase: TARGET_EMAIL.toUpperCase(),
    });

    expect(result.deleted).toBe(true);
    expect(deps.txRepos.humans.deleteHuman).toHaveBeenCalledWith(TARGET_ID);
  });

  it("deletes a human who has an active support thread (GDPR erasure) — scrubs USER message bodies and runs in the deletion tx", async () => {
    const deps = buildDeps();
    const result = await adminDeleteHuman(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      confirmationPhrase: TARGET_EMAIL,
    });

    // The delete resolves even though the human has support history — the FK is
    // ON DELETE SET NULL, so there's nothing left to throw a Restrict error.
    expect(result.deleted).toBe(true);

    const scrub = deps.txRepos.supportThreads.scrubHumanSupportContent as ReturnType<
      typeof vi.fn
    >;
    const deleteHuman = deps.txRepos.humans.deleteHuman as ReturnType<typeof vi.fn>;

    // Free-text scrub fired with the target id + a tombstone.
    expect(scrub).toHaveBeenCalledWith({
      humanId: TARGET_ID,
      tombstone: "[deleted]",
    });

    // And the human row delete used the target id.
    expect(deleteHuman).toHaveBeenCalledWith(TARGET_ID);

    // Order matters: scrub the messages BEFORE deleting the human (so the
    // authorHumanId lookup still resolves the user's rows).
    expect(scrub.mock.invocationCallOrder[0]).toBeLessThan(
      deleteHuman.mock.invocationCallOrder[0]!,
    );
  });

  it("tears down the target's entity page and enqueues R2 cleanup (staff flow shares the self-serve teardown)", async () => {
    const deps = buildDeps({
      entityPage: {
        id: "88888888-8888-4888-8888-888888888888",
        ownerType: "HUMAN",
        ownerId: TARGET_ID,
        slug: "jane-doe",
        displayName: "Jane Doe",
        bio: null,
        avatarUrl: `https://media.example.com/avatars/human/${TARGET_ID}/2026-07-06/cccc.jpg`,
        bannerUrl: null,
        visibility: "PUBLIC",
        allowFollows: true,
        showFollowerCount: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const result = await adminDeleteHuman(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      confirmationPhrase: TARGET_EMAIL,
    });

    expect(result.deleted).toBe(true);
    expect(deps.txRepos.entityPages.deleteByOwner).toHaveBeenCalledWith(
      "HUMAN",
      TARGET_ID,
    );
    expect(deps.txRepos.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith([
      {
        targetKey: `avatars/human/${TARGET_ID}/2026-07-06/cccc.jpg`,
        targetKind: "KEY",
        source: "human_delete",
        sourceId: TARGET_ID,
      },
    ]);
    expect(deps.txRepos.resourceQuotas.deleteUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: TARGET_ID,
      kind: "STORAGE_BYTES_HUMAN",
    });
    // Saved reasons go with the human (staff flow shares the erasure).
    expect(deps.txRepos.savedSnippets.deleteByOwner).toHaveBeenCalledWith({
      ownerType: "HUMAN",
      ownerId: TARGET_ID,
    });
  });

  it("throws forbidden when actor lacks ADMIN role", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      adminDeleteHuman(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        confirmationPhrase: TARGET_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws forbidden when actor tries to delete own account", async () => {
    const deps = buildDeps();

    await expect(
      adminDeleteHuman(deps, {
        actorHumanId: ACTOR_ID,
        humanId: ACTOR_ID,
        confirmationPhrase: TARGET_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "CANNOT_DELETE_OWN_ACCOUNT" });
  });

  it("throws not_found when target human does not exist", async () => {
    const deps = buildDeps({ target: null });

    await expect(
      adminDeleteHuman(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        confirmationPhrase: TARGET_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });

  it("throws invalid_input when confirmation phrase does not match email", async () => {
    const deps = buildDeps();

    await expect(
      adminDeleteHuman(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        confirmationPhrase: "wrong@example.com",
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_PHRASE_MISMATCH" });

    // Should NOT have called deleteHuman
    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
  });

  it("rejects empty confirmation phrase", async () => {
    const deps = buildDeps();

    await expect(
      adminDeleteHuman(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        confirmationPhrase: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws conflict when the target has deletion-blocking order/ticket/resale history", async () => {
    const deps = buildDeps({ hasDeletionBlockingHistory: true });

    await expect(
      adminDeleteHuman(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        confirmationPhrase: TARGET_EMAIL,
      }),
    ).rejects.toMatchObject({
      code: "CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY",
    });

    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
    expect(deps.txRepos.savedSnippets.deleteByOwner).not.toHaveBeenCalled();
  });

  it("throws conflict when the target is the sole owner of an organization", async () => {
    const deps = buildDeps({ isSoleOwnerOfAnyOrg: true });

    await expect(
      adminDeleteHuman(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        confirmationPhrase: TARGET_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "CANNOT_DELETE_SOLE_ORG_OWNER" });

    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
  });

  it("locks the owner roster of every org the human belongs to, on the transaction's handle, before the sole-owner check", async () => {
    const deps = buildDeps();
    const organizations = deps.txRepos.organizations as unknown as {
      lockOwnerRostersForMember: ReturnType<typeof vi.fn>;
      isSoleOwnerOfAnyOrg: ReturnType<typeof vi.fn>;
    };

    await adminDeleteHuman(deps, {
      actorHumanId: ACTOR_ID,
      humanId: TARGET_ID,
      confirmationPhrase: TARGET_EMAIL,
    });

    expect(organizations.lockOwnerRostersForMember).toHaveBeenCalledTimes(1);
    expect(organizations.lockOwnerRostersForMember).toHaveBeenCalledWith(
      TARGET_ID,
    );
    // The outer handle took no lock and ran no check, write or delete.
    expectOuterHandleUnused(deps.outer);
    expect(
      organizations.lockOwnerRostersForMember.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      organizations.isSoleOwnerOfAnyOrg.mock.invocationCallOrder[0]!,
    );
  });

  it("takes the roster locks before it refuses a sole owner, and deletes nothing", async () => {
    const deps = buildDeps({ isSoleOwnerOfAnyOrg: true });
    const organizations = deps.txRepos.organizations as unknown as {
      lockOwnerRostersForMember: ReturnType<typeof vi.fn>;
    };

    await expect(adminDeleteHuman(deps, {
        actorHumanId: ACTOR_ID,
        humanId: TARGET_ID,
        confirmationPhrase: TARGET_EMAIL,
      })).rejects.toMatchObject({
      code: "CANNOT_DELETE_SOLE_ORG_OWNER",
    });

    expect(organizations.lockOwnerRostersForMember).toHaveBeenCalledWith(
      TARGET_ID,
    );
    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
    expectOuterHandleUnused(deps.outer);
  });
});
