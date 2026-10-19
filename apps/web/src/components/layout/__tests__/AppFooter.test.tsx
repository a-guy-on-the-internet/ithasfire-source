import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

/**
 * House shows left the homepage hero's chip row (owner ruling 2026-10-14: the
 * chips offer only categories whose page lists something), so the footer's
 * Platform column carries the entry instead.
 *
 * Server-rendered to a string, like AppChrome.featureGates.test: tamagui
 * stacks are plain divs, `@th/ui`'s `useTranslations` echoes the key, `Link`
 * is an anchor.
 */

vi.mock("tamagui", async (importOriginal) => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    ...(await importOriginal<typeof import("tamagui")>()),
    YStack: Stack,
    XStack: Stack,
    styled: () => Stack,
  };
});
vi.mock("@th/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/ui")>()),
  useTranslations: () => (key: string) => key,
  Link: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { resale: false } }),
}));
vi.mock("@/components/gdpr/ConsentProvider", () => ({
  useConsentContext: () => ({ openPreferences: () => {} }),
}));
vi.mock("../BuildInfo", () => ({ BuildInfo: () => null }));
let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

import { AppFooter } from "../AppFooter";

describe("AppFooter", () => {
  it("links House shows from the Platform column, between Search and Features", () => {
    const html = renderToString(<AppFooter />);

    expect(html).toMatch(
      /href="\/house-shows"[^>]*>(?:<[^>]+>)*common\.footerHouseShows/,
    );
    const search = html.indexOf('href="/events/search"');
    const houseShows = html.indexOf('href="/house-shows"');
    const features = html.indexOf('href="/features"');
    expect(search).toBeGreaterThan(-1);
    expect(houseShows).toBeGreaterThan(search);
    expect(features).toBeGreaterThan(houseShows);
  });

  describe("About and Contact follow the page's language (spanish-seo FR-006)", () => {
    afterEach(() => {
      mockPathname = "/";
    });

    it("links the Spanish twins from an /es page, and nothing else moves", () => {
      mockPathname = "/es/eventos/categoria/musica";
      const html = renderToString(<AppFooter />);

      expect(html).toContain('href="/es/acerca-de"');
      expect(html).toContain('href="/es/contacto"');
      expect(html).not.toContain('href="/about"');
      expect(html).not.toContain('href="/contact"');
      // Pages with one URL keep it.
      for (const href of ["/support", "/help", "/house-shows", "/privacy"]) {
        expect(html).toContain(`href="${href}"`);
      }
    });

    it("links the English pages from an English page", () => {
      mockPathname = "/events/category/music";
      const html = renderToString(<AppFooter />);

      expect(html).toContain('href="/about"');
      expect(html).toContain('href="/contact"');
      expect(html).not.toContain('href="/es/');
    });
  });

  it("the label reads in both catalogs", () => {
    expect(
      createTranslator("en", enMessages).t("common.footerHouseShows"),
    ).toBe("House shows");
    expect(
      createTranslator("es", esMessages).t("common.footerHouseShows"),
    ).toBe("Conciertos en casa");
  });
});
