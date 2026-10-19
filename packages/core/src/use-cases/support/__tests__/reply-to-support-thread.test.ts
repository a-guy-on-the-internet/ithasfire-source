import { describe, expect, it, vi } from "vitest";

import { replyToSupportThread } from "../reply-to-support-thread";
import type { ReplyToSupportThreadDeps } from "../reply-to-support-thread";

const STAFF_ID = "00000000-0000-4000-8000-000000000099";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-06-23T12:00:00.000Z");

function makeThread() {
  return {
    id: THREAD_ID,
    humanId: USER_ID,
    eventId: null,
    orderId: null,
    status: "AWAITING_HUMAN",
    source: "WIDGET",
    lastMessageAt: new Date("2026-06-23T11:00:00.000Z"),
    resolvedAt: null,
    createdAt: new Date("2026-06-23T10:00:00.000Z"),
    updatedAt: new Date("2026-06-23T11:00:00.000Z"),
  };
}

function makeDeps(opts: {
  isStaff: boolean;
  thread?: unknown;
}): ReplyToSupportThreadDeps & { tx: ReturnType<typeof vi.fn> } {
  const repos = {
    supportThreads: {
      getThreadById: vi.fn(async () =>
        opts.thread === undefined ? makeThread() : opts.thread,
      ),
      appendMessage: vi.fn(async () => ({
        id: "00000000-0000-4000-8000-0000000000b1",
        threadId: THREAD_ID,
        authorType: "HUMAN_AGENT",
        authorHumanId: STAFF_ID,
        body: "on it",
        readAt: null,
        createdAt: NOW,
      })),
      findActiveThreadByHuman: vi.fn(),
      createThread: vi.fn(),
      updateThreadStatus: vi.fn(),
      listMessages: vi.fn(),
      listThreads: vi.fn(),
    },
    audit: { log: vi.fn(async () => {}) },
  };

  // tx passes the same repos through, mirroring the real transactional client,
  // so assertions on appendMessage / audit.log observe the in-tx calls.
  const tx = vi.fn(async (fn: (t: typeof repos) => Promise<unknown>) =>
    fn(repos),
  );

  const deps = {
    repos: { ...repos, tx },
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: opts.isStaff })),
    },
    clock: { now: () => NOW },
  } as unknown as ReplyToSupportThreadDeps;

  return Object.assign(deps, { tx });
}

describe("replyToSupportThread", () => {
  it("posts a HUMAN_AGENT message and audits it (staff)", async () => {
    const deps = makeDeps({ isStaff: true });

    const result = await replyToSupportThread(deps, {
      actorHumanId: STAFF_ID,
      threadId: THREAD_ID,
      body: "on it",
    });

    expect(result.message.authorType).toBe("HUMAN_AGENT");
    expect(deps.repos.supportThreads.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        authorType: "HUMAN_AGENT",
        authorHumanId: STAFF_ID,
        lastMessageAt: NOW,
      }),
    );
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "support_thread.replied" }),
    );
  });

  it("runs the reply + audit write inside a single transaction", async () => {
    const deps = makeDeps({ isStaff: true });

    await replyToSupportThread(deps, {
      actorHumanId: STAFF_ID,
      threadId: THREAD_ID,
      body: "on it",
    });

    // Exactly one tx wraps the mutation, and both the message + audit writes
    // happen inside it (engineering-standards: audit inside the mutation tx).
    expect(deps.tx).toHaveBeenCalledTimes(1);
    const txCallOrder = deps.tx.mock.invocationCallOrder[0];
    const appendOrder = (deps.repos.supportThreads.appendMessage as any).mock
      .invocationCallOrder[0];
    const auditOrder = (deps.repos.audit.log as any).mock
      .invocationCallOrder[0];
    expect(appendOrder).toBeGreaterThan(txCallOrder);
    expect(auditOrder).toBeGreaterThan(txCallOrder);
  });

  it("forbids non-staff", async () => {
    const deps = makeDeps({ isStaff: false });

    await expect(
      replyToSupportThread(deps, {
        actorHumanId: USER_ID,
        threadId: THREAD_ID,
        body: "hi",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws not_found when the thread is missing", async () => {
    const deps = makeDeps({ isStaff: true, thread: null });

    await expect(
      replyToSupportThread(deps, {
        actorHumanId: STAFF_ID,
        threadId: THREAD_ID,
        body: "hi",
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });
});
