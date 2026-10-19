import { describe, expect, it } from "vitest";

import { requireEventResaleClauseSet } from "../resale-clause";

/**
 * The switch-on / publish gate (organiser-resale-share FR-001, review B2/W4):
 * the event's RESALE terms exist, carry a set clause, and have at least one
 * RESALE line — all read under the terms lock, so a concurrent clear
 * (`setResaleClause`, which takes the same lock) cannot slip between the
 * check and the write it guards.
 */

const EVENT_ID = "d0000000-0000-4000-8000-0000000000ee";
const TERMS_ID = "d0000000-0000-4000-8000-0000000000a1";

function repos(opts: {
  exists?: boolean;
  clause?: boolean;
  lines?: number;
}) {
  const calls: string[] = [];
  return {
    calls,
    repos: {
      deals: {
        lockTerms: async (id: string) => {
          calls.push(`lock:${id}`);
          return opts.exists ?? true;
        },
      },
      payoutTerms: {
        getById: async (id: string) => {
          calls.push(`read:${id}`);
          if (!(opts.exists ?? true)) return null;
          return (opts.clause ?? true)
            ? {
                id,
                resaleShareType: "PERCENT",
                resaleShareBps: 1000,
                resaleShareCents: null,
                resaleSharePayer: "SELLER",
              }
            : {
                id,
                resaleShareType: null,
                resaleShareBps: null,
                resaleShareCents: null,
                resaleSharePayer: "SELLER",
              };
        },
        listLines: async (id: string) => {
          calls.push(`lines:${id}`);
          return Array.from({ length: opts.lines ?? 1 }, (_, i) => ({ id: `l${i}` }));
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const event = { id: EVENT_ID, resalePayoutTermsId: TERMS_ID };

describe("requireEventResaleClauseSet", () => {
  it("passes on a set clause with a line, locking before it reads", async () => {
    const r = repos({});
    await expect(requireEventResaleClauseSet(r.repos, event)).resolves.toBeUndefined();
    expect(r.calls).toEqual([`lock:${TERMS_ID}`, `read:${TERMS_ID}`, `lines:${TERMS_ID}`]);
  });

  it("no RESALE terms → RESALE_TERMS_MISSING, nothing locked", async () => {
    const r = repos({});
    await expect(
      requireEventResaleClauseSet(r.repos, { id: EVENT_ID, resalePayoutTermsId: null }),
    ).rejects.toMatchObject({ code: "RESALE_TERMS_MISSING", meta: { reason: "resale_terms_missing" } });
    expect(r.calls).toEqual([]);
  });

  it("terms gone under the lock → RESALE_TERMS_MISSING (resale_clause_not_set), not read", async () => {
    const r = repos({ exists: false });
    await expect(requireEventResaleClauseSet(r.repos, event)).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
      meta: { reason: "resale_clause_not_set", payoutTermsId: TERMS_ID },
    });
    expect(r.calls).toEqual([`lock:${TERMS_ID}`]);
  });

  it("clause not set → RESALE_TERMS_MISSING (resale_clause_not_set)", async () => {
    const r = repos({ clause: false });
    await expect(requireEventResaleClauseSet(r.repos, event)).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
      meta: { reason: "resale_clause_not_set" },
    });
  });

  it("a set clause with no RESALE line → AGREEMENT_MISSING_LINES (resale_lines_missing)", async () => {
    const r = repos({ lines: 0 });
    await expect(requireEventResaleClauseSet(r.repos, event)).rejects.toMatchObject({
      code: "AGREEMENT_MISSING_LINES",
      meta: { reason: "resale_lines_missing", payoutTermsId: TERMS_ID },
    });
  });
});
