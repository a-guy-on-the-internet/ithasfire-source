import { describe, expect, it } from "vitest";

import {
  checkoutUrlSnapshot,
  mergeCheckoutSearch,
  readCheckoutSearch,
  stashSignInAmounts,
  takeSignInAmounts,
} from "./checkout-url-state";

describe("mergeCheckoutSearch", () => {
  it("serializes the cart on top of an empty search", () => {
    const result = mergeCheckoutSearch("", {
      step: "selecting",
      quantities: { "tt-1": 2 },
      promoCodes: [],
    });
    expect(result).toBe("step=selecting&t=tt-1%3A2");
  });

  it("accepts a leading '?' and preserves unrelated params", () => {
    const result = mergeCheckoutSearch("?ref=abc&resume=order-9", {
      step: "selecting",
      quantities: { "tt-1": 2 },
      promoCodes: ["EARLYBIRD"],
    });
    const params = new URLSearchParams(result);
    expect(params.get("ref")).toBe("abc");
    expect(params.get("resume")).toBe("order-9");
    expect(params.get("step")).toBe("selecting");
    expect(params.get("t")).toBe("tt-1:2");
    expect(params.get("p")).toBe("EARLYBIRD");
  });

  it("replaces stale cart keys wholesale", () => {
    const result = mergeCheckoutSearch("step=payment&t=tt-old:9&p=OLD", {
      step: "details",
      quantities: { "tt-new": 1 },
      promoCodes: [],
    });
    const params = new URLSearchParams(result);
    expect(params.get("step")).toBe("details");
    expect(params.get("t")).toBe("tt-new:1");
    expect(params.get("p")).toBeNull();
  });

  it("round-trips through readCheckoutSearch (sign-in redirect survives)", () => {
    // This is the Bug-2 path: the redirect handed to /sign-in must carry the
    // serialized cart so the buyer's selection survives the auth round trip.
    const search = mergeCheckoutSearch("", {
      step: "selecting",
      quantities: { "tt-1": 2, "tt-2": 1 },
      promoCodes: ["STUDENT"],
    });
    const restored = readCheckoutSearch(new URLSearchParams(search));
    expect(restored.step).toBe("selecting");
    expect(restored.quantities).toEqual({ "tt-1": 2, "tt-2": 1 });
    expect(restored.promoCodes).toEqual(["STUDENT"]);
  });
});

describe("pay-what-you-want amounts (sign-in round trip only)", () => {
  it("the sign-in redirect carries a NONCE, never an amount", () => {
    const token = stashSignInAmounts({ "tt-pwyw": 5000 })!;
    const search = mergeCheckoutSearch("", {
      step: "selecting",
      quantities: { "tt-pwyw": 1 },
      promoCodes: [],
      amountsToken: token,
    });
    expect(search).toContain(`a=${token}`);
    expect(search).not.toContain("5000");
    const read = readCheckoutSearch(new URLSearchParams(search));
    expect(takeSignInAmounts(read.amountsToken)).toEqual({ "tt-pwyw": 5000 });
  });

  it("stashing clears earlier stashes (only the latest round trip is live)", () => {
    window.sessionStorage.setItem("unrelated", "keep");
    const first = stashSignInAmounts({ "tt-pwyw": 1000 })!;
    const second = stashSignInAmounts({ "tt-pwyw": 2000 })!;
    const keys = Array.from({ length: window.sessionStorage.length }, (_, i) =>
      window.sessionStorage.key(i),
    ).filter((key) => key?.startsWith("checkout:pwyw-amounts:"));
    expect(keys).toEqual([`checkout:pwyw-amounts:${second}`]);
    expect(takeSignInAmounts(first)).toEqual({});
    expect(takeSignInAmounts(second)).toEqual({ "tt-pwyw": 2000 });
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
  });

  it("stashing NOTHING still clears an earlier stash", () => {
    const earlier = stashSignInAmounts({ "tt-pwyw": 1000 })!;
    expect(stashSignInAmounts({})).toBeNull();
    expect(takeSignInAmounts(earlier)).toEqual({});
  });

  it("the stash is single-use: a second take (a reload, a shared copy) finds nothing", () => {
    const token = stashSignInAmounts({ "tt-pwyw": 5000 })!;
    expect(takeSignInAmounts(token)).toEqual({ "tt-pwyw": 5000 });
    expect(takeSignInAmounts(token)).toEqual({});
  });

  it("regression: a crafted `a=` link pre-fills nothing", () => {
    // The round-1 wire format, and a guessed nonce: neither was stashed here.
    for (const crafted of ["tt-pwyw%3A999999", "not-a-real-token"]) {
      const read = readCheckoutSearch(
        new URLSearchParams(`t=tt-pwyw%3A1&a=${crafted}`),
      );
      expect(takeSignInAmounts(read.amountsToken)).toEqual({});
    }
  });

  it("the continuous URL sync (no token in its snapshot) STRIPS `a`", () => {
    const search = mergeCheckoutSearch("?a=some-token&ref=abc", {
      step: "selecting",
      quantities: { "tt-pwyw": 1 },
      promoCodes: [],
    });
    expect(search).not.toContain("a=");
    expect(search).toContain("ref=abc");
  });

  it("a tampered stash is filtered like any input: malformed / over-cap dropped", () => {
    window.sessionStorage.setItem(
      "checkout:pwyw-amounts:tampered",
      "ok:1500,neg:-5,big:1000001,junk:abc,cap:1000000",
    );
    expect(takeSignInAmounts("tampered")).toEqual({
      ok: 1500,
      cap: 1_000_000,
    });
  });
});

describe("the confirmed URL (`step=confirmed&order=`)", () => {
  const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const CART = { quantities: { "tt-1": 2 }, promoCodes: ["EARLYBIRD"] };

  it.each(["confirmed", "done"] as const)(
    "a %s phase with an order names the order and drops t/p/a",
    (phase) => {
      const search = mergeCheckoutSearch(
        "?step=payment&t=tt-1%3A2&p=EARLYBIRD&a=tok&ref=abc",
        checkoutUrlSnapshot({ phase, orderId: ORDER_ID, ...CART }),
      );
      const params = new URLSearchParams(search);
      expect(params.get("step")).toBe("confirmed");
      expect(params.get("order")).toBe(ORDER_ID);
      expect(params.has("t")).toBe(false);
      expect(params.has("p")).toBe(false);
      expect(params.has("a")).toBe(false);
      // Params other code owns are kept.
      expect(params.get("ref")).toBe("abc");
    },
  );

  it("round-trips: the written URL reads back as the order, no cart", () => {
    const search = mergeCheckoutSearch(
      "",
      checkoutUrlSnapshot({ phase: "confirmed", orderId: ORDER_ID, ...CART }),
    );
    expect(search).toBe(`step=confirmed&order=${ORDER_ID}`);
    const read = readCheckoutSearch(new URLSearchParams(search));
    expect(read.step).toBe("confirmed");
    expect(read.orderId).toBe(ORDER_ID);
    expect(read.quantities).toEqual({});
    expect(read.promoCodes).toEqual([]);
  });

  it("a confirmed phase with no order id keeps the old shape (no step)", () => {
    const snapshot = checkoutUrlSnapshot({
      phase: "confirmed",
      orderId: null,
      ...CART,
    });
    expect(snapshot.step).toBeNull();
    expect(mergeCheckoutSearch("", snapshot)).not.toContain("order=");
  });

  it("an in-progress phase writes no order, even when one is held", () => {
    const search = mergeCheckoutSearch(
      `?step=confirmed&order=${ORDER_ID}`,
      checkoutUrlSnapshot({ phase: "held", orderId: ORDER_ID, ...CART }),
    );
    const params = new URLSearchParams(search);
    expect(params.get("step")).toBe("details");
    expect(params.has("order")).toBe(false);
    expect(params.get("t")).toBe("tt-1:2");
  });

  it.each([
    ["not a uuid", "step=confirmed&order=not-a-uuid&t=tt-1%3A2"],
    ["empty", "step=confirmed&order=&t=tt-1%3A2"],
    ["missing", "step=confirmed&t=tt-1%3A2"],
    ["injected", `step=confirmed&order=${ORDER_ID}%27%20OR%201%3D1&t=tt-1%3A2`],
    // Hex-shaped, but no RFC version/variant: the server's uuid() refuses it.
    ["crafted all-d", "step=confirmed&order=dddddddd-dddd-dddd-dddd-dddddddddddd&t=tt-1%3A2"],
  ])("an invalid order id (%s) is ignored: no step, the cart reads", (_, q) => {
    const read = readCheckoutSearch(new URLSearchParams(q));
    expect(read.orderId).toBeNull();
    expect(read.step).toBeNull();
    expect(read.quantities).toEqual({ "tt-1": 2 });
  });

  it("`order` without `step=confirmed` is ignored", () => {
    const read = readCheckoutSearch(
      new URLSearchParams(`step=details&order=${ORDER_ID}`),
    );
    expect(read.step).toBe("details");
    expect(read.orderId).toBeNull();
  });

  it("the cart sync strips a stale `order` once the page is back on a step", () => {
    const search = mergeCheckoutSearch(`?step=confirmed&order=${ORDER_ID}`, {
      step: "selecting",
      quantities: {},
      promoCodes: [],
    });
    expect(search).toBe("step=selecting");
  });
});
