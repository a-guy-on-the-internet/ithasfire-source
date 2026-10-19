import { describe, expect, it, vi } from "vitest";

import { createFakeSavedSnippets } from "@th/test-utils/fakes/saved-snippets";

import { deleteMyAccount } from "../delete-my-account";
import type { DeleteMyAccountDeps } from "../delete-my-account";
import {
  expectOuterHandleUnused,
  makeOuterHandle,
} from "../../orgs/__tests__/outer-handle";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_EMAIL = "self@example.com";

function makeHumanFixture(overrides: { emailVerified?: boolean } = {}) {
  return {
    human: {
      id: ACTOR_ID,
      name: "Self Deleter",
      status: "ACTIVE" as const,
      roles: ["USER"],
      locale: null,
      phone: null,
      billingAddressLine1: null,
      billingAddressLine2: null,
      billingCity: null,
      billingState: null,
      billingPostalCode: null,
      billingCountry: null,
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
      trustTier: "NEW" as const,
      trustBadgeLabel: null,
      trustBadgeIcon: null,
      createdAt: new Date(),
    },
    identity: {
      authUserId: "aa-bb-cc",
      email: ACTOR_EMAIL,
      emailVerified: overrides.emailVerified ?? true,
      phone: null,
      phoneVerified: false,
      username: null,
      displayUsername: null,
      image: null,
    },
  };
}

type HumanFixture = ReturnType<typeof makeHumanFixture>;

function makeEntityPageFixture(
  overrides: { avatarUrl?: string | null; bannerUrl?: string | null } = {},
) {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    ownerType: "HUMAN" as const,
    ownerId: ACTOR_ID,
    slug: "self-deleter",
    displayName: "Self Deleter",
    bio: null,
    avatarUrl:
      overrides.avatarUrl !== undefined
        ? overrides.avatarUrl
        : `https://media.example.com/avatars/human/${ACTOR_ID}/2026-07-06/aaaa.jpg`,
    bannerUrl: overrides.bannerUrl !== undefined ? overrides.bannerUrl : null,
    visibility: "PUBLIC" as const,
    allowFollows: true,
    showFollowerCount: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

type EntityPageFixture = ReturnType<typeof makeEntityPageFixture>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    target?: HumanFixture | null;
    hasDeletionBlockingHistory?: boolean;
    isSoleOwnerOfAnyOrg?: boolean;
    hasPasswordCredential?: boolean;
    verifyPassword?: boolean;
    entityPage?: EntityPageFixture | null;
    savedSnippets?: ReturnType<typeof createFakeSavedSnippets>;
  } = {},
): DeleteMyAccountDeps & {
  txRepos: DeleteMyAccountDeps["repos"];
  outer: ReturnType<typeof makeOuterHandle>;
} {
  const target =
    overrides.target !== undefined ? overrides.target : makeHumanFixture();
  const entityPage =
    overrides.entityPage !== undefined ? overrides.entityPage : null;

  const humans = {
    getByIdWithIdentity: vi.fn(async () => target),
    deleteHuman: vi.fn(),
    hasDeletionBlockingHistory: vi.fn(
      async () => overrides.hasDeletionBlockingHistory ?? false,
    ),
    hasPasswordCredential: vi.fn(
      async () => overrides.hasPasswordCredential ?? false,
    ),
    verifyPassword: vi.fn(async () => overrides.verifyPassword ?? true),
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
    getByOwner: vi.fn(async () => entityPage),
    deleteByOwner: vi.fn(),
  };

  const pendingObjectDeletions = {
    enqueueMany: vi.fn(),
  };

  const resourceQuotas = {
    deleteUsage: vi.fn(),
  };

  // The real fake (not a stub), spied: the erasure test seeds rows and checks
  // they are gone.
  const savedSnippets = overrides.savedSnippets ?? createFakeSavedSnippets();
  vi.spyOn(savedSnippets, "deleteByOwner");

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
  const outer = makeOuterHandle(
    { ...txRepos, savedSnippets: { deleteByOwner: savedSnippets.deleteByOwner } },
    {
      humans: {
        getByIdWithIdentity: humans.getByIdWithIdentity,
        hasPasswordCredential: humans.hasPasswordCredential,
        verifyPassword: humans.verifyPassword,
      },
    },
  );

  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn(txRepos),
  );

  return {
    repos: { ...outer, tx } as unknown as DeleteMyAccountDeps["repos"],
    // Not deps: the two handles, for assertions.
    txRepos: txRepos as unknown as DeleteMyAccountDeps["repos"],
    outer,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("deleteMyAccount", () => {
  it("deletes the caller's own account with correct confirmation phrase", async () => {
    const deps = buildDeps();
    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(result.deleted).toBe(true);

    expect(deps.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "Human",
        entityId: ACTOR_ID,
        action: "self.deleteAccount",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          actorKind: "self",
          deletedEmail: ACTOR_EMAIL,
          deletedName: "Self Deleter",
        }),
      }),
    );

    expect(deps.txRepos.humans.deleteHuman).toHaveBeenCalledWith(ACTOR_ID);
  });

  it("accepts confirmation phrase with different casing", async () => {
    const deps = buildDeps();
    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL.toUpperCase(),
    });

    expect(result.deleted).toBe(true);
    expect(deps.txRepos.humans.deleteHuman).toHaveBeenCalledWith(ACTOR_ID);
  });

  it("scrubs support content BEFORE deleting the human (GDPR erasure ordering)", async () => {
    const deps = buildDeps();
    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(result.deleted).toBe(true);

    const scrub = deps.txRepos.supportThreads
      .scrubHumanSupportContent as ReturnType<typeof vi.fn>;
    const deleteHuman = deps.txRepos.humans.deleteHuman as ReturnType<
      typeof vi.fn
    >;

    expect(scrub).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      tombstone: "[deleted]",
    });
    expect(deleteHuman).toHaveBeenCalledWith(ACTOR_ID);

    expect(scrub.mock.invocationCallOrder[0]).toBeLessThan(
      deleteHuman.mock.invocationCallOrder[0]!,
    );
  });

  it("deletes the entity page and enqueues R2 cleanup for the current avatar + banner objects BEFORE the human delete", async () => {
    const deps = buildDeps({
      entityPage: makeEntityPageFixture({
        avatarUrl: `https://media.example.com/avatars/human/${ACTOR_ID}/2026-07-06/aaaa.jpg`,
        bannerUrl: `https://media.example.com/banners/human/${ACTOR_ID}/2026-07-06/bbbb.jpg`,
      }),
    });

    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(result.deleted).toBe(true);

    // Keys derived from the public URLs (pathname == key).
    expect(deps.txRepos.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith([
      {
        targetKey: `avatars/human/${ACTOR_ID}/2026-07-06/aaaa.jpg`,
        targetKind: "KEY",
        source: "human_delete",
        sourceId: ACTOR_ID,
      },
      {
        targetKey: `banners/human/${ACTOR_ID}/2026-07-06/bbbb.jpg`,
        targetKind: "KEY",
        source: "human_delete",
        sourceId: ACTOR_ID,
      },
    ]);

    expect(deps.txRepos.entityPages.deleteByOwner).toHaveBeenCalledWith(
      "HUMAN",
      ACTOR_ID,
    );

    // The page must be read + torn down BEFORE the human delete (the URLs are
    // only derivable while the row exists; ordering documents the invariant).
    const deletePage = deps.txRepos.entityPages.deleteByOwner as ReturnType<
      typeof vi.fn
    >;
    const enqueue = deps.txRepos.pendingObjectDeletions
      .enqueueMany as ReturnType<typeof vi.fn>;
    const deleteHuman = deps.txRepos.humans.deleteHuman as ReturnType<
      typeof vi.fn
    >;
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      deleteHuman.mock.invocationCallOrder[0]!,
    );
    expect(deletePage.mock.invocationCallOrder[0]).toBeLessThan(
      deleteHuman.mock.invocationCallOrder[0]!,
    );
  });

  it("skips page teardown when the human has no entity page but still drops the storage quota row", async () => {
    const deps = buildDeps({ entityPage: null });

    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(result.deleted).toBe(true);
    expect(deps.txRepos.entityPages.deleteByOwner).not.toHaveBeenCalled();
    expect(
      deps.txRepos.pendingObjectDeletions.enqueueMany,
    ).not.toHaveBeenCalled();
    expect(deps.txRepos.resourceQuotas.deleteUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: ACTOR_ID,
      kind: "STORAGE_BYTES_HUMAN",
    });
    expect(deps.txRepos.humans.deleteHuman).toHaveBeenCalledWith(ACTOR_ID);
  });

  it("erases the human's saved reasons and their list rows in the deletion tx, and nobody else's", async () => {
    const savedSnippets = createFakeSavedSnippets();
    const mine = { ownerType: "HUMAN", ownerId: ACTOR_ID } as const;
    // An org whose id string happens to equal the human's: a different owner.
    const orgSameId = { ownerType: "ORGANIZATION", ownerId: ACTOR_ID } as const;
    for (const owner of [mine, orgSameId]) {
      await savedSnippets.create({
        ...owner,
        kind: "DECLINE_REASON",
        label: "Booked that week",
        body: "We're already booked that week.",
      });
      await savedSnippets.lockList({ ...owner, kind: "DECLINE_REASON" });
      await savedSnippets.markStartersCopied(
        { ...owner, kind: "DECLINE_REASON" },
        new Date("2026-10-01T00:00:00.000Z"),
      );
    }
    const deps = buildDeps({ savedSnippets });

    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(result.deleted).toBe(true);
    expect(deps.txRepos.savedSnippets.deleteByOwner).toHaveBeenCalledWith(mine);
    expect(await savedSnippets.listByOwner(mine)).toEqual([]);
    expect([...savedSnippets.lists.values()].map((l) => l.ownerType)).toEqual([
      "ORGANIZATION",
    ]);
    expect(await savedSnippets.listByOwner(orgSameId)).toHaveLength(1);

    // Inside the tx, before the Human row goes.
    const eraseSnippets = deps.txRepos.savedSnippets.deleteByOwner as ReturnType<
      typeof vi.fn
    >;
    const deleteHuman = deps.txRepos.humans.deleteHuman as ReturnType<
      typeof vi.fn
    >;
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    expect(eraseSnippets.mock.invocationCallOrder[0]).toBeLessThan(
      deleteHuman.mock.invocationCallOrder[0]!,
    );
  });

  it("enqueues no object deletions when the page has no avatar or banner", async () => {
    const deps = buildDeps({
      entityPage: makeEntityPageFixture({ avatarUrl: null, bannerUrl: null }),
    });

    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(result.deleted).toBe(true);
    // enqueueMany([]) is a documented no-op on the port; the page itself is
    // still deleted.
    expect(deps.txRepos.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith(
      [],
    );
    expect(deps.txRepos.entityPages.deleteByOwner).toHaveBeenCalledWith(
      "HUMAN",
      ACTOR_ID,
    );
    expect(deps.txRepos.resourceQuotas.deleteUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: ACTOR_ID,
      kind: "STORAGE_BYTES_HUMAN",
    });
  });

  it("never enqueues R2 deletions for keys outside the human's own media namespaces (client-writable URLs)", async () => {
    const VICTIM_ID = "99999999-9999-4999-8999-999999999999";
    // updatePage stores arbitrary absolute URLs; an attacker can point their
    // own page's avatar/banner at ANOTHER entity's public object. Deletion
    // must drop those keys instead of enqueueing the victim's object.
    const deps = buildDeps({
      entityPage: makeEntityPageFixture({
        avatarUrl: `https://media.example.com/avatars/human/${VICTIM_ID}/2026-07-06/victim.jpg`,
        bannerUrl: `https://media.example.com/events/some-event/hero.jpg`,
      }),
    });

    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(result.deleted).toBe(true);
    // Both keys are off-prefix → nothing enqueued (empty batch is a no-op).
    expect(deps.txRepos.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith(
      [],
    );
    // The page itself is still torn down.
    expect(deps.txRepos.entityPages.deleteByOwner).toHaveBeenCalledWith(
      "HUMAN",
      ACTOR_ID,
    );
  });

  it("accepts entity-page image keys under the human's own entity-pages namespace", async () => {
    const deps = buildDeps({
      entityPage: makeEntityPageFixture({
        avatarUrl: `https://media.example.com/entity-pages/human/${ACTOR_ID}/2026-07-06/dddd.png`,
        bannerUrl: null,
      }),
    });

    const result = await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(result.deleted).toBe(true);
    expect(deps.txRepos.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith([
      {
        targetKey: `entity-pages/human/${ACTOR_ID}/2026-07-06/dddd.png`,
        targetKind: "KEY",
        source: "human_delete",
        sourceId: ACTOR_ID,
      },
    ]);
  });

  it("does not touch the entity page, outbox, or quota rows when blocked by financial history", async () => {
    const deps = buildDeps({
      hasDeletionBlockingHistory: true,
      entityPage: makeEntityPageFixture(),
    });

    await expect(
      deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: ACTOR_EMAIL,
      }),
    ).rejects.toMatchObject({
      code: "CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY",
    });

    expect(deps.txRepos.entityPages.deleteByOwner).not.toHaveBeenCalled();
    expect(
      deps.txRepos.pendingObjectDeletions.enqueueMany,
    ).not.toHaveBeenCalled();
    expect(deps.txRepos.resourceQuotas.deleteUsage).not.toHaveBeenCalled();
    expect(deps.txRepos.savedSnippets.deleteByOwner).not.toHaveBeenCalled();
    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
  });

  it("throws not_found when the target human does not exist", async () => {
    const deps = buildDeps({ target: null });

    await expect(
      deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: ACTOR_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });

  it("throws invalid_input when confirmation phrase does not match email", async () => {
    const deps = buildDeps();

    await expect(
      deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: "wrong@example.com",
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_PHRASE_MISMATCH" });

    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
  });

  it("rejects empty confirmation phrase", async () => {
    const deps = buildDeps();

    await expect(
      deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws conflict when the caller has deletion-blocking order/ticket/resale history", async () => {
    const deps = buildDeps({ hasDeletionBlockingHistory: true });

    await expect(
      deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: ACTOR_EMAIL,
      }),
    ).rejects.toMatchObject({
      code: "CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY",
    });

    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
  });

  it("throws conflict when the caller is the sole owner of an organization", async () => {
    const deps = buildDeps({ isSoleOwnerOfAnyOrg: true });

    await expect(
      deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: ACTOR_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "CANNOT_DELETE_SOLE_ORG_OWNER" });

    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
  });

  describe("password step-up re-authentication", () => {
    it("deletes the account when the caller has a password credential and supplies the correct currentPassword", async () => {
      const deps = buildDeps({
        hasPasswordCredential: true,
        verifyPassword: true,
      });

      const result = await deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: ACTOR_EMAIL,
        currentPassword: "correct-horse-battery-staple",
      });

      expect(result.deleted).toBe(true);
      expect(deps.repos.humans.verifyPassword).toHaveBeenCalledWith(
        ACTOR_ID,
        "correct-horse-battery-staple",
      );
      expect(deps.txRepos.humans.deleteHuman).toHaveBeenCalledWith(ACTOR_ID);
    });

    it("throws CURRENT_PASSWORD_INVALID when the caller has a password credential and supplies the wrong currentPassword", async () => {
      const deps = buildDeps({
        hasPasswordCredential: true,
        verifyPassword: false,
      });

      await expect(
        deleteMyAccount(deps, {
          actorHumanId: ACTOR_ID,
          confirmationPhrase: ACTOR_EMAIL,
          currentPassword: "wrong-password",
        }),
      ).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });

      expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
    });

    it("throws CURRENT_PASSWORD_REQUIRED when the caller has a password credential and omits currentPassword", async () => {
      const deps = buildDeps({ hasPasswordCredential: true });

      await expect(
        deleteMyAccount(deps, {
          actorHumanId: ACTOR_ID,
          confirmationPhrase: ACTOR_EMAIL,
        }),
      ).rejects.toMatchObject({ code: "CURRENT_PASSWORD_REQUIRED" });

      expect(deps.repos.humans.verifyPassword).not.toHaveBeenCalled();
      expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
    });

    it("deletes the account without currentPassword when the caller has no password credential (OAuth/passkey-only)", async () => {
      const deps = buildDeps({ hasPasswordCredential: false });

      const result = await deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: ACTOR_EMAIL,
      });

      expect(result.deleted).toBe(true);
      expect(deps.repos.humans.verifyPassword).not.toHaveBeenCalled();
      expect(deps.txRepos.humans.deleteHuman).toHaveBeenCalledWith(ACTOR_ID);
    });
  });

  it("locks the owner roster of every org the human belongs to, on the transaction's handle, before the sole-owner check", async () => {
    const deps = buildDeps();
    const organizations = deps.txRepos.organizations as unknown as {
      lockOwnerRostersForMember: ReturnType<typeof vi.fn>;
      isSoleOwnerOfAnyOrg: ReturnType<typeof vi.fn>;
    };

    await deleteMyAccount(deps, {
      actorHumanId: ACTOR_ID,
      confirmationPhrase: ACTOR_EMAIL,
    });

    expect(organizations.lockOwnerRostersForMember).toHaveBeenCalledTimes(1);
    expect(organizations.lockOwnerRostersForMember).toHaveBeenCalledWith(
      ACTOR_ID,
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

    await expect(deleteMyAccount(deps, {
        actorHumanId: ACTOR_ID,
        confirmationPhrase: ACTOR_EMAIL,
      })).rejects.toMatchObject({
      code: "CANNOT_DELETE_SOLE_ORG_OWNER",
    });

    expect(organizations.lockOwnerRostersForMember).toHaveBeenCalledWith(
      ACTOR_ID,
    );
    expect(deps.txRepos.humans.deleteHuman).not.toHaveBeenCalled();
    expectOuterHandleUnused(deps.outer);
  });
});
