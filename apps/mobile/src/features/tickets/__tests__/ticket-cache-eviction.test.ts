import { describe, expect, it } from "vitest";

import {
  EVICT_AFTER_EVENT_DAYS,
  EVICT_UNDATED_AFTER_DAYS,
  isExpiredCacheEntry,
  parseCachedOrderTickets,
  serializeCachedOrderTickets,
} from "../ticket-cache-codec";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const iso = (offsetDays: number) =>
  new Date(NOW + offsetDays * DAY).toISOString();

describe("isExpiredCacheEntry — dated entries", () => {
  it("keeps an entry for a future event, however long ago it was cached", () => {
    // THE case this whole design exists for: buy sixty days out, don't reopen
    // the app until the night of the show. A cache-age TTL would have dropped
    // these codes at exactly the moment they are needed.
    expect(
      isExpiredCacheEntry(
        { cachedAt: iso(-60), eventStartsAt: iso(1) },
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps an entry through the grace period after the event", () => {
    expect(
      isExpiredCacheEntry(
        { cachedAt: iso(-10), eventStartsAt: iso(-EVICT_AFTER_EVENT_DAYS + 1) },
        NOW,
      ),
    ).toBe(false);
  });

  it("drops an entry once the grace period has passed", () => {
    expect(
      isExpiredCacheEntry(
        { cachedAt: iso(-10), eventStartsAt: iso(-EVICT_AFTER_EVENT_DAYS - 1) },
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps an entry for an event happening right now", () => {
    expect(
      isExpiredCacheEntry({ cachedAt: iso(-1), eventStartsAt: iso(0) }, NOW),
    ).toBe(false);
  });
});

describe("isExpiredCacheEntry — undated entries", () => {
  it("keeps a recently cached entry with no event date", () => {
    expect(
      isExpiredCacheEntry({ cachedAt: iso(-30), eventStartsAt: null }, NOW),
    ).toBe(false);
  });

  it("drops an undated entry past the backstop", () => {
    expect(
      isExpiredCacheEntry(
        { cachedAt: iso(-EVICT_UNDATED_AFTER_DAYS - 1), eventStartsAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it("uses a backstop long enough to outlive any real on-sale-to-doors gap", () => {
    // Guards against someone "tidying" this into a normal 30-day TTL, which
    // would silently break the far-future-purchase case above.
    expect(EVICT_UNDATED_AFTER_DAYS).toBeGreaterThan(365);
  });
});

describe("isExpiredCacheEntry — corrupt input", () => {
  it("evicts rather than retaining credentials on an unparseable date", () => {
    expect(
      isExpiredCacheEntry({ cachedAt: "not-a-date", eventStartsAt: null }, NOW),
    ).toBe(true);
  });

  it("falls back to cachedAt when the event date is unparseable", () => {
    expect(
      isExpiredCacheEntry(
        { cachedAt: iso(-1), eventStartsAt: "garbage" },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("eventStartsAt round-trip", () => {
  it("persists and reads back the event date", () => {
    const blob = serializeCachedOrderTickets(
      "order-1",
      [{ id: "t1", code: "AAA", status: "VALID", scannedAt: null }],
      iso(0),
      iso(5),
    );
    expect(parseCachedOrderTickets(blob, "order-1")?.eventStartsAt).toBe(iso(5));
  });

  it("treats a legacy entry with no eventStartsAt as undated, not corrupt", () => {
    // Entries written before eviction existed must still load — dropping them
    // would take working offline passes away on upgrade.
    const legacy = JSON.stringify({
      orderId: "order-1",
      cachedAt: iso(-1),
      tickets: [{ id: "t1", code: "AAA", status: "VALID", scannedAt: null }],
    });
    const parsed = parseCachedOrderTickets(legacy, "order-1");
    expect(parsed).not.toBeNull();
    expect(parsed?.eventStartsAt).toBeNull();
    expect(isExpiredCacheEntry(parsed!, NOW)).toBe(false);
  });
});
