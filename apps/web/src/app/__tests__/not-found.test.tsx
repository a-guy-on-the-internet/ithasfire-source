/**
 * The app-wide 404 is translated: English under en, Spanish under es (an
 * unknown /es/... URL renders it too, with its home link going to /es).
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/nope" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => nav.pathname,
}));

import { AppLocaleProvider } from "@/i18n";
import NotFound from "../not-found";

const renderAt = (pathname: string, locale: "en" | "es") => {
  nav.pathname = pathname;
  return render(
    <AppLocaleProvider serverLocale={locale}>
      <NotFound />
    </AppLocaleProvider>,
  );
};

const href = (name: string) =>
  screen.getByRole("link", { name }).getAttribute("href");

describe("NotFound", () => {
  beforeEach(() => {
    localStorage.clear();
    // The Spanish case saves th-locale=es; the cookie is the fallback read.
    document.cookie = "th-locale=; max-age=0; path=/";
  });

  it("reads in English", () => {
    renderAt("/nope", "en");
    expect(screen.getByText("Page not found")).toBeTruthy();
    expect(
      screen.getByText(
        "The page you're looking for doesn't exist or may have been moved.",
      ),
    ).toBeTruthy();
    expect(href("Go home")).toBe("/");
    expect(href("Browse events")).toBe("/events");
  });

  it("reads in Spanish on an /es URL", () => {
    renderAt("/es/nope", "es");
    expect(screen.getByText("Página no encontrada")).toBeTruthy();
    expect(
      screen.getByText("La página que buscas no existe o se ha movido."),
    ).toBeTruthy();
    expect(href("Ir al inicio")).toBe("/es");
    expect(href("Explorar eventos")).toBe("/events");
  });
});
