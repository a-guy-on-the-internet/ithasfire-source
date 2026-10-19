import { createTranslator } from "@th/locale";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  SEAT_PRICE_WRITE_CHUNK,
  addSaveCounts,
  chunkSeatIds,
  describeSaveOutcome,
  emptySaveCounts,
  forgetUnsent,
  saveInChunks,
  totalSkipped,
  type SaveCounts,
  type SaveOutcome,
} from "../seat-price-save";

const en = createTranslator("en", enMessages as never).t;
const es = createTranslator("es", esMessages as never).t;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const seatIds = (count: number) =>
  Array.from({ length: count }, (_, index) => `seat-${index + 1}`);

const counts = (
  updated: number,
  skipped: Partial<SaveCounts["skipped"]> = {},
): SaveCounts => ({
  updated,
  skipped: { sold: 0, held: 0, busy: 0, notFound: 0, ...skipped },
});

const outcome = (over: Partial<SaveOutcome> = {}): SaveOutcome => ({
  action: { kind: "set", priceCents: 6000 },
  counts: counts(0),
  unsentCount: 0,
  errorMessage: null,
  ...over,
});

describe("chunkSeatIds", () => {
  it("matches the server's limit of 500 seats per write", () => {
    expect(SEAT_PRICE_WRITE_CHUNK).toBe(500);
  });

  it.each([
    [0, []],
    [1, [1]],
    [500, [500]],
    [501, [500, 1]],
    [1000, [500, 500]],
    [1200, [500, 500, 200]],
  ])("splits %i seats into chunks of %j", (count, sizes) => {
    const chunks = chunkSeatIds(seatIds(count));
    expect(chunks.map((chunk) => chunk.length)).toEqual(sizes);
    // Every seat is sent once, in order.
    expect(chunks.flat()).toEqual(seatIds(count));
  });

  it("refuses a chunk size that would loop forever or send nothing", () => {
    expect(() => chunkSeatIds(["a"], 0)).toThrow();
    expect(() => chunkSeatIds(["a"], -1)).toThrow();
    expect(() => chunkSeatIds(["a"], 1.5)).toThrow();
  });
});

describe("save counts", () => {
  it("adds two results field by field", () => {
    expect(
      addSaveCounts(
        counts(3, { sold: 1, busy: 2 }),
        counts(4, { sold: 1, held: 5, notFound: 1 }),
      ),
    ).toEqual(counts(7, { sold: 2, held: 5, busy: 2, notFound: 1 }));
  });

  it("totals the four skip causes", () => {
    expect(totalSkipped(counts(9, { sold: 1, held: 2, busy: 3, notFound: 4 }))).toBe(10);
    expect(totalSkipped(emptySaveCounts())).toBe(0);
  });
});

describe("saveInChunks", () => {
  it("sends every chunk in order and adds up what each one reports", async () => {
    const write = vi.fn((chunk: string[]) =>
      Promise.resolve(counts(chunk.length - 1, { sold: 1 })),
    );
    const result = await saveInChunks(seatIds(1200), write);

    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.map(([chunk]) => chunk.length)).toEqual([500, 500, 200]);
    expect(result).toEqual({
      counts: counts(1197, { sold: 3 }),
      unsentSeatIds: [],
      error: null,
    });
  });

  it("sends one chunk at a time", async () => {
    let inFlight = 0;
    let most = 0;
    await saveInChunks(
      seatIds(6),
      async (chunk) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return counts(chunk.length);
      },
      2,
    );
    expect(most).toBe(1);
  });

  it("stops at the first failed chunk and reports what was saved and what was not", async () => {
    const boom = new Error("network down");
    const write = vi
      .fn<[chunk: string[]], Promise<SaveCounts>>()
      .mockResolvedValueOnce(counts(499, { held: 1 }))
      .mockRejectedValueOnce(boom);
    const all = seatIds(1200);

    const result = await saveInChunks(all, write);

    // The third chunk is never sent once the second has failed.
    expect(write).toHaveBeenCalledTimes(2);
    expect(result.counts).toEqual(counts(499, { held: 1 }));
    expect(result.error).toBe(boom);
    expect(result.unsentSeatIds).toEqual(all.slice(500));
    expect(result.unsentSeatIds).toHaveLength(700);
  });

  it("reports every seat as unsent when the first chunk fails", async () => {
    const result = await saveInChunks(seatIds(3), () =>
      Promise.reject(new Error("nope")),
    );
    expect(result.counts).toEqual(emptySaveCounts());
    expect(result.unsentSeatIds).toEqual(seatIds(3));
  });

  it("writes nothing for an empty selection", async () => {
    const write = vi.fn(() => Promise.resolve(counts(0)));
    const result = await saveInChunks([], write);
    expect(write).not.toHaveBeenCalled();
    expect(result).toEqual({ counts: emptySaveCounts(), unsentSeatIds: [], error: null });
  });
});

describe("describeSaveOutcome", () => {
  it("is a plain success only when every seat changed", () => {
    expect(describeSaveOutcome(outcome({ counts: counts(12) }), en, usd)).toEqual({
      tone: "success",
      title: "12 seats updated to $60.00.",
      skippedSummary: null,
      details: [],
      failure: null,
      failureReason: null,
    });
  });

  it("uses the singular for one seat", () => {
    expect(describeSaveOutcome(outcome({ counts: counts(1) }), en, usd).title).toBe(
      "1 seat updated to $60.00.",
    );
  });

  it("says a $0 price as the amount", () => {
    expect(
      describeSaveOutcome(
        outcome({ action: { kind: "set", priceCents: 0 }, counts: counts(2) }),
        en,
        usd,
      ).title,
    ).toBe("2 seats updated to $0.00.");
  });

  it("says seats went back to the section price after a clear", () => {
    const clear = { kind: "clear" } as const;
    expect(
      describeSaveOutcome(outcome({ action: clear, counts: counts(1) }), en, usd).title,
    ).toBe("1 seat now uses the section price.");
    expect(
      describeSaveOutcome(outcome({ action: clear, counts: counts(7) }), en, usd).title,
    ).toBe("7 seats now use the section price.");
  });

  it.each([
    [
      "sold",
      { sold: 1 },
      "1 skipped: 1 sold.",
      "The sold seat keeps its price.",
    ],
    [
      "sold, several",
      { sold: 3 },
      "3 skipped: 3 sold.",
      "Sold seats keep their price.",
    ],
    [
      "held",
      { held: 1 },
      "1 skipped: 1 in someone’s cart.",
      "The seat in a cart can change once that checkout ends, usually within minutes.",
    ],
    [
      "held, several",
      { held: 2 },
      "2 skipped: 2 in someone’s cart.",
      "Seats in a cart can change once those checkouts end, usually within minutes.",
    ],
    [
      "busy",
      { busy: 1 },
      "1 skipped: 1 being bought or edited right now.",
      "One seat was being bought or edited at that moment. Try again.",
    ],
    [
      "busy, several",
      { busy: 4 },
      "4 skipped: 4 being bought or edited right now.",
      "4 seats were being bought or edited at that moment. Try again.",
    ],
    [
      "not found",
      { notFound: 1 },
      "1 skipped: 1 no longer part of this event.",
      "One seat is no longer a seat of this event.",
    ],
    [
      "not found, several",
      { notFound: 2 },
      "2 skipped: 2 no longer part of this event.",
      "2 seats are no longer seats of this event.",
    ],
  ] as const)(
    "names a skip (%s) with its count and what it means",
    (_name, skipped, summary, detail) => {
      const view = describeSaveOutcome(outcome({ counts: counts(5, skipped) }), en, usd);
      expect(view.tone).toBe("warning");
      expect(view.title).toBe("5 seats updated to $60.00.");
      expect(view.skippedSummary).toBe(summary);
      expect(view.details).toEqual([detail]);
      expect(view.failure).toBeNull();
    },
  );

  it("lists several skip causes in one sentence, each with its own count", () => {
    const view = describeSaveOutcome(
      outcome({ counts: counts(12, { sold: 1, held: 1, busy: 2, notFound: 1 }) }),
      en,
      usd,
    );
    expect(view.tone).toBe("warning");
    expect(view.skippedSummary).toBe(
      "5 skipped: 1 sold, 1 in someone’s cart, 2 being bought or edited right now, 1 no longer part of this event.",
    );
    expect(view.details).toHaveLength(4);
  });

  it("never reads as a success when every seat was skipped", () => {
    const view = describeSaveOutcome(
      outcome({ counts: counts(0, { sold: 2, held: 1 }) }),
      en,
      usd,
    );
    expect(view.tone).toBe("warning");
    expect(view.title).toBe("No seats were changed.");
    expect(view.skippedSummary).toBe("3 skipped: 2 sold, 1 in someone’s cart.");
  });

  it("gives the reason alone when the whole save failed", () => {
    const view = describeSaveOutcome(
      outcome({ unsentCount: 12, errorMessage: "You’re offline. Try again." }),
      en,
      usd,
    );
    expect(view).toEqual({
      tone: "error",
      title: "Nothing was saved.",
      skippedSummary: null,
      details: [],
      failure: null,
      failureReason: "Reason: You’re offline. Try again.",
    });
  });

  it("says what was saved, what was skipped and what was not sent after a partial failure", () => {
    const view = describeSaveOutcome(
      outcome({
        counts: counts(499, { sold: 1 }),
        unsentCount: 700,
        errorMessage: "Something went wrong.",
      }),
      en,
      usd,
    );
    expect(view.tone).toBe("error");
    expect(view.title).toBe("499 seats updated to $60.00.");
    expect(view.skippedSummary).toBe("1 skipped: 1 sold.");
    expect(view.failure).toBe(
      "700 seats were not saved. They are still selected, so you can try again.",
    );
    // The reason stands on its own line: never spliced into the sentence,
    // where a message without a final period would run on.
    expect(view.failureReason).toBe("Reason: Something went wrong.");
  });

  it("uses the singular for one unsent seat", () => {
    const view = describeSaveOutcome(
      outcome({
        counts: counts(500),
        unsentCount: 1,
        errorMessage: "Something went wrong.",
      }),
      en,
      usd,
    );
    expect(view.failure).toBe(
      "1 seat was not saved. It is still selected, so you can try again.",
    );
    expect(view.failureReason).toBe("Reason: Something went wrong.");
  });

  it("writes the same result in Spanish", () => {
    const view = describeSaveOutcome(
      outcome({ counts: counts(12, { sold: 1, held: 1 }) }),
      es,
      usd,
    );
    expect(view.title).toBe("12 asientos actualizados a $60.00.");
    expect(view.skippedSummary).toBe(
      "2 omitidos: 1 vendido, 1 en el carrito de alguien.",
    );
    expect(view.details).toEqual([
      "El asiento vendido conserva su precio.",
      "El asiento en un carrito podrá cambiar cuando termine esa compra, normalmente en minutos.",
    ]);
  });
});

describe("forgetUnsent", () => {
  it("keeps the counts of a partial failure and drops the failure lines", () => {
    const failed = outcome({
      counts: counts(3, { sold: 1 }),
      unsentCount: 500,
      errorMessage: "No prices were saved.",
    });
    const kept = forgetUnsent(failed);
    expect(kept).not.toBeNull();
    const view = describeSaveOutcome(kept!, en, usd);
    expect(view.title).toBe("3 seats updated to $60.00.");
    expect(view.skippedSummary).toBe("1 skipped: 1 sold.");
    expect(view.failure).toBeNull();
    expect(view.failureReason).toBeNull();
    expect(view.tone).toBe("warning");
  });

  it("drops a result that was only the failure", () => {
    expect(
      forgetUnsent(outcome({ unsentCount: 4, errorMessage: "Offline." })),
    ).toBeNull();
  });

  it("leaves a result without a failure as it is", () => {
    const ok = outcome({ counts: counts(2) });
    expect(forgetUnsent(ok)).toBe(ok);
  });
});
