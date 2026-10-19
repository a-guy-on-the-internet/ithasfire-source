import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

const reindexAfterMutation = vi.fn();
vi.mock("../../search/reindex-after-mutation", () => ({
  reindexAfterMutation: (...args: unknown[]) => reindexAfterMutation(...args),
  reindexAllPublishedEvents: vi.fn(),
}));

import { deleteEvent, type DeleteEventDeps } from "../delete-event";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-05-01T12:00:00.000Z");

function buildEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: HUMAN_ID,
    status: "DRAFT",
    title: "Draft Event",
    publishedAt: null,
    startsAt: new Date("2026-06-01T20:00:00.000Z"),
    endsAt: new Date("2026-06-01T22:00:00.000Z"),
    ...overrides,
  } as EventRecord;
}

function buildDeps(): {
  deps: DeleteEventDeps;
  search: NonNullable<DeleteEventDeps["search"]>;
  reportError: ReturnType<typeof vi.fn>;
} {
  const events = {
    getById: vi.fn(async () => buildEvent()),
    delete: vi.fn(async () => true),
  };
  const txRepos = {
    events,
    authz: { getOrgMembership: vi.fn() },
    audit: { log: vi.fn(async () => undefined) },
    audioUploads: { listByEventIdIncludingDeleted: vi.fn(async () => []) },
    images: { listByEventId: vi.fn(async () => []) },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    // No open call on this event (deleteEvent's FR-022 step is skipped).
    eventApplications: { getOpenCall: vi.fn(async () => null) },
  } as unknown as TxRepos;
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;
  const clock: ClockPort = { now: vi.fn(() => NOW) };

  const search = {
    ensureIndexes: vi.fn(),
    upsertDocuments: vi.fn(),
    deleteDocuments: vi.fn(async () => ({ ok: true, value: { deleted: 1 } })),
  } as unknown as NonNullable<DeleteEventDeps["search"]>;
  const reportError = vi.fn();

  return { deps: { repos, clock, search, reportError }, search, reportError };
}

describe("deleteEvent — search removal wiring", () => {
  it("triggers a reindex (REMOVE reconciliation) after delete, threading search + reportError", async () => {
    reindexAfterMutation.mockClear();
    const { deps, search, reportError } = buildDeps();

    const result = await deleteEvent(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, deleted: true });
    expect(reindexAfterMutation).toHaveBeenCalledTimes(1);
    const [reindexDeps, useCaseName, selector] =
      reindexAfterMutation.mock.calls[0];
    expect(useCaseName).toBe("deleteEvent");
    expect(selector).toEqual({ kind: "event", id: EVENT_ID });
    expect(reindexDeps.search).toBe(search);
    expect(reindexDeps.reportError).toBe(reportError);
  });
});

describe("deleteEvent — fail-closed search removal (search/privacy-scrub.ts)", () => {
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

    await deleteEvent(deps, { actorHumanId: HUMAN_ID, eventId: EVENT_ID });

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

      await expect(deleteEvent(deps, { actorHumanId: HUMAN_ID, eventId: EVENT_ID })).rejects.toMatchObject({
        code: "SEARCH_UPDATE_RETRY",
      });
      expect(order).not.toContain("commit");
      expect(reindexAfterMutation).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: { useCase: "deleteEvent", op: "searchPrivacyScrub" },
        }),
      );
    },
  );
});
