import { describe, expect, it, vi } from "vitest";

import { sendSupportMessage } from "../send-support-message";
import type { SendSupportMessageDeps } from "../send-support-message";

const HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-0000000000aa";
const MESSAGE_ID = "00000000-0000-4000-8000-0000000000bb";
const EVENT_ID = "00000000-0000-4000-8000-0000000000cc";
const NOW = new Date("2026-06-23T12:00:00.000Z");

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD_ID,
    humanId: HUMAN_ID,
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

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    threadId: THREAD_ID,
    authorType: "USER",
    authorHumanId: HUMAN_ID,
    body: "help me",
    readAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makeDeps(opts: {
  existingThread?: unknown;
  notifySupport?: SendSupportMessageDeps["notifySupport"];
  createThread?: ReturnType<typeof vi.fn>;
  findActiveThreadByHuman?: ReturnType<typeof vi.fn>;
  appendMessage?: ReturnType<typeof vi.fn>;
}): SendSupportMessageDeps & { tx: ReturnType<typeof vi.fn> } {
  const createThread =
    opts.createThread ??
    vi.fn(async (input: { eventId: string | null; orderId: string | null }) =>
      makeThread({ eventId: input.eventId, orderId: input.orderId }),
    );
  const repos = {
    supportThreads: {
      findActiveThreadByHuman:
        opts.findActiveThreadByHuman ??
        vi.fn(async () => opts.existingThread ?? null),
      createThread,
      appendMessage: opts.appendMessage ?? vi.fn(async () => makeMessage()),
      getThreadById: vi.fn(async () => null),
      updateThreadStatus: vi.fn(),
      listMessages: vi.fn(),
      listThreads: vi.fn(),
    },
  };

  // tx passes the same repos through, mirroring the real transactional client.
  const tx = vi.fn(async (fn: (t: typeof repos) => Promise<unknown>) =>
    fn(repos),
  );

  const deps = {
    repos: { ...repos, tx },
    clock: { now: () => NOW },
    notifySupport: opts.notifySupport,
  } as unknown as SendSupportMessageDeps;

  return Object.assign(deps, { tx });
}

describe("sendSupportMessage", () => {
  it("creates a new thread carrying the caller's humanId when none exists", async () => {
    const deps = makeDeps({ existingThread: null });

    const result = await sendSupportMessage(deps, {
      actorHumanId: HUMAN_ID,
      body: "help me",
      eventId: EVENT_ID,
    });

    expect(deps.repos.supportThreads.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: HUMAN_ID,
        eventId: EVENT_ID,
        status: "OPEN",
        source: "WIDGET",
        lastMessageAt: NOW,
      }),
    );
    expect(result.thread.humanId).toBe(HUMAN_ID);
    expect(result.message.authorType).toBe("USER");
    expect(result.thread.lastMessageAt).toEqual(NOW);
  });

  it("reuses the caller's active thread instead of creating a new one", async () => {
    const deps = makeDeps({ existingThread: makeThread() });

    await sendSupportMessage(deps, { actorHumanId: HUMAN_ID, body: "again" });

    expect(deps.repos.supportThreads.createThread).not.toHaveBeenCalled();
    expect(deps.repos.supportThreads.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        authorType: "USER",
        authorHumanId: HUMAN_ID,
        lastMessageAt: NOW,
      }),
    );
  });

  it("fires the support alert on a NEW thread", async () => {
    const notifySupport = vi.fn(async () => {});
    const deps = makeDeps({ existingThread: null, notifySupport });

    await sendSupportMessage(deps, { actorHumanId: HUMAN_ID, body: "help" });

    // Fire-and-forget: the notify runs un-awaited, so wait for the microtask.
    await vi.waitFor(() => expect(notifySupport).toHaveBeenCalled());
    expect(notifySupport).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new_thread", humanId: HUMAN_ID }),
    );
    // Data-minimization: the payload carries ONLY routing/label ids — no
    // message body/preview, no email. Pin the exact key set so any future PII
    // leak (e.g. a re-added messagePreview) fails the test.
    const payload = notifySupport.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(
      ["eventId", "humanId", "orderId", "reason", "threadId"].sort(),
    );
  });

  it("does NOT fire the alert when reusing an existing thread", async () => {
    const notifySupport = vi.fn(async () => {});
    const deps = makeDeps({ existingThread: makeThread(), notifySupport });

    await sendSupportMessage(deps, { actorHumanId: HUMAN_ID, body: "more" });

    expect(notifySupport).not.toHaveBeenCalled();
  });

  it("does NOT fail the send when the alert throws", async () => {
    const notifySupport = vi.fn(async () => {
      throw new Error("discord down");
    });
    const deps = makeDeps({ existingThread: null, notifySupport });

    const result = await sendSupportMessage(deps, {
      actorHumanId: HUMAN_ID,
      body: "help",
    });

    // The use case resolves normally; the rejection is swallowed by `.catch`.
    expect(result.message.id).toBe(MESSAGE_ID);
    await vi.waitFor(() => expect(notifySupport).toHaveBeenCalled());
  });

  it("creates the new thread + first message inside a single transaction", async () => {
    const deps = makeDeps({ existingThread: null });

    await sendSupportMessage(deps, { actorHumanId: HUMAN_ID, body: "help me" });

    expect(deps.tx).toHaveBeenCalledTimes(1);
    const txOrder = deps.tx.mock.invocationCallOrder[0];
    const createOrder = (deps.repos.supportThreads.createThread as any).mock
      .invocationCallOrder[0];
    const appendOrder = (deps.repos.supportThreads.appendMessage as any).mock
      .invocationCallOrder[0];
    expect(createOrder).toBeGreaterThan(txOrder);
    expect(appendOrder).toBeGreaterThan(txOrder);
  });

  it("recovers from a thread-create unique violation by reusing the winning thread", async () => {
    const winner = makeThread({ id: "00000000-0000-4000-8000-0000000000ee" });

    // First read (the conditional precheck) sees no active thread; the create
    // then loses the race (P2002); the re-read returns the winner.
    const findActiveThreadByHuman = vi
      .fn()
      .mockResolvedValueOnce(null) // precheck: no active thread
      .mockResolvedValueOnce(winner); // post-P2002 re-read: winner exists

    const createThread = vi.fn(async () => {
      throw { code: "P2002" };
    });

    const appendMessage = vi.fn(async () =>
      makeMessage({ threadId: winner.id }),
    );

    const notifySupport = vi.fn(async () => {});

    const deps = makeDeps({
      findActiveThreadByHuman,
      createThread,
      appendMessage,
      notifySupport,
    });

    const result = await sendSupportMessage(deps, {
      actorHumanId: HUMAN_ID,
      body: "double tap",
    });

    // The losing create attempt threw P2002; the message is appended to the
    // winning thread instead of failing the send.
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: winner.id, authorType: "USER" }),
    );
    expect(result.thread.id).toBe(winner.id);

    // The winner already owns the thread, so this is NOT a new-thread send —
    // the new-thread alert must not double-fire.
    expect(notifySupport).not.toHaveBeenCalled();
  });

  it("rethrows non-unique errors from thread creation", async () => {
    const createThread = vi.fn(async () => {
      throw new Error("db exploded");
    });
    const deps = makeDeps({ existingThread: null, createThread });

    await expect(
      sendSupportMessage(deps, { actorHumanId: HUMAN_ID, body: "boom" }),
    ).rejects.toThrow("db exploded");
  });

  it("rejects invalid input (empty body)", async () => {
    const deps = makeDeps({ existingThread: null });

    await expect(
      sendSupportMessage(deps, { actorHumanId: HUMAN_ID, body: "   " }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
