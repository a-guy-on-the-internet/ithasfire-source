import { describe, expect, it, vi } from "vitest";

import { ensureSeedPrimaryPayoutLine } from "../src/scripts/seed/finance";

describe("ensureSeedPrimaryPayoutLine", () => {
  it("updates an existing shared line instead of deleting and recreating it", async () => {
    const findFirst = vi.fn(async () => ({ id: "line-1" }));
    const update = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({}));

    const prisma = {
      payoutTermsLine: {
        findFirst,
        update,
        create,
      },
    } as any;

    await ensureSeedPrimaryPayoutLine(prisma, "terms-1", "payee-1");

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payoutTermsId: "terms-1",
          payeeId: "payee-1",
          ticketTypeId: null,
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "line-1" },
      data: {
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a valid 100% line when the agreement has none", async () => {
    const prisma = {
      payoutTermsLine: {
        findFirst: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
        create: vi.fn(async () => ({})),
      },
    } as any;

    await ensureSeedPrimaryPayoutLine(prisma, "terms-2", "payee-2");

    expect(prisma.payoutTermsLine.update).not.toHaveBeenCalled();
    expect(prisma.payoutTermsLine.create).toHaveBeenCalledWith({
      data: {
        payoutTermsId: "terms-2",
        payeeId: "payee-2",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    });
  });
});
