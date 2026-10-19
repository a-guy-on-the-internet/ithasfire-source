import { describe, expect, it } from "vitest";

import {
  buildTicketCardMeta,
  resolvePriceHeadline,
  type TicketCardMetaInput,
} from "../TicketTypeEditor";

// Stand-ins for the component's injected formatters. `price` mirrors the
// `formatPrice` helper (free -> "Free", else "$X.XX"); `cap` mirrors the
// `admin.ttCapacityCount` i18n string ("N available").
const price = (cents: number) =>
  cents === 0 ? "Free" : `$${(cents / 100).toFixed(2)}`;
const cap = (capacity: number) => `${capacity} available`;

// `resaleEnabled` is REQUIRED — it used to be optional with a `?? true`
// fallback, so a caller that omitted it printed "Resale allowed" while the
// feature was switched off. These non-resale cases pass the gate OFF, which is
// the real-world default.
const GATE_OFF = { resaleEnabled: false } as const;
const GATE_ON = { resaleEnabled: true } as const;

const base: TicketCardMetaInput = {
  pricingMode: "FIXED",
  priceCents: 2500,
  capacity: 100,
  resaleAllowed: false,
  resaleCapCents: null,
  minimumCents: null,
  suggestedCents: null,
};

describe("buildTicketCardMeta", () => {
  it("composes price and capacity for a fixed-price ticket", () => {
    expect(buildTicketCardMeta(base, price, cap, GATE_OFF)).toBe(
      "$25.00 · 100 available",
    );
  });

  it("renders Free for a zero-price ticket", () => {
    expect(
      buildTicketCardMeta({ ...base, priceCents: 0 }, price, cap, GATE_OFF),
    ).toBe("Free · 100 available");
  });

  it("summarises pay-what-you-want pricing with min and suggested", () => {
    const meta = buildTicketCardMeta(
      {
        ...base,
        pricingMode: "ADJUSTABLE",
        priceCents: 0,
        minimumCents: 500,
        suggestedCents: 1500,
      },
      price,
      cap,
      GATE_OFF,
    );
    expect(meta).toBe(
      "Pay What You Want (min $5.00) · suggested $15.00 · 100 available",
    );
  });

  it("appends a resale note with the cap when resale is allowed", () => {
    const meta = buildTicketCardMeta(
      { ...base, resaleAllowed: true, resaleCapCents: 4000 },
      price,
      cap,
      GATE_ON,
    );
    expect(meta).toBe("$25.00 · 100 available · Resale allowed (cap: $40.00)");
  });

  it("appends a resale note without a cap when none is set", () => {
    const meta = buildTicketCardMeta(
      { ...base, resaleAllowed: true, resaleCapCents: null },
      price,
      cap,
      GATE_ON,
    );
    expect(meta).toBe("$25.00 · 100 available · Resale allowed");
  });

  it("suppresses the resale note when the resale feature gate is off", () => {
    const meta = buildTicketCardMeta(
      { ...base, resaleAllowed: true, resaleCapCents: 4000 },
      price,
      cap,
      GATE_OFF,
    );
    expect(meta).toBe("$25.00 · 100 available");
  });

  it("keeps the resale note when the gate is explicitly on", () => {
    const meta = buildTicketCardMeta(
      { ...base, resaleAllowed: true, resaleCapCents: null },
      price,
      cap,
      GATE_ON,
    );
    expect(meta).toBe("$25.00 · 100 available · Resale allowed");
  });

  it("suppresses the resale note for a ticket saved with a cap while the gate is off", () => {
    // The stored value is untouched by gating — a ticket that was configured
    // for resale before the flag went off must still render no resale text,
    // cap included. This is the case the old `?? true` default got wrong.
    const meta = buildTicketCardMeta(
      { ...base, resaleAllowed: true, resaleCapCents: 4000 },
      price,
      cap,
      GATE_OFF,
    );
    expect(meta).not.toContain("Resale");
    expect(meta).not.toContain("40.00");
  });
});

describe("resolvePriceHeadline — show what buyers are actually charged", () => {
  it("keeps the stored price when nothing has flipped", () => {
    expect(resolvePriceHeadline({ priceCents: 1200 })).toEqual({
      cents: 1200,
      wasCents: null,
    });
    expect(
      resolvePriceHeadline({ priceCents: 1200, effectivePriceCents: 1200 }),
    ).toEqual({ cents: 1200, wasCents: null });
  });

  it("promotes the effective price once a flip has fired, keeping the old one", () => {
    // The bug this exists to kill: the row read "$12" while the fee block two
    // lines below said "Buyer pays $21.xx" and buyers were charged $20.
    expect(
      resolvePriceHeadline({ priceCents: 1200, effectivePriceCents: 2000 }),
    ).toEqual({ cents: 2000, wasCents: 1200 });
  });

  it("promotes an effective price of 0 — a tier that has flipped to FREE", () => {
    // `== null`, never falsy. A falsy check here would show the stale $12 for
    // a tier that is now free.
    expect(
      resolvePriceHeadline({ priceCents: 1200, effectivePriceCents: 0 }),
    ).toEqual({ cents: 0, wasCents: 1200 });
  });

  it("promotes a flip UP from free", () => {
    expect(
      resolvePriceHeadline({ priceCents: 0, effectivePriceCents: 2000 }),
    ).toEqual({ cents: 2000, wasCents: 0 });
  });
});

describe("buildTicketCardMeta — the flipped price on the mobile card", () => {
  const base = {
    priceCents: 1200,
    capacity: 100,
    resaleAllowed: false,
  };
  // Local formatters: unlike the module-level `price`, $0 stays "$0.00" here so
  // a flip-to-free is legible as a number rather than the word "Free".
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const capacity = (n: number) => `${n} cap.`;

  it("leads with the effective price and names the former one", () => {
    expect(
      buildTicketCardMeta(
        { ...base, effectivePriceCents: 2000 },
        money,
        capacity,
        { resaleEnabled: false, wasLabel: (p) => `was ${p}` },
      ),
    ).toBe("$20.00 · was $12.00 · 100 cap.");
  });

  it("is unchanged when no flip has fired", () => {
    expect(
      buildTicketCardMeta(
        { ...base, effectivePriceCents: 1200 },
        money,
        capacity,
        { resaleEnabled: false },
      ),
    ).toBe("$12.00 · 100 cap.");
  });

  it("leaves Pay What You Want alone — it has no flip to show", () => {
    expect(
      buildTicketCardMeta(
        { ...base, pricingMode: "ADJUSTABLE", effectivePriceCents: 2000 },
        money,
        capacity,
        { resaleEnabled: false, wasLabel: (p) => `was ${p}` },
      ),
    ).toBe("Pay What You Want · 100 cap.");
  });
});
