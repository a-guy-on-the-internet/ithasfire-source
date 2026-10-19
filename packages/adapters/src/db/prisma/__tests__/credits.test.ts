import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { makeCreditsRepo } from "../credits";
import type { PrismaClientOrTx } from "../types";

const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-09T12:00:00.000Z");

/**
 * `releaseForOrder` is a single raw statement, so the unit surface is the
 * SQL skeleton and its bound parameters. Semantics (locking, the replay
 * guard, the balance/status arithmetic) live in
 * `credits-release.integration.test.ts` against real Postgres.
 */
function makePrisma(rows: Array<{ creditId: string; restoredCents: number }>) {
  const queryRaw = vi.fn(async () => rows);
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaClientOrTx;
  return { prisma, queryRaw };
}

function capturedSql(queryRaw: ReturnType<typeof vi.fn>): {
  text: string;
  values: unknown[];
} {
  const call = queryRaw.mock.calls[0];
  expect(call).toBeDefined();
  const sql = call![0] as Prisma.Sql;
  // `Prisma.Sql` is a type, not a runtime constructor, in this Prisma build;
  // duck-type the tagged template instead.
  expect(Array.isArray(sql.strings)).toBe(true);
  expect(Array.isArray(sql.values)).toBe(true);
  // Re-join the template with a placeholder marker so substring assertions
  // read across parameter boundaries.
  return { text: sql.strings.join("?"), values: sql.values };
}

describe("makeCreditsRepo.releaseForOrder", () => {
  it("issues ONE statement bound to the order id and the caller's clock", async () => {
    const { prisma, queryRaw } = makePrisma([]);

    await makeCreditsRepo(prisma).releaseForOrder(ORDER_ID, { now: NOW });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const { values } = capturedSql(queryRaw);
    // ONE bound instant, used for the releasedAt stamp, the expiry CASE and
    // updatedAt alike, so the release matches the JS-Date predicate
    // `listActiveForHuman` reads by rather than server NOW().
    expect(values).toEqual([ORDER_ID, NOW, NOW, NOW]);
  });

  it("falls back to wall-clock time when the caller has no clock", async () => {
    const { prisma, queryRaw } = makePrisma([]);
    const before = Date.now();

    await makeCreditsRepo(prisma).releaseForOrder(ORDER_ID);

    const { values } = capturedSql(queryRaw);
    expect(values[0]).toBe(ORDER_ID);
    const instants = values.slice(1) as Date[];
    expect(instants).toHaveLength(3);
    for (const instant of instants) {
      expect(instant).toBeInstanceOf(Date);
      expect(instant.getTime()).toBeGreaterThanOrEqual(before);
    }
    // And it is the SAME instant everywhere, not three reads of the clock.
    expect(new Set(instants.map((d) => d.getTime())).size).toBe(1);
  });

  it("locks the credit row and guards on releasedAt IS NULL so a replay is a no-op", async () => {
    const { prisma, queryRaw } = makePrisma([]);

    await makeCreditsRepo(prisma).releaseForOrder(ORDER_ID);

    const { text } = capturedSql(queryRaw);
    // Schema-qualified: Neon can hand us an empty search_path.
    expect(text).toContain('public."UserCreditRedemption"');
    expect(text).toContain('public."UserCredit"');
    expect(text).not.toMatch(/(?<!public\.)"UserCredit(Redemption)?"\s+(r|c|u)\b/);
    expect(text).toContain('"orderId" = ?');
    expect(text).toContain('"releasedAt" IS NULL');
    // A redemption already reversed by a refund must not be restored twice.
    expect(text).toContain('"refundedAt" IS NULL');
    expect(text).toMatch(/FOR UPDATE/);
    // Credits are locked in the order `listActiveForHuman` spends them, so a
    // concurrent `redeemConditional` walking the same list cannot cycle.
    expect(text).toMatch(/ORDER BY[^;]*"expiresAt" ASC NULLS LAST[^;]*"createdAt" ASC[^;]*FOR UPDATE/s);
    // Balance goes back; status follows the expiry predicate that
    // `listActiveForHuman` uses, never a blind flip to ACTIVE.
    expect(text).toContain('"balanceCents" + ');
    expect(text).toContain("'ACTIVE'::\"UserCreditStatus\"");
    expect(text).toContain("'EXPIRED'::\"UserCreditStatus\"");
  });

  it("sums the restored cents across every credit on the order", async () => {
    const { prisma } = makePrisma([
      { creditId: "credit-a", restoredCents: 2000 },
      { creditId: "credit-b", restoredCents: 500 },
    ]);

    const result = await makeCreditsRepo(prisma).releaseForOrder(ORDER_ID);

    expect(result).toEqual({
      releasedCents: 2500,
      creditIds: ["credit-a", "credit-b"],
    });
  });

  it("reports zero when nothing was pending on the order", async () => {
    const { prisma } = makePrisma([]);

    const result = await makeCreditsRepo(prisma).releaseForOrder(ORDER_ID);

    expect(result).toEqual({ releasedCents: 0, creditIds: [] });
  });

  it("coerces a bigint SUM to an integer number of cents", async () => {
    // Postgres returns SUM(int) as bigint; the adapter casts in SQL, but the
    // mapping must not trust that and hand a bigint to money math upstream.
    const { prisma } = makePrisma([
      { creditId: "credit-a", restoredCents: BigInt(1234) as unknown as number },
    ]);

    const result = await makeCreditsRepo(prisma).releaseForOrder(ORDER_ID);

    expect(result.releasedCents).toBe(1234);
    expect(typeof result.releasedCents).toBe("number");
  });
});

describe("makeCreditsRepo.redeemConditional", () => {
  it("schema-qualifies the credit table", async () => {
    const { prisma, queryRaw } = makePrisma([]);

    await makeCreditsRepo(prisma).redeemConditional({
      creditId: "credit-1",
      requestedCents: 100,
    });

    const { text } = capturedSql(queryRaw);
    expect(text).toContain('public."UserCredit"');
    expect(text).not.toMatch(/(?<!public\.)"UserCredit"/);
  });
});
