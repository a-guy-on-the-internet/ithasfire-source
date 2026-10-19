import { describe, expect, it, vi } from "vitest";

import { makeClaimsRepo } from "../claims";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// `claims.lockOrderItem` is the transaction advisory lock that serializes
// opening a resale claim against every move of that order item's ticket
// (owner ruling 2026-10-04: a ticket under an unresolved claim is frozen).
//
// Mock-Prisma test for the QUERY SHAPE: a transaction-scoped advisory lock,
// keyed per order item in its own `claim_order_item:` namespace, with the key
// a BOUND value rather than SQL text. Whether it actually blocks is Postgres'
// job; that needs a live database and is not exercised here.
// ---------------------------------------------------------------------------

function makePrisma() {
  const executeRaw = vi.fn(async () => 0);
  const prisma = { $executeRaw: executeRaw } as unknown as PrismaClientOrTx;
  return { prisma, executeRaw };
}

describe("makeClaimsRepo.lockOrderItem", () => {
  it("takes a transaction-scoped advisory lock keyed on the order item", async () => {
    const { prisma, executeRaw } = makePrisma();
    const repo = makeClaimsRepo(prisma);

    await repo.lockOrderItem("item-1");

    expect(executeRaw).toHaveBeenCalledTimes(1);
    // Tagged template: [strings, ...values]. The key must be a BOUND value.
    const [strings, ...values] = executeRaw.mock.calls[0]! as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain("pg_advisory_xact_lock(hashtext(");
    // Never the session-scoped form: it would outlive the transaction.
    expect(sql).not.toContain("pg_advisory_lock(");
    expect(values).toEqual(["claim_order_item:item-1"]);
  });

  it("keys each order item separately", async () => {
    const { prisma, executeRaw } = makePrisma();
    const repo = makeClaimsRepo(prisma);

    await repo.lockOrderItem("item-1");
    await repo.lockOrderItem("item-2");

    const keys = executeRaw.mock.calls.map(
      (call) => (call as unknown as [TemplateStringsArray, string])[1],
    );
    expect(keys).toEqual([
      "claim_order_item:item-1",
      "claim_order_item:item-2",
    ]);
  });
});
