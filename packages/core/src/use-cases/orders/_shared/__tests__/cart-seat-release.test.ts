import { describe, expect, it } from "vitest";

import {
  ORDER_HOLD_TTL_SECONDS,
  SEAT_FENCE_SLACK_SECONDS,
  collectSeatIds,
  resolveSeatHoldFence,
} from "../cart-seat-release";

const HELD_AT = new Date("2024-02-01T00:00:00.000Z");
const at = (seconds: number) =>
  new Date(HELD_AT.getTime() + seconds * 1000);
const holdStampedAt = (instant: Date) =>
  new Date(instant.getTime() + ORDER_HOLD_TTL_SECONDS * 1000).toISOString();

describe("collectSeatIds", () => {
  it("collects, dedupes and preserves first-seen order", () => {
    expect(
      collectSeatIds([
        { meta: { seatIds: ["b", "a"] } },
        { meta: { seatIds: ["a", "c"] } },
      ]),
    ).toEqual(["b", "a", "c"]);
  });

  it("skips malformed entries instead of throwing", () => {
    // The strict twin (`extractSeatIdsFromMeta`) throws, which is right at
    // checkout and fatal on a release path: it would roll back a cancel that
    // was otherwise fine and wedge the cart forever.
    expect(
      collectSeatIds([
        { meta: null },
        { meta: "nope" },
        { meta: { seatIds: "not-an-array" } },
        { meta: { seatIds: [42, "", null, "ok"] } },
        {},
      ]),
    ).toEqual(["ok"]);
  });
});

describe("resolveSeatHoldFence", () => {
  it("falls back to occurredAt plus the slack for an unedited cart", () => {
    expect(
      resolveSeatHoldFence({
        occurredAt: HELD_AT,
        items: [{ meta: { seatIds: ["s1"] } }],
      }),
    ).toEqual(at(SEAT_FENCE_SLACK_SECONDS));
  });

  it("prefers the cart's LAST hold over occurredAt", () => {
    // `updateOrderItems` re-holds the seats on every edit and never rewrites
    // `occurredAt`. An `occurredAt`-only fence would decline the cart's own
    // seats on the very next edit, and `holdSeatsForCheckout` would then
    // refuse the buyer their own seat with `seat_unavailable`.
    const editedAt = at(300);
    expect(
      resolveSeatHoldFence({
        occurredAt: HELD_AT,
        items: [
          { meta: { seatIds: ["s1"], holdExpiresAt: holdStampedAt(editedAt) } },
        ],
      }),
    ).toEqual(new Date(editedAt.getTime() + SEAT_FENCE_SLACK_SECONDS * 1000));
  });

  it("takes the freshest hold across items", () => {
    const late = at(420);
    expect(
      resolveSeatHoldFence({
        occurredAt: HELD_AT,
        items: [
          { meta: { seatIds: ["s1"], holdExpiresAt: holdStampedAt(at(60)) } },
          { meta: { seatIds: ["s2"], holdExpiresAt: holdStampedAt(late) } },
          { meta: { seatIds: ["s3"] } },
        ],
      }),
    ).toEqual(new Date(late.getTime() + SEAT_FENCE_SLACK_SECONDS * 1000));
  });

  it("never moves the fence BACKWARDS past occurredAt", () => {
    // A stale/short `holdExpiresAt` must not shrink the fence below the
    // insert stamp, or an unedited cart would stop releasing its own seats.
    expect(
      resolveSeatHoldFence({
        occurredAt: HELD_AT,
        items: [
          {
            meta: {
              seatIds: ["s1"],
              holdExpiresAt: holdStampedAt(at(-600)),
            },
          },
        ],
      }),
    ).toEqual(at(SEAT_FENCE_SLACK_SECONDS));
  });

  it("ignores an unparseable holdExpiresAt", () => {
    expect(
      resolveSeatHoldFence({
        occurredAt: HELD_AT,
        items: [
          { meta: { seatIds: ["s1"], holdExpiresAt: "not a date" } },
          { meta: { seatIds: ["s2"], holdExpiresAt: 1234 } },
        ],
      }),
    ).toEqual(at(SEAT_FENCE_SLACK_SECONDS));
  });

  it("returns null when there is nothing to fence on", () => {
    // Callers MUST treat this as "release nothing and report". An
    // ownership-blind release is the double-sell the fence exists to prevent.
    expect(
      resolveSeatHoldFence({ items: [{ meta: { seatIds: ["s1"] } }] }),
    ).toBeNull();
    expect(
      resolveSeatHoldFence({
        occurredAt: new Date(NaN),
        items: [{ meta: { seatIds: ["s1"] } }],
      }),
    ).toBeNull();
    expect(
      resolveSeatHoldFence({ occurredAt: "2024-02-01", items: [] }),
    ).toBeNull();
  });

  it("keeps the fence strictly inside the seat-hold TTL", () => {
    // The property the whole design rests on: another buyer cannot stamp a
    // hold on one of our seats until the seat reaper has freed it, which is
    // SEAT_HOLD_TTL (900s) after our own stamp. The fence must land before
    // that, or it reaches a competing hold.
    const SEAT_HOLD_TTL_SECONDS = 900;
    expect(SEAT_FENCE_SLACK_SECONDS).toBeLessThan(SEAT_HOLD_TTL_SECONDS);

    const fence = resolveSeatHoldFence({
      occurredAt: HELD_AT,
      items: [{ meta: { seatIds: ["s1"] } }],
    })!;
    expect(fence.getTime()).toBeLessThan(
      at(SEAT_HOLD_TTL_SECONDS).getTime(),
    );
  });
});
