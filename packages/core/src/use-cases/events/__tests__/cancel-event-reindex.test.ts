import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

// Mock the fire-and-forget reindex so we can assert the mutation wires it
// (correct selector + threaded search/reportError) without driving the whole
// buildSearchIndex path. The end-to-end upsert-or-delete behaviour is covered
// in search/__tests__/build-search-index.test.ts.
const reindexAfterMutation = vi.fn();
vi.mock("../../search/reindex-after-mutation", () => ({
  reindexAfterMutation: (...args: unknown[]) => reindexAfterMutation(...args),
  reindexAllPublishedEvents: vi.fn(),
}));

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "20000000-0000-4000-8000-000000000003";
const CLIENT_KEY = "cancel-reindex-key-12345";
const NOW = new Date("2026-05-10T18:00:00.000Z");

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Riverside Jazz Night",
    slug: "riverside-jazz-night",
    startsAt: new Date("2026-06-01T20:00:00.000Z"),
    endsAt: new Date("2026-06-01T23:00:00.000Z"),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as EventRecord;
}

function buildDeps(): {
  deps: CancelEventDeps;
  search: NonNullable<CancelEventDeps["search"]>;
  reportError: ReturnType<typeof vi.fn>;
} {
  const event = makeEvent();
  const txRepos = {
    events: {
      getById: vi.fn(async () => event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => event),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER" as const,
      })),
    },
    orders: {
      listAll: vi.fn(async () => ({ items: [], total: 0 })),
    },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
    images: {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: {
      enqueueMany: vi.fn(async () => undefined),
    },
    eventChangeNotices: {
      create: vi.fn(async () => ({ id: "notice-1", createdAt: NOW })),
    },
    audit: {
      log: vi.fn(async () => undefined),
    },
    resourceQuotas: {
      incrementUsage: vi.fn(async () => undefined),
    },
    // Booking-timeline reverse lookup: this event never came from a booking.
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const search = {
    ensureIndexes: vi.fn(),
    upsertDocuments: vi.fn(),
    deleteDocuments: vi.fn(async () => ({ ok: true, value: { deleted: 1 } })),
  } as unknown as NonNullable<CancelEventDeps["search"]>;
  const reportError = vi.fn();

  const deps: CancelEventDeps = {
    repos,
    authz: denyStaffAuthz,
    payments: {
      refundPaymentIntent: vi.fn(async () => ({
        refundId: "re_test",
        status: "succeeded",
      })),
    } as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    search,
    reportError,
  };

  return { deps, search, reportError };
}

describe("cancelEvent — search removal wiring", () => {
  it("triggers a reindex (REMOVE) of the cancelled event, threading search + reportError", async () => {
    reindexAfterMutation.mockClear();
    const { deps, search, reportError } = buildDeps();

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.status).toBe("CANCELLED");
    expect(reindexAfterMutation).toHaveBeenCalledTimes(1);
    const [reindexDeps, useCaseName, selector] =
      reindexAfterMutation.mock.calls[0];
    expect(useCaseName).toBe("cancelEvent");
    expect(selector).toEqual({ kind: "event", id: EVENT_ID });
    expect(reindexDeps.search).toBe(search);
    expect(reindexDeps.reportError).toBe(reportError);
  });
});

describe("cancelEvent — search removal before commit, REPORT-ONLY", () => {
  // Refunds are issued BEFORE cancel's transaction, so a search failure must
  // never roll the cancel back (buyers refunded, event still on sale).
  it("deletes event_<id> inside the transaction, before it commits", async () => {
    const { deps, search } = buildDeps();
    const order: string[] = [];
    const tx = deps.repos.tx as unknown as ReturnType<typeof vi.fn>;
    const originalTx = tx.getMockImplementation()!;
    tx.mockImplementation(async (fn: never) => {
      const out = await originalTx(fn);
      order.push("commit");
      return out;
    });
    (search.deleteDocuments as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("search.delete");
        return { ok: true, value: { deleted: 1 } };
      },
    );

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: `${CLIENT_KEY}-order`,
    });

    expect(search.deleteDocuments).toHaveBeenCalledWith({
      ids: [`event_${EVENT_ID}`],
    });
    expect(order).toEqual(["search.delete", "commit"]);
  });

  it.each(["err", "throw"] as const)(
    "a failed delete (%s) is REPORTED and the cancel still commits",
    async (mode) => {
      reindexAfterMutation.mockClear();
      const { deps, search, reportError } = buildDeps();
      (search.deleteDocuments as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          if (mode === "throw") throw new Error("search db unreachable");
          return { ok: false, error: new Error("delete failed") };
        },
      );

      const result = await cancelEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        clientKey: `${CLIENT_KEY}-${mode}`,
      });

      expect(result.status).toBe("CANCELLED");
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: { useCase: "cancelEvent", op: "searchPrivacyScrub" },
        }),
      );
      // The post-commit reindex still runs and removes it again.
      expect(reindexAfterMutation).toHaveBeenCalledTimes(1);
    },
  );
});
