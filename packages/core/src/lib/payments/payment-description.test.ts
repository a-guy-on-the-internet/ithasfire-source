import { formatOrderCode } from "@th/types/order-identifier";
import { describe, expect, it } from "vitest";

import { buildPaymentDescription } from "./payment-description";

/**
 * A UUID whose HEAD and TAIL differ, so a test that passes here cannot be
 * satisfied by `id.slice(0, 8)`. The head is `db21b2c3`; the tail — the ONE
 * canonical order code — is `9f0a1b2c`.
 */
const ORDER_ID = "db21b2c3-1234-4234-8234-56789f0a1b2c";

/**
 * True when `value` contains a UTF-16 surrogate code unit that is not part of a
 * well-formed pair. `Array.from` iterates by CODE POINT, so a valid pair yields
 * one 2-unit element while an orphan half yields a lone 1-unit element in the
 * surrogate range.
 */
function hasUnpairedSurrogate(value: string): boolean {
  return Array.from(value).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
  });
}

describe("buildPaymentDescription", () => {
  it("renders a multi-ticket primary sale", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "Launch Party",
        orderId: ORDER_ID,
        ticketQuantity: 3,
        kind: "primary",
      }),
    ).toBe(`Launch Party — 3 tickets · Order ${formatOrderCode(ORDER_ID)}`);
  });

  it("singularises a one-ticket primary sale", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "Launch Party",
        orderId: ORDER_ID,
        ticketQuantity: 1,
        kind: "primary",
      }),
    ).toBe(`Launch Party — 1 ticket · Order ${formatOrderCode(ORDER_ID)}`);
  });

  it("labels a single resale ticket", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "Launch Party",
        orderId: ORDER_ID,
        ticketQuantity: 1,
        kind: "resale",
      }),
    ).toBe(
      `Launch Party — 1 resale ticket · Order ${formatOrderCode(ORDER_ID)}`,
    );
  });

  it("pluralises resale tickets", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "Launch Party",
        orderId: ORDER_ID,
        ticketQuantity: 2,
        kind: "resale",
      }),
    ).toBe(
      `Launch Party — 2 resale tickets · Order ${formatOrderCode(ORDER_ID)}`,
    );
  });

  it("adds a POS segment only on the card-present path", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "Launch Party",
        orderId: ORDER_ID,
        ticketQuantity: 2,
        kind: "pos",
      }),
    ).toBe(`Launch Party — 2 tickets · POS · Order ${formatOrderCode(ORDER_ID)}`);

    expect(
      buildPaymentDescription({
        eventTitle: "Launch Party",
        orderId: ORDER_ID,
        ticketQuantity: 2,
        kind: "primary",
      }),
    ).not.toContain("POS");
  });

  it("uses the 8-hex TAIL of the order id, never the head", () => {
    const description = buildPaymentDescription({
      eventTitle: "Launch Party",
      orderId: ORDER_ID,
      ticketQuantity: 1,
      kind: "primary",
    });

    const tail = ORDER_ID.slice(-8).toUpperCase();
    const head = ORDER_ID.slice(0, 8).toUpperCase();

    expect(tail).not.toBe(head); // the fixture must actually discriminate
    expect(description).toContain(`Order ${tail}`);
    expect(description).not.toContain(head);
  });

  it("truncates a long title at a word boundary with an ellipsis", () => {
    const title =
      "The Extremely Long Midsummer Launch Party Extravaganza Downtown Under The Bridge At Midnight";

    const description = buildPaymentDescription({
      eventTitle: title,
      orderId: ORDER_ID,
      ticketQuantity: 2,
      kind: "primary",
    });

    expect(description).toBe(
      `The Extremely Long Midsummer Launch Party Extravaganza Downtown Under The… — 2 tickets · Order ${formatOrderCode(ORDER_ID)}`,
    );

    const renderedTitle = description.split(" — ")[0] ?? "";
    expect(renderedTitle.endsWith("…")).toBe(true);
    // Cut on a space, so no word is sliced mid-way.
    expect(title.startsWith(renderedTitle.slice(0, -1))).toBe(true);
    // The cap is inclusive of the ellipsis.
    expect(renderedTitle.length).toBeLessThanOrEqual(80);
  });

  it("leaves a title at exactly the cap untouched", () => {
    const title = "a".repeat(80);

    expect(
      buildPaymentDescription({
        eventTitle: title,
        orderId: ORDER_ID,
        ticketQuantity: 1,
        kind: "primary",
      }),
    ).toBe(`${title} — 1 ticket · Order ${formatOrderCode(ORDER_ID)}`);
  });

  it("omits the title segment entirely for an empty or whitespace title", () => {
    for (const title of ["", "   ", "\n\t ", null, undefined]) {
      expect(
        buildPaymentDescription({
          eventTitle: title,
          orderId: ORDER_ID,
          ticketQuantity: 2,
          kind: "primary",
        }),
      ).toBe(`2 tickets · Order ${formatOrderCode(ORDER_ID)}`);
    }
  });

  it("collapses internal whitespace and strips control characters", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "  Launch\n\tParty  Redux  ",
        orderId: ORDER_ID,
        ticketQuantity: 1,
        kind: "primary",
      }),
    ).toBe(
      `Launch Party Redux — 1 ticket · Order ${formatOrderCode(ORDER_ID)}`,
    );
  });

  it("preserves non-ASCII titles verbatim — no transliteration, no uppercasing", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "Café São João 🎟️ 夏祭り",
        orderId: ORDER_ID,
        ticketQuantity: 2,
        kind: "primary",
      }),
    ).toBe(
      `Café São João 🎟️ 夏祭り — 2 tickets · Order ${formatOrderCode(ORDER_ID)}`,
    );
  });

  it("omits the quantity segment rather than emitting '0 tickets'", () => {
    for (const ticketQuantity of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(
        buildPaymentDescription({
          eventTitle: "Launch Party",
          orderId: ORDER_ID,
          ticketQuantity,
          kind: "primary",
        }),
      ).toBe(`Launch Party · Order ${formatOrderCode(ORDER_ID)}`);
    }
  });

  it("never leaves a lone surrogate when truncation lands mid-emoji", () => {
    // 78 kanji + a 2-unit emoji + 5 kanji = 85 UTF-16 units, and NO SPACE, so
    // the word-boundary search finds nothing and the raw 79-unit slice cuts the
    // emoji in half.
    const title = "\u590f".repeat(78) + "\ud83c\udf9f" + "\u796d".repeat(5);
    expect(title.length).toBe(85);

    const description = buildPaymentDescription({
      eventTitle: title,
      orderId: ORDER_ID,
      ticketQuantity: 2,
      kind: "primary",
    });

    // The fixture actually exercises the hazard: the naive slice IS broken.
    expect(hasUnpairedSurrogate(title.slice(0, 79))).toBe(true);
    // ...and the builder's output is not.
    expect(hasUnpairedSurrogate(description)).toBe(false);
    expect(description).toBe(
      `${"\u590f".repeat(78)}\u2026 \u2014 2 tickets \u00b7 Order ${formatOrderCode(ORDER_ID)}`,
    );
  });

  it("strips bidi overrides and zero-width characters via the house sanitiser", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE would visually reorder the order code that
    // follows it in the Dashboard column; U+200B is an invisible payload.
    const description = buildPaymentDescription({
      eventTitle: "Launch\u202e Party\u200b",
      orderId: ORDER_ID,
      ticketQuantity: 2,
      kind: "primary",
    });

    expect(description).toBe(
      `Launch Party \u2014 2 tickets \u00b7 Order ${formatOrderCode(ORDER_ID)}`,
    );
    expect(description).not.toContain("\u202e");
    expect(description).not.toContain("\u200b");
  });

  it("strips HTML tags rather than shipping markup to Stripe", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "<b>Launch</b> <script>alert(1)</script>Party",
        orderId: ORDER_ID,
        ticketQuantity: 1,
        kind: "primary",
      }),
    ).toBe(`Launch Party \u2014 1 ticket \u00b7 Order ${formatOrderCode(ORDER_ID)}`);
  });

  it("falls back to the order code alone when there is no title and no quantity", () => {
    expect(
      buildPaymentDescription({
        eventTitle: "   ",
        orderId: ORDER_ID,
        kind: "primary",
      }),
    ).toBe(`Order ${formatOrderCode(ORDER_ID)}`);
  });
});
