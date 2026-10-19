import { describe, expect, it, vi } from "vitest";

import { makeHumansRepo } from "../humans";
import type { PrismaClientOrTx } from "../types";

/**
 * `setDefaultPrimaryPayoutTermsIdIfNull` is the guarded compare-and-swap
 * pointer write behind on-demand entity-default provisioning
 * (`ensureEntityDefaultPrimaryTerms`). The WHERE must pin the pointer to
 * NULL so two concurrent provisioners (settings-save vs first-publish) can
 * never silently overwrite each other's committed default — the loser gets
 * a 0-match and adopts the winner's row instead.
 */
describe("makeHumansRepo.setDefaultPrimaryPayoutTermsIdIfNull", () => {
  it("guards the write with WHERE defaultPrimaryPayoutTermsId IS NULL and returns true on a 1-match", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = { human: { updateMany } } as unknown as PrismaClientOrTx;

    const won = await makeHumansRepo(
      prisma,
    ).setDefaultPrimaryPayoutTermsIdIfNull({
      id: "human-1",
      payoutTermsId: "pt-1",
    });

    expect(won).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "human-1", defaultPrimaryPayoutTermsId: null },
      data: { defaultPrimaryPayoutTermsId: "pt-1" },
    });
  });

  it("returns false on a 0-match (pointer already set by a concurrent transaction)", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = { human: { updateMany } } as unknown as PrismaClientOrTx;

    const won = await makeHumansRepo(
      prisma,
    ).setDefaultPrimaryPayoutTermsIdIfNull({
      id: "human-1",
      payoutTermsId: "pt-1",
    });

    expect(won).toBe(false);
  });
});
