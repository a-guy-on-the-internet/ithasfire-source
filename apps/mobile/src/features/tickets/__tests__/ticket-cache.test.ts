import { describe, expect, it } from "vitest";

// Imported from the codec, not `ticket-cache.ts`: the latter pulls in
// `expo-secure-store` → the React Native runtime, which vitest cannot
// transform. The split exists precisely so this stays testable.
import {
  CACHE_INDEX_KEY,
  cacheKeyFor,
  isValidOrderId,
  parseCachedOrderTickets,
  parseOrderIndex,
  serializeCachedOrderTickets,
  serializeOrderIndex,
} from "../ticket-cache-codec";

const ORDER_ID = "11111111-2222-3333-4444-555555555555";

const validBlob = JSON.stringify({
  orderId: ORDER_ID,
  cachedAt: "2026-07-30T00:00:00.000Z",
  tickets: [
    { id: "t1", code: "ABC123", status: "VALID", scannedAt: null },
    {
      id: "t2",
      code: "DEF456",
      status: "SCANNED",
      scannedAt: "2026-07-30T01:00:00.000Z",
    },
  ],
});

describe("parseCachedOrderTickets", () => {
  it("round-trips a well-formed entry", () => {
    const parsed = parseCachedOrderTickets(validBlob, ORDER_ID);

    expect(parsed).not.toBeNull();
    expect(parsed?.orderId).toBe(ORDER_ID);
    expect(parsed?.tickets).toHaveLength(2);
    expect(parsed?.tickets[0]).toEqual({
      id: "t1",
      code: "ABC123",
      status: "VALID",
      scannedAt: null,
    });
  });

  it("rejects an entry cached under a different order", () => {
    // Guards against a key collision handing one order's codes to another.
    expect(
      parseCachedOrderTickets(validBlob, "99999999-9999-9999-9999-999999999999"),
    ).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    // The pass screen is being held up at a door; a corrupt cache must
    // degrade to "no cache", never crash.
    expect(() => parseCachedOrderTickets("{not json", ORDER_ID)).not.toThrow();
    expect(parseCachedOrderTickets("{not json", ORDER_ID)).toBeNull();
  });

  it("returns null when tickets is not an array", () => {
    const blob = JSON.stringify({
      orderId: ORDER_ID,
      cachedAt: "2026-07-30T00:00:00.000Z",
      tickets: "nope",
    });
    expect(parseCachedOrderTickets(blob, ORDER_ID)).toBeNull();
  });

  it("returns null when a ticket is missing its code", () => {
    const blob = JSON.stringify({
      orderId: ORDER_ID,
      cachedAt: "2026-07-30T00:00:00.000Z",
      tickets: [{ id: "t1", status: "VALID", scannedAt: null }],
    });
    expect(parseCachedOrderTickets(blob, ORDER_ID)).toBeNull();
  });

  it("returns null when cachedAt is absent", () => {
    const blob = JSON.stringify({
      orderId: ORDER_ID,
      tickets: [],
    });
    expect(parseCachedOrderTickets(blob, ORDER_ID)).toBeNull();
  });

  it("returns null for a JSON primitive", () => {
    expect(parseCachedOrderTickets("null", ORDER_ID)).toBeNull();
    expect(parseCachedOrderTickets('"a string"', ORDER_ID)).toBeNull();
    expect(parseCachedOrderTickets("42", ORDER_ID)).toBeNull();
  });

  it("accepts an order legitimately cached with zero tickets", () => {
    const blob = JSON.stringify({
      orderId: ORDER_ID,
      cachedAt: "2026-07-30T00:00:00.000Z",
      tickets: [],
    });
    const parsed = parseCachedOrderTickets(blob, ORDER_ID);
    expect(parsed).not.toBeNull();
    expect(parsed?.tickets).toEqual([]);
  });
});

describe("serializeCachedOrderTickets", () => {
  it("round-trips through the parser", () => {
    const serialized = serializeCachedOrderTickets(
      ORDER_ID,
      [{ id: "t1", code: "ABC123", status: "VALID", scannedAt: null }],
      "2026-07-30T00:00:00.000Z",
    );

    expect(parseCachedOrderTickets(serialized, ORDER_ID)).toEqual({
      orderId: ORDER_ID,
      cachedAt: "2026-07-30T00:00:00.000Z",
      // Undated unless the caller supplied an event start — see the eviction
      // tests in ticket-cache-eviction.test.ts.
      eventStartsAt: null,
      tickets: [
        { id: "t1", code: "ABC123", status: "VALID", scannedAt: null },
      ],
    });
  });

  it("drops fields outside the persisted subset", () => {
    // Guards against a wire-type change quietly widening what we write to the
    // keychain — extra PII should not ride along with the codes.
    const serialized = serializeCachedOrderTickets(
      ORDER_ID,
      [
        {
          id: "t1",
          code: "ABC123",
          status: "VALID",
          scannedAt: null,
          // @ts-expect-error deliberately passing an unmodelled field
          buyerEmail: "someone@example.com",
        },
      ],
      "2026-07-30T00:00:00.000Z",
    );

    expect(serialized).not.toContain("buyerEmail");
    expect(serialized).not.toContain("example.com");
  });
});

describe("cache keys", () => {
  it("namespaces and versions the key", () => {
    expect(cacheKeyFor(ORDER_ID)).toBe(`th.tickets.order.${ORDER_ID}.v1`);
  });

  it("accepts UUIDs and rejects ids SecureStore would choke on", () => {
    expect(isValidOrderId(ORDER_ID)).toBe(true);
    expect(isValidOrderId("order/../escape")).toBe(false);
    expect(isValidOrderId("has space")).toBe(false);
    expect(isValidOrderId("")).toBe(false);
  });

  it("keeps the index key distinct from any order key", () => {
    // A collision here would make the purge delete the index instead of an
    // entry, or vice versa.
    expect(CACHE_INDEX_KEY).not.toBe(cacheKeyFor(ORDER_ID));
  });
});

/**
 * The purge index is the ONLY handle on cached bearer credentials — SecureStore
 * has no key enumeration. If this codec loses ids, sign-out cannot delete the
 * codes they point at.
 */
describe("order index codec", () => {
  const OTHER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("round-trips ids", () => {
    expect(parseOrderIndex(serializeOrderIndex([ORDER_ID, OTHER_ID]))).toEqual([
      ORDER_ID,
      OTHER_ID,
    ]);
  });

  it("dedupes while preserving insertion order", () => {
    // Order matters: eviction drops from the front, so a reshuffle would evict
    // the wrong entry.
    expect(
      parseOrderIndex(serializeOrderIndex([ORDER_ID, OTHER_ID, ORDER_ID])),
    ).toEqual([ORDER_ID, OTHER_ID]);
  });

  it("drops ids SecureStore could not key on, in both directions", () => {
    expect(parseOrderIndex(serializeOrderIndex([ORDER_ID, "bad id"]))).toEqual([
      ORDER_ID,
    ]);
    expect(parseOrderIndex(JSON.stringify([ORDER_ID, "bad id"]))).toEqual([
      ORDER_ID,
    ]);
  });

  it("drops non-string entries", () => {
    expect(parseOrderIndex(JSON.stringify([ORDER_ID, 42, null, {}]))).toEqual([
      ORDER_ID,
    ]);
  });

  it("degrades a corrupt or absent index to empty rather than throwing", () => {
    // A wedged purge path would leave credentials undeletable forever, so
    // every malformed shape must resolve to "nothing indexed".
    expect(parseOrderIndex(null)).toEqual([]);
    expect(parseOrderIndex("")).toEqual([]);
    expect(parseOrderIndex("{not json")).toEqual([]);
    expect(parseOrderIndex('{"not":"an array"}')).toEqual([]);
    expect(parseOrderIndex("null")).toEqual([]);
    expect(() => parseOrderIndex("{not json")).not.toThrow();
  });

  it("stays well inside the SecureStore size advisory at the cap", () => {
    // 40 is MAX_INDEXED_ORDERS in ticket-cache.ts; the index is itself a
    // SecureStore value subject to the ~2KB limit.
    const ids = Array.from(
      { length: 40 },
      (_, i) => `${i.toString().padStart(8, "0")}-bbbb-cccc-dddd-eeeeeeeeeeee`,
    );
    expect(serializeOrderIndex(ids).length).toBeLessThan(2048);
  });
});
