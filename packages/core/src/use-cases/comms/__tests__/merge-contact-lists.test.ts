import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mergeContactLists,
  type MergeContactListsDeps,
} from "../merge-contact-lists";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { InviteListsRepo } from "@th/ports/repos/events";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { AuthZRepo } from "@th/ports/repos/authz";
import type { InviteListRecord } from "@th/types";
import {
  createFakeIdempotencyPort,
  type FakeIdempotencyPort,
} from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const NOW = new Date("2025-06-01T12:00:00.000Z");
const ACTOR_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_LIST_ID = "cccc3333-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE_LIST_A = "dddd4444-dddd-4ddd-8ddd-dddddddddddd";
const SOURCE_LIST_B = "eeee5555-eeee-4eee-8eee-eeeeeeeeeeee";
const ORG_ID = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_KEY = "merge-key-abc12345";

function makeList(overrides: Partial<InviteListRecord> = {}): InviteListRecord {
  return {
    id: TARGET_LIST_ID,
    ownerType: "HUMAN",
    ownerId: ACTOR_ID,
    name: "Target List",
    description: null,
    passwordHint: null,
    contactCount: 10,
    lastImportAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface TestContext {
  deps: MergeContactListsDeps;
  mocks: {
    inviteLists: InviteListsRepo;
    humans: HumansRepo;
    audit: AuditRepo;
    authz: AuthZRepo;
    idempotency: FakeIdempotencyPort;
  };
}

function makeTestContext(
  options: {
    emailVerified?: boolean;
    orgRole?: string | null;
  } = {},
): TestContext {
  const emailVerified = options.emailVerified ?? true;

  const lists = new Map<string, InviteListRecord>([
    [TARGET_LIST_ID, makeList({ id: TARGET_LIST_ID, name: "Target" })],
    [SOURCE_LIST_A, makeList({ id: SOURCE_LIST_A, name: "Source A" })],
    [SOURCE_LIST_B, makeList({ id: SOURCE_LIST_B, name: "Source B" })],
  ]);

  const inviteListsRepo: InviteListsRepo = {
    createList: vi.fn(async () => makeList()),
    updateList: vi.fn(async () => makeList()),
    deleteList: vi.fn(async () => undefined),
    listByOwner: vi.fn(async () => []),
    getListById: vi.fn(async (id: string) => lists.get(id) ?? null),
    createEntry: vi.fn(async () => ({}) as any),
    updateEntry: vi.fn(async () => ({}) as any),
    deleteEntry: vi.fn(async () => ({ deleted: true })),
    listEntries: vi.fn(async () => []),
    copyEntries: vi.fn(async () => 5),
    batchUpsertEntries: vi.fn(async () => ({
      insertedCount: 0,
      skippedCount: 0,
    })),
    deleteAllEntries: vi.fn(async () => 0),
    updateListCounts: vi.fn(async () => undefined),
    attachToEvent: vi.fn(async () => ({}) as any),
    detachFromEvent: vi.fn(async () => undefined),
    listEventLinks: vi.fn(async () => []),
  };

  const humansRepo: HumansRepo = {
    getById: vi.fn(async () => ({
      id: ACTOR_ID,
      name: "Actor",
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
    })),
    getByIdWithIdentity: vi.fn(async () => ({
      human: {
        id: ACTOR_ID,
        name: "Actor",
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
      },
      identity: {
        authUserId: ACTOR_ID,
        email: "actor@example.com",
        emailVerified,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    })),
    getByEmail: vi.fn(),
    getByPhone: vi.fn(),
    getHumanIdForAuthUserId: vi.fn(),
    linkAuthUserToHuman: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ensureByProvider: vi.fn(),
    listForSearchIndex: vi.fn(),
    batchLookupHumanIdsByEmail: vi.fn(async () => new Map<string, string>()),
    hasSecondFactorEnrolled: vi.fn(async () => false),
  };

  const auditRepo: AuditRepo = {
    log: vi.fn(async () => undefined),
  };

  const authzRepo: AuthZRepo = {
    getOrgMembership: vi.fn(async () =>
      options.orgRole !== undefined
        ? options.orgRole === null
          ? null
          : { role: options.orgRole, orgId: ORG_ID, humanId: ACTOR_ID }
        : null,
    ),
    getEventOrgId: vi.fn(async () => null),
    getPlaceAccessContext: vi.fn(async () => null),
    isPlaceVerifiedForOrg: vi.fn(async () => false),
  };

  const txRepos = {
    humans: humansRepo,
    inviteLists: inviteListsRepo,
    contactImports: {} as any,
    audit: auditRepo,
    authz: authzRepo,
    events: {} as any,
    images: {} as any,
    audioUploads: {} as any,
    eventUnlocks: {} as any,
    eventInvites: {} as any,
    featuredEvents: {} as any,
    eventApplications: {} as any,
    eventWaitlists: {} as any,
    categories: {} as any,
    orders: {} as any,
    orderItems: {} as any,
    orderItemSettlementLines: {} as any,
    tickets: {} as any,
    payoutTerms: {} as any,
    feePolicies: {} as any,
    splits: {} as any,
    payees: {} as any,
    settlements: {} as any,
    settlementLines: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    seats: {} as any,
    eventTemplates: {} as any,
    eventHumans: {} as any,
    series: {} as any,
    seriesOccurrences: {} as any,
    pushDevices: {} as any,
    notificationPrefs: {} as any,
    notificationDigests: {} as any,
    notifications: undefined as any,
    placeLayouts: {} as any,
    placeLayoutBlobs: {} as any,
    placeLayoutStatuses: {} as any,
    payouts: {} as any,
    analytics: {} as any,
  } as unknown as TxRepos;

  const repos: Repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const idempotency = createFakeIdempotencyPort();
  const logger = createTestLogger();

  const deps: MergeContactListsDeps = {
    repos,
    idempotency,
    clock: { now: () => NOW },
    logger,
  };

  return {
    deps,
    mocks: {
      inviteLists: inviteListsRepo,
      humans: humansRepo,
      audit: auditRepo,
      authz: authzRepo,
      idempotency,
    },
  };
}

function makeBaseInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR_ID,
    targetListId: TARGET_LIST_ID,
    sourceListIds: [SOURCE_LIST_A, SOURCE_LIST_B],
    deleteSourcesAfterMerge: false,
    clientKey: CLIENT_KEY,
    ...overrides,
  };
}

describe("mergeContactLists", () => {
  describe("happy path", () => {
    it("copies entries from all sources into target and updates counts", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput();

      const result = await mergeContactLists(ctx.deps, input);

      expect(result.targetListId).toBe(TARGET_LIST_ID);
      expect(result.mergedCount).toBe(10); // 5 per source
      expect(ctx.mocks.inviteLists.copyEntries).toHaveBeenCalledTimes(2);
      expect(ctx.mocks.inviteLists.copyEntries).toHaveBeenCalledWith({
        sourceInviteListId: SOURCE_LIST_A,
        targetInviteListId: TARGET_LIST_ID,
        performedByHumanId: ACTOR_ID,
      });
      expect(ctx.mocks.inviteLists.copyEntries).toHaveBeenCalledWith({
        sourceInviteListId: SOURCE_LIST_B,
        targetInviteListId: TARGET_LIST_ID,
        performedByHumanId: ACTOR_ID,
      });
      expect(ctx.mocks.inviteLists.updateListCounts).toHaveBeenCalledWith(
        TARGET_LIST_ID,
      );
      expect(result.deletedSourceIds).toBeUndefined();
    });

    it("deletes source lists when deleteSourcesAfterMerge is true", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({ deleteSourcesAfterMerge: true });

      const result = await mergeContactLists(ctx.deps, input);

      expect(ctx.mocks.inviteLists.deleteList).toHaveBeenCalledWith(
        SOURCE_LIST_A,
      );
      expect(ctx.mocks.inviteLists.deleteList).toHaveBeenCalledWith(
        SOURCE_LIST_B,
      );
      expect(result.deletedSourceIds).toEqual([SOURCE_LIST_A, SOURCE_LIST_B]);
    });

    it("does not delete sources when deleteSourcesAfterMerge is false", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({ deleteSourcesAfterMerge: false });

      await mergeContactLists(ctx.deps, input);

      expect(ctx.mocks.inviteLists.deleteList).not.toHaveBeenCalled();
    });
  });

  describe("audit logging", () => {
    it("logs the merge action with correct data", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput();

      await mergeContactLists(ctx.deps, input);

      expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "invite_list",
          entityId: TARGET_LIST_ID,
          action: "comms.contact_list.merged",
          data: expect.objectContaining({
            actorHumanId: ACTOR_ID,
            sourceListIds: [SOURCE_LIST_A, SOURCE_LIST_B],
            mergedCount: 10,
          }),
        }),
      );
    });
  });

  describe("idempotency", () => {
    it("replays prior result on duplicate request", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput();

      const first = await mergeContactLists(ctx.deps, input);
      const second = await mergeContactLists(ctx.deps, input);

      expect(first).toEqual(second);
      expect(ctx.mocks.inviteLists.copyEntries).toHaveBeenCalledTimes(2); // only from first call
    });

    it("throws conflict on key reuse with different payload", async () => {
      const ctx = makeTestContext();
      const input1 = makeBaseInput();

      await mergeContactLists(ctx.deps, input1);

      const input2 = makeBaseInput({
        sourceListIds: [SOURCE_LIST_A], // different set of sources
      });

      await expect(mergeContactLists(ctx.deps, input2)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    });
  });

  describe("authorization", () => {
    it("rejects when HUMAN owner does not match actor", async () => {
      const ctx = makeTestContext();
      const otherOwner = "ff000000-ff00-4f00-8f00-ff0000000000";

      // Return a target list owned by someone else
      vi.mocked(ctx.mocks.inviteLists.getListById).mockResolvedValue(
        makeList({ ownerId: otherOwner }),
      );

      const input = makeBaseInput();

      await expect(mergeContactLists(ctx.deps, input)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });

    it("rejects when ORG member has no role", async () => {
      const ctx = makeTestContext({ orgRole: null });

      // All lists owned by the org
      vi.mocked(ctx.mocks.inviteLists.getListById).mockImplementation(
        async (id: string) =>
          makeList({ id, ownerType: "ORGANIZATION", ownerId: ORG_ID }),
      );

      const input = makeBaseInput();

      await expect(mergeContactLists(ctx.deps, input)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });

    it("allows ORG member with EDITOR role", async () => {
      const ctx = makeTestContext({ orgRole: "EDITOR" });

      vi.mocked(ctx.mocks.inviteLists.getListById).mockImplementation(
        async (id: string) =>
          makeList({ id, ownerType: "ORGANIZATION", ownerId: ORG_ID }),
      );

      const input = makeBaseInput();
      const result = await mergeContactLists(ctx.deps, input);
      expect(result.targetListId).toBe(TARGET_LIST_ID);
    });
  });

  describe("email verification gate", () => {
    it("rejects when actor email is not verified", async () => {
      const ctx = makeTestContext({ emailVerified: false });
      const input = makeBaseInput();

      await expect(mergeContactLists(ctx.deps, input)).rejects.toMatchObject({
        code: "forbidden",
        message: "email_verification_required",
      });
    });
  });

  describe("validation errors", () => {
    it("rejects when source includes target", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({
        sourceListIds: [TARGET_LIST_ID, SOURCE_LIST_A],
      });

      await expect(mergeContactLists(ctx.deps, input)).rejects.toMatchObject({ code: "SOURCE_CANNOT_BE_TARGET" });
    });

    it("rejects when target list does not exist", async () => {
      const ctx = makeTestContext();
      vi.mocked(ctx.mocks.inviteLists.getListById).mockResolvedValue(null);

      const input = makeBaseInput();

      await expect(mergeContactLists(ctx.deps, input)).rejects.toMatchObject({ code: "TARGET_LIST_NOT_FOUND" });
    });

    it("rejects when source list does not exist", async () => {
      const ctx = makeTestContext();
      const missingId = "ff000000-ff00-4f00-8f00-ff0000000099";

      vi.mocked(ctx.mocks.inviteLists.getListById).mockImplementation(
        async (id: string) => {
          if (id === missingId) return null;
          return makeList({ id });
        },
      );

      const input = makeBaseInput({
        sourceListIds: [missingId],
      });

      await expect(mergeContactLists(ctx.deps, input)).rejects.toMatchObject({ code: "TARGET_LIST_NOT_FOUND" });
    });

    it("rejects cross-owner merge", async () => {
      const ctx = makeTestContext();
      const otherOwner = "ff000000-ff00-4f00-8f00-ff0000000001";

      vi.mocked(ctx.mocks.inviteLists.getListById).mockImplementation(
        async (id: string) => {
          if (id === SOURCE_LIST_A) {
            return makeList({ id: SOURCE_LIST_A, ownerId: otherOwner });
          }
          return makeList({ id });
        },
      );

      const input = makeBaseInput();

      await expect(mergeContactLists(ctx.deps, input)).rejects.toMatchObject({ code: "CROSS_OWNER_MERGE_NOT_ALLOWED" });
    });

    it("rejects empty sourceListIds", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({ sourceListIds: [] });

      // Zod min(1) should reject
      await expect(mergeContactLists(ctx.deps, input)).rejects.toBeDefined();
    });
  });
});
