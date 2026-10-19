import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTranslator,
  type MessageCatalog,
  type TranslationValues,
} from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

/**
 * The COMPOSED header line, through the REAL catalogs and a real translator,
 * in both locales. The key-echo tests beside this one cannot catch the bug
 * this file exists for: "last" + a relative phrase that already carried its
 * own "last" / "yesterday" ("38 shows · since Mar 2024 · last yesterday",
 * "· último ayer", "· last last month"). Here the figure after "last" is the
 * absolute day and the relative phrase stands alone in parentheses.
 */

const locale = vi.hoisted(() => ({ current: "en" as "en" | "es" }));

vi.mock("@th/ui", async () => {
  const { createTranslator } = await import("@th/locale");
  const { default: en } = await import("@/i18n/messages/en");
  const { default: es } = await import("@/i18n/messages/es");
  const translators = {
    en: createTranslator("en", en as unknown as MessageCatalog),
    es: createTranslator("es", es as unknown as MessageCatalog),
  };
  const translator = () => translators[locale.current];
  return {
    useTranslations:
      () =>
      (key: string, values?: TranslationValues) =>
        translator().t(key, values),
    useFormatters: () => ({
      locale: translator().locale,
      number: translator().formatNumber,
      currency: translator().formatCurrency,
      dateTime: translator().formatDate,
      getRawMessage: translator().getRawMessage,
    }),
  };
});

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ActsRoster } from "../_components/ActsRoster";

const TZ = "America/Chicago";
/** Thursday 2026-09-24, noon Central. */
const NOW = "2026-09-24T17:00:00.000Z";
const show = (local: string) =>
  new Date(`${local}T20:00:00-05:00`).toISOString();

function headerText(lastLocal: string): string {
  const { container } = render(
    <ActsRoster
      venueName="Fishbowl House"
      venueHref="/p/fishbowl-house-00000000"
      acts={[]}
      summary={{
        showsHosted: 38,
        firstShowAt: show("2024-03-08"),
        lastShowAt: show(lastLocal),
        timeZone: TZ,
      }}
      linkProfiles={false}
      timeZone={TZ}
      nowIso={NOW}
    />,
  );
  // The stamp is a <p> too; the figures line is the last one in the header.
  const line = container.querySelector("header p:last-of-type");
  if (!line || line.textContent === "The door" || line.textContent === "La puerta") {
    throw new Error("header line did not render");
  }
  return (line.textContent ?? "").replace(/\s+/g, " ").trim();
}

// The catalogs are real, so a sanity check that they loaded as expected.
const enT = createTranslator("en", enMessages as unknown as MessageCatalog);
const esT = createTranslator("es", esMessages as unknown as MessageCatalog);

afterEach(() => {
  locale.current = "en";
});

describe("ActsRoster header line — composed, real catalogs", () => {
  it("the catalogs carry the roster keys (guards a raw-key pass)", () => {
    expect(enT.t("actsRoster.headLast")).toBe("last");
    expect(esT.t("actsRoster.headLast")).toBe("último");
  });

  it("en: a show that ended yesterday", () => {
    expect(headerText("2026-09-23")).toBe(
      "38 shows · since Mar 2024 · last Sep 23 (yesterday)",
    );
  });

  it("en: a show 35 days ago never reads 'last last month'", () => {
    const text = headerText("2026-08-20");
    expect(text).toBe("38 shows · since Mar 2024 · last Aug 20 (1 month ago)");
    expect(text).not.toMatch(/last last/);
  });

  it("en: nine days ago", () => {
    expect(headerText("2026-09-15")).toBe(
      "38 shows · since Mar 2024 · last Sep 15 (9 days ago)",
    );
  });

  it("es: a show that ended yesterday never reads 'último ayer'", () => {
    locale.current = "es";
    const text = headerText("2026-09-23");
    // ICU renders the short month as "sept" or "sep" depending on version.
    expect(text).toMatch(
      /^38 shows · desde mar 2024 · último 23 sept?\.? \(ayer\)$/,
    );
    expect(text).not.toMatch(/último ayer/);
  });

  it("es: a show 35 days ago", () => {
    locale.current = "es";
    const text = headerText("2026-08-20");
    expect(text).toMatch(
      /^38 shows · desde mar 2024 · último 20 ago\.? \(hace 1 mes\)$/,
    );
  });
});
