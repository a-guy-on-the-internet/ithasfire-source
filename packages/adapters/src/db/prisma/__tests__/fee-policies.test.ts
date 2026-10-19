import { describe, expect, it, vi, type Mock } from "vitest";

import { makeFeePoliciesRepo } from "../fee-policies";
import type { PrismaClientOrTx } from "../types";

const EXISTING = {
  id: "fp-1",
  scopeType: "GLOBAL",
  scopeId: null,
  status: "ACTIVE",
  version: 3,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  buyerFeePct: 0.065,
  maxFeeCents: null,
  minFeeCents: 100,
  maxPlatformFeeCents: null,
  platformFixedCents: 0,
  feeMode: "PASS_THROUGH",
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0.0025,
  payoutFixedCents: 25,
  monthlyPayoutCents: 0,
  payoutMinimumCents: 1000,
  connectAccountFeeCents: 200,
};

const UPSERT_INPUT = {
  scopeType: "GLOBAL" as const,
  scopeId: null,
  buyerFeePct: 0.07,
  maxFeeCents: null,
  minFeeCents: 100,
  maxPlatformFeeCents: null,
  platformFixedCents: 0,
  feeMode: "PASS_THROUGH" as const,
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0.0025,
  payoutFixedCents: 25,
  monthlyPayoutCents: 0,
  payoutMinimumCents: 1000,
  actorHumanId: "human-1",
};

function makePrisma(existing: typeof EXISTING | null) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...EXISTING,
    ...data,
  }));
  const executeRaw = vi.fn(async () => 1);
  const prisma = {
    feePolicy: {
      findFirst: vi.fn(async () => existing),
      findUnique: vi.fn(async () => existing),
      update: vi.fn(async () => existing),
      create,
    },
    $executeRaw: executeRaw,
  } as unknown as PrismaClientOrTx;
  return { prisma, create, executeRaw };
}

describe("makeFeePoliciesRepo", () => {
  it("maps connectAccountFeeCents onto the record", async () => {
    const { prisma } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    const record = await repo.resolveEffective({
      scopeType: "GLOBAL",
      scopeId: null,
      at: new Date("2026-03-05T06:00:00Z"),
    });

    expect(record?.connectAccountFeeCents).toBe(200);
  });

  it("CARRIES FORWARD connectAccountFeeCents when the caller omits it", async () => {
    // `upsert` mints a NEW version row. A platform admin editing an unrelated
    // pricing knob through a form that doesn't know about this field must not
    // silently switch off the Connect fee recovery.
    const { prisma, create } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    await repo.upsert(UPSERT_INPUT);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ connectAccountFeeCents: 200 }),
    });
  });

  it("honours an explicit connectAccountFeeCents", async () => {
    const { prisma, create } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    await repo.upsert({ ...UPSERT_INPUT, connectAccountFeeCents: 0 });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ connectAccountFeeCents: 0 }),
    });
  });

  it("defaults to 0 (recovery off) when there is no prior policy", async () => {
    const { prisma, create } = makePrisma(null);
    const repo = makeFeePoliciesRepo(prisma);

    await repo.upsert(UPSERT_INPUT);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ connectAccountFeeCents: 0 }),
    });
  });

  it("persists maxFeeCents: null AS NULL, never coerced to 0", async () => {
    // THE BUG THIS GUARDS: this used to be `input.maxFeeCents ?? 0`. `null`
    // means "no per-ticket cap" everywhere that reads it
    // (`compute-ticket-price-for-agreement` does `?? POSITIVE_INFINITY`), but
    // 0 makes `Math.min(0, pctFee)` ZERO THE PLATFORM FEE on every sale. With
    // PLATFORM_FEE_POLICY now the only editing surface, a one-token edit to
    // `maxFeeCents: null` reading as "remove the cap" would have wiped all
    // platform revenue AND made the reconciler diff `0 !== null` forever,
    // minting a policy version on every deploy.
    const { prisma, create } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    const record = await repo.upsert({ ...UPSERT_INPUT, maxFeeCents: null });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ maxFeeCents: null }),
    });
    // And it round-trips as null through the DTO mapper, so a reconciler
    // comparing `null === null` sees no diff.
    expect(record.maxFeeCents).toBeNull();
  });

  it("persists a numeric maxFeeCents unchanged", async () => {
    const { prisma, create } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    const record = await repo.upsert({ ...UPSERT_INPUT, maxFeeCents: 50 });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ maxFeeCents: 50 }),
    });
    expect(record.maxFeeCents).toBe(50);
  });
});

describe("makeFeePoliciesRepo.getActiveForScope", () => {
  it("queries by status ACTIVE only — NO effectiveFrom filter", async () => {
    // The absence of a time filter is the point. `resolveEffective` answers
    // "what does a buyer pay at instant T"; this answers "what row is in
    // place", which is what a reconciler must compare against. Using the
    // time-filtered read there let two concurrent reconciles both write.
    const { prisma } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    const record = await repo.getActiveForScope({
      scopeType: "GLOBAL",
      scopeId: null,
    });

    expect(record?.id).toBe("fp-1");
    const findFirst = (prisma as unknown as { feePolicy: { findFirst: Mock } })
      .feePolicy.findFirst;
    const [args] = findFirst.mock.calls[0]! as [
      { where: Record<string, unknown>; orderBy: unknown },
    ];
    expect(args.where).toEqual({
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
    });
    expect(args.where).not.toHaveProperty("effectiveFrom");
    expect(args.where).not.toHaveProperty("OR");
    // Highest version wins — the same row `upsert` picks to archive.
    expect(args.orderBy).toEqual({ version: "desc" });
  });

  it("forces scopeId to null for GLOBAL, matching upsert", async () => {
    const { prisma } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    await repo.getActiveForScope({ scopeType: "GLOBAL", scopeId: "stray" });

    const findFirst = (prisma as unknown as { feePolicy: { findFirst: Mock } })
      .feePolicy.findFirst;
    const [args] = findFirst.mock.calls[0]! as [
      { where: { scopeId: string | null } },
    ];
    expect(args.where.scopeId).toBeNull();
  });

  it("returns null when the scope has no ACTIVE row", async () => {
    const { prisma } = makePrisma(null);
    const repo = makeFeePoliciesRepo(prisma);

    await expect(
      repo.getActiveForScope({ scopeType: "GLOBAL", scopeId: null }),
    ).resolves.toBeNull();
  });
});

describe("makeFeePoliciesRepo.lockScopeGuard", () => {
  it("takes a transaction-scoped advisory lock keyed on the scope", async () => {
    const { prisma, executeRaw } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    await repo.lockScopeGuard({ scopeType: "GLOBAL", scopeId: null });

    expect(executeRaw).toHaveBeenCalledTimes(1);
    // Tagged template: [strings, ...values]. The key must be a BOUND value, not
    // interpolated into the SQL text.
    const [strings, ...values] = executeRaw.mock.calls[0]! as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock");
    expect(values).toEqual(["fee_policy:GLOBAL:"]);
  });

  it("keys ORG scopes separately, so an ORG write cannot block a GLOBAL one", async () => {
    const { prisma, executeRaw } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    await repo.lockScopeGuard({ scopeType: "GLOBAL", scopeId: null });
    await repo.lockScopeGuard({ scopeType: "ORG", scopeId: "org-1" });
    await repo.lockScopeGuard({ scopeType: "ORG", scopeId: "org-2" });

    const keys = executeRaw.mock.calls.map(
      (call) => (call as unknown as [TemplateStringsArray, string])[1],
    );
    expect(keys).toEqual([
      "fee_policy:GLOBAL:",
      "fee_policy:ORG:org-1",
      "fee_policy:ORG:org-2",
    ]);
    expect(new Set(keys).size).toBe(3);
  });

  it("ignores a stray scopeId on GLOBAL, matching resolveEffective/upsert", async () => {
    // Both of those force `scopeId` to null for GLOBAL. If the lock key did NOT,
    // two GLOBAL reconciles passing different stray ids would take DIFFERENT
    // locks and the serialization would silently not happen.
    const { prisma, executeRaw } = makePrisma(EXISTING);
    const repo = makeFeePoliciesRepo(prisma);

    await repo.lockScopeGuard({ scopeType: "GLOBAL", scopeId: "stray" });

    const [, key] = executeRaw.mock.calls[0]! as unknown as [
      TemplateStringsArray,
      string,
    ];
    expect(key).toBe("fee_policy:GLOBAL:");
  });
});
