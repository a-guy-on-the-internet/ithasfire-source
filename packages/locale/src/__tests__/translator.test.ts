import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../constants";
import { createTranslator } from "../create-translator";
import {
  flattenCatalog,
  resolveMessage,
  resolveMessageAsString,
} from "../message-resolver";
import { loadMessages } from "../load-messages";

const SAMPLE_LOCALE = DEFAULT_LOCALE;

describe("@th/locale platform utilities", () => {
  it("exposes supported locales and default locale", () => {
    expect(SUPPORTED_LOCALES).toContain("en");
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("loads and validates message catalogs", async () => {
    const messages = await loadMessages(SAMPLE_LOCALE);

    expect(messages).toHaveProperty("common");
    expect(resolveMessage(messages, "common.greeting")).toBe("Hello {name}!");
  });

  it("creates a translator that formats strings", async () => {
    const messages = await loadMessages(SAMPLE_LOCALE);
    const translator = createTranslator(SAMPLE_LOCALE, messages);
    const output = translator.t("common.greeting", { name: "Ada" });

    expect(output).toBe("Hello Ada!");
  });

  it("returns the key when a translation is missing", async () => {
    const messages = await loadMessages(SAMPLE_LOCALE);
    const onMissing = vi.fn();
    const translator = createTranslator(SAMPLE_LOCALE, messages, {
      onMissingMessage: onMissing,
    });

    expect(translator.t("missing.key")).toBe("missing.key");
    expect(onMissing).toHaveBeenCalledWith("missing.key");
  });

  it("provides locale-aware formatting helpers", async () => {
    const messages = await loadMessages(SAMPLE_LOCALE);
    const translator = createTranslator("es-ES", messages);

    expect(translator.formatNumber(1234.5)).toBe(
      new Intl.NumberFormat("es-ES").format(1234.5),
    );
    expect(translator.formatDate("2025-03-14T12:00:00Z")).toBe(
      new Intl.DateTimeFormat("es-ES").format(new Date("2025-03-14T12:00:00Z")),
    );
    expect(translator.formatCurrency(1999.5, "USD")).toBe(
      new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "USD",
      }).format(1999.5),
    );
  });

  it("flattens catalog keys for diagnostics", async () => {
    const messages = await loadMessages(SAMPLE_LOCALE);
    const flat = flattenCatalog(messages);

    expect(flat).toHaveProperty("tickets.cta", "Buy tickets");
    expect(flat).toHaveProperty("tickets.status.held", "Held");
    expect(Object.keys(flat).length).toBeGreaterThan(0);
  });

  it("gracefully resolves messages as string", async () => {
    const messages = await loadMessages(SAMPLE_LOCALE);

    expect(resolveMessageAsString(messages, "tickets.cta")).toBe("Buy tickets");
    expect(resolveMessageAsString(messages, "tickets.unknown")).toBeUndefined();
  });
});
