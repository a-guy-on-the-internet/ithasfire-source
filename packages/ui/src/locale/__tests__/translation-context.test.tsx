import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  TranslationProvider,
  useFormatters,
  useLocale,
  useMessages,
  useTranslations,
} from "../translation-context.js";
import { messageDictionarySchema } from "@th/locale";
import esCatalog from "@th/locale/messages/es.json" with { type: "json" };

const FallbackProbe = () => {
  const t = useTranslations();
  const locale = useLocale();
  const messages = useMessages();

  return (
    <div>
      <span data-testid="fallback-text">{String(t("tickets.cta"))}</span>
      <span data-testid="fallback-locale">{locale}</span>
      <span data-testid="fallback-message-count">
        {Object.keys(messages.tickets ?? {}).length}
      </span>
    </div>
  );
};

const ProviderProbe = () => {
  const t = useTranslations();
  const locale = useLocale();
  const { currency } = useFormatters();

  return (
    <div>
      <span data-testid="text">{String(t("tickets.status.held"))}</span>
      <span data-testid="locale">{locale}</span>
      <span data-testid="currency">{currency(1234, "USD")}</span>
    </div>
  );
};

describe("TranslationProvider", () => {
  it("provides fallback translations when no provider is mounted", () => {
    render(<FallbackProbe />);

    expect(screen.getByTestId("fallback-text").textContent).toBe("Buy tickets");
    expect(screen.getByTestId("fallback-locale").textContent).toBe("en");
    expect(
      Number(screen.getByTestId("fallback-message-count").textContent),
    ).toBeGreaterThan(0);
  });

  it("uses provided messages and locale when a provider is present", () => {
    const messages = messageDictionarySchema.parse(esCatalog);

    render(
      <TranslationProvider locale="es" messages={messages}>
        <ProviderProbe />
      </TranslationProvider>,
    );

    expect(screen.getByTestId("text").textContent).toBe("Reservado");
    expect(screen.getByTestId("locale").textContent).toBe("es");
    const formatted = screen.getByTestId("currency").textContent ?? "";
    expect(formatted).toMatch(/1234,00/);
    expect(formatted).toMatch(/US\$/);
  });
});
