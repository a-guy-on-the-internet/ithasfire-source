import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", () => ({ YStack: () => null }));
vi.mock("@th/ui", () => ({
  Badge: () => null,
  Text: () => null,
  useFormatters: () => ({}),
  useTranslations: () => (key: string) => key,
}));

import { answerParts } from "../PayoutPanel";

function spans(text: string, amounts: string[]) {
  const { container } = render(<p>{answerParts(text, amounts)}</p>);
  return {
    text: container.textContent,
    amounts: Array.from(container.querySelectorAll(".th-payout-answer-amount")).map(
      (el) => el.textContent,
    ),
  };
}

describe("answerParts", () => {
  it("wraps each named amount and leaves the text unchanged", () => {
    const text = "$4,282.51 goes out tonight. $2,858.48 more ready by Nov 15.";
    expect(spans(text, ["$4,282.51", "$2,858.48"])).toEqual({
      text,
      amounts: ["$4,282.51", "$2,858.48"],
    });
  });

  it("matches the longest amount first, so $12.00 never splits $112.00", () => {
    expect(spans("$112.00 then $12.00", ["$12.00", "$112.00"]).amounts).toEqual([
      "$112.00",
      "$12.00",
    ]);
  });

  it("escapes regex characters and keeps a no-break space inside an amount", () => {
    const es = "4.282,51 US$ sale esta noche.";
    expect(spans(es, ["4.282,51 US$"])).toEqual({
      text: es,
      amounts: ["4.282,51 US$"],
    });
  });

  it("no amounts: the sentence as one text node", () => {
    expect(spans("We can't say yet.", []).amounts).toEqual([]);
  });
});
