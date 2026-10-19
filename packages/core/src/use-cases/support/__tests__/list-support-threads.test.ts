import { describe, expect, it, vi } from "vitest";

import { listSupportThreads } from "../list-support-threads";
import type { ListSupportThreadsDeps } from "../list-support-threads";

const STAFF_ID = "00000000-0000-4000-8000-000000000099";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000d1";

function makeThread(
  id: string,
  overrides: Record<string, unknown> = {},
  status = "AWAITING_HUMAN",
) {
  return {
    id,
    humanId: USER_ID,
    eventId: null,
    orderId: null,
    status,
    source: "WIDGET",
    lastMessageAt: new Date("2026-06-23T11:00:00.000Z"),
    resolvedAt: null,
    createdAt: new Date("2026-06-23T10:00:00.000Z"),
    updatedAt: new Date("2026-06-23T11:00:00.000Z"),
    // Staff-enrichment fields (resolved in the adapter join).
    humanDisplayName: "Jane Doe",
    humanEmail: "jane@example.com",
    eventTitle: null,
    orderRef: null,
    // Derived operator-inbox state (resolved in the adapter from the latest
    // non-SYSTEM message). Default to "awaiting operator" so fixtures read as
    // the common inbox case unless a test overrides it.
    needsReply: true,
    lastMessageAuthorType: "USER",
    ...overrides,
  };
}

function makeDeps(opts: {
  isStaff: boolean;
  result?: { items: unknown[]; total: number };
}): ListSupportThreadsDeps {
  return {
    repos: {
      supportThreads: {
        listThreads: vi.fn(
          async () =>
            opts.result ?? {
              items: [makeThread("00000000-0000-4000-8000-0000000000a1")],
              total: 1,
            },
        ),
        getThreadById: vi.fn(),
        findActiveThreadByHuman: vi.fn(),
        createThread: vi.fn(),
        appendMessage: vi.fn(),
        updateThreadStatus: vi.fn(),
        listMessages: vi.fn(),
      },
    } as any,
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: opts.isStaff })),
    },
  };
}

describe("listSupportThreads", () => {
  it("returns a paginated list for staff", async () => {
    const deps = makeDeps({ isStaff: true });

    const result = await listSupportThreads(deps, { actorHumanId: STAFF_ID });

    expect(result.items).toHaveLength(1);
    expect(result.pageInfo.total).toBe(1);
  });

  it("surfaces the resolved human identity to operators", async () => {
    const deps = makeDeps({ isStaff: true });

    const result = await listSupportThreads(deps, { actorHumanId: STAFF_ID });

    expect(result.items[0]).toMatchObject({
      humanDisplayName: "Jane Doe",
      humanEmail: "jane@example.com",
    });
  });

  it("surfaces event title + order ref when the thread is order-aware", async () => {
    const deps = makeDeps({
      isStaff: true,
      result: {
        items: [
          makeThread("00000000-0000-4000-8000-0000000000a2", {
            eventId: EVENT_ID,
            orderId: ORDER_ID,
            eventTitle: "Show at The Chapel",
            orderRef: "OD-1234",
          }),
        ],
        total: 1,
      },
    });

    const result = await listSupportThreads(deps, { actorHumanId: STAFF_ID });

    expect(result.items[0]).toMatchObject({
      eventTitle: "Show at The Chapel",
      orderRef: "OD-1234",
    });
  });

  it("handles null event/order and a human with no display name", async () => {
    const deps = makeDeps({
      isStaff: true,
      result: {
        items: [
          makeThread("00000000-0000-4000-8000-0000000000a3", {
            humanDisplayName: null,
            humanEmail: null,
            eventTitle: null,
            orderRef: null,
          }),
        ],
        total: 1,
      },
    });

    const result = await listSupportThreads(deps, { actorHumanId: STAFF_ID });

    expect(result.items[0]).toMatchObject({
      humanDisplayName: null,
      humanEmail: null,
      eventTitle: null,
      orderRef: null,
    });
  });

  it("surfaces needsReply derived state to operators", async () => {
    const deps = makeDeps({
      isStaff: true,
      result: {
        items: [
          // Ball in the operator's court: latest non-SYSTEM message is USER.
          makeThread("00000000-0000-4000-8000-0000000000b1", {
            needsReply: true,
            lastMessageAuthorType: "USER",
          }),
          // Operator already replied: latest non-SYSTEM message is HUMAN_AGENT.
          makeThread("00000000-0000-4000-8000-0000000000b2", {
            needsReply: false,
            lastMessageAuthorType: "HUMAN_AGENT",
          }),
        ],
        total: 2,
      },
    });

    const result = await listSupportThreads(deps, { actorHumanId: STAFF_ID });

    expect(result.items[0]).toMatchObject({
      needsReply: true,
      lastMessageAuthorType: "USER",
    });
    expect(result.items[1]).toMatchObject({
      needsReply: false,
      lastMessageAuthorType: "HUMAN_AGENT",
    });
  });

  it("passes the status filter through to the repo", async () => {
    const deps = makeDeps({ isStaff: true, result: { items: [], total: 0 } });

    await listSupportThreads(deps, {
      actorHumanId: STAFF_ID,
      status: "AWAITING_HUMAN",
    });

    expect(deps.repos.supportThreads.listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ status: "AWAITING_HUMAN" }),
    );
  });

  it("forbids non-staff (no PII enrichment leaks)", async () => {
    const deps = makeDeps({ isStaff: false });

    await expect(
      listSupportThreads(deps, { actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });
});
