import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two remaining `FeePolicy` writers outside the reconciler are seeders, and
 * both could produce a SECOND ACTIVE row for the same scope. That is now a
 * P2002 against `FeePolicy_one_active_per_scope_key` (migration
 * 20260812130000_fee_policy_one_active_per_scope), which for the e2e helper
 * would turn a currently-green suite red the moment a spec seeds twice between
 * resets. These tests pin both fixes.
 *
 * `@th/db` exports a module-level Prisma singleton, so it is mocked here; the
 * index behaviour itself is covered against real Postgres in
 * `packages/adapters/src/db/prisma/__tests__/fee-policies-one-active-per-scope.integration.test.ts`.
 */

const prismaMock = vi.hoisted(() => {
  const feePolicy = {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    aggregate: vi.fn(),
  };
  const tx = {
    feePolicy,
    $executeRaw: vi.fn(async () => 1),
  };
  return {
    feePolicy,
    tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
});

vi.mock("@th/db", () => ({
  prisma: prismaMock,
  getPrisma: () => prismaMock,
}));

import { seedFeePolicy } from "../src/routes/e2e/_helpers";
import { ensureFeePolicy } from "../src/scripts/seed/finance";
import { PLATFORM_FEE_POLICY } from "@th/core/lib/pricing/platform-fee-policy";

const NOW = new Date("2026-08-12T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.feePolicy.findFirst.mockResolvedValue(null);
  prismaMock.feePolicy.aggregate.mockResolvedValue({ _max: { version: null } });
  prismaMock.feePolicy.create.mockImplementation(async ({ data }: any) => ({
    id: "fp-new",
    ...data,
  }));
  prismaMock.feePolicy.update.mockResolvedValue({ id: "fp-old" });
});

describe("e2e seedFeePolicy", () => {
  it("creates v1 from PLATFORM_FEE_POLICY when the scope has no ACTIVE row", async () => {
    await seedFeePolicy({ createdBy: "human-1", now: NOW, notes: "e2e" });

    expect(prismaMock.feePolicy.update).not.toHaveBeenCalled();
    expect(prismaMock.feePolicy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ...PLATFORM_FEE_POLICY,
        status: "ACTIVE",
        version: 1,
        notes: "e2e",
        createdBy: "human-1",
        approvedBy: "human-1",
      }),
    });
  });

  it("ARCHIVES the scope's existing ACTIVE row instead of creating a second one", async () => {
    // The regression this guards: several specs seed twice between resets
    // (`event-detail-currency` seeds two paid-checkout events in one
    // `beforeAll`, `page-smoke`'s second describe never resets). A blind
    // `create` there is now a P2002.
    prismaMock.feePolicy.findFirst.mockResolvedValue({ id: "fp-old" });
    prismaMock.feePolicy.aggregate.mockResolvedValue({ _max: { version: 4 } });

    await seedFeePolicy({ createdBy: "human-1", now: NOW });

    expect(prismaMock.feePolicy.update).toHaveBeenCalledWith({
      where: { id: "fp-old" },
      data: {
        status: "ARCHIVED",
        effectiveTo: new Date(NOW.getTime() - 60_000),
      },
    });
    // Version is per-scope monotonic across ARCHIVED rows too, so the ARCHIVED
    // tuple can never collide with @@unique([scopeType, scopeId, status,
    // version]) for a non-null scopeId.
    expect(prismaMock.feePolicy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "ACTIVE", version: 5 }),
    });
  });

  it("looks for the existing row by SCOPE and status only — no effective-window filter", async () => {
    // Must match the index predicate exactly. A time-filtered read would miss
    // an ACTIVE row outside its window and try to insert alongside it.
    await seedFeePolicy({ createdBy: "human-1", now: NOW });

    expect(prismaMock.feePolicy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scopeType: "GLOBAL", scopeId: null, status: "ACTIVE" },
      }),
    );
  });

  it("serializes on the same advisory-lock key the reconciler uses", async () => {
    await seedFeePolicy({ createdBy: "human-1", now: NOW });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prismaMock.tx.$executeRaw.mock
      .calls[0]! as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock");
    // Bound parameter, not interpolated SQL. Key shape matches
    // `feePolicies.lockScopeGuard`.
    expect(values).toEqual(["fee_policy:GLOBAL:"]);
  });

  it("honours scope overrides, keying the lock and the archive on THAT scope", async () => {
    prismaMock.feePolicy.findFirst.mockResolvedValue({ id: "fp-org" });
    prismaMock.feePolicy.aggregate.mockResolvedValue({ _max: { version: 2 } });

    await seedFeePolicy({
      createdBy: "human-1",
      now: NOW,
      overrides: { scopeType: "ORG", scopeId: "org-a" },
    });

    const [, key] = prismaMock.tx.$executeRaw.mock.calls[0]! as unknown as [
      TemplateStringsArray,
      string,
    ];
    expect(key).toBe("fee_policy:ORG:org-a");
    expect(prismaMock.feePolicy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scopeType: "ORG", scopeId: "org-a", status: "ACTIVE" },
      }),
    );
    expect(prismaMock.feePolicy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopeType: "ORG",
        scopeId: "org-a",
        version: 3,
      }),
    });
  });
});

describe("dev seed ensureFeePolicy", () => {
  it("returns the existing ACTIVE GLOBAL row without creating another", async () => {
    prismaMock.feePolicy.findFirst.mockResolvedValue({ id: "fp-existing" });

    await expect(ensureFeePolicy(prismaMock as any)).resolves.toEqual({
      id: "fp-existing",
    });
    expect(prismaMock.feePolicy.create).not.toHaveBeenCalled();
  });

  it("does NOT filter on the effective window — an out-of-window ACTIVE row still blocks a second create", async () => {
    // THE BUG THIS GUARDS: the existence check used to require
    // `effectiveFrom <= now < effectiveTo`. An ACTIVE GLOBAL row outside its
    // window read as "no policy", and this function inserted a SECOND ACTIVE
    // GLOBAL row — now a P2002 against the one-active-per-scope index.
    await ensureFeePolicy(prismaMock as any);

    expect(prismaMock.feePolicy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scopeType: "GLOBAL", scopeId: null, status: "ACTIVE" },
      }),
    );
    const [args] = prismaMock.feePolicy.findFirst.mock.calls[0]! as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).not.toHaveProperty("effectiveFrom");
    expect(args.where).not.toHaveProperty("OR");
  });

  it("creates a GLOBAL v1 from PLATFORM_FEE_POLICY when the scope is empty", async () => {
    await ensureFeePolicy(prismaMock as any);

    expect(prismaMock.feePolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ...PLATFORM_FEE_POLICY,
          status: "ACTIVE",
          version: 1,
        }),
      }),
    );
  });
});
