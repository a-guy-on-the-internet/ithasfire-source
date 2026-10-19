/**
 * FR-004 through the real provider: on a page with language twins, picking a
 * language in the switcher saves it and navigates to that language's page
 * (the English twin from an /es/ page included). Elsewhere it still switches
 * live. `LanguageSwitcher.test.tsx` covers the pickers' own mechanics.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { HTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  pathname: "/",
  router: { refresh: vi.fn(), replace: vi.fn(), push: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
}));

let isSmall = false;

// Tamagui primitives as plain elements; `onPress` maps to `onClick` and the
// style-only props are dropped so they do not land on the DOM.
// Partial: the real `@th/ui` (TranslationProvider, useLocale) loads the rest
// of tamagui at import.
vi.mock("tamagui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tamagui")>();
  const DROP = new Set([
    "alignItems",
    "justifyContent",
    "gap",
    "paddingHorizontal",
    "paddingVertical",
    "pointerEvents",
    "backgroundColor",
  ]);
  const make =
    () =>
    ({
      children,
      onPress,
      ...rest
    }: HTMLAttributes<HTMLDivElement> & { onPress?: () => void }) => {
      const props: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (!DROP.has(key)) props[key] = value;
      }
      return (
        <div {...(props as HTMLAttributes<HTMLDivElement>)} onClick={onPress}>
          {children}
        </div>
      );
    };
  return {
    ...actual,
    XStack: make(),
    YStack: make(),
    styled: () => make(),
    useMedia: () => ({ sm: isSmall }),
  };
});

vi.mock("@th/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/ui")>()),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

import { AppLocaleProvider, PublicTwins, type PublicTwinSet } from "@/i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";

const EN = "/about";
const ES = "/es/acerca-de";
const twins: PublicTwinSet = {
  en: { path: EN, indexable: true },
  es: { path: ES, indexable: true },
};

const renderAt = (
  pathname: string,
  serverLocale: "en" | "es",
  pageTwins: PublicTwinSet | null,
) => {
  nav.pathname = pathname;
  render(
    <AppLocaleProvider serverLocale={serverLocale}>
      {pageTwins ? <PublicTwins twins={pageTwins} /> : null}
      <LanguageSwitcher />
    </AppLocaleProvider>,
  );
};

const pick = (label: string) => {
  if (isSmall) {
    const select = screen.getByTestId("language-switcher");
    const value = label === "English" ? "en" : "es";
    fireEvent.change(select, { target: { value } });
    return;
  }
  fireEvent.click(screen.getByTestId("language-switcher"));
  fireEvent.click(screen.getByRole("option", { name: label }));
};

beforeEach(() => {
  localStorage.clear();
  document.cookie = "th-locale=;path=/;max-age=0";
  nav.router.push.mockClear();
  nav.router.replace.mockClear();
  nav.router.refresh.mockClear();
});

describe.each([false, true])(
  "LanguageSwitcher with twins (small=%s)",
  (small) => {
    beforeEach(() => {
      isSmall = small;
    });

    it("goes to the /es/ twin from the English page and saves Spanish (replace, not push)", () => {
      renderAt(EN, "en", twins);
      pick("Español");
      expect(nav.router.replace).toHaveBeenCalledWith(ES);
      expect(nav.router.push).not.toHaveBeenCalled();
      expect(localStorage.getItem("th-locale")).toBe("es");
    });

    it("goes to the English twin from the /es/ page and saves English", () => {
      renderAt(ES, "es", twins);
      pick("English");
      expect(nav.router.replace).toHaveBeenCalledWith(EN);
      expect(nav.router.push).not.toHaveBeenCalled();
      expect(localStorage.getItem("th-locale")).toBe("en");
    });

    it("switches live on a page with no twins", () => {
      renderAt("/search", "en", null);
      pick("Español");
      expect(nav.router.push).not.toHaveBeenCalled();
      expect(localStorage.getItem("th-locale")).toBe("es");
      expect(nav.router.refresh).toHaveBeenCalledTimes(1);
    });
  },
);
