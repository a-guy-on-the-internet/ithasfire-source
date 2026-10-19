import { describe, expect, it, vi } from "vitest";

import { markThreadRead } from "../mark-thread-read";
import type { MarkThreadReadDeps } from "../mark-thread-read";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const THREAD_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-06-23T12:00:00.000Z");

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD_ID,
    humanId: OWNER_ID,
    eventId: null,
    orderId: null,
    status: "OPEN",
    source: "WIDGET",
    lastMessageAt: new Date("2026-06-23T11:00:00.000Z"),
    resolvedAt: null,
    createdAt: new Date("2026-06-23T10:00:00.000Z"),
    updatedAt: new Date("2026-06-23T11:00:00.000Z"),
    ...overrides,
  };
}

function makeDeps(opts: {
  thread?: unknown;
  // markMessagesRead returns this many updated rows.
  updated?: number;
}): MarkThreadReadDeps & { tx: ReturnType<typeof vi.fn> } {
  const thread = opts.thread === undefined ? makeThread() : opts.thread;
  const repos = {
    supportThreads: {
      getThreadById: vi.fn(async () => thread),
      markMessagesRead: vi.fn(async () => ({ updated: opts.updated ?? 0 })),
      findActiveThreadByHuman: vi.fn(),
      createThread: vi.fn(),
      appendMessage: vi.fn(),
      updateThreadStatus: vi.fn(),
      listMessages: vi.fn(),
      listThreads: vi.fn(),
    },
    audit: { log: vi.fn(async () => {}) },
  };

  const tx = vi.fn(async (fn: (t: typeof repos) => Promise<unknown>) =>
    fn(repos),
  );

  const deps = {
    repos: { ...repos, tx },
    clock: { now: () => NOW },
  } as unknown as MarkThreadReadDeps;

  return Object.assign(deps, { tx });
}

describe("markThreadRead", () => {
  it("stamps readAt only on non-USER unread messages, in a single tx", async () => {
    const deps = makeDeps({ updated: 2 });

    const result = await markThreadRead(deps, {
      actorHumanId: OWNER_ID,
      threadId: THREAD_ID,
    });

    expect(result.updated).toBe(2);

    // Exactly one transaction wraps the write.
    expect(deps.tx).toHaveBeenCalledTimes(1);

    // The repo is told to mark only the counterparty author types, with the
    // clock's `now`, and never USER messages.
    const call = (deps.repos.supportThreads.markMessagesRead as any).mock
      .calls[0][0];
    expect(call.threadId).toBe(THREAD_ID);
    expect(call.readAt).toBe(NOW);
    expect(call.authorTypes).toEqual(["HUMAN_AGENT", "AI_CLERK", "SYSTEM"]);
    expect(call.authorTypes).not.toContain("USER");

    // The mark write runs inside the tx.
    const txOrder = deps.tx.mock.invocationCallOrder[0];
    const markOrder = (deps.repos.supportThreads.markMessagesRead as any).mock
      .invocationCallOrder[0];
    expect(markOrder).toBeGreaterThan(txOrder);

    // No audit row for a benign self-action.
    expect((deps.repos as any).audit.log).not.toHaveBeenCalled();
  });

  it("is idempotent: a second call with nothing unread updates 0", async () => {
    const deps = makeDeps({ updated: 0 });

    const result = await markThreadRead(deps, {
      actorHumanId: OWNER_ID,
      threadId: THREAD_ID,
    });

    expect(result.updated).toBe(0);
    expect(deps.repos.supportThreads.markMessagesRead).toHaveBeenCalledTimes(1);
  });

  it("forbids a non-owner (even staff don't use this path) from marking read", async () => {
    const deps = makeDeps({ updated: 1 });

    await expect(
      markThreadRead(deps, {
        actorHumanId: OTHER_ID,
        threadId: THREAD_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    // Ownership is rejected before any write.
    expect(deps.repos.supportThreads.markMessagesRead).not.toHaveBeenCalled();
    expect(deps.tx).not.toHaveBeenCalled();
  });

  it("throws not_found when the thread does not exist", async () => {
    const deps = makeDeps({ thread: null });

    await expect(
      markThreadRead(deps, {
        actorHumanId: OWNER_ID,
        threadId: THREAD_ID,
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });
});
