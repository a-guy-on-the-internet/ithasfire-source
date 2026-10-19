import { beforeEach, describe, expect, it, vi } from "vitest";

import { importContacts, type ImportContactsDeps } from "../import-contacts";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  InviteListsRepo,
  ContactImportsRepo,
} from "@th/ports/repos/events";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { AuthZRepo } from "@th/ports/repos/authz";
import type { ContactImportRecord, InviteListRecord } from "@th/types";
import {
  createFakeIdempotencyPort,
  type FakeIdempotencyPort,
} from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const NOW = new Date("2025-06-01T12:00:00.000Z");
const ACTOR_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = ACTOR_ID;
const ORG_ID = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LIST_ID = "cccc3333-cccc-4ccc-8ccc-cccccccccccc";
const IMPORT_ID = "dddd4444-dddd-4ddd-8ddd-dddddddddddd";
const CLIENT_KEY = "client-key-abc12345";

function makeInviteList(
  overrides: Partial<InviteListRecord> = {},
): InviteListRecord {
  return {
    id: LIST_ID,
    ownerType: "HUMAN",
    ownerId: OWNER_ID,
    name: "My Contacts",
    description: null,
    passwordHint: null,
    contactCount: 0,
    lastImportAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeImportRecord(
  overrides: Partial<ContactImportRecord> = {},
): ContactImportRecord {
  return {
    id: IMPORT_ID,
    ownerType: "HUMAN",
    ownerId: OWNER_ID,
    inviteListId: LIST_ID,
    fileName: "contacts.csv",
    fileFormat: "CSV",
    totalRows: 3,
    importedCount: 0,
    skippedCount: 0,
    rejectedCount: 0,
    chunksReceived: 0,
    totalChunks: null,
    completedAt: null,
    createdByHumanId: ACTOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface TestContext {
  deps: ImportContactsDeps;
  mocks: {
    inviteLists: InviteListsRepo;
    contactImports: ContactImportsRepo;
    humans: HumansRepo;
    audit: AuditRepo;
    authz: AuthZRepo;
    idempotency: FakeIdempotencyPort;
    /**
     * The transaction boundary. The fake runs the callback inline, so a read
     * "before the transaction" and one "inside it" look identical unless
     * invocation order is compared against this mock.
     */
    tx: ReturnType<typeof vi.fn>;
  };
}

function makeTestContext(
  options: {
    ownerType?: "HUMAN" | "ORGANIZATION";
    emailVerified?: boolean;
    orgRole?: string | null;
  } = {},
): TestContext {
  const ownerType = options.ownerType ?? "HUMAN";
  const emailVerified = options.emailVerified ?? true;

  const inviteListsRepo: InviteListsRepo = {
    createList: vi.fn(async (input) =>
      makeInviteList({
        id: LIST_ID,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        name: input.name,
      }),
    ),
    updateList: vi.fn(async () => makeInviteList()),
    deleteList: vi.fn(async () => undefined),
    listByOwner: vi.fn(async () => []),
    getListById: vi.fn(async () => makeInviteList({ ownerType })),
    createEntry: vi.fn(async () => ({}) as any),
    updateEntry: vi.fn(async () => ({}) as any),
    deleteEntry: vi.fn(async () => ({ deleted: true })),
    listEntries: vi.fn(async () => []),
    copyEntries: vi.fn(async () => 0),
    batchUpsertEntries: vi.fn(async ({ entries }) => ({
      insertedCount: entries.length,
      skippedCount: 0,
    })),
    deleteAllEntries: vi.fn(async () => 0),
    updateListCounts: vi.fn(async () => undefined),
    attachToEvent: vi.fn(async () => ({}) as any),
    detachFromEvent: vi.fn(async () => undefined),
    listEventLinks: vi.fn(async () => []),
  };

  const contactImportsRepo: ContactImportsRepo = {
    create: vi.fn(async (input) =>
      makeImportRecord({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        inviteListId: input.inviteListId,
        fileName: input.fileName,
        fileFormat: input.fileFormat,
        totalRows: input.totalRows,
      }),
    ),
    getById: vi.fn(async () => makeImportRecord()),
    incrementCounts: vi.fn(async ({ importedDelta, skippedDelta }) =>
      makeImportRecord({
        importedCount: importedDelta,
        skippedCount: skippedDelta,
        chunksReceived: 1,
      }),
    ),
    complete: vi.fn(async (importId, completedAt) =>
      makeImportRecord({ id: importId, completedAt }),
    ),
    listByOwner: vi.fn(async () => []),
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
    contactImports: contactImportsRepo,
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

  // Mirrors the real bag: `TxRepos = Omit<Repos, "tx">`, so the
  // non-transactional surface carries the SAME repos as the transactional
  // one. Without the spread, anything the use case reads BEFORE its
  // transaction hits `undefined` and a green test proves nothing.
  const tx = vi.fn(async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos));
  const repos: Repos = {
    ...txRepos,
    tx,
  } as unknown as Repos;

  const idempotency = createFakeIdempotencyPort();
  const logger = createTestLogger();

  const deps: ImportContactsDeps = {
    repos,
    idempotency,
    clock: { now: () => NOW },
    logger,
  };

  return {
    deps,
    mocks: {
      inviteLists: inviteListsRepo,
      contactImports: contactImportsRepo,
      humans: humansRepo,
      audit: auditRepo,
      authz: authzRepo,
      idempotency,
      tx,
    },
  };
}

function makeBaseInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR_ID,
    owner: { kind: "HUMAN" as const, id: OWNER_ID },
    fileName: "contacts.csv",
    fileFormat: "CSV" as const,
    contacts: [
      { contactEmail: "alice@example.com", displayName: "Alice" },
      { contactEmail: "bob@example.com", displayName: "Bob" },
    ],
    chunkIndex: 0,
    isFinalChunk: true,
    clientKey: CLIENT_KEY,
    targetListName: "My Contacts",
    ...overrides,
  };
}

describe("importContacts", () => {
  describe("happy path: single-chunk import (new list)", () => {
    it("creates a new list, import record, inserts contacts, and returns counts", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput();

      const result = await importContacts(ctx.deps, input);

      expect(result.importId).toBe(IMPORT_ID);
      expect(result.inviteListId).toBe(LIST_ID);
      expect(result.chunkIndex).toBe(0);
      expect(result.chunkImportedCount).toBe(2);
      expect(result.chunkSkippedCount).toBe(0);

      expect(ctx.mocks.inviteLists.createList).toHaveBeenCalledWith({
        ownerType: "HUMAN",
        ownerId: OWNER_ID,
        name: "My Contacts",
      });
      expect(ctx.mocks.contactImports.create).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.inviteLists.batchUpsertEntries).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.contactImports.incrementCounts).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.contactImports.complete).toHaveBeenCalledWith(
        IMPORT_ID,
        NOW,
      );
      expect(ctx.mocks.inviteLists.updateListCounts).toHaveBeenCalledWith(
        LIST_ID,
      );
      expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "contact_import",
          entityId: IMPORT_ID,
          action: "comms.contact_import.completed",
        }),
      );
    });
  });

  describe("happy path: single-chunk import into existing list", () => {
    it("uses targetListId instead of creating new list", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({
        targetListId: LIST_ID,
        targetListName: undefined,
      });

      const result = await importContacts(ctx.deps, input);

      expect(result.inviteListId).toBe(LIST_ID);
      expect(ctx.mocks.inviteLists.createList).not.toHaveBeenCalled();
      expect(ctx.mocks.inviteLists.getListById).toHaveBeenCalledWith(LIST_ID);
    });
  });

  describe("happy path: multi-chunk import", () => {
    it("first chunk creates resources, subsequent chunk appends", async () => {
      const ctx = makeTestContext();

      // First chunk
      const chunk0Input = makeBaseInput({
        chunkIndex: 0,
        isFinalChunk: false,
        totalChunks: 2,
        totalRows: 4,
      });

      const result0 = await importContacts(ctx.deps, chunk0Input);
      expect(result0.importId).toBe(IMPORT_ID);
      expect(result0.chunkIndex).toBe(0);
      expect(ctx.mocks.contactImports.create).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.contactImports.complete).not.toHaveBeenCalled();
      expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "comms.contact_import.chunk_completed",
        }),
      );

      // Second chunk - uses importId from first
      const chunk1Input = makeBaseInput({
        importId: IMPORT_ID,
        chunkIndex: 1,
        isFinalChunk: true,
        totalChunks: 2,
        totalRows: 4,
        clientKey: CLIENT_KEY,
        contacts: [
          { contactEmail: "charlie@example.com", displayName: "Charlie" },
          { contactEmail: "dave@example.com", displayName: "Dave" },
        ],
      });

      const result1 = await importContacts(ctx.deps, chunk1Input);
      expect(result1.chunkIndex).toBe(1);
      // Second chunk should not create a new list or import
      expect(ctx.mocks.contactImports.create).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.contactImports.complete).toHaveBeenCalledWith(
        IMPORT_ID,
        NOW,
      );
    });
  });

  describe("AuthUser linking", () => {
    it("looks up emails and links matching humanIds", async () => {
      const ctx = makeTestContext();
      const linkedHumanId = "eeee5555-eeee-4eee-8eee-eeeeeeeeeeee";

      vi.mocked(ctx.mocks.humans.batchLookupHumanIdsByEmail).mockResolvedValue(
        new Map([["alice@example.com", linkedHumanId]]),
      );

      const input = makeBaseInput();
      const result = await importContacts(ctx.deps, input);

      expect(ctx.mocks.humans.batchLookupHumanIdsByEmail).toHaveBeenCalledWith([
        "alice@example.com",
        "bob@example.com",
      ]);
      expect(result.linkedToAuthUserCount).toBe(1);

      // Verify the entries passed to batchUpsert include the humanId
      const upsertCall = vi.mocked(ctx.mocks.inviteLists.batchUpsertEntries)
        .mock.calls[0]![0];
      const aliceEntry = upsertCall.entries.find(
        (e) => e.contactEmail === "alice@example.com",
      );
      expect(aliceEntry?.humanId).toBe(linkedHumanId);

      const bobEntry = upsertCall.entries.find(
        (e) => e.contactEmail === "bob@example.com",
      );
      expect(bobEntry?.humanId).toBeNull();
    });

    it("looks up AuthUser emails BEFORE the transaction opens", async () => {
      const ctx = makeTestContext();

      await importContacts(ctx.deps, makeBaseInput());

      // The lookup is a pure read the transaction does not need; running it
      // inside the tx meant a failed SELECT aborted the session and the
      // upsert that followed died with 25P02. The fake runs the tx callback
      // inline, so invocation order is the only evidence of the hoist.
      expect(ctx.mocks.tx).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(ctx.mocks.humans.batchLookupHumanIdsByEmail).mock
          .invocationCallOrder[0]!,
      ).toBeLessThan(ctx.mocks.tx.mock.invocationCallOrder[0]!);
    });

    it("a failed AuthUser lookup FAILS the chunk — nothing is committed as an unlinked 'success'", async () => {
      const ctx = makeTestContext();
      const linkedHumanId = "eeee5555-eeee-4eee-8eee-eeeeeeeeeeee";

      // First attempt: the lookup fails. Previously this was swallowed and
      // the chunk committed with every contact `humanId: null`, reported as a
      // fully successful import that a re-run (dedup) could never repair.
      vi.mocked(ctx.mocks.humans.batchLookupHumanIdsByEmail)
        .mockRejectedValueOnce(new Error("db timeout"))
        .mockResolvedValueOnce(new Map([["alice@example.com", linkedHumanId]]));

      const input = makeBaseInput();
      await expect(importContacts(ctx.deps, input)).rejects.toThrow(
        "db timeout",
      );

      // No transaction was opened and no entries were written.
      expect(ctx.mocks.tx).not.toHaveBeenCalled();
      expect(ctx.mocks.inviteLists.batchUpsertEntries).not.toHaveBeenCalled();

      // The idempotency key was released, so the caller's retry runs for
      // real and lands the linkage the first attempt could not.
      const retry = await importContacts(ctx.deps, input);
      expect(retry.linkedToAuthUserCount).toBe(1);
      expect(retry.chunkImportedCount).toBe(2);
      expect(ctx.mocks.inviteLists.batchUpsertEntries).toHaveBeenCalledTimes(1);
      // Released, never `failed:` (a failed marker locks the retry out 15 min).
      expect(ctx.mocks.idempotency.release).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
    });

    it("keeps the claim when the chunk committed and only the idempotency commit throws", async () => {
      const ctx = makeTestContext();
      vi.spyOn(ctx.mocks.idempotency, "commit").mockRejectedValueOnce(
        new Error("redis down"),
      );

      const input = makeBaseInput();
      await expect(importContacts(ctx.deps, input)).rejects.toThrow(
        "redis down",
      );
      // A same-key retry is refused, so committed work cannot be redone.
      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({
        code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
      });

      expect(ctx.mocks.inviteLists.batchUpsertEntries).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.idempotency.release).not.toHaveBeenCalled();
      expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
    });
  });

  describe("deduplication", () => {
    it("reports skipped count when duplicates exist", async () => {
      const ctx = makeTestContext();

      vi.mocked(ctx.mocks.inviteLists.batchUpsertEntries).mockResolvedValue({
        insertedCount: 1,
        skippedCount: 1,
      });

      const input = makeBaseInput();
      const result = await importContacts(ctx.deps, input);

      expect(result.chunkImportedCount).toBe(1);
      expect(result.chunkSkippedCount).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("replays prior result on duplicate request", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput();

      const first = await importContacts(ctx.deps, input);
      const second = await importContacts(ctx.deps, input);

      expect(first).toEqual(second);
      // Should only have been called once (no replay invocation)
      expect(ctx.mocks.inviteLists.batchUpsertEntries).toHaveBeenCalledTimes(1);
    });

    it("throws conflict when key reused with different payload", async () => {
      const ctx = makeTestContext();
      const input1 = makeBaseInput();

      await importContacts(ctx.deps, input1);

      // Different contacts but same clientKey + chunkIndex
      const input2 = makeBaseInput({
        contacts: [
          { contactEmail: "x@example.com", displayName: "X" },
          { contactEmail: "y@example.com", displayName: "Y" },
          { contactEmail: "z@example.com", displayName: "Z" },
        ],
      });

      await expect(importContacts(ctx.deps, input2)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    });
  });

  describe("authorization", () => {
    it("rejects when HUMAN owner does not match actor", async () => {
      const ctx = makeTestContext();
      const differentOwner = "ff000000-ff00-4f00-8f00-ff0000000000";
      const input = makeBaseInput({
        owner: { kind: "HUMAN", id: differentOwner },
      });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      // Authorization is a pre-transaction gate: an unauthorized actor never
      // opens a transaction (and never triggers the email lookup that follows).
      expect(ctx.mocks.tx).not.toHaveBeenCalled();
      expect(ctx.mocks.humans.batchLookupHumanIdsByEmail).not.toHaveBeenCalled();
    });

    it("rejects when actor has no org membership", async () => {
      const ctx = makeTestContext({ orgRole: null });
      const input = makeBaseInput({
        owner: { kind: "ORG", id: ORG_ID },
      });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });

    it("rejects when actor has VIEWER role", async () => {
      const ctx = makeTestContext({ orgRole: "VIEWER" });
      const input = makeBaseInput({
        owner: { kind: "ORG", id: ORG_ID },
      });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });

    it("allows ORG owner with ADMIN role", async () => {
      const ctx = makeTestContext({ orgRole: "ADMIN" });
      const input = makeBaseInput({
        owner: { kind: "ORG", id: ORG_ID },
        targetListName: "Org Contacts",
      });

      vi.mocked(ctx.mocks.inviteLists.createList).mockResolvedValue(
        makeInviteList({ ownerType: "ORGANIZATION", ownerId: ORG_ID }),
      );

      const result = await importContacts(ctx.deps, input);
      expect(result.importId).toBe(IMPORT_ID);
    });
  });

  describe("email verification gate", () => {
    it("rejects when actor email is not verified", async () => {
      const ctx = makeTestContext({ emailVerified: false });
      const input = makeBaseInput();

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({
        code: "forbidden",
        message: "email_verification_required",
      });
    });
  });

  describe("validation errors", () => {
    it("rejects contact without email or phone", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({
        contacts: [{ displayName: "No Contact Info" }],
      });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "CONTACT_MUST_HAVE_EMAIL_OR_PHONE" });
    });

    it("rejects when creating new list without targetListName", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({
        targetListName: undefined,
      });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "TARGET_LIST_NAME_REQUIRED_FOR_NEW_LIST" });
    });

    it("rejects when targetListId does not exist", async () => {
      const ctx = makeTestContext();
      vi.mocked(ctx.mocks.inviteLists.getListById).mockResolvedValue(null);

      const input = makeBaseInput({ targetListId: LIST_ID });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "TARGET_LIST_NOT_FOUND" });
    });

    it("rejects when targetListId owner does not match", async () => {
      const ctx = makeTestContext();
      const otherOwner = "ff000000-ff00-4f00-8f00-ff0000000001";
      vi.mocked(ctx.mocks.inviteLists.getListById).mockResolvedValue(
        makeInviteList({ ownerId: otherOwner }),
      );

      const input = makeBaseInput({ targetListId: LIST_ID });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "LIST_OWNER_MISMATCH" });
    });

    it("rejects empty contacts array", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({ contacts: [] });

      // Zod min(1) should reject this
      await expect(importContacts(ctx.deps, input)).rejects.toBeDefined();
    });
  });

  describe("subsequent chunk errors", () => {
    it("rejects when importId not found", async () => {
      const ctx = makeTestContext();
      vi.mocked(ctx.mocks.contactImports.getById).mockResolvedValue(null);

      const input = makeBaseInput({
        importId: IMPORT_ID,
        chunkIndex: 1,
        isFinalChunk: true,
      });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "IMPORT_NOT_FOUND" });
    });

    it("rejects when import owner does not match", async () => {
      const ctx = makeTestContext();
      const otherOwner = "ff000000-ff00-4f00-8f00-ff0000000002";
      vi.mocked(ctx.mocks.contactImports.getById).mockResolvedValue(
        makeImportRecord({ ownerId: otherOwner }),
      );

      const input = makeBaseInput({
        importId: IMPORT_ID,
        chunkIndex: 1,
        isFinalChunk: true,
      });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "IMPORT_OWNER_MISMATCH" });
    });

    it("rejects when import is already completed", async () => {
      const ctx = makeTestContext();
      vi.mocked(ctx.mocks.contactImports.getById).mockResolvedValue(
        makeImportRecord({ completedAt: new Date("2025-05-01") }),
      );

      const input = makeBaseInput({
        importId: IMPORT_ID,
        chunkIndex: 1,
        isFinalChunk: true,
      });

      await expect(importContacts(ctx.deps, input)).rejects.toMatchObject({ code: "IMPORT_ALREADY_COMPLETED" });
    });
  });

  describe("consent tracking", () => {
    it("passes consentSource and consentRecordedAt to batch upsert entries", async () => {
      const ctx = makeTestContext();
      const input = makeBaseInput({ consentSource: "Signup form 2025" });

      await importContacts(ctx.deps, input);

      const upsertCall = vi.mocked(ctx.mocks.inviteLists.batchUpsertEntries)
        .mock.calls[0]![0];
      expect(upsertCall.entries[0]?.consentSource).toBe("Signup form 2025");
      expect(upsertCall.entries[0]?.consentRecordedAt).toEqual(NOW);
    });
  });

  describe("clearExisting", () => {
    it("deletes all existing entries before importing when clearExisting=true on existing list", async () => {
      const ctx = makeTestContext();
      vi.mocked(ctx.mocks.inviteLists.deleteAllEntries).mockResolvedValue(5);

      const input = makeBaseInput({
        targetListId: LIST_ID,
        targetListName: undefined,
        clearExisting: true,
      });

      const result = await importContacts(ctx.deps, input);

      expect(ctx.mocks.inviteLists.deleteAllEntries).toHaveBeenCalledWith(
        LIST_ID,
      );
      expect(result.clearedCount).toBe(5);
      expect(result.chunkImportedCount).toBe(2);
    });

    it("does not clear when clearExisting is false", async () => {
      const ctx = makeTestContext();

      const input = makeBaseInput({
        targetListId: LIST_ID,
        targetListName: undefined,
        clearExisting: false,
      });

      await importContacts(ctx.deps, input);

      expect(ctx.mocks.inviteLists.deleteAllEntries).not.toHaveBeenCalled();
    });

    it("does not clear when creating a new list even if clearExisting=true", async () => {
      const ctx = makeTestContext();

      const input = makeBaseInput({
        targetListName: "Brand New",
        clearExisting: true,
      });

      await importContacts(ctx.deps, input);

      expect(ctx.mocks.inviteLists.deleteAllEntries).not.toHaveBeenCalled();
    });

    it("returns no clearedCount when clearExisting is not set", async () => {
      const ctx = makeTestContext();

      const input = makeBaseInput({
        targetListId: LIST_ID,
        targetListName: undefined,
      });

      const result = await importContacts(ctx.deps, input);

      expect(result.clearedCount).toBeUndefined();
    });
  });
});
