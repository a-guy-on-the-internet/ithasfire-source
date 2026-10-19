import { describe, expect, it, vi } from "vitest";
import type { EventRecord, TxRepos } from "@th/ports/repos";
import type { SeatSectionPriceOverride } from "@th/ports/repos/seats";

import {
  ensureStoredOverridesGatedForTierWrites,
  sectionNewlySoldAtFixedPrice,
  type OverrideRuleTier,
  type TierSectionWrite,
} from "../seat-price-override-rules";

// ---------------------------------------------------------------------------
// The gate the ticket type writes share (seat-price-overrides spec, step 7e):
// a FREE tier may not START selling, at a FIXED price, a section that already
// stores a paid seat price override without the override write's own gates.
// The three callers (upsertTicketType, updateTicketType,
// assignTicketTypeSections) are tested in their own files; this pins the
// rule itself: which writes start selling, and that the stored overrides are
// judged against the tier AS WRITTEN.
// ---------------------------------------------------------------------------

const EVENT = {
  id: "event-1",
  orgId: "org-1",
  humanId: null,
  status: "PUBLISHED",
} as unknown as EventRecord;
const NOW = new Date("2026-10-10T12:00:00.000Z");

function tier(over: Partial<OverrideRuleTier> = {}): OverrideRuleTier {
  return {
    status: "ACTIVE",
    pricingMode: "FIXED",
    seatSectionId: "s-1",
    priceCents: 0,
    scheduledPriceCents: null,
    minimumCents: null,
    ...over,
  };
}

function harness(opts: {
  overrides?: SeatSectionPriceOverride[];
  linked?: boolean;
  feePolicy?: boolean;
}) {
  const mocks = {
    seats: {
      listDistinctPriceOverridesByEvent: vi.fn(
        async (_input: { eventId: string }) => opts.overrides ?? [],
      ),
    },
    payees: {
      getBySubject: vi.fn(async () =>
        opts.linked === false ? null : { id: "payee-1" },
      ),
      getById: vi.fn(async () => ({
        id: "payee-1",
        stripeAccountId: "acct_1",
      })),
    },
    feePolicies: {
      resolveEffective: vi.fn(async () =>
        opts.feePolicy === false ? null : { id: "fp-1" },
      ),
    },
  };
  const run = (writes: TierSectionWrite[], event: EventRecord = EVENT) =>
    ensureStoredOverridesGatedForTierWrites(
      mocks as unknown as TxRepos,
      event,
      writes,
      NOW,
      { source: "testUseCase" },
    );
  return { mocks, run };
}

const paidAt = (seatSectionId: string): SeatSectionPriceOverride => ({
  seatSectionId,
  priceOverride: { priceCents: 5000, reason: null },
});

describe("sectionNewlySoldAtFixedPrice", () => {
  it("names the section a created FIXED tier lands on", () => {
    expect(sectionNewlySoldAtFixedPrice({ before: null, after: tier() })).toBe(
      "s-1",
    );
  });

  it("names the section for an assign, a re-point and a switch to FIXED", () => {
    expect(
      sectionNewlySoldAtFixedPrice({
        before: tier({ seatSectionId: null }),
        after: tier(),
      }),
    ).toBe("s-1");
    expect(
      sectionNewlySoldAtFixedPrice({
        before: tier({ seatSectionId: "s-0" }),
        after: tier(),
      }),
    ).toBe("s-1");
    expect(
      sectionNewlySoldAtFixedPrice({
        before: tier({ pricingMode: "ADJUSTABLE" }),
        after: tier(),
      }),
    ).toBe("s-1");
  });

  it("is null when the tier already sold that section at a FIXED price", () => {
    expect(
      sectionNewlySoldAtFixedPrice({ before: tier(), after: tier() }),
    ).toBeNull();
  });

  it("is null for an unassign, a switch to ADJUSTABLE and an unseated tier", () => {
    expect(
      sectionNewlySoldAtFixedPrice({
        before: tier(),
        after: tier({ seatSectionId: null }),
      }),
    ).toBeNull();
    expect(
      sectionNewlySoldAtFixedPrice({
        before: tier(),
        after: tier({ pricingMode: "ADJUSTABLE" }),
      }),
    ).toBeNull();
    expect(
      sectionNewlySoldAtFixedPrice({
        before: null,
        after: tier({ seatSectionId: null }),
      }),
    ).toBeNull();
  });
});

describe("ensureStoredOverridesGatedForTierWrites", () => {
  it("judges the stored overrides against the tier AS WRITTEN, not as stored", async () => {
    // Stored: the tier sells s-0, which holds nothing. Written: it sells s-1,
    // which holds a paid override. Judged on the stored tier this would pass.
    const { run, mocks } = harness({
      overrides: [paidAt("s-1")],
      linked: false,
    });

    await expect(
      run([{ before: tier({ seatSectionId: "s-0" }), after: tier() }]),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
    expect(mocks.seats.listDistinctPriceOverridesByEvent).toHaveBeenCalledTimes(
      1,
    );
  });

  it("ignores the section the tier leaves", async () => {
    const { run } = harness({ overrides: [paidAt("s-0")], linked: false });

    await expect(
      run([{ before: tier({ seatSectionId: "s-0" }), after: tier() }]),
    ).resolves.toBeUndefined();
  });

  it("runs Stripe first, then the fee policy, like the override write", async () => {
    const neither = harness({
      overrides: [paidAt("s-1")],
      linked: false,
      feePolicy: false,
    });
    const noPolicy = harness({ overrides: [paidAt("s-1")], feePolicy: false });

    await expect(
      neither.run([{ before: null, after: tier() }]),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
    await expect(
      noPolicy.run([{ before: null, after: tier() }]),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });
  });

  it.each([
    ["an unassign", { before: tier(), after: tier({ seatSectionId: null }) }],
    [
      "a switch to ADJUSTABLE",
      { before: tier(), after: tier({ pricingMode: "ADJUSTABLE" as const }) },
    ],
    ["a tier that stays put", { before: tier(), after: tier() }],
    ["a paid tier", { before: null, after: tier({ priceCents: 2000 }) }],
    [
      "a tier with a scheduled paid price",
      { before: null, after: tier({ scheduledPriceCents: 2000 }) },
    ],
  ] as [string, TierSectionWrite][])(
    "does not read the seats for %s",
    async (_label, write) => {
      const { run, mocks } = harness({
        overrides: [paidAt("s-1")],
        linked: false,
        feePolicy: false,
      });

      await expect(run([write])).resolves.toBeUndefined();
      expect(
        mocks.seats.listDistinctPriceOverridesByEvent,
      ).not.toHaveBeenCalled();
      expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
    },
  );

  it("a paid tier and a free tier onto the same section: the free one is gated, in one read", async () => {
    const { run, mocks } = harness({
      overrides: [paidAt("s-1")],
      linked: false,
    });

    await expect(
      run([
        { before: null, after: tier({ priceCents: 2000 }) },
        { before: null, after: tier() },
      ]),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
    expect(mocks.seats.listDistinctPriceOverridesByEvent).toHaveBeenCalledTimes(
      1,
    );
  });

  it("a pay-what-you-want tier with a minimum, switched to FIXED $0, is a free tier", async () => {
    const { run } = harness({ overrides: [paidAt("s-1")], linked: false });

    await expect(
      run([
        {
          before: tier({ pricingMode: "ADJUSTABLE", minimumCents: 500 }),
          // updateTicketType clears the minimum on a FIXED tier.
          after: tier({ pricingMode: "FIXED", minimumCents: null }),
        },
      ]),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
  });

  it("ACCEPTED GAP: a paid FIXED tier edited to $0 on its section is not re-gated", async () => {
    const { run, mocks } = harness({
      overrides: [paidAt("s-1")],
      linked: false,
      feePolicy: false,
    });

    await expect(
      run([{ before: tier({ priceCents: 2000 }), after: tier() }]),
    ).resolves.toBeUndefined();
    expect(
      mocks.seats.listDistinctPriceOverridesByEvent,
    ).not.toHaveBeenCalled();
  });

  describe("what the refusal tells the client (meta)", () => {
    const corruptAt = (seatSectionId: string): SeatSectionPriceOverride => ({
      seatSectionId,
      priceOverride: { invalid: true },
    });

    it("a paid stored price: cause stored_seat_price and its section", async () => {
      const { run } = harness({
        overrides: [paidAt("s-1"), paidAt("s-9")],
        linked: false,
      });

      // s-9 holds a paid price too, but no written tier starts selling it.
      await expect(
        run([{ before: null, after: tier() }]),
      ).rejects.toMatchObject({
        code: "PAID_TICKETING_REQUIRES_STRIPE",
        meta: {
          cause: "stored_seat_price",
          seatSectionIds: ["s-1"],
          invalidSeatSectionIds: [],
        },
      });
    });

    it("a corrupt value alone: cause seat_price_override_invalid", async () => {
      const { run } = harness({ overrides: [corruptAt("s-1")], feePolicy: false });

      await expect(
        run([{ before: null, after: tier() }]),
      ).rejects.toMatchObject({
        code: "PAID_TICKETING_REQUIRES_FEE_POLICY",
        meta: {
          cause: "seat_price_override_invalid",
          seatSectionIds: ["s-1"],
          invalidSeatSectionIds: ["s-1"],
        },
      });
    });

    it("a paid price and a corrupt value: every section, the corrupt ones marked", async () => {
      const { run } = harness({
        overrides: [corruptAt("s-2"), paidAt("s-1")],
        linked: false,
      });

      await expect(
        run([
          { before: null, after: tier() },
          { before: null, after: tier({ seatSectionId: "s-2" }) },
        ]),
      ).rejects.toMatchObject({
        code: "PAID_TICKETING_REQUIRES_STRIPE",
        meta: {
          cause: "stored_seat_price",
          seatSectionIds: ["s-1", "s-2"],
          invalidSeatSectionIds: ["s-2"],
        },
      });
    });

    it("any other failure passes through untouched", async () => {
      const { run, mocks } = harness({ overrides: [paidAt("s-1")] });
      const down = new Error("connection reset");
      mocks.payees.getBySubject.mockRejectedValue(down);

      await expect(run([{ before: null, after: tier() }])).rejects.toBe(down);
    });
  });

  it("on a DRAFT event counts a tier whatever its status", async () => {
    const { run } = harness({ overrides: [paidAt("s-1")], linked: false });

    await expect(
      run([{ before: null, after: tier({ status: "DRAFT" }) }], {
        ...EVENT,
        status: "DRAFT",
      } as EventRecord),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
  });
});
