import { describe, expect, it, vi } from "vitest";

import {
  freezeCandidateWhere,
  freezeEvents,
} from "../src/scripts/backfill/freeze-published-deals";

type Row = {
  id: string;
  status: string;
  endsAt: Date;
  dealFrozenAt: Date | null;
  publishedAt: Date | null;
  payoutTermsId: string | null;
  resalePayoutTermsId: string | null;
};

const NOW = new Date("2026-10-14T12:00:00Z");
const future = new Date("2026-11-01T00:00:00Z");

function fakeRepos(rows: Row[]) {
  const audit: unknown[] = [];
  const freezeCalls: unknown[] = [];
  const tx = {
    events: {
      lockRows: vi.fn(async () => {}),
      getById: vi.fn(async (id: string) => {
        const r = rows.find((x) => x.id === id);
        return r ? { ...r, dealFrozenByHumanId: null } : null;
      }),
    },
    deals: {
      lockTerms: vi.fn(async () => {}),
      // The guarded UPDATE: only while dealFrozenAt IS NULL.
      freezeEventDealIfUnfrozen: vi.fn(
        async (i: { eventId: string; frozenAt: Date; frozenByHumanId: string | null }) => {
          freezeCalls.push(i);
          const r = rows.find((x) => x.id === i.eventId)!;
          if (r.dealFrozenAt) return false;
          r.dealFrozenAt = i.frozenAt;
          return true;
        },
      ),
    },
    // lockEventDealTerms also locks the terms of any booking agreement whose
    // deal scope is this event; none in these fixtures.
    agreements: { findManyByLinkedEventIds: vi.fn(async () => []) },
    audit: { log: vi.fn(async (e: unknown) => void audit.push(e)) },
  };
  const repos = { tx: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { repos: repos as never, audit, freezeCalls, tx };
}

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  status: "PUBLISHED",
  endsAt: future,
  dealFrozenAt: null,
  publishedAt: new Date("2026-10-01T00:00:00Z"),
  payoutTermsId: null,
  resalePayoutTermsId: null,
  ...over,
});

describe("freezeCandidateWhere", () => {
  it("selects published, published-at set, not ended, unfrozen", () => {
    expect(freezeCandidateWhere(NOW)).toEqual({
      status: "PUBLISHED",
      publishedAt: { not: null },
      endsAt: { gt: NOW },
      dealFrozenAt: null,
    });
  });
});

describe("freezeEvents", () => {
  it("freezes with a null human and writes one BACKFILL audit row each", async () => {
    const { repos, audit, freezeCalls } = fakeRepos([row("a"), row("b")]);
    const s = await freezeEvents(repos, ["a", "b"], NOW);
    expect(s).toEqual({ frozen: 2, alreadyFrozen: 0, skipped: 0, failed: 0 });
    expect(freezeCalls).toHaveLength(2);
    expect(freezeCalls[0]).toMatchObject({ frozenAt: NOW, frozenByHumanId: null });
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      entity: "event",
      entityId: "a",
      action: "event.deal_frozen",
      data: { source: "BACKFILL" },
    });
  });

  it("is idempotent: a second run freezes nothing and writes no audit", async () => {
    const { repos, audit } = fakeRepos([row("a")]);
    await freezeEvents(repos, ["a"], NOW);
    const second = await freezeEvents(repos, ["a"], NOW);
    expect(second).toEqual({ frozen: 0, alreadyFrozen: 1, skipped: 0, failed: 0 });
    expect(audit).toHaveLength(1);
  });

  it("never overwrites an existing freeze", async () => {
    const earlier = new Date("2026-10-01T00:00:00Z");
    const rows = [row("a", { dealFrozenAt: earlier })];
    const { repos, freezeCalls } = fakeRepos(rows);
    const s = await freezeEvents(repos, ["a"], NOW);
    expect(s.alreadyFrozen).toBe(1);
    expect(freezeCalls).toHaveLength(0);
    expect(rows[0]!.dealFrozenAt).toBe(earlier);
  });

  it("skips an event that ended or was unpublished since selection", async () => {
    const { repos, audit } = fakeRepos([
      row("ended", { endsAt: new Date("2026-10-01T00:00:00Z") }),
      row("draft", { status: "DRAFT" }),
    ]);
    const s = await freezeEvents(repos, ["ended", "draft", "gone"], NOW);
    expect(s).toEqual({ frozen: 0, alreadyFrozen: 0, skipped: 3, failed: 0 });
    expect(audit).toHaveLength(0);
  });

  it("locks the event row first, then the event's terms rows in id order, before freezing", async () => {
    const { repos, tx } = fakeRepos([
      row("a", { payoutTermsId: "terms-z", resalePayoutTermsId: "terms-b" }),
    ]);
    const s = await freezeEvents(repos, ["a"], NOW);
    expect(s).toEqual({ frozen: 1, alreadyFrozen: 0, skipped: 0, failed: 0 });
    expect(tx.events.lockRows).toHaveBeenCalledWith({ ids: ["a"], mode: "update" });
    expect(tx.deals.lockTerms.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "terms-b",
      "terms-z",
    ]);
    const rowLock = tx.events.lockRows.mock.invocationCallOrder[0]!;
    const termsLocks = tx.deals.lockTerms.mock.invocationCallOrder;
    const freeze = tx.deals.freezeEventDealIfUnfrozen.mock.invocationCallOrder[0]!;
    expect(termsLocks.every((o) => o > rowLock && o < freeze)).toBe(true);
  });

  it("re-checks publishedAt under the row lock", async () => {
    const { repos, audit } = fakeRepos([row("a", { publishedAt: null })]);
    const s = await freezeEvents(repos, ["a"], NOW);
    expect(s).toEqual({ frozen: 0, alreadyFrozen: 0, skipped: 1, failed: 0 });
    expect(audit).toHaveLength(0);
  });

  it("counts a failing event and carries on with the rest", async () => {
    const { repos, tx } = fakeRepos([row("a"), row("b")]);
    tx.deals.freezeEventDealIfUnfrozen.mockRejectedValueOnce(new Error("boom"));
    const onError = vi.fn();
    const s = await freezeEvents(repos, ["a", "b"], NOW, onError);
    expect(s).toEqual({ frozen: 1, alreadyFrozen: 0, skipped: 0, failed: 1 });
    expect(onError).toHaveBeenCalledWith("a", expect.any(Error));
  });
});
