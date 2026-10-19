import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";

// `fillTaxRateIfUnset` — the checkout's after-commit tax self-heal. The WHERE
// is the behaviour: it may only fill a NULL stamp on a row still at the
// version the rate was resolved from, so neither a stamp a settings save
// committed between the checkout's resolve and its write, nor a save that left
// the stamp NULL (instruction-only turned off, provider lookup missed), is
// overwritten by the stale rate.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION = new Date("2026-09-30T10:00:00.000Z");

function repoWith(count: number) {
  const updateMany = vi.fn(async () => ({ count }));
  const update = vi.fn();
  const repo = makeEventsRepo({ event: { updateMany, update } } as never);
  return { repo, updateMany, update };
}

describe("fillTaxRateIfUnset", () => {
  it("regression: writes only WHERE the stamp IS NULL AND the row is still at the read version (a conditional update, never a plain one)", async () => {
    const { repo, updateMany, update } = repoWith(1);
    await repo.fillTaxRateIfUnset({
      eventId: EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
      expectedUpdatedAt: VERSION,
    });
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: EVENT_ID, admissionTaxRateBps: null, updatedAt: VERSION },
      data: { admissionTaxRateBps: 975, taxRateSource: "ziptax" },
    });
  });

  it("passes expectedUpdatedAt straight through as the SAME Date (no string / epoch / truncation round trip)", async () => {
    const { repo, updateMany } = repoWith(1);
    // Identity, not just equality: a string / epoch hop in the adapter would
    // pass `toEqual` yet could shift the compared instant.
    await repo.fillTaxRateIfUnset({
      eventId: EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
      expectedUpdatedAt: VERSION,
    });
    const where = (
      updateMany.mock.calls[0] as unknown as [{ where: { updatedAt: unknown } }]
    )[0].where;
    expect(where.updatedAt).toBeInstanceOf(Date);
    expect(where.updatedAt).toBe(VERSION);
  });

  it("fails closed without a version: never an unguarded (NULL-only) write", async () => {
    const { repo, updateMany } = repoWith(1);
    await expect(
      repo.fillTaxRateIfUnset({
        eventId: EVENT_ID,
        admissionTaxRateBps: 0,
        taxRateSource: "exempt:tn-instruction",
      } as never),
    ).rejects.toThrow(/expectedUpdatedAt/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("reports whether it wrote: true when the row was unset, false when a stamp was already there", async () => {
    await expect(
      repoWith(1).repo.fillTaxRateIfUnset({
        eventId: EVENT_ID,
        admissionTaxRateBps: 0,
        taxRateSource: "exempt:tn-instruction",
        expectedUpdatedAt: VERSION,
      }),
    ).resolves.toBe(true);
    await expect(
      repoWith(0).repo.fillTaxRateIfUnset({
        eventId: EVENT_ID,
        admissionTaxRateBps: 0,
        taxRateSource: "exempt:tn-instruction",
        expectedUpdatedAt: VERSION,
      }),
    ).resolves.toBe(false);
  });
});
