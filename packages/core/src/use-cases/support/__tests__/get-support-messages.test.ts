import { describe, expect, it, vi } from "vitest";

import { getSupportMessages } from "../get-support-messages";
import type { GetSupportMessagesDeps } from "../get-support-messages";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const STAFF_ID = "00000000-0000-4000-8000-000000000099";
const THREAD_ID = "00000000-0000-4000-8000-0000000000aa";

function makeThread() {
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
  };
}

const OLDER_AT = new Date("2026-06-23T11:00:00.000Z");
const NEWER_AT = new Date("2026-06-23T11:05:00.000Z");

function makeMessages() {
  return [
    {
      id: "00000000-0000-4000-8000-0000000000b1",
      threadId: THREAD_ID,
      authorType: "USER",
      authorHumanId: OWNER_ID,
      body: "hi",
      readAt: null,
      createdAt: OLDER_AT,
    },
    {
      id: "00000000-0000-4000-8000-0000000000b2",
      threadId: THREAD_ID,
      authorType: "HUMAN_AGENT",
      authorHumanId: null,
      body: "how can I help?",
      readAt: null,
      createdAt: NEWER_AT,
    },
  ];
}

function makeDeps(opts: {
  thread?: unknown;
  isStaff?: boolean;
}): GetSupportMessagesDeps {
  return {
    repos: {
      supportThreads: {
        getThreadById: vi.fn(async () =>
          opts.thread === undefined ? makeThread() : opts.thread,
        ),
        // Honour the `since` cursor like the real adapter (strictly newer).
        listMessages: vi.fn(async (_threadId: string, since?: Date) =>
          makeMessages().filter((m) => !since || m.createdAt > since),
        ),
        findActiveThreadByHuman: vi.fn(),
        createThread: vi.fn(),
        appendMessage: vi.fn(),
        updateThreadStatus: vi.fn(),
        listThreads: vi.fn(),
      },
    } as any,
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: opts.isStaff ?? false })),
    },
  };
}

describe("getSupportMessages", () => {
  it("returns messages for the thread owner", async () => {
    const deps = makeDeps({});

    const result = await getSupportMessages(deps, {
      actorHumanId: OWNER_ID,
      threadId: THREAD_ID,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.thread.id).toBe(THREAD_ID);
    expect(deps.authz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("without `since` returns full history", async () => {
    const deps = makeDeps({});

    const result = await getSupportMessages(deps, {
      actorHumanId: OWNER_ID,
      threadId: THREAD_ID,
    });

    expect(result.messages.map((m) => m.id)).toEqual([
      "00000000-0000-4000-8000-0000000000b1",
      "00000000-0000-4000-8000-0000000000b2",
    ]);
  });

  it("with `since` at the older message returns only newer messages (gt)", async () => {
    const deps = makeDeps({});

    const result = await getSupportMessages(deps, {
      actorHumanId: OWNER_ID,
      threadId: THREAD_ID,
      // Cursor = createdAt of the already-seen older message → only the newer
      // one comes back (strictly greater, never re-fetching the cursor row).
      since: OLDER_AT,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe("00000000-0000-4000-8000-0000000000b2");
    expect(deps.repos.supportThreads.listMessages).toHaveBeenCalledWith(
      THREAD_ID,
      OLDER_AT,
    );
  });

  it("with `since` at/after the newest createdAt returns an empty delta (caught up)", async () => {
    const deps = makeDeps({});

    const result = await getSupportMessages(deps, {
      actorHumanId: OWNER_ID,
      threadId: THREAD_ID,
      since: NEWER_AT,
    });

    expect(result.messages).toEqual([]);
    // The thread itself is always returned in full, even with no new messages.
    expect(result.thread.id).toBe(THREAD_ID);
  });

  it("returns messages for staff on someone else's thread", async () => {
    const deps = makeDeps({ isStaff: true });

    const result = await getSupportMessages(deps, {
      actorHumanId: STAFF_ID,
      threadId: THREAD_ID,
    });

    expect(deps.authz.hasStaffRole).toHaveBeenCalled();
    expect(result.thread.id).toBe(THREAD_ID);
  });

  it("forbids a non-owner non-staff human from reading another thread", async () => {
    const deps = makeDeps({ isStaff: false });

    await expect(
      getSupportMessages(deps, {
        actorHumanId: OTHER_ID,
        threadId: THREAD_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws not_found when the thread does not exist", async () => {
    const deps = makeDeps({ thread: null });

    await expect(
      getSupportMessages(deps, {
        actorHumanId: OWNER_ID,
        threadId: THREAD_ID,
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });
});
