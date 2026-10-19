import { describe, expect, it, vi } from "vitest";

import { makeHumanDelegatesRepo } from "../human-delegates";
import type { PrismaClientOrTx } from "../types";

/**
 * Query shape for the reverse delegation read (holds-without-a-request
 * FR-002, the booker gate). DB-backed behaviour lives in
 * test/integration/holds-without-a-request.test.ts.
 */
function delegatesPrisma(rows: { principalId: string }[]) {
  const findMany = vi.fn(async () => rows);
  const prisma = { humanDelegate: { findMany } } as unknown as PrismaClientOrTx;
  return { prisma, findMany };
}

describe("humanDelegates.listPrincipalsForDelegate", () => {
  it("one read by delegate + role, principal ids only, sorted", async () => {
    const { prisma, findMany } = delegatesPrisma([
      { principalId: "p-1" },
      { principalId: "p-2" },
    ]);
    expect(
      await makeHumanDelegatesRepo(prisma).listPrincipalsForDelegate({
        delegateId: "d-1",
        roles: ["ADMIN", "EDITOR"],
      }),
    ).toEqual(["p-1", "p-2"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { delegateId: "d-1", role: { in: ["ADMIN", "EDITOR"] } },
      select: { principalId: true },
      orderBy: { principalId: "asc" },
    });
  });

  it("narrows to the candidate principals when given", async () => {
    const { prisma, findMany } = delegatesPrisma([]);
    await makeHumanDelegatesRepo(prisma).listPrincipalsForDelegate({
      delegateId: "d-1",
      roles: ["EDITOR"],
      principalIds: ["p-9"],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          delegateId: "d-1",
          role: { in: ["EDITOR"] },
          principalId: { in: ["p-9"] },
        },
      }),
    );
  });

  it("no roles, or an empty candidate list, is [] without a read", async () => {
    const { prisma, findMany } = delegatesPrisma([{ principalId: "p-1" }]);
    const repo = makeHumanDelegatesRepo(prisma);
    expect(await repo.listPrincipalsForDelegate({ delegateId: "d-1", roles: [] })).toEqual([]);
    expect(
      await repo.listPrincipalsForDelegate({
        delegateId: "d-1",
        roles: ["EDITOR"],
        principalIds: [],
      }),
    ).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
