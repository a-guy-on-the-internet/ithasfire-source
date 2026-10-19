import { describe, it, expect, vi } from "vitest";
import { listOrderSplits } from "../list-order-splits";

const ORDER_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ac5";
const SPLIT_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ac6";
const PAYEE_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ac7";

// A second split whose payee row does NOT come back from the repo — the payee
// was hard-deleted, or the id is stale. The split row itself still exists and
// still carries money.
const ORPHAN_SPLIT_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ad0";
const MISSING_PAYEE_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ad1";

describe("listOrderSplits", () => {
  it("returns splits with payee info and total", async () => {
    const mocks = {
      splits: {
        getForOrder: vi.fn(async (orderId: string) => {
          expect(orderId).toBe(ORDER_ID);
          return [{ id: SPLIT_ID, payeeId: PAYEE_ID, amountCents: 4800 }];
        }),
      },
      payees: {
        getById: vi.fn(async (id: string) => {
          expect(id).toBe(PAYEE_ID);
          return {
            id: PAYEE_ID,
            subjectType: "ORGANIZATION",
            subjectId: "org_1",
            stripeAccountId: "acct_123",
            status: "ACTIVE",
            payoutsEnabled: true,
            chargesEnabled: true,
            defaultCurrency: "usd",
          };
        }),
        getByIds: vi.fn(async (ids: string[]) => {
          return ids.map((id) => ({
            id,
            subjectType: "ORGANIZATION" as const,
            subjectId: "org_1",
            stripeAccountId: "acct_123",
            status: "ACTIVE" as const,
            payoutsEnabled: true,
            chargesEnabled: true,
            defaultCurrency: "usd",
          }));
        }),
      },
    } as any;

    const result = await listOrderSplits(
      { repos: mocks },
      { orderId: ORDER_ID },
    );

    expect(result.orderId).toBe(ORDER_ID);
    expect(result.splits.length).toBe(1);
    expect(result.totalCents).toBe(4800);
    expect(result.splits[0]!.payee!.id).toBe(PAYEE_ID);
  });

  // A payee row that does not resolve must degrade that ONE row, not blow up
  // the whole read. Dropping the row instead would be worse still: the total
  // would stop matching the sum of the rows on screen, on a money surface.
  it("degrades a split whose payee row is missing instead of failing the whole read", async () => {
    const mocks = {
      splits: {
        getForOrder: vi.fn(async (orderId: string) => {
          expect(orderId).toBe(ORDER_ID);
          return [
            { id: SPLIT_ID, payeeId: PAYEE_ID, amountCents: 4800 },
            {
              id: ORPHAN_SPLIT_ID,
              payeeId: MISSING_PAYEE_ID,
              amountCents: 1200,
            },
          ];
        }),
      },
      payees: {
        // Returns ONLY the resolvable payee. `getByIds` is a bulk read: a
        // missing row is simply absent from the result, not an error.
        getByIds: vi.fn(async (ids: string[]) => {
          expect(ids).toEqual([PAYEE_ID, MISSING_PAYEE_ID]);
          return ids
            .filter((id) => id === PAYEE_ID)
            .map((id) => ({
              id,
              subjectType: "ORGANIZATION" as const,
              subjectId: "org_1",
              stripeAccountId: "acct_123",
              status: "ACTIVE" as const,
              payoutsEnabled: true,
              chargesEnabled: true,
              defaultCurrency: "usd",
            }));
        }),
      },
    } as any;

    const result = await listOrderSplits(
      { repos: mocks },
      { orderId: ORDER_ID },
    );

    // Both rows survive — nothing is filtered out.
    expect(result.splits.length).toBe(2);

    const resolved = result.splits.find((s) => s.id === SPLIT_ID);
    expect(resolved?.payee?.id).toBe(PAYEE_ID);
    expect(resolved?.payee?.stripeAccountId).toBe("acct_123");
    expect(resolved?.amountCents).toBe(4800);

    const orphan = result.splits.find((s) => s.id === ORPHAN_SPLIT_ID);
    expect(orphan?.payee).toBeNull();
    // The payee id is what lets a caller still render something useful.
    expect(orphan?.payeeId).toBe(MISSING_PAYEE_ID);
    expect(orphan?.amountCents).toBe(1200);

    // The money point: the unresolved row is still counted.
    expect(result.totalCents).toBe(6000);
    expect(result.totalCents).toBe(
      result.splits.reduce((acc, s) => acc + s.amountCents, 0),
    );
  });
});
