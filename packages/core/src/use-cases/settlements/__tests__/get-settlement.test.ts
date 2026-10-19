import { describe, it, expect, vi } from "vitest";
import { getSettlement } from "../get-settlement";

const SETTLEMENT_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ac8";
const PAYEE_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ac7";
const ORDER_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ac5";

describe("getSettlement", () => {
  it("returns settlement, payee and lines", async () => {
    const now = new Date();
    const mocks: any = {
      settlements: {
        getById: vi.fn(async (id: string) => ({
          id: SETTLEMENT_ID,
          payeeId: PAYEE_ID,
          date: now,
          amountCents: 4675,
          currency: "usd",
          status: "transferred",
          stripeTransferId: "tr_123",
          createdAt: now,
          updatedAt: now,
        })),
      },
      payees: {
        getById: vi.fn(async (id: string) => ({
          id: PAYEE_ID,
          subjectType: "ORGANIZATION",
          subjectId: "org-1",
          stripeAccountId: "acct_1",
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: "usd",
          status: "ACTIVE",
        })),
      },
      settlementLines: {
        listBySettlementId: vi.fn(async (settlementId: string) => [
          {
            id: "731ec309-a9d8-49f0-8caf-0e67f4c00ac9",
            settlementId: SETTLEMENT_ID,
            orderId: ORDER_ID,
            orderSplitId: "731ec309-a9d8-49f0-8caf-0e67f4c00ac6",
            payeeId: PAYEE_ID,
            amountCents: 4675,
            currency: "usd",
            createdAt: now,
          },
        ]),
      },
    };

    const result = await getSettlement(
      { repos: mocks as any },
      { settlementId: SETTLEMENT_ID },
    );

    expect(result.settlement.id).toBe(SETTLEMENT_ID);
    expect(result.payee!.id).toBe(PAYEE_ID);
    expect(result.lines.length).toBe(1);
  });
});
