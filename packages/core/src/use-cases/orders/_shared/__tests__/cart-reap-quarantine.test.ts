import { describe, expect, it } from "vitest";

import { createCartReapQuarantine } from "../cart-reap-quarantine";
import { CART_REAPER_PERIOD_SECONDS } from "../cart-reaper-cycle";

const T0 = new Date("2024-02-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("createCartReapQuarantine", () => {
  it("holds nothing until something is refused", () => {
    const q = createCartReapQuarantine();
    expect(q.active(T0)).toEqual([]);
    expect(q.size()).toBe(0);
  });

  it("a first backoff lapses well inside one reaper period", () => {
    // Money: a cart's tickets stay reserved for TTL + 2 reaper periods. A
    // first-strike cooldown as long as a period could make the cart sit out
    // the next tick (which may start a little earlier in its slot) and be
    // reaped after its reservation lapsed. Keep the default base short.
    const q = createCartReapQuarantine();
    q.hold({ orderId: "order-1", now: T0, kind: "backoff" });

    expect(q.active(at(1))).toEqual(["order-1"]);
    expect(q.active(at(CART_REAPER_PERIOD_SECONDS / 2))).toEqual([]);
  });

  it("never releases a permanent hold on a cooldown", () => {
    // The buyer HAS paid: that order belongs to finalize and its DLQ, and no
    // number of retries will make its PaymentIntent cancellable. No cooldown,
    // however long, brings it back — only the stale sweep below does.
    const q = createCartReapQuarantine({ forgetAfterSeconds: 86_400 });
    q.hold({ orderId: "order-1", now: T0, kind: "permanent" });

    expect(q.active(at(1))).toEqual(["order-1"]);
    expect(q.active(at(6 * 60 * 60))).toEqual(["order-1"]);
    expect(q.active(at(86_400))).toEqual(["order-1"]);
  });

  it("re-admits a permanent entry once the forget window lapses", () => {
    // A permanent entry is never re-probed, so its `lastRefusedMs` is frozen
    // at the first refusal — which made it immortal while the stale sweep
    // lived in the lapsed branch that `untilMs === null` never reaches.
    //
    // The cost of that was not just a leaked slot. "Permanent" is a claim
    // about THIS process's ability to resolve the refusal, not about the
    // cart: an order that pays DURING a pass is scanned PENDING, refuses with
    // `succeeded`, and is quarantined permanent even though finalize then
    // completes it normally. Healthy traffic therefore drifted
    // `quarantinedCount` upward forever — and `releaseExpiredCartsOutput`
    // documents that gauge as THE wedge signal ("a number that only ever
    // grows"). Re-admitting after a day costs one probe.
    const q = createCartReapQuarantine({ forgetAfterSeconds: 86_400 });
    q.hold({ orderId: "paid-mid-pass", now: T0, kind: "permanent" });

    expect(q.active(at(86_400))).toEqual(["paid-mid-pass"]);
    expect(q.size()).toBe(1);

    expect(q.active(at(86_401))).toEqual([]);
    expect(q.size()).toBe(0);
  });

  it("keeps a genuinely wedged cart out of the scan between forget windows", () => {
    // Re-admission is one probe, not a return to 288 a day: the cart refuses
    // again and goes straight back into permanent quarantine.
    const q = createCartReapQuarantine({ forgetAfterSeconds: 86_400 });
    q.hold({ orderId: "wedged", now: T0, kind: "permanent" });

    expect(q.active(at(86_401))).toEqual([]);
    q.hold({ orderId: "wedged", now: at(86_401), kind: "permanent" });

    expect(q.active(at(86_402))).toEqual(["wedged"]);
    expect(q.active(at(86_401 + 86_400))).toEqual(["wedged"]);
  });

  it("releases a backoff hold once its cooldown lapses", () => {
    const q = createCartReapQuarantine({ baseCooldownSeconds: 300 });
    q.hold({ orderId: "order-1", now: T0, kind: "backoff" });

    expect(q.active(at(299))).toEqual(["order-1"]);
    expect(q.active(at(300))).toEqual([]);
  });

  it("doubles the cooldown on each consecutive refusal, up to the cap", () => {
    // The point is termination, not punishment: a cart that keeps failing
    // settles at a handful of probes a day instead of 288.
    const q = createCartReapQuarantine({
      baseCooldownSeconds: 100,
      maxCooldownSeconds: 400,
    });

    q.hold({ orderId: "order-1", now: T0, kind: "backoff" });
    expect(q.active(at(99))).toEqual(["order-1"]);
    expect(q.active(at(100))).toEqual([]);

    q.hold({ orderId: "order-1", now: at(100), kind: "backoff" });
    expect(q.active(at(299))).toEqual(["order-1"]);
    expect(q.active(at(300))).toEqual([]);

    q.hold({ orderId: "order-1", now: at(300), kind: "backoff" });
    expect(q.active(at(699))).toEqual(["order-1"]);
    expect(q.active(at(700))).toEqual([]);

    // Capped from here on.
    q.hold({ orderId: "order-1", now: at(700), kind: "backoff" });
    expect(q.active(at(1099))).toEqual(["order-1"]);
    expect(q.active(at(1100))).toEqual([]);
  });

  it("does not overflow the cooldown for a cart that has failed hundreds of times", () => {
    const q = createCartReapQuarantine({
      baseCooldownSeconds: 300,
      maxCooldownSeconds: 3600,
    });
    for (let i = 0; i < 500; i++) {
      q.hold({ orderId: "order-1", now: T0, kind: "backoff" });
    }
    expect(q.active(at(3599))).toEqual(["order-1"]);
    expect(q.active(at(3600))).toEqual([]);
  });

  it("resets the escalation when the cart is forgotten", () => {
    const q = createCartReapQuarantine({ baseCooldownSeconds: 100 });
    q.hold({ orderId: "order-1", now: T0, kind: "backoff" });
    q.hold({ orderId: "order-1", now: at(100), kind: "backoff" });
    q.forget("order-1");

    expect(q.size()).toBe(0);

    q.hold({ orderId: "order-1", now: at(1000), kind: "backoff" });
    // Back to the base cooldown, not the escalated one.
    expect(q.active(at(1099))).toEqual(["order-1"]);
    expect(q.active(at(1100))).toEqual([]);
  });

  it("drops a lapsed entry that has not been seen again for a day", () => {
    // Otherwise every cart that ever hiccupped is remembered for the life of
    // the process, including the ones that have since been finalized by hand.
    const q = createCartReapQuarantine({
      baseCooldownSeconds: 300,
      forgetAfterSeconds: 86_400,
    });
    q.hold({ orderId: "order-1", now: T0, kind: "backoff" });

    q.active(at(86_400));
    expect(q.size()).toBe(1);

    q.active(at(86_401));
    expect(q.size()).toBe(0);
  });

  it("evicts the least-recently-refused cart rather than growing without bound", () => {
    // Eviction only means that cart gets probed sooner — the safe direction.
    const q = createCartReapQuarantine({ maxEntries: 3 });
    q.hold({ orderId: "old", now: T0, kind: "permanent" });
    q.hold({ orderId: "b", now: at(10), kind: "permanent" });
    q.hold({ orderId: "c", now: at(20), kind: "permanent" });
    q.hold({ orderId: "d", now: at(30), kind: "permanent" });

    expect(q.size()).toBe(3);
    expect(q.active(at(40)).sort()).toEqual(["b", "c", "d"]);
  });

  it("sheds backoff entries before permanent ones when the map is full", () => {
    // Least-recently-refused ALONE is exactly backwards. A permanent entry is
    // never re-probed, so its stamp is frozen at first refusal, while a
    // backoff entry's is bumped on every re-refusal — so the minimum is
    // ALWAYS a permanent one, and a Stripe incident (a wave of backoff
    // refusals) would evict the paid-PI carts this module exists for first.
    // Here `paid` is the oldest entry by a mile and must survive anyway.
    const q = createCartReapQuarantine({
      maxEntries: 3,
      baseCooldownSeconds: 300,
    });
    q.hold({ orderId: "paid", now: T0, kind: "permanent" });
    q.hold({ orderId: "flap-1", now: at(100), kind: "backoff" });
    q.hold({ orderId: "flap-2", now: at(110), kind: "backoff" });
    q.hold({ orderId: "flap-3", now: at(120), kind: "backoff" });

    expect(q.size()).toBe(3);
    // The oldest BACKOFF went, not the oldest entry.
    expect(q.active(at(130)).sort()).toEqual(["flap-2", "flap-3", "paid"]);
  });

  it("falls back to evicting permanents only when no backoff entry is left", () => {
    const q = createCartReapQuarantine({ maxEntries: 2 });
    q.hold({ orderId: "paid-1", now: T0, kind: "permanent" });
    q.hold({ orderId: "paid-2", now: at(10), kind: "permanent" });
    q.hold({ orderId: "paid-3", now: at(20), kind: "permanent" });

    expect(q.size()).toBe(2);
    expect(q.active(at(30)).sort()).toEqual(["paid-2", "paid-3"]);
  });

  it("keeps the cart it was just handed even when the map is full", () => {
    const q = createCartReapQuarantine({ maxEntries: 1 });
    q.hold({ orderId: "a", now: T0, kind: "permanent" });
    q.hold({ orderId: "b", now: at(10), kind: "permanent" });

    expect(q.active(at(20))).toEqual(["b"]);
  });
});
