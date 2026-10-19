import { describe, expect, it } from "vitest";

import { CAPACITY_HELD_WINDOW_SECONDS } from "@th/core/use-cases/_helpers/assert-ticket-type-capacity";
import { CART_REAPER_PERIOD_SECONDS } from "@th/core/use-cases/orders/_shared/cart-reaper-cycle";
import { ORDER_HOLD_TTL_SECONDS } from "@th/core/use-cases/orders/_shared/cart-seat-release";
import { DEFAULT_CART_TTL_SECONDS } from "@th/core/use-cases/orders/release-expired-carts";

import en from "@/i18n/messages/en";
import es from "@/i18n/messages/es";

import {
  LEFT_ORDER_RESERVED_MINUTES,
  LEFT_ORDER_USUALLY_RESERVED_MINUTES,
  leftOrderReservedUntil,
  leftOrderUsuallyReleasedBy,
} from "./embed-payment-order";

/**
 * How long the embed says an order the buyer left can keep its tickets,
 * held to the server's own constants. The widget prints two clock times
 * worked out from these numbers ("usually go back on sale by … and can stay
 * reserved until …") and stops saying so when the later one is up, so a
 * change to the cart reaper's schedule or the capacity window that is not
 * carried here would make the widget state something false. This fails
 * instead.
 */
describe("the time an order left behind keeps its tickets, against the server's constants", () => {
  it("is the server's capacity window: an abandoned cart reserves against other buyers that long", () => {
    expect(LEFT_ORDER_RESERVED_MINUTES * 60).toBe(CAPACITY_HELD_WINDOW_SECONDS);
  });

  it("covers picked seats too: held until the cart reaper's first pass after the cart TTL, and one late pass", () => {
    const seatsFreedBySeconds =
      DEFAULT_CART_TTL_SECONDS + CART_REAPER_PERIOD_SECONDS;
    expect(LEFT_ORDER_RESERVED_MINUTES * 60).toBeGreaterThanOrEqual(
      seatsFreedBySeconds,
    );
    // Longer than the order's own countdown: the reason "until the time is
    // up" (the countdown) would be false.
    expect(seatsFreedBySeconds).toBeGreaterThan(ORDER_HOLD_TTL_SECONDS);
  });

  it("is counted from the order's creation: `holdExpiresAt` is creation plus the server's time to pay", () => {
    const createdAt = Date.parse("2026-10-10T18:00:00.000Z");
    const holdExpiresAt = new Date(
      createdAt + ORDER_HOLD_TTL_SECONDS * 1000,
    ).toISOString();

    expect(leftOrderReservedUntil(holdExpiresAt)).toBe(
      new Date(createdAt + CAPACITY_HELD_WINDOW_SECONDS * 1000).toISOString(),
    );
  });

  it("unknown or unreadable: no time is claimed", () => {
    expect(leftOrderReservedUntil(null)).toBeNull();
    expect(leftOrderReservedUntil("not a date")).toBeNull();
    expect(leftOrderUsuallyReleasedBy(null)).toBeNull();
    expect(leftOrderUsuallyReleasedBy("not a date")).toBeNull();
  });

  it("'usually' is the cart reaper on time: the cart TTL plus one reaper period after the order was created", () => {
    expect(LEFT_ORDER_USUALLY_RESERVED_MINUTES * 60).toBe(
      DEFAULT_CART_TTL_SECONDS + CART_REAPER_PERIOD_SECONDS,
    );
    // Later than the order's own countdown, earlier than the latest.
    expect(LEFT_ORDER_USUALLY_RESERVED_MINUTES * 60).toBeGreaterThan(
      ORDER_HOLD_TTL_SECONDS,
    );
    expect(LEFT_ORDER_USUALLY_RESERVED_MINUTES).toBeLessThan(
      LEFT_ORDER_RESERVED_MINUTES,
    );

    const createdAt = Date.parse("2026-10-10T18:00:00.000Z");
    const holdExpiresAt = new Date(
      createdAt + ORDER_HOLD_TTL_SECONDS * 1000,
    ).toISOString();
    expect(
      leftOrderUsuallyReleasedBy(leftOrderReservedUntil(holdExpiresAt)),
    ).toBe(
      new Date(
        createdAt +
          (DEFAULT_CART_TTL_SECONDS + CART_REAPER_PERIOD_SECONDS) * 1000,
      ).toISOString(),
    );
  });

  it("the copy takes both times as arguments, in both languages: no number is typed into a sentence", () => {
    for (const catalog of [en, es]) {
      const checkout = (
        catalog as unknown as Record<string, Record<string, string>>
      ).checkout!;
      expect(checkout.embedEarlierOrderReserved).toContain("{typicalTime}");
      expect(checkout.embedEarlierOrderReserved).toContain("{latestTime}");
      expect(checkout.embedEarlierOrderReserved).not.toMatch(/\d/);
      // The order still on the page makes no claim about the clean-up: a
      // change releases its tickets (embeds.releaseGuestOrder), so its
      // sentence takes the countdown and neither time.
      expect(checkout.embedTicketsReserved).toContain("{countdown}");
      expect(checkout.embedTicketsReserved).not.toContain("{typicalTime}");
      expect(checkout.embedTicketsReserved).not.toContain("{latestTime}");
      expect(checkout.embedTicketsReserved).not.toMatch(/\d/);
    }
  });
});
