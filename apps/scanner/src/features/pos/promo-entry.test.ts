import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_PROMO_STATE,
  MAX_PROMO_CODES,
  PROMO_PREVIEW_DEBOUNCE_MS,
  cartKeyOf,
  createPromoController,
  normalizePromoCode,
  promoCodesForSale,
  promoErrorMessage,
  saleErrorMessage,
  selectCartTotals,
  type PromoApplication,
  type PromoPreviewOutput,
  type PromoPreviewRequest,
  type PromoState,
} from "./promo-entry";

const EVENT_ID = "11111111-1111-1111-1111-111111111111";
const GA = "22222222-2222-2222-2222-222222222222";
const VIP = "33333333-3333-3333-3333-333333333333";

const application = (
  over: Partial<PromoApplication> & { normalizedCode: string },
): PromoApplication => ({
  code: over.normalizedCode,
  promoId: "44444444-4444-4444-4444-444444444444",
  kind: "AMOUNT",
  value: 1_000,
  scope: "EVENT",
  discountCents: 1_000,
  stackable: true,
  isPublic: true,
  ...over,
});

const previewOutput = (
  applications: PromoApplication[],
  orderSubtotalCents = 6_000,
): PromoPreviewOutput => ({
  applications,
  totalDiscountCents: applications.reduce((n, a) => n + a.discountCents, 0),
  orderSubtotalCents,
});

/** Use-case errors arrive as `TRPCClientError` — a plain `.message` carrier. */
const serverError = (message: string) => Object.assign(new Error(message));

function harness(
  preview: (req: PromoPreviewRequest) => Promise<PromoPreviewOutput>,
) {
  const requests: PromoPreviewRequest[] = [];
  const states: PromoState[] = [];
  const controller = createPromoController({
    preview: (req) => {
      requests.push(req);
      return preview(req);
    },
    onChange: (s) => states.push(s),
  });
  return {
    controller,
    requests,
    states,
    get state() {
      return controller.getState();
    },
  };
}

const ctx = (selections: { ticketTypeId: string; qty: number }[]) => ({
  eventId: EVENT_ID,
  selections,
});

const CART_2GA = [{ ticketTypeId: GA, qty: 2 }];

describe("normalizePromoCode / cartKeyOf", () => {
  it("normalizes the way the server's preparePromoCodes does", () => {
    expect(normalizePromoCode("  door10 ")).toBe("DOOR10");
    expect(normalizePromoCode("   ")).toBe("");
  });

  it("produces an order-independent cart signature and drops zero lines", () => {
    expect(
      cartKeyOf([
        { ticketTypeId: VIP, qty: 1 },
        { ticketTypeId: GA, qty: 2 },
      ]),
    ).toBe(
      cartKeyOf([
        { ticketTypeId: GA, qty: 2 },
        { ticketTypeId: VIP, qty: 1 },
      ]),
    );
    expect(cartKeyOf([{ ticketTypeId: GA, qty: 0 }])).toBe("");
  });
});

describe("promoErrorMessage", () => {
  it("renders the typed server messages for an operator", () => {
    expect(promoErrorMessage(serverError("promo_not_found"))).toBe(
      "Code not recognised.",
    );
    expect(promoErrorMessage(serverError("promo_min_order_not_met"))).toBe(
      "Cart is below this code's minimum.",
    );
    expect(promoErrorMessage(serverError("promo_not_stackable"))).toBe(
      "That code can't be combined with another code.",
    );
    expect(promoErrorMessage(serverError("promo_max_redeemed"))).toBe(
      "That code has hit its redemption limit.",
    );
    expect(promoErrorMessage(serverError("promo_not_applicable"))).toBe(
      "That code doesn't apply to this cart.",
    );
    expect(promoErrorMessage(serverError("duplicate_promo"))).toBe(
      "That code is already applied.",
    );
  });

  it("never leaks an unmapped internal token, but keeps free-text messages", () => {
    expect(promoErrorMessage(serverError("promo_some_new_rule"))).toBe(
      "Couldn't apply that code. Try again.",
    );
    expect(promoErrorMessage(serverError("Network request failed"))).toBe(
      "Network request failed",
    );
    expect(promoErrorMessage(undefined)).toBe(
      "Couldn't apply that code. Try again.",
    );
  });
});

describe("selectCartTotals", () => {
  const applied = (over: Partial<PromoState>): PromoState => ({
    ...EMPTY_PROMO_STATE,
    codes: ["DOOR10"],
    totalDiscountCents: 1_000,
    previewedCartKey: cartKeyOf(CART_2GA),
    ...over,
  });

  it("subtracts the discount from the door subtotal", () => {
    const totals = selectCartTotals({
      subtotalCents: 6_000,
      cartKey: cartKeyOf(CART_2GA),
      promo: applied({}),
    });
    expect(totals).toEqual({
      subtotalCents: 6_000,
      discountCents: 1_000,
      totalCents: 5_000,
      isStale: false,
    });
  });

  it("clamps a discount larger than the cart to zero, never negative", () => {
    const totals = selectCartTotals({
      subtotalCents: 500,
      cartKey: cartKeyOf(CART_2GA),
      promo: applied({ totalDiscountCents: 1_000 }),
    });
    expect(totals.discountCents).toBe(500);
    expect(totals.totalCents).toBe(0);
  });

  it("flags stale when the cart moved past the previewed one", () => {
    expect(
      selectCartTotals({
        subtotalCents: 9_000,
        cartKey: cartKeyOf([{ ticketTypeId: GA, qty: 3 }]),
        promo: applied({}),
      }).isStale,
    ).toBe(true);
  });

  it("is never stale and never discounts with no codes applied", () => {
    const totals = selectCartTotals({
      subtotalCents: 6_000,
      cartKey: cartKeyOf(CART_2GA),
      promo: EMPTY_PROMO_STATE,
    });
    expect(totals).toEqual({
      subtotalCents: 6_000,
      discountCents: 0,
      totalCents: 6_000,
      isStale: false,
    });
  });
});

describe("promoCodesForSale", () => {
  it("omits the field entirely when nothing is applied", () => {
    expect(promoCodesForSale(EMPTY_PROMO_STATE)).toBeUndefined();
  });

  it("hands the sale mutations the applied codes", () => {
    expect(
      promoCodesForSale({ ...EMPTY_PROMO_STATE, codes: ["DOOR10", "STAFF"] }),
    ).toEqual(["DOOR10", "STAFF"]);
  });
});

describe("createPromoController — apply", () => {
  it("previews at DOOR pricing against the current cart and updates the total", async () => {
    const h = harness(async () =>
      previewOutput([application({ normalizedCode: "DOOR10" })]),
    );

    await h.controller.apply("door10", ctx(CART_2GA));

    expect(h.requests).toEqual([
      {
        eventId: EVENT_ID,
        codes: ["DOOR10"],
        ticketSelections: [{ ticketTypeId: GA, qty: 2 }],
        source: "manual",
        pricing: "DOOR",
      },
    ]);
    expect(h.state.codes).toEqual(["DOOR10"]);
    expect(h.state.totalDiscountCents).toBe(1_000);
    expect(h.state.error).toBeNull();
    expect(h.state.isPreviewing).toBe(false);

    const totals = selectCartTotals({
      subtotalCents: 6_000,
      cartKey: cartKeyOf(CART_2GA),
      promo: h.state,
    });
    expect(totals.totalCents).toBe(5_000);
    expect(totals.isStale).toBe(false);
  });

  it("shows the error inline and does NOT add a rejected code", async () => {
    const h = harness(async () => {
      throw serverError("promo_not_found");
    });

    await h.controller.apply("NOPE", ctx(CART_2GA));

    expect(h.state.codes).toEqual([]);
    expect(h.state.totalDiscountCents).toBe(0);
    expect(h.state.error).toBe("Code not recognised.");
    expect(h.state.isPreviewing).toBe(false);
  });

  it("keeps the previously-valid discount when a SECOND code is rejected", async () => {
    let call = 0;
    const h = harness(async () => {
      call += 1;
      if (call === 1)
        return previewOutput([application({ normalizedCode: "DOOR10" })]);
      throw serverError("promo_not_stackable");
    });

    await h.controller.apply("DOOR10", ctx(CART_2GA));
    await h.controller.apply("STAFF", ctx(CART_2GA));

    expect(h.state.codes).toEqual(["DOOR10"]);
    expect(h.state.totalDiscountCents).toBe(1_000);
    expect(h.state.error).toBe(
      "That code can't be combined with another code.",
    );
  });

  it("does nothing on empty / whitespace input", async () => {
    const h = harness(async () => previewOutput([]));
    await h.controller.apply("", ctx(CART_2GA));
    await h.controller.apply("   ", ctx(CART_2GA));
    expect(h.requests).toEqual([]);
    expect(h.states).toEqual([]);
  });

  it("rejects a duplicate code without a round trip", async () => {
    const h = harness(async () =>
      previewOutput([application({ normalizedCode: "DOOR10" })]),
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));
    await h.controller.apply("  door10 ", ctx(CART_2GA));
    expect(h.requests).toHaveLength(1);
    expect(h.state.error).toBe("That code is already applied.");
    expect(h.state.codes).toEqual(["DOOR10"]);
  });

  it("caps at the server's 4-code maximum", async () => {
    const codes = ["A", "B", "C", "D"];
    const h = harness(async (req) =>
      previewOutput(
        req.codes.map((c) =>
          application({ normalizedCode: c, discountCents: 100 }),
        ),
      ),
    );
    for (const code of codes) await h.controller.apply(code, ctx(CART_2GA));
    expect(h.state.codes).toHaveLength(MAX_PROMO_CODES);

    await h.controller.apply("E", ctx(CART_2GA));
    expect(h.requests).toHaveLength(MAX_PROMO_CODES);
    expect(h.state.codes).toEqual(codes);
    expect(h.state.error).toBe("Up to 4 promo codes per sale.");
  });

  it("refuses to preview against an empty cart (server requires >= 1 line)", async () => {
    const h = harness(async () => previewOutput([]));
    await h.controller.apply("DOOR10", ctx([]));
    expect(h.requests).toEqual([]);
    expect(h.state.error).toBe("Add tickets before applying a code.");
  });
});

describe("createPromoController — cart changes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-previews when the cart changes while codes are applied", async () => {
    const h = harness(async (req) =>
      previewOutput([
        application({
          normalizedCode: "HALF",
          kind: "PERCENT",
          value: 50,
          // PERCENT scales with the cart — the exact reason a stale preview
          // would misquote the operator.
          discountCents:
            req.ticketSelections.reduce((n, s) => n + s.qty, 0) * 1_500,
        }),
      ]),
    );

    await h.controller.apply("HALF", ctx(CART_2GA));
    expect(h.state.totalDiscountCents).toBe(3_000);

    const bigger = [{ ticketTypeId: GA, qty: 4 }];
    h.controller.syncCart(ctx(bigger));
    // Stale until the re-preview lands.
    expect(
      selectCartTotals({
        subtotalCents: 12_000,
        cartKey: cartKeyOf(bigger),
        promo: h.state,
      }).isStale,
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toMatchObject({
      codes: ["HALF"],
      ticketSelections: [{ ticketTypeId: GA, qty: 4 }],
      pricing: "DOOR",
    });
    expect(h.state.totalDiscountCents).toBe(6_000);
    expect(
      selectCartTotals({
        subtotalCents: 12_000,
        cartKey: cartKeyOf(bigger),
        promo: h.state,
      }).isStale,
    ).toBe(false);
  });

  it("coalesces a burst of stepper taps into a single preview", async () => {
    const h = harness(async () =>
      previewOutput([application({ normalizedCode: "DOOR10" })]),
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));

    for (const qty of [3, 4, 5, 6]) {
      h.controller.syncCart(ctx([{ ticketTypeId: GA, qty }]));
      await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS - 50);
    }
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.ticketSelections).toEqual([
      { ticketTypeId: GA, qty: 6 },
    ]);
  });

  it("does not re-request when the cart signature is unchanged", async () => {
    const h = harness(async () =>
      previewOutput([application({ normalizedCode: "DOOR10" })]),
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));
    h.controller.syncCart(ctx(CART_2GA));
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);
    expect(h.requests).toHaveLength(1);
  });

  it("drops the codes rather than showing a discount the sale won't honour", async () => {
    let call = 0;
    const h = harness(async () => {
      call += 1;
      if (call === 1)
        return previewOutput([application({ normalizedCode: "BIG20" })]);
      throw serverError("promo_min_order_not_met");
    });

    await h.controller.apply("BIG20", ctx([{ ticketTypeId: GA, qty: 4 }]));
    expect(h.state.totalDiscountCents).toBe(1_000);

    h.controller.syncCart(ctx([{ ticketTypeId: GA, qty: 1 }]));
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.state.codes).toEqual([]);
    expect(h.state.applications).toEqual([]);
    expect(h.state.totalDiscountCents).toBe(0);
    expect(h.state.error).toBe("Cart is below this code's minimum.");
    expect(promoCodesForSale(h.state)).toBeUndefined();
  });

  it("drops the codes when the cart is emptied, without a round trip", async () => {
    const h = harness(async () =>
      previewOutput([application({ normalizedCode: "DOOR10" })]),
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));

    h.controller.syncCart(ctx([]));
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.requests).toHaveLength(1);
    expect(h.state).toEqual(EMPTY_PROMO_STATE);
  });

  it("is inert when no codes are applied", async () => {
    const h = harness(async () => previewOutput([]));
    h.controller.syncCart(ctx(CART_2GA));
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);
    expect(h.requests).toEqual([]);
  });
});

describe("createPromoController — stale responses", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * First preview (the `apply`) settles immediately so a code is actually
   * applied; every later one is held open so two re-previews can be in flight
   * at once — the real shape of the race the qty steppers produce.
   */
  function overlappingHarness() {
    const held: {
      resolve: (o: PromoPreviewOutput) => void;
      reject: (e: unknown) => void;
    }[] = [];
    let first = true;
    const h = harness(() => {
      if (first) {
        first = false;
        return Promise.resolve(
          previewOutput([
            application({ normalizedCode: "DOOR10", discountCents: 1_000 }),
          ]),
        );
      }
      return new Promise<PromoPreviewOutput>((resolve, reject) => {
        held.push({ resolve, reject });
      });
    });
    // NOT `{ ...h, held }` — spreading would evaluate the `state` getter once
    // and freeze the initial snapshot.
    return {
      controller: h.controller,
      requests: h.requests,
      held,
      get state() {
        return h.controller.getState();
      },
    };
  }

  const CART_4 = [{ ticketTypeId: GA, qty: 4 }];
  const CART_6 = [{ ticketTypeId: GA, qty: 6 }];

  async function startTwoOverlappingPreviews(h: {
    controller: ReturnType<typeof createPromoController>;
  }) {
    await h.controller.apply("DOOR10", ctx(CART_2GA));
    h.controller.syncCart(ctx(CART_4));
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);
    h.controller.syncCart(ctx(CART_6));
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);
  }

  it("a slow earlier preview can never overwrite a newer one", async () => {
    const h = overlappingHarness();
    await startTwoOverlappingPreviews(h);
    expect(h.held).toHaveLength(2);

    // Newest lands first…
    h.held[1]!.resolve(
      previewOutput([
        application({ normalizedCode: "DOOR10", discountCents: 6_000 }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.totalDiscountCents).toBe(6_000);

    // …then the superseded qty-4 response arrives late and is discarded.
    h.held[0]!.resolve(
      previewOutput([
        application({ normalizedCode: "DOOR10", discountCents: 4_000 }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.totalDiscountCents).toBe(6_000);
    expect(h.state.previewedCartKey).toBe(cartKeyOf(CART_6));
  });

  it("a superseded FAILURE cannot wipe a newer successful discount", async () => {
    const h = overlappingHarness();
    await startTwoOverlappingPreviews(h);

    h.held[1]!.resolve(
      previewOutput([
        application({ normalizedCode: "DOOR10", discountCents: 2_500 }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(0);

    h.held[0]!.reject(serverError("promo_not_found"));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.state.codes).toEqual(["DOOR10"]);
    expect(h.state.totalDiscountCents).toBe(2_500);
    expect(h.state.error).toBeNull();
  });

  it("dispose() orphans an in-flight response", async () => {
    let resolve!: (o: PromoPreviewOutput) => void;
    const h = harness(
      () =>
        new Promise<PromoPreviewOutput>((r) => {
          resolve = r;
        }),
    );
    void h.controller.apply("DOOR10", ctx(CART_2GA));
    h.controller.dispose();
    resolve(previewOutput([application({ normalizedCode: "DOOR10" })]));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState().codes).toEqual([]);
  });
});

describe("createPromoController — remove / reset", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-previews the remaining codes when one is removed", async () => {
    const h = harness(async (req) =>
      previewOutput(
        req.codes.map((c) =>
          application({ normalizedCode: c, discountCents: 500 }),
        ),
      ),
    );
    await h.controller.apply("A", ctx(CART_2GA));
    await h.controller.apply("B", ctx(CART_2GA));
    expect(h.state.totalDiscountCents).toBe(1_000);

    await h.controller.remove("A", ctx(CART_2GA));
    expect(h.requests[2]?.codes).toEqual(["B"]);
    expect(h.state.codes).toEqual(["B"]);
    expect(h.state.totalDiscountCents).toBe(500);
  });

  it("clears without a round trip when the last code is removed", async () => {
    const h = harness(async () =>
      previewOutput([application({ normalizedCode: "DOOR10" })]),
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));
    await h.controller.remove("door10", ctx(CART_2GA));
    expect(h.requests).toHaveLength(1);
    expect(h.state).toEqual(EMPTY_PROMO_STATE);
  });

  it("ignores a remove for a code that isn't applied", async () => {
    const h = harness(async () =>
      previewOutput([application({ normalizedCode: "DOOR10" })]),
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));
    await h.controller.remove("OTHER", ctx(CART_2GA));
    expect(h.requests).toHaveLength(1);
    expect(h.state.codes).toEqual(["DOOR10"]);
  });

  it("reset() clears codes between sales and kills a pending re-preview", async () => {
    const h = harness(async () =>
      previewOutput([application({ normalizedCode: "DOOR10" })]),
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));
    h.controller.syncCart(ctx([{ ticketTypeId: GA, qty: 5 }]));

    h.controller.reset();
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.state).toEqual(EMPTY_PROMO_STATE);
    expect(promoCodesForSale(h.state)).toBeUndefined();
    expect(h.requests).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-healing staleness.
//
// Regression cover for a wedge found in review: the controller used to be
// purely edge-triggered by `syncCart`, so a cart change that landed WHILE a
// preview was in flight could leave `previewedCartKey` permanently behind the
// live cart with nothing scheduled. `isStale` then stuck true forever, which
// disables both sale CTAs — the door-sales screen deadlocks mid-queue with
// only "Total · updating" on screen and no way out but removing the chip.
// ─────────────────────────────────────────────────────────────────────────────

/** A promise the test resolves by hand, to hold a preview open mid-flight. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Harness whose controller can read a mutable "live" cart, as the screen does. */
function harnessWithLiveCart(
  preview: (req: PromoPreviewRequest) => Promise<PromoPreviewOutput>,
  initialCart: { ticketTypeId: string; qty: number }[],
) {
  const requests: PromoPreviewRequest[] = [];
  let liveCart = initialCart;
  const controller = createPromoController({
    preview: (req) => {
      requests.push(req);
      return preview(req);
    },
    onChange: () => {},
    getCart: () => ctx(liveCart),
  });
  return {
    controller,
    requests,
    setCart: (next: { ticketTypeId: string; qty: number }[]) => {
      liveCart = next;
      controller.syncCart(ctx(next));
    },
    get liveKey() {
      return cartKeyOf(liveCart);
    },
    get state() {
      return controller.getState();
    },
  };
}

describe("createPromoController — self-healing staleness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reconciles when the cart changes during the FIRST apply (wedge route A)", async () => {
    // The wedge: syncCart early-returns while `codes` is still empty, so the
    // cart change is invisible; the apply then commits against the old cart.
    const gate = deferred();
    let held = false;
    const h = harnessWithLiveCart(async () => {
      if (!held) {
        held = true;
        await gate.promise;
      }
      return previewOutput([application({ normalizedCode: "DOOR10" })]);
    }, CART_2GA);

    const applying = h.controller.apply("DOOR10", ctx(CART_2GA));
    // Cart moves while the apply is still in flight.
    h.setCart([{ ticketTypeId: GA, qty: 4 }]);
    gate.resolve();
    await applying;
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.state.codes).toEqual(["DOOR10"]);
    // The quote must have caught up with the cart the operator is looking at.
    expect(h.state.previewedCartKey).toBe(h.liveKey);
    expect(
      selectCartTotals({
        subtotalCents: 12_000,
        cartKey: h.liveKey,
        promo: h.state,
      }).isStale,
    ).toBe(false);
    expect(h.requests).toHaveLength(2);
  });

  it("reconciles when a second code is rejected after a cart change (wedge route B)", async () => {
    // The wedge: apply()'s invalidate() cancels the pending cart-sync timer,
    // and the keep-failure branch rewinds pendingCartKey to the OLD cart key.
    const h = harnessWithLiveCart(async (req) => {
      if (req.codes.includes("STAFF")) throw serverError("promo_not_stackable");
      return previewOutput([application({ normalizedCode: "DOOR10" })]);
    }, CART_2GA);

    await h.controller.apply("DOOR10", ctx(CART_2GA));
    h.setCart([{ ticketTypeId: GA, qty: 4 }]); // schedules a re-preview
    // …and within the debounce window the operator tries a second code.
    await h.controller.apply("STAFF", ctx([{ ticketTypeId: GA, qty: 4 }]));
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.state.codes).toEqual(["DOOR10"]); // rejected code not added
    expect(h.state.previewedCartKey).toBe(h.liveKey); // and not wedged
    expect(
      selectCartTotals({
        subtotalCents: 12_000,
        cartKey: h.liveKey,
        promo: h.state,
      }).isStale,
    ).toBe(false);
  });

  it("does not re-request when the cart returns to the already-quoted shape", async () => {
    // +1 then −1 leaves a settled quote valid; scheduling a round trip there
    // left a timer pending while isStale read false — CTAs live with a
    // re-preview about to fire under them.
    const h = harnessWithLiveCart(
      async () => previewOutput([application({ normalizedCode: "DOOR10" })]),
      CART_2GA,
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));
    expect(h.requests).toHaveLength(1);

    h.setCart([{ ticketTypeId: GA, qty: 3 }]);
    h.setCart(CART_2GA); // back to the quoted cart before the debounce fires
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.requests).toHaveLength(1);
    expect(h.state.previewedCartKey).toBe(cartKeyOf(CART_2GA));
  });

  it("drops the codes when the cart is emptied while a preview is in flight", async () => {
    const gate = deferred();
    let held = false;
    const h = harnessWithLiveCart(async () => {
      if (!held) {
        held = true;
        await gate.promise;
      }
      return previewOutput([application({ normalizedCode: "DOOR10" })]);
    }, CART_2GA);

    const applying = h.controller.apply("DOOR10", ctx(CART_2GA));
    h.setCart([]);
    gate.resolve();
    await applying;

    expect(h.state).toEqual(EMPTY_PROMO_STATE);
    expect(promoCodesForSale(h.state)).toBeUndefined();
  });
});

describe("selectCartTotals — in-flight gating", () => {
  it("is stale while previewing even when the previewed cart key matches", () => {
    // This is the guard that keeps both CTAs disabled during the first apply.
    const totals = selectCartTotals({
      subtotalCents: 6_000,
      cartKey: cartKeyOf(CART_2GA),
      promo: {
        ...EMPTY_PROMO_STATE,
        codes: ["DOOR10"],
        totalDiscountCents: 1_000,
        previewedCartKey: cartKeyOf(CART_2GA),
        isPreviewing: true,
      },
    });
    expect(totals.isStale).toBe(true);
  });
});

describe("promoErrorMessage — wire shapes", () => {
  it("prefers the stable data.appCode over the message", () => {
    const err = Object.assign(new Error("something internal"), {
      data: { appCode: "PROMO_MAX_REDEEMED" },
    });
    expect(promoErrorMessage(err)).toBe(
      "That code has hit its redemption limit.",
    );
  });

  it("maps fail()-shaped codes that arrive only as the message", () => {
    expect(promoErrorMessage(serverError("DUPLICATE_PROMO"))).toBe(
      "That code is already applied.",
    );
  });

  it("never renders a Zod issue dump to the operator", () => {
    const zodish = serverError(
      JSON.stringify(
        [{ code: "too_big", maximum: 64, path: ["codes", 0] }],
        null,
        2,
      ),
    );
    expect(promoErrorMessage(zodish)).toBe("Couldn't apply that code. Try again.");
  });

  it("still passes through short, actionable free text", () => {
    expect(promoErrorMessage(serverError("Network request failed"))).toBe(
      "Network request failed",
    );
  });
});

describe("createPromoController — reconcile termination", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("terminates (drops codes) when the reconciling re-preview itself fails", async () => {
    // The reconcile re-preview runs in "drop" mode, so a server that keeps
    // rejecting converges on "no codes" rather than re-arming forever.
    let calls = 0;
    const h = harnessWithLiveCart(async () => {
      calls += 1;
      if (calls === 1) {
        return previewOutput([application({ normalizedCode: "DOOR10" })]);
      }
      throw serverError("promo_min_order_not_met");
    }, CART_2GA);

    await h.controller.apply("DOOR10", ctx(CART_2GA));
    h.setCart([{ ticketTypeId: GA, qty: 1 }]);
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);
    // Let any (incorrectly) re-armed timer fire.
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS * 4);

    expect(h.state.codes).toEqual([]);
    expect(h.state.error).toBe("Cart is below this code's minimum.");
    expect(calls).toBe(2); // no retry storm
  });

  it("leaves no pending timer once the quote matches the live cart", async () => {
    const h = harnessWithLiveCart(
      async () => previewOutput([application({ normalizedCode: "DOOR10" })]),
      CART_2GA,
    );
    await h.controller.apply("DOOR10", ctx(CART_2GA));
    h.setCart([{ ticketTypeId: GA, qty: 4 }]);
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS + 1);

    expect(h.state.previewedCartKey).toBe(h.liveKey);
    const requestsAfterSettle = h.requests.length;
    // Nothing further may fire on its own.
    await vi.advanceTimersByTimeAsync(PROMO_PREVIEW_DEBOUNCE_MS * 10);
    expect(h.requests).toHaveLength(requestsAfterSettle);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("saleErrorMessage", () => {
  it("gives sale-specific copy instead of promo copy for a capacity failure", () => {
    expect(saleErrorMessage(serverError("TICKET_TYPE_TEMPORARILY_HELD"))).toBe(
      "Someone else is mid-sale on the last of these. Try again in a moment.",
    );
    expect(saleErrorMessage(serverError("TICKET_TYPE_SOLD_OUT"))).toBe(
      "That ticket type just sold out.",
    );
  });

  it("still resolves promo codes rejected at sale time", () => {
    expect(saleErrorMessage(serverError("promo_max_redeemed"))).toBe(
      "That code has hit its redemption limit.",
    );
  });

  it("falls back to sale copy, not promo copy, for an unknown code", () => {
    expect(saleErrorMessage(serverError("SOME_NEW_CODE"))).toBe(
      "Couldn't complete that sale. Try again.",
    );
  });

  it("ignores inherited Object.prototype keys", () => {
    expect(saleErrorMessage(serverError("constructor"))).toBe(
      "Couldn't complete that sale. Try again.",
    );
    expect(promoErrorMessage(serverError("toString"))).toBe(
      "Couldn't apply that code. Try again.",
    );
  });
});
