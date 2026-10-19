import { describe, expect, it, vi } from "vitest";

import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";

import { PLATFORM_FEE_POLICY } from "../../../lib/pricing/platform-fee-policy";
import {
  diffPlatformFeePolicy,
  reconcilePlatformFeePolicy,
} from "../reconcile-platform-fee-policy";
import { makeClock, NOW } from "./_fixtures";

const ACTOR = "system:test";
const NOTES = "test notes";

/**
 * A `FeePolicyRecord` DTO that is a faithful materialization of the shipped
 * constant. Built by SPREADING the constant rather than restating the numbers,
 * so a fee change cannot make these tests pass for the wrong reason.
 */
const materializedRecord = (
  overrides: Partial<FeePolicyRecord> = {},
): FeePolicyRecord => ({
  ...PLATFORM_FEE_POLICY,
  id: "policy-1",
  status: "ACTIVE",
  version: 3,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  ...overrides,
});

/**
 * Fake `repos` exposing only `tx`, matching the real dep shape. `calls` records
 * the ORDER of every tx-scoped operation so the tests can assert that the
 * advisory lock is taken BEFORE the read (the whole point of taking it) and
 * that the audit row is written inside the same transaction as the upsert.
 *
 * `txCommitted` is only flipped after the callback resolves, so a test can tell
 * "ran inside the transaction" from "ran after it".
 */
const makeRepos = (
  current: FeePolicyRecord | null,
  opts: { upsertThrows?: Error } = {},
) => {
  const calls: string[] = [];
  let txCommitted = false;

  const getActiveForScope = vi.fn(async () => {
    calls.push("getActiveForScope");
    return current;
  });
  const lockScopeGuard = vi.fn(async () => {
    calls.push("lockScopeGuard");
  });
  const upsert = vi.fn(async () => {
    calls.push("upsert");
    if (opts.upsertThrows) throw opts.upsertThrows;
    return materializedRecord({
      id: "policy-2",
      version: (current?.version ?? 0) + 1,
    });
  });
  const auditLog = vi.fn(async () => {
    calls.push("audit.log");
  });

  const txRepos = {
    feePolicies: {
      getActiveForScope,
      resolveEffective: vi.fn(async () => {
        // The reconciler must NEVER use the time-filtered read: see the
        // dedicated test below for the duplicate-write bug it caused.
        calls.push("resolveEffective");
        return current;
      }),
      upsert,
      lockScopeGuard,
      getById: vi.fn(),
    },
    audit: { log: auditLog, list: vi.fn() },
  };

  const tx = vi.fn(async (fn: (t: typeof txRepos) => Promise<unknown>) => {
    calls.push("tx:begin");
    const result = await fn(txRepos);
    calls.push("tx:commit");
    txCommitted = true;
    return result;
  });

  return {
    repos: { tx } as never,
    tx,
    getActiveForScope,
    lockScopeGuard,
    upsert,
    auditLog,
    calls,
    didCommit: () => txCommitted,
  };
};

describe("diffPlatformFeePolicy", () => {
  it("reports no diff for a faithful materialization", () => {
    expect(diffPlatformFeePolicy(materializedRecord())).toEqual([]);
  });

  it("ignores row-lifecycle fields (id, status, version, effectiveFrom/To)", () => {
    // These are NOT part of the constant and must never trigger a rewrite —
    // otherwise the very act of writing a version would make the next deploy
    // write another one.
    const diffs = diffPlatformFeePolicy(
      materializedRecord({
        id: "something-else",
        version: 99,
        effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
        effectiveTo: new Date("2099-01-01T00:00:00.000Z"),
      }),
    );
    expect(diffs).toEqual([]);
  });

  it("compares decimals NUMERICALLY, not by string or reference", () => {
    // The adapter's `decimalToNumber` is literally `Number(value)`, which goes
    // Decimal → string → double. Reproduce that exact route and require it to
    // compare equal to the literal in the constant; a string or reference
    // comparison here would report a spurious diff on every deploy.
    const viaAdapterConversion = Number("0.0333");
    const diffs = diffPlatformFeePolicy(
      materializedRecord({ buyerFeePct: viaAdapterConversion }),
    );
    expect(diffs).toEqual([]);
  });

  it("reports each changed field with its old and new value", () => {
    const diffs = diffPlatformFeePolicy(
      materializedRecord({ buyerFeePct: 0, platformFixedCents: 50 }),
    );
    expect(diffs).toEqual(
      expect.arrayContaining([
        { field: "buyerFeePct", current: 0, next: 0.0333 },
        { field: "platformFixedCents", current: 50, next: 0 },
      ]),
    );
    expect(diffs).toHaveLength(2);
  });

  it("distinguishes the per-ticket cap from the order-wide cap", () => {
    // maxFeeCents (per ticket, 50) vs maxPlatformFeeCents (per order, null).
    // Confusing them would quietly cut platform revenue ~90% on group orders,
    // so the reconciler has to see them as separate fields.
    const diffs = diffPlatformFeePolicy(
      materializedRecord({ maxFeeCents: null, maxPlatformFeeCents: 50 }),
    );
    expect(diffs.map((diff) => diff.field).sort()).toEqual([
      "maxFeeCents",
      "maxPlatformFeeCents",
    ]);
  });

  it("treats a missing policy as every field changing", () => {
    const diffs = diffPlatformFeePolicy(null);
    expect(diffs).toHaveLength(Object.keys(PLATFORM_FEE_POLICY).length);
    expect(diffs.every((diff) => diff.current === undefined)).toBe(true);
  });
});

describe("reconcilePlatformFeePolicy", () => {
  it("is a NO-OP when the live row already matches the constant", async () => {
    // The load-bearing case: this runs on EVERY deploy. If it wrote here, every
    // deploy would mint a policy version and every PayoutTerms.feePolicyId pin
    // would be one version behind within a day.
    const current = materializedRecord();
    const { repos, getActiveForScope, upsert } = makeRepos(current);

    const result = await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(result).toEqual({ action: "noop", policy: current, diffs: [] });
    expect(upsert).not.toHaveBeenCalled();
    expect(getActiveForScope).toHaveBeenCalledWith({
      scopeType: "GLOBAL",
      scopeId: null,
    });
  });

  it("WRITES a new version when the live row differs", async () => {
    const current = materializedRecord({
      buyerFeePct: 0,
      maxFeeCents: null,
      platformFixedCents: 50,
    });
    const { repos, upsert } = makeRepos(current);

    const result = await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(result.action).toBe("written");
    if (result.action !== "written") throw new Error("unreachable");
    expect(result.previous).toBe(current);
    expect(result.diffs.map((diff) => diff.field).sort()).toEqual([
      "buyerFeePct",
      "maxFeeCents",
      "platformFixedCents",
    ]);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      ...PLATFORM_FEE_POLICY,
      actorHumanId: ACTOR,
      notes: NOTES,
    });
  });

  it("INSTALLS v1 when the scope has no ACTIVE policy at all", async () => {
    // This is the prod bug that started all of this: prod had no FeePolicy row,
    // so the first-ever publishEvent threw FEE_POLICY_NOT_FOUND.
    const { repos, upsert } = makeRepos(null);

    const result = await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(result.action).toBe("written");
    if (result.action !== "written") throw new Error("unreachable");
    expect(result.previous).toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("passes connectAccountFeeCents EXPLICITLY so the adapter cannot carry a stale value forward", async () => {
    // `UpsertFeePolicyInput.connectAccountFeeCents` is optional and the adapter
    // carries the existing value forward when it is omitted. The constant owns
    // the field, so the reconciler must always send it — otherwise a value set
    // once by hand would survive forever and the "everything in code" guarantee
    // would be a lie.
    const { repos, upsert } = makeRepos(
      materializedRecord({ connectAccountFeeCents: 200 }),
    );

    await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    const [payload] = upsert.mock.calls[0]! as unknown as [
      Record<string, unknown>,
    ];
    expect(payload).toHaveProperty(
      "connectAccountFeeCents",
      PLATFORM_FEE_POLICY.connectAccountFeeCents,
    );
  });

  it("does NOT compare notes — a reworded note never mints a version", async () => {
    const { repos, upsert } = makeRepos(materializedRecord());

    const result = await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: "something completely different" },
    );

    expect(result.action).toBe("noop");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("propagates a repo failure instead of pretending the row is correct", async () => {
    const tx = vi.fn(
      async (
        fn: (t: {
          feePolicies: Record<string, unknown>;
          audit: Record<string, unknown>;
        }) => Promise<unknown>,
      ) =>
        fn({
          feePolicies: {
            lockScopeGuard: vi.fn(),
            getActiveForScope: vi.fn(async () => {
              throw new Error("db unreachable");
            }),
            resolveEffective: vi.fn(),
            upsert: vi.fn(),
            getById: vi.fn(),
          },
          audit: { log: vi.fn(), list: vi.fn() },
        }),
    );

    await expect(
      reconcilePlatformFeePolicy(
        { repos: { tx } as never, clock: makeClock() },
        { actorHumanId: ACTOR, notes: NOTES },
      ),
    ).rejects.toThrow("db unreachable");
  });
});

describe("reconcilePlatformFeePolicy — transaction + serialization", () => {
  it("does EVERYTHING inside ONE transaction (no read outside, no write outside)", async () => {
    // `feePolicies.upsert` is archive-then-create, two statements. Split across
    // the transaction boundary — or interrupted between them — the GLOBAL scope
    // is left with ZERO ACTIVE policies, which is the exact prod outage
    // (FEE_POLICY_NOT_FOUND) this mechanism exists to prevent. And this runs
    // UNATTENDED on a workflow with concurrency.cancel-in-progress: true.
    const { repos, tx, calls, didCommit } = makeRepos(
      materializedRecord({ buyerFeePct: 0, platformFixedCents: 50 }),
    );

    await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(tx).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "tx:begin",
      "lockScopeGuard",
      "getActiveForScope",
      "upsert",
      "audit.log",
      "tx:commit",
    ]);
    expect(didCommit()).toBe(true);
  });

  it("takes the advisory lock BEFORE the read, on the no-op path too", async () => {
    // If the lock came after the resolve, two overlapping reconciles could both
    // read version n and both write n+1. The GLOBAL unique index cannot catch
    // that duplicate — `scopeId IS NULL`, and Postgres treats NULLs as distinct
    // — so one row would be orphaned as a permanently ACTIVE ghost.
    const { repos, calls } = makeRepos(materializedRecord());

    await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(calls.indexOf("lockScopeGuard")).toBeGreaterThan(
      calls.indexOf("tx:begin"),
    );
    expect(calls.indexOf("lockScopeGuard")).toBeLessThan(
      calls.indexOf("getActiveForScope"),
    );
  });

  it("NEVER uses the time-filtered resolveEffective (the duplicate-write bug)", async () => {
    // OBSERVED AT RUNTIME, not theorised. This originally read
    // `resolveEffective({ at: clock.now() })` with `at` captured BEFORE
    // `repos.tx`. Two concurrent reconciles serialized on the advisory lock
    // correctly — the probe showed the waiter blocking for the full hold — but
    // the waiter's `at` predated the row the holder had just committed, so
    // `effectiveFrom <= at` excluded it while the previous row was already
    // ARCHIVED. The waiter saw NOTHING, decided no policy existed, and wrote a
    // SECOND ACTIVE GLOBAL row. Verified against a real Postgres: v4 by actor A
    // at 19:35:20.72 and v5 by actor B at 19:35:20.775, both from one
    // `Promise.all`.
    //
    // `getActiveForScope` has no time filter and returns exactly the row
    // `upsert` will archive, which removes the class of bug rather than
    // narrowing its window.
    const { repos, calls } = makeRepos(materializedRecord());

    await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(calls).not.toContain("resolveEffective");
    expect(calls).toContain("getActiveForScope");
  });

  it("locks the SCOPE being written, so an ORG write can't block a GLOBAL one", async () => {
    const { repos, lockScopeGuard } = makeRepos(materializedRecord());

    await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(lockScopeGuard).toHaveBeenCalledWith({
      scopeType: PLATFORM_FEE_POLICY.scopeType,
      scopeId: PLATFORM_FEE_POLICY.scopeId,
    });
  });

  it("writes an audit row, in the same transaction, recording the field-level diff", async () => {
    // A platform-wide fee change had NO audit trail before this. The row has to
    // answer "when did the fee change and to what" without diffing git.
    const current = materializedRecord({
      buyerFeePct: 0,
      platformFixedCents: 50,
      version: 7,
      id: "old-policy",
    });
    const { repos, auditLog, calls } = makeRepos(current);

    await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(calls.indexOf("audit.log")).toBeGreaterThan(calls.indexOf("upsert"));
    expect(calls.indexOf("audit.log")).toBeLessThan(calls.indexOf("tx:commit"));

    expect(auditLog).toHaveBeenCalledTimes(1);
    const [entry] = auditLog.mock.calls[0]! as unknown as [
      {
        entity: string;
        entityId: string;
        action: string;
        at: Date;
        data: {
          actorHumanId: string;
          previousVersion: number | null;
          version: number;
          changes: Array<{ field: string; from: unknown; to: unknown }>;
        };
      },
    ];

    expect(entry.entity).toBe("FeePolicy");
    expect(entry.entityId).toBe("policy-2");
    expect(entry.action).toBe("platform.feePolicy.reconciled");
    expect(entry.at).toEqual(NOW);
    expect(entry.data.actorHumanId).toBe(ACTOR);
    expect(entry.data.previousVersion).toBe(7);
    expect(entry.data.version).toBe(8);
    expect(entry.data.changes).toEqual(
      expect.arrayContaining([
        { field: "buyerFeePct", from: 0, to: PLATFORM_FEE_POLICY.buyerFeePct },
        { field: "platformFixedCents", from: 50, to: 0 },
      ]),
    );
  });

  it("writes NO audit row on the no-op path", async () => {
    const { repos, auditLog } = makeRepos(materializedRecord());

    await reconcilePlatformFeePolicy(
      { repos, clock: makeClock() },
      { actorHumanId: ACTOR, notes: NOTES },
    );

    expect(auditLog).not.toHaveBeenCalled();
  });

  it("does not commit when the write throws — the archive rolls back with it", async () => {
    const { repos, auditLog, didCommit } = makeRepos(
      materializedRecord({ buyerFeePct: 0 }),
      { upsertThrows: new Error("connection reset mid-upsert") },
    );

    await expect(
      reconcilePlatformFeePolicy(
        { repos, clock: makeClock() },
        { actorHumanId: ACTOR, notes: NOTES },
      ),
    ).rejects.toThrow("connection reset mid-upsert");

    expect(didCommit()).toBe(false);
    expect(auditLog).not.toHaveBeenCalled();
  });
});
