import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";

// `replaceTaxRateIfUnchanged` — a checkout's after-commit replacement of a
// hand-entered tax rate by the provider's answer (owner ruling R5). The WHERE
// is the behaviour: it replaces only the exact stamp the sale read, on the row
// version it read, so a rate entered again, a settings save, a venue change or
// a concurrent sale's replacement committed in between is never overwritten,
// and the "rates differ" report fires once.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION = new Date("2026-10-07T10:00:00.000Z");

function repoWith(count: number) {
  const updateMany = vi.fn(async () => ({ count }));
  const update = vi.fn();
  const repo = makeEventsRepo({ event: { updateMany, update } } as never);
  return { repo, updateMany, update };
}

const input = {
  eventId: EVENT_ID,
  expected: {
    admissionTaxRateBps: 900,
    taxRateSource: "manual:event",
    updatedAt: VERSION,
  },
  admissionTaxRateBps: 975,
  taxRateSource: "ziptax",
};

describe("replaceTaxRateIfUnchanged", () => {
  it("writes only WHERE the stamp, its source and the row version are still the ones read (a conditional update)", async () => {
    const { repo, updateMany, update } = repoWith(1);
    await repo.replaceTaxRateIfUnchanged(input);
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: EVENT_ID,
        admissionTaxRateBps: 900,
        taxRateSource: "manual:event",
        updatedAt: VERSION,
      },
      data: { admissionTaxRateBps: 975, taxRateSource: "ziptax" },
    });
    const where = (
      updateMany.mock.calls[0] as unknown as [{ where: { updatedAt: unknown } }]
    )[0].where;
    expect(where.updatedAt).toBe(VERSION);
  });

  it("a \"no rate here\" answer unstamps the event (both columns null)", async () => {
    const { repo, updateMany } = repoWith(1);
    await repo.replaceTaxRateIfUnchanged({
      ...input,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { admissionTaxRateBps: null, taxRateSource: null },
      }),
    );
  });

  it("fails closed without a version: never a stamp-only compare", async () => {
    const { repo, updateMany } = repoWith(1);
    await expect(
      repo.replaceTaxRateIfUnchanged({
        ...input,
        expected: { ...input.expected, updatedAt: undefined },
      } as never),
    ).rejects.toThrow(/expected\.updatedAt/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("reports whether it wrote", async () => {
    await expect(repoWith(1).repo.replaceTaxRateIfUnchanged(input)).resolves.toBe(true);
    await expect(repoWith(0).repo.replaceTaxRateIfUnchanged(input)).resolves.toBe(false);
  });
});
