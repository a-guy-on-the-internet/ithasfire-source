import { describe, expect, it } from "vitest";

import { descriptionWithOrderCode, orderCodeSuffix } from "../LedgerTable";

const ORDER_ID = "c6e6cf21-a43b-4973-8de9-69838e735f0a";
const CODE = "8E735F0A";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";

describe("descriptionWithOrderCode", () => {
  it("replaces the full order id with the 8-char uppercase code", () => {
    const out = descriptionWithOrderCode(`Door cash sale refunded, order ${ORDER_ID}`, ORDER_ID);
    expect(out).toBe(`Door cash sale refunded, order ${CODE}`);
    expect(out).not.toContain(ORDER_ID);
  });

  it("replaces an uppercase-written id too, and every occurrence", () => {
    const out = descriptionWithOrderCode(
      `${ORDER_ID.toUpperCase()} and ${ORDER_ID}`,
      ORDER_ID,
    );
    expect(out).toBe(`${CODE} and ${CODE}`);
  });

  it("leaves a description that already carries the short code", () => {
    const d = `Sale, order ${CODE}`;
    expect(descriptionWithOrderCode(d, ORDER_ID)).toBe(d);
  });

  it("shortens a full id even when the entry has no orderId", () => {
    expect(descriptionWithOrderCode(`Sale, order ${ORDER_ID}`, null)).toBe(`Sale, order ${CODE}`);
    expect(descriptionWithOrderCode("Sale settled", null)).toBe("Sale settled");
  });

  it("shortens a different id (a payout id) to its last 8 hex chars, uppercased", () => {
    expect(descriptionWithOrderCode(`Payout ${OTHER_ID}`, ORDER_ID)).toBe("Payout 55555555");
    expect(
      descriptionWithOrderCode(`Rolling reserve released by payout item ${OTHER_ID}`, null),
    ).toBe("Rolling reserve released by payout item 55555555");
  });

  it("shortens both the entry's own order id and a payout id", () => {
    expect(
      descriptionWithOrderCode(`Order ${ORDER_ID} paid out in payout ${OTHER_ID.toUpperCase()}`, ORDER_ID),
    ).toBe(`Order ${CODE} paid out in payout 55555555`);
  });

  it("leaves a non-UUID 8-hex token alone", () => {
    const d = "Payout deadbeef and 0000DEAD, order 12345678-1234";
    expect(descriptionWithOrderCode(d, ORDER_ID)).toBe(d);
  });
});

describe("orderCodeSuffix", () => {
  it("is null when the description holds the full id", () => {
    expect(orderCodeSuffix(`order ${ORDER_ID}`, ORDER_ID)).toBeNull();
  });

  it("is null when the description holds the short code", () => {
    expect(orderCodeSuffix(`order ${CODE.toLowerCase()}`, ORDER_ID)).toBeNull();
  });

  it("returns the code when the description names neither", () => {
    expect(orderCodeSuffix("Sale settled", ORDER_ID)).toBe(CODE);
  });
});

describe("the row's sub-line as the table composes it", () => {
  const subLine = (description: string) =>
    [descriptionWithOrderCode(description, ORDER_ID), orderCodeSuffix(description, ORDER_ID)]
      .filter(Boolean)
      .join(" · ");

  it.each([
    `Door cash sale — tax, order ${ORDER_ID}`,
    `Door cash sale refunded by the organiser — amount owed on it returned, order ${ORDER_ID}`,
    `Ticket revenue — order ${CODE}`,
    `Payout ${OTHER_ID} for order ${ORDER_ID}`,
    "Sale settled",
    "",
  ])("names the order code exactly once and never the full id: %j", (description) => {
    const line = subLine(description);
    expect(line.split(CODE)).toHaveLength(2);
    expect(line.toLowerCase()).not.toContain(ORDER_ID);
    expect(line).not.toContain(OTHER_ID);
  });
});
