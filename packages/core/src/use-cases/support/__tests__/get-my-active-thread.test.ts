import { describe, expect, it, vi } from "vitest";

import { getMyActiveThread } from "../get-my-active-thread";
import type { GetMyActiveThreadDeps } from "../get-my-active-thread";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const THREAD_ID = "00000000-0000-4000-8000-0000000000aa";

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
  // What findActiveThreadByHuman resolves to, keyed by the humanId it receives.
  byHuman?: (humanId: string) => unknown;
}): GetMyActiveThreadDeps {
  return {
    repos: {
      supportThreads: {
        findActiveThreadByHuman: vi.fn(async (humanId: string) =>
          opts.byHuman ? opts.byHuman(humanId) : makeThread(),
        ),
        getThreadById: vi.fn(),
        listMessages: vi.fn(),
        createThread: vi.fn(),
        appendMessage: vi.fn(),
        updateThreadStatus: vi.fn(),
        listThreads: vi.fn(),
        markMessagesRead: vi.fn(),
      },
    } as any,
  };
}

describe("getMyActiveThread", () => {
  it("returns the caller's own active thread", async () => {
    const deps = makeDeps({});

    const result = await getMyActiveThread(deps, { actorHumanId: OWNER_ID });

    expect(result.thread?.id).toBe(THREAD_ID);
    expect(result.thread?.humanId).toBe(OWNER_ID);
    expect(deps.repos.supportThreads.findActiveThreadByHuman).toHaveBeenCalledWith(
      OWNER_ID,
    );
  });

  it("returns null when the caller has no active thread", async () => {
    const deps = makeDeps({ byHuman: () => null });

    const result = await getMyActiveThread(deps, { actorHumanId: OWNER_ID });

    expect(result.thread).toBeNull();
  });

  it("only ever looks up the caller's own thread (never another human's)", async () => {
    // The repo is queried strictly by the authenticated actorHumanId — so even
    // if OWNER has an active thread, calling as OTHER returns OTHER's lookup
    // (null here), never OWNER's thread.
    const deps = makeDeps({
      byHuman: (humanId) => (humanId === OWNER_ID ? makeThread() : null),
    });

    const result = await getMyActiveThread(deps, { actorHumanId: OTHER_ID });

    expect(deps.repos.supportThreads.findActiveThreadByHuman).toHaveBeenCalledWith(
      OTHER_ID,
    );
    expect(result.thread).toBeNull();
  });
});
