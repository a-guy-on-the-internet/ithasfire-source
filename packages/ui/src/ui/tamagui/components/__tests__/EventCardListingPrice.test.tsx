import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { messageDictionarySchema } from "@th/locale";
import esCatalog from "@th/locale/messages/es.json" with { type: "json" };

import { renderWithProvider } from "../../../../../test/utils";
import { TranslationProvider } from "../../../../locale";
import {
  EventCard,
  listingPriceText,
  listingPriceWordsFrom,
  type EventSummary,
} from "../event-grid";

const baseEvent: EventSummary = {
  id: "evt-1",
  title: "Sample Event",
  date: "2025-12-31",
  venue: "Harbor Hall",
  priceLabel: "$120",
  media: {
    url: "https://static.ithasfire.test/sample.jpg",
    alt: "Sample Event image",
    aspectRatio: 16 / 9,
  },
};

// The package's es.json plus the keys the web app's catalog layers on top
// (apps/web/src/i18n/messages/es.ts), as the web locale provider merges them.
const esJson = esCatalog as unknown as Record<string, Record<string, string>>;
const spanish = messageDictionarySchema.parse({
  ...esJson,
  search: { ...esJson.search, freePlus: "Gratis+" },
  eventDetail: { ...esJson.eventDetail, payWhatYouWant: "Paga lo que quieras" },
  eventCard: { ...esJson.eventCard, seeDetails: "Ver detalles" },
});

const renderSpanish = (event: EventSummary, testIdBase: string) =>
  renderWithProvider(
    <TranslationProvider locale="es" messages={spanish}>
      <EventCard event={event} testIdBase={testIdBase} />
    </TranslationProvider>,
  );

describe("EventCard words the structured listingPrice in the viewer's language", () => {
  it("prints 'Paga lo que quieras' for a floor-0 PWYW event, ignoring the English label", () => {
    renderSpanish(
      {
        ...baseEvent,
        priceLabel: "Pay what you want",
        listingPrice: { kind: "payWhatYouWant" },
      },
      "pwyw",
    );
    expect(screen.getByTestId("pwyw-price").textContent).toContain(
      "Paga lo que quieras",
    );
    expect(screen.getByTestId("pwyw-price").textContent).not.toContain(
      "Pay what you want",
    );
  });

  it("does not prefix 'From' to 'Pay what you want' or 'Free+'", () => {
    renderSpanish(
      { ...baseEvent, priceLabel: "Pay what you want", listingPrice: { kind: "payWhatYouWant" } },
      "nofrom-pwyw",
    );
    const pwyw = screen.getByTestId("nofrom-pwyw-price").textContent ?? "";
    expect(pwyw).toContain("Paga lo que quieras");
    expect(pwyw).not.toMatch(/desde|from/i);
    renderSpanish(
      { ...baseEvent, priceLabel: "Free+", listingPrice: { kind: "freePlus" } },
      "nofrom-plus",
    );
    const plus = screen.getByTestId("nofrom-plus-price").textContent ?? "";
    expect(plus).toContain("Gratis+");
    expect(plus).not.toMatch(/desde|from/i);
  });

  it("prints 'Gratis' and 'Gratis+'", () => {
    renderSpanish(
      { ...baseEvent, priceLabel: "Free", listingPrice: { kind: "free" }, isFree: true },
      "free",
    );
    expect(screen.getByTestId("free-price").textContent).toContain("Gratis");
    renderSpanish(
      { ...baseEvent, priceLabel: "Free+", listingPrice: { kind: "freePlus" } },
      "freeplus",
    );
    expect(screen.getByTestId("freeplus-price").textContent).toContain(
      "Gratis+",
    );
  });

  it("keeps the amount as formatted and hides the no-price placeholder in any language", () => {
    renderSpanish(
      {
        ...baseEvent,
        priceLabel: "$28.62",
        listingPrice: { kind: "amount", cents: 2862, currency: "USD", from: false },
      },
      "amt",
    );
    expect(screen.getByTestId("amt-price").textContent).toContain("$28.62");

    // `listingPrice: null` is "See details": no block, and no "Ver detalles".
    renderSpanish(
      { ...baseEvent, priceLabel: "See details", listingPrice: null },
      "none",
    );
    expect(screen.queryByTestId("none-price")).not.toBeInTheDocument();
    expect(screen.queryByText("Ver detalles")).not.toBeInTheDocument();
  });

  it("falls back to the English priceLabel when a producer sent no listingPrice", () => {
    renderSpanish({ ...baseEvent, priceLabel: "$45" }, "legacy");
    expect(screen.getByTestId("legacy-price").textContent).toContain("$45");
  });
});

describe("listingPriceWordsFrom / listingPriceText", () => {
  it("falls back to English when the translator returns the key (no app catalog)", () => {
    const words = listingPriceWordsFrom((key) => key);
    expect(words.free).toBe("Free");
    expect(words.freePlus).toBe("Free+");
    expect(words.payWhatYouWant).toBe("Pay what you want");
    expect(words.fromPrice("$15")).toBe("From $15");
    expect(words.seeDetails).toBe("See details");
  });

  it("uses the catalog when it answers", () => {
    const table: Record<string, string> = {
      "search.free": "Gratis",
      "search.freePlus": "Gratis+",
      "eventDetail.payWhatYouWant": "Paga lo que quieras",
      "eventCard.seeDetails": "Ver detalles",
    };
    const words = listingPriceWordsFrom((key, values) =>
      key === "search.fromPrice" ? `Desde ${values?.price}` : (table[key] ?? key),
    );
    expect(
      listingPriceText(
        {
          listingPrice: { kind: "amount", cents: 1500, currency: "USD", from: true },
          priceLabel: "From $15",
        },
        words,
      ),
    ).toBe("Desde $15");
    expect(
      listingPriceText({ listingPrice: { kind: "payWhatYouWant" } }, words),
    ).toBe("Paga lo que quieras");
    expect(listingPriceText({ listingPrice: null, priceLabel: "See details" }, words)).toBeNull();
    expect(listingPriceText({ priceLabel: "See details" }, words)).toBeNull();
    expect(listingPriceText({ priceLabel: "$9" }, words)).toBe("$9");
  });
});
