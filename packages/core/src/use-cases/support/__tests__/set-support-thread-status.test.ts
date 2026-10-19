import { describe, expect, it, vi } from "vitest";

import { setSupportThreadStatus } from "../set-support-thread-status";
import type { SetSupportThreadStatusDeps } from "../set-support-thread-status";

const STAFF_ID = "00000000-0000-4000-8000-000000000099";
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
  isStaff: boolean;
  thread?: unknown;
  notifySupport?: SetSupportThreadStatusDeps["notifySupport"];
}): SetSupportThreadStatusDeps & { tx: ReturnType<typeof vi.fn> } {
  const thread = opts.thread === undefined ? makeThread() : opts.thread;
  const repos = {
    supportThreads: {
      getThreadById: vi.fn(async () => thread),
      updateThreadStatus: vi.fn(
        async (input: { status: string; resolvedAt: Date | null }) =>
          makeThread({
            status: input.status,
            resolvedAt: input.resolvedAt,
          }),
      ),
      findActiveThreadByHuman: vi.fn(),
      createThread: vi.fn(),
      appendMessage: vi.fn(),
      listMessages: vi.fn(),
      listThreads: vi.fn(),
    },
    audit: { log: vi.fn(async () => {}) },
  };

  // tx passes the same repos through so updateThreadStatus + audit.log run
  // "inside" the transaction for assertion purposes.
  const tx = vi.fn(async (fn: (t: typeof repos) => Promise<unknown>) =>
    fn(repos),
  );

  const deps = {
    repos: { ...repos, tx },
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: opts.isStaff })),
    },
    clock: { now: () => NOW },
    notifySupport: opts.notifySupport,
  } as unknown as SetSupportThreadStatusDeps;

  return Object.assign(deps, { tx });
}

describe("setSupportThreadStatus", () => {
  it("staff can resolve a thread and resolvedAt is stamped", async () => {
    const deps = makeDeps({ isStaff: true });

    const result = await setSupportThreadStatus(deps, {
      actorHumanId: STAFF_ID,
      threadId: THREAD_ID,
      status: "RESOLVED",
    });

    expect(deps.repos.supportThreads.updateThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "RESOLVED", resolvedAt: NOW }),
    );
    expect(result.thread.status).toBe("RESOLVED");
  });

  it("runs the status change + audit write inside a single transaction, alert outside", async () => {
    const notifySupport = vi.fn(async () => {});
    const deps = makeDeps({ isStaff: true, notifySupport });

    await setSupportThreadStatus(deps, {
      actorHumanId: STAFF_ID,
      threadId: THREAD_ID,
      status: "AWAITING_HUMAN",
    });

    // One tx wraps the DB writes; both happen inside it.
    expect(deps.tx).toHaveBeenCalledTimes(1);
    const txOrder = deps.tx.mock.invocationCallOrder[0];
    const updateOrder = (deps.repos.supportThreads.updateThreadStatus as any)
      .mock.invocationCallOrder[0];
    const auditOrder = (deps.repos.audit.log as any).mock
      .invocationCallOrder[0];
    expect(updateOrder).toBeGreaterThan(txOrder);
    expect(auditOrder).toBeGreaterThan(txOrder);

    // The best-effort alert fires AFTER the tx resolves (outside it), so a
    // slow/failed Discord call never rolls back the status change.
    // Fire-and-forget: the notify runs un-awaited, so wait for it.
    await vi.waitFor(() => expect(notifySupport).toHaveBeenCalled());
    const notifyOrder = notifySupport.mock.invocationCallOrder[0];
    expect(notifyOrder).toBeGreaterThan(updateOrder);
    expect(notifyOrder).toBeGreaterThan(auditOrder);
  });

  it("fires the alert when transitioning to AWAITING_HUMAN", async () => {
    const notifySupport = vi.fn(async () => {});
    const deps = makeDeps({ isStaff: true, notifySupport });

    await setSupportThreadStatus(deps, {
      actorHumanId: STAFF_ID,
      threadId: THREAD_ID,
      status: "AWAITING_HUMAN",
    });

    // Fire-and-forget: the notify runs un-awaited, so wait for the microtask.
    await vi.waitFor(() => expect(notifySupport).toHaveBeenCalled());
    expect(notifySupport).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "awaiting_human" }),
    );
  });

  it("does not fire the alert when already AWAITING_HUMAN", async () => {
    const notifySupport = vi.fn(async () => {});
    const deps = makeDeps({
      isStaff: true,
      thread: makeThread({ status: "AWAITING_HUMAN" }),
      notifySupport,
    });

    await setSupportThreadStatus(deps, {
      actorHumanId: STAFF_ID,
      threadId: THREAD_ID,
      status: "AWAITING_HUMAN",
    });

    expect(notifySupport).not.toHaveBeenCalled();
  });

  it("does not throw when the escalation alert fails", async () => {
    const notifySupport = vi.fn(async () => {
      throw new Error("discord down");
    });
    const deps = makeDeps({ isStaff: true, notifySupport });

    const result = await setSupportThreadStatus(deps, {
      actorHumanId: STAFF_ID,
      threadId: THREAD_ID,
      status: "AWAITING_HUMAN",
    });

    expect(result.thread.status).toBe("AWAITING_HUMAN");
  });

  it("owner can escalate their own thread to AWAITING_HUMAN", async () => {
    const deps = makeDeps({ isStaff: false });

    const result = await setSupportThreadStatus(deps, {
      actorHumanId: OWNER_ID,
      threadId: THREAD_ID,
      status: "AWAITING_HUMAN",
    });

    expect(result.thread.status).toBe("AWAITING_HUMAN");
  });

  it("owner cannot resolve their own thread", async () => {
    const deps = makeDeps({ isStaff: false });

    await expect(
      setSupportThreadStatus(deps, {
        actorHumanId: OWNER_ID,
        threadId: THREAD_ID,
        status: "RESOLVED",
      }),
    ).rejects.toMatchObject({ code: "OWNER_CAN_ONLY_ESCALATE" });
  });

  it("non-owner non-staff cannot change status", async () => {
    const deps = makeDeps({ isStaff: false });

    await expect(
      setSupportThreadStatus(deps, {
        actorHumanId: OTHER_ID,
        threadId: THREAD_ID,
        status: "AWAITING_HUMAN",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws not_found when the thread is missing", async () => {
    const deps = makeDeps({ isStaff: true, thread: null });

    await expect(
      setSupportThreadStatus(deps, {
        actorHumanId: STAFF_ID,
        threadId: THREAD_ID,
        status: "RESOLVED",
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });
});
