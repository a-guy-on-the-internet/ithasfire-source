import { vi } from "vitest";

import {
  createFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EnqueuePendingObjectDeletionItem,
  EnqueuePendingObjectDeletionOnceItem,
  PendingObjectDeletionRecord,
} from "@th/ports/repos/pending-object-deletions";

/**
 * In-memory fakes for the row-less upload finalizes (avatar, banner, page
 * image): an object store that keeps bytes, an outbox with real id
 * semantics (a taken id is not overwritten), a quota ledger, one entity page
 * per owner. The transaction runs its callback against the same state (no
 * rollback) and records each commit, so tests can order post-commit work.
 */

export const CDN = "https://cdn.example";

type StoredObject = {
  content: Buffer;
  contentType?: string;
  /** User metadata, as a presigned PUT would have stored it. */
  metadata?: Record<string, string>;
};

export function makeObjectStore() {
  const objects = new Map<string, StoredObject>();
  const failDeletesOf = new Set<string>();
  const storage = {
    headObject: vi.fn(async ({ key }: { key: string }) => {
      const o = objects.get(key);
      return o
        ? {
            exists: true,
            size: o.content.length,
            contentType: o.contentType,
            ...(o.metadata ? { metadata: o.metadata } : {}),
          }
        : { exists: false };
    }),
    getObject: vi.fn(async ({ key }: { key: string }) => {
      const o = objects.get(key);
      if (!o) throw createFileStorageError("not_found", "object_not_found");
      return { content: o.content, size: o.content.length, contentType: o.contentType };
    }),
    putObject: vi.fn(
      async (input: {
        key: string;
        content: Buffer | Uint8Array;
        options?: { contentType?: string };
      }) => {
        const content = Buffer.from(input.content);
        objects.set(input.key, { content, contentType: input.options?.contentType });
        return { url: `${CDN}/${input.key}`, size: content.length };
      },
    ),
    // Like the R2/S3 adapters: getObjectUrl HEADs the key first.
    getObjectUrl: vi.fn(async ({ key }: { key: string }) => {
      if (!objects.has(key)) throw createFileStorageError("not_found", "object_not_found");
      return { url: `${CDN}/${key}` };
    }),
    deleteObject: vi.fn(async ({ key }: { key: string }) => {
      if (failDeletesOf.has(key)) throw createFileStorageError("transient", "r2_unavailable");
      objects.delete(key);
    }),
    presignPutObject: vi.fn(),
  };
  return {
    objects,
    /** Every delete of these keys fails `transient`. */
    failDeletesOf,
    storage: storage as typeof storage & FileStoragePort,
    put(
      key: string,
      content: Buffer,
      contentType?: string,
      metadata?: Record<string, string>,
    ) {
      objects.set(key, { content, contentType, metadata });
    },
  };
}

export function makeOutbox() {
  const rows = new Map<string, PendingObjectDeletionRecord>();
  let seq = 0;
  const toRecord = (item: EnqueuePendingObjectDeletionItem): PendingObjectDeletionRecord => {
    const now = new Date();
    return {
      id: item.id ?? `generated-${++seq}`,
      targetKey: item.targetKey,
      targetKind: item.targetKind,
      status: "PENDING",
      attempts: 0,
      lastError: null,
      nextAttemptAt: item.notBefore ?? now,
      source: item.source ?? null,
      sourceId: item.sourceId ?? null,
      createdAt: now,
      updatedAt: now,
    };
  };
  const repo = {
    enqueueMany: vi.fn(async (items: EnqueuePendingObjectDeletionItem[]) => {
      for (const item of items) {
        const row = toRecord(item);
        if (rows.has(row.id)) throw new Error(`duplicate outbox id ${row.id}`);
        rows.set(row.id, row);
      }
    }),
    enqueueOnce: vi.fn(async (item: EnqueuePendingObjectDeletionOnceItem) => {
      const existing = rows.get(item.id);
      if (existing) return { inserted: false as const, existing };
      rows.set(item.id, toRecord(item));
      return { inserted: true as const };
    }),
    getById: vi.fn(async (id: string) => rows.get(id) ?? null),
    markDeleted: vi.fn(async (id: string) => (rows.delete(id) ? 1 : 0)),
    listDue: vi.fn(async () => []),
    markFailed: vi.fn(async () => {}),
    markDead: vi.fn(async () => {}),
    countOutboxHealth: vi.fn(async () => ({ dead: 0, overdue: 0 })),
  };
  return {
    rows,
    repo,
    /** Rows as plain data, oldest first. */
    list: () => [...rows.values()],
  };
}

export type FakePage = {
  id: string;
  ownerType: "HUMAN" | "ORGANIZATION" | "PLACE";
  ownerId: string;
  slug: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  visibility: "PUBLIC";
  createdAt: Date;
  updatedAt: Date;
};

export function makeRepos(opts: { page?: Partial<FakePage> | null } = {}) {
  const outbox = makeOutbox();
  const quotaDeltas: Array<{ subjectType: string; subjectId: string; kind: string; delta: bigint }> = [];
  // The limit every subject gets; its usage is the sum of its deltas.
  let quotaLimit = 536_870_912n;
  const usageOf = (input: { subjectType: string; subjectId: string; kind: string }) =>
    quotaDeltas
      .filter(
        (d) =>
          d.subjectType === input.subjectType &&
          d.subjectId === input.subjectId &&
          d.kind === input.kind,
      )
      .reduce((sum, d) => sum + d.delta, 0n);
  const resourceQuotas = {
    incrementUsage: vi.fn(
      async (input: { subjectType: string; subjectId: string; kind: string; delta: bigint }) => {
        quotaDeltas.push(input);
        return { currentUsage: 0n };
      },
    ),
    getEffectiveQuota: vi.fn(
      async (input: { subjectType: string; subjectId: string; kind: string }) => ({
        kind: input.kind,
        limitValue: quotaLimit,
        currentUsage: usageOf(input),
        isOverride: false,
      }),
    ),
    hasPendingExpansionRequest: vi.fn(async () => false),
  };
  let page: FakePage | null =
    opts.page === null
      ? null
      : {
          id: "page-1",
          ownerType: "HUMAN",
          ownerId: "owner",
          slug: "me",
          displayName: "Me",
          bio: null,
          avatarUrl: null,
          bannerUrl: null,
          visibility: "PUBLIC",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...opts.page,
        };
  const entityPages = {
    getByOwner: vi.fn(async () => (page ? { ...page } : null)),
    upsert: vi.fn(async (input: Partial<FakePage>) => {
      page = { ...(page as FakePage), ...input } as FakePage;
      return { ...page };
    }),
  };
  const txCommitted = vi.fn();
  const txRepos = {
    entityPages,
    resourceQuotas,
    pendingObjectDeletions: outbox.repo,
  } as unknown as TxRepos;
  const repos = {
    ...txRepos,
    tx: vi.fn(async <T>(fn: (tx: TxRepos) => Promise<T>) => {
      const result = await fn(txRepos);
      txCommitted();
      return result;
    }),
  } as unknown as Repos;
  return {
    repos,
    outbox,
    quotaDeltas,
    resourceQuotas,
    setQuotaLimit: (limit: bigint) => {
      quotaLimit = limit;
    },
    entityPages,
    txCommitted,
    page: () => page,
  };
}

export function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return logger as typeof logger & import("@th/ports/logger").LoggerPort;
}
