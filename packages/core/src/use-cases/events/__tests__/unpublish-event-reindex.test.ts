import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

const reindexAfterMutation = vi.fn();
vi.mock("../../search/reindex-after-mutation", () => ({
  reindexAfterMutation: (...args: unknown[]) => reindexAfterMutation(...args),
  reindexAllPublishedEvents: vi.fn(),
}));

import { unpublishEvent, type UnpublishEventDeps } from "../unpublish-event";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = "00000000-0000-4000-8000-000000000003";

function buildDeps(): {
  deps: UnpublishEventDeps;
  search: NonNullable<UnpublishEventDeps["search"]>;
  reportError: ReturnType<typeof vi.fn>;
} {
  const event = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Published Event",
    publishedAt: new Date("2026-05-15T12:00:00.000Z"),
  } as EventRecord;

  const events = {
    lockRows: vi.fn(async () => {}),
    getById: vi.fn(async () => ({ ...event })),
    unpublish: vi.fn(async () => ({ ...event, status: "DRAFT" })),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => ({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "ADMIN" as const,
    })),
  };
  const orders = { listAll: vi.fn(async () => ({ items: [], total: 0 })) };
  const eventChangeNotices = {
    create: vi.fn(async () => ({ id: "notice-1", createdAt: new Date() })),
  };
  const txRepos = { events, eventChangeNotices } as unknown as TxRepos;
  const repos = {
    events,
    authz,
    orders,
    eventChangeNotices,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const search = {
    ensureIndexes: vi.fn(),
    upsertDocuments: vi.fn(),
    deleteDocuments: vi.fn(async () => ({ ok: true, value: { deleted: 1 } })),
  } as unknown as NonNullable<UnpublishEventDeps["search"]>;
  const reportError = vi.fn();

  // The unpublish stamps its search reindex mark with the clock.
  const clock = { now: () => new Date("2026-06-01T12:00:00.000Z") };
  return { deps: { repos, search, reportError, clock }, search, reportError };
}

describe("unpublishEvent — search removal wiring", () => {
  it("triggers a reindex (REMOVE) of the now-DRAFT event, threading search + reportError", async () => {
    reindexAfterMutation.mockClear();
    const { deps, search, reportError } = buildDeps();

    const result = await unpublishEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, status: "DRAFT" });
    expect(reindexAfterMutation).toHaveBeenCalledTimes(1);
    const [reindexDeps, useCaseName, selector] =
      reindexAfterMutation.mock.calls[0];
    expect(useCaseName).toBe("unpublishEvent");
    expect(selector).toEqual({ kind: "event", id: EVENT_ID });
    expect(reindexDeps.search).toBe(search);
    expect(reindexDeps.reportError).toBe(reportError);
  });
});

describe("unpublishEvent — fail-closed search removal (search/privacy-scrub.ts)", () => {
  it("deletes event_<id> INSIDE the transaction, before it commits", async () => {
    reindexAfterMutation.mockClear();
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

    await unpublishEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });

    expect(search.deleteDocuments).toHaveBeenCalledWith({
      ids: [`event_${EVENT_ID}`],
    });
    expect(order).toEqual(["search.delete", "commit"]);
  });

  it.each(["err", "throw"] as const)(
    "a failed delete (%s) FAILS the call: nothing commits, reported, retryable",
    async (mode) => {
      reindexAfterMutation.mockClear();
      const { deps, search, reportError } = buildDeps();
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
          if (mode === "throw") throw new Error("search db unreachable");
          return { ok: false, error: new Error("delete failed") };
        },
      );

      await expect(unpublishEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID })).rejects.toMatchObject({
        code: "SEARCH_UPDATE_RETRY",
      });
      expect(order).not.toContain("commit");
      expect(reindexAfterMutation).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: { useCase: "unpublishEvent", op: "searchPrivacyScrub" },
        }),
      );
    },
  );
});
