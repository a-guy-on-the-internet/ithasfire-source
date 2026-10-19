/**
 * `MobileNavMenu` — the bottom sheet specified by the design system folder as
 * `MobileNavSheet` (components/navigation/MobileNavSheet.{prompt.md,jsx},
 * navigation.css:36-45).
 *
 * Everything here was browser-verified before it was written down; these tests
 * exist so the next edit cannot quietly undo it. What they pin, in order of how
 * easy it is to break by accident:
 *
 *  - separator weight — a hairline on `--borderColorSoft`, NOT the 2px full-ink
 *    rule the head carries. Asserted off the raw `style` ATTRIBUTE, because
 *    jsdom's CSSOM drops a `var()` inside a `border` shorthand and would make
 *    `el.style.borderBottom` an empty string either way;
 *  - the `var(--token, fallback)` fallbacks, which are what SSR paints before
 *    the theme injector runs, so they must equal the Stub values;
 *  - focus in on open, focus back to the opener on close, and the Tab trap;
 *  - scrim dismiss, Escape dismiss, current-route marking, reduced motion.
 *
 * MOCKS. Two are forced by the component rather than chosen: `usePathname`
 * (`next/navigation`) and `useLocale` (`@th/ui`) — both had to be added to
 * `AppNavbar.test.tsx` for the same reason when this sheet was mounted there.
 * `tokens` / `HIT_MIN` carry hardcoded values in the `@th/ui` mock: the token
 * VALUES are guarded by `packages/ui/.../__tests__/design-system-v2.test.ts`,
 * and what these tests guard is which token the component reaches for. If a
 * value below stops matching the real bag, fix the mock — do not relax the
 * assertion.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Route ───────────────────────────────────────────────────────────────────
let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

// ── Theme + locale ──────────────────────────────────────────────────────────
const toggleTheme = vi.fn();
let themeMode: "light" | "dark" = "light";

vi.mock("@/components/theme/AppThemeProvider", () => ({
  useAppTheme: () => ({ mode: themeMode, toggle: toggleTheme }),
}));

// A tiny live locale store standing in for `AppLocaleProvider`: the setter
// changes what `useLocale()` returns and re-renders its readers, which is the
// behaviour the Language row depends on (no reload).
const setAppLocaleMock = vi.fn();
let currentLocale = "en";
const localeListeners = new Set<() => void>();
const subscribeLocale = (fn: () => void) => {
  localeListeners.add(fn);
  return () => localeListeners.delete(fn);
};

vi.mock("@/i18n", () => ({
  SUPPORTED_LOCALES: ["en", "es"] as const,
  LOCALE_LABELS: { en: "English", es: "Español" },
  useSetAppLocale: () => (locale: string) => {
    setAppLocaleMock(locale);
    currentLocale = locale;
    localeListeners.forEach((fn) => fn());
  },
}));

// ── tamagui ─────────────────────────────────────────────────────────────────
// The real XStack/YStack need a TamaguiProvider and a theme. The stub renders a
// plain element and republishes the layout props as `data-tamagui-*` so the
// head's SPEC values (`padding="$4"`, a 2px structural rule) stay assertable —
// they are Tamagui props, not inline CSS, so there is no style to read.
const TAMAGUI_PROPS = new Set([
  "alignItems",
  "justifyContent",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingHorizontal",
  "gap",
  "borderBottomWidth",
  "borderBottomColor",
]);

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    tag,
    ...rest
  }: HTMLAttributes<HTMLElement> & { tag?: string }) => {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (TAMAGUI_PROPS.has(key))
        props[`data-tamagui-${key.toLowerCase()}`] = String(value);
      else props[key] = value;
    }
    const Tag = (tag ?? "div") as "div";
    return <Tag {...(props as HTMLAttributes<HTMLDivElement>)}>{children}</Tag>;
  };

  return { XStack: passthrough, YStack: passthrough };
});

// ── @th/ui ──────────────────────────────────────────────────────────────────
vi.mock("@th/ui", () => ({
  // Real values from packages/ui/src/ui/tamagui/tokens/{space,z-index,border}.ts
  // and `HIT_MIN` from tokens/density.ts. See the MOCKS note at the top.
  tokens: {
    space: { $3: 12, $4: 16 },
    zIndex: { drawer: 1350 },
    border: { hair: 1, structure: 2 },
  },
  HIT_MIN: 44,
  // Last key segment, camelCase split — same convention as AppNavbar.test.tsx.
  useTranslations: () => (key: string) => {
    const segment = key.includes(".") ? key.split(".").pop()! : key;
    return segment.replace(/([A-Z])/g, " $1").trim();
  },
  useLocale: () => useSyncExternalStore(subscribeLocale, () => currentLocale),
  Text: ({
    children,
    "aria-hidden": ariaHidden,
  }: {
    children?: ReactNode;
    "aria-hidden"?: boolean;
  }) => <span aria-hidden={ariaHidden}>{children}</span>,
}));

import { MobileNavMenu } from "../MobileNavMenu";

/** The raw `style` attribute — see the CSSOM caveat in the file header. */
const styleAttr = (el: Element) => el.getAttribute("style") ?? "";

const panel = () => screen.getByRole("dialog");
const closeButton = () => screen.getByTestId("mobile-nav-menu-close");
const scrim = () => screen.getByTestId("mobile-nav-menu-scrim");

/** Mounts the sheet behind a real opener, so focus restore has a target. */
const Harness = ({ initialOpen = false }: { initialOpen?: boolean }) => {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Menu
      </button>
      <MobileNavMenu open={open} onClose={() => setOpen(false)} />
    </>
  );
};

/** Replaces jsdom's always-false matchMedia so the reduce branch is reachable. */
const setPrefersReducedMotion = (reduce: boolean) => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion: reduce"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
};

beforeEach(() => {
  pathname = "/";
  themeMode = "light";
  toggleTheme.mockClear();
  setAppLocaleMock.mockClear();
  currentLocale = "en";
  setPrefersReducedMotion(false);
});

afterEach(() => {
  document.body.style.overflow = "";
});

describe("MobileNavMenu", () => {
  it("renders nothing while closed", () => {
    render(<MobileNavMenu open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("mobile-nav-menu")).toBeNull();
  });

  describe("row chrome (the folder's `.if-navsheet__body a`)", () => {
    /** Any link row; they all share one style object. */
    const aRow = () => screen.getByTestId("mobile-nav-menu-features");

    beforeEach(() => {
      render(<MobileNavMenu open onClose={vi.fn()} />);
    });

    it("separates rows with a hairline on the SOFT border, not full ink", () => {
      const style = styleAttr(aRow());
      expect(style).toContain(
        "border-bottom: 1px solid var(--borderColorSoft, rgba(33, 28, 22, 0.3))",
      );
      // The regression this exists for: `--borderColor` is #211C16 at full
      // strength — roughly 3x the weight the folder asks a row divider for.
      expect(style).not.toContain("var(--borderColor,");
    });

    it("pads to sp-4 with an sp-3 gap over a 44px hit target", () => {
      const style = styleAttr(aRow());
      expect(style).toContain("padding: 16px");
      expect(style).toContain("gap: 12px");
      expect(style).toContain("min-height: 44px");
      // Not the old `0 16px`, which left the rows unpadded vertically.
      expect(style).not.toContain("padding: 0px 16px");
    });

    it("insets the system focus ring so the panel cannot clip it", () => {
      // Full-bleed rows inside a panel whose overflow-x resolves to `auto`:
      // at the system's +2px offset the vertical strokes are drawn outside the
      // panel and clipped, so the ring reads as two loose horizontal rules.
      // Measured at 760px before the fix: row 0-760 in a panel 0-760.
      // `data-focus-inset` is the SHARED mechanism (globals.css) rather than a
      // rule local to this component, and it flips only the offset.
      expect(aRow()).toHaveAttribute("data-focus-inset");
      expect(
        document.querySelector('[data-testid="mobile-nav-menu"] style'),
      ).toBeNull();
    });

    it("resets the ink and rule a bare anchor would inherit", () => {
      const style = styleAttr(aRow());
      expect(aRow().tagName).toBe("A");
      expect(style).toContain("color: inherit");
      expect(style).toContain("text-decoration: none");
    });
  });

  describe("the current route", () => {
    it("carries aria-current, the accent wash and the 3px inset bar", () => {
      pathname = "/help";
      render(<MobileNavMenu open onClose={vi.fn()} />);

      const current = screen.getByTestId("mobile-nav-menu-help");
      expect(current).toHaveAttribute("aria-current", "page");
      const style = styleAttr(current);
      // The fallback is what SSR paints, so it must be the Stub `accentSoft`
      // — `transparent` would render the marking invisible until hydration.
      expect(style).toContain("var(--accentSoft, rgba(226, 72, 29, 0.10))");
      expect(style).toContain("inset 3px 0 0 var(--accent, #E2481D)");
    });

    it("leaves every other row unmarked", () => {
      pathname = "/help";
      render(<MobileNavMenu open onClose={vi.fn()} />);

      const other = screen.getByTestId("mobile-nav-menu-about");
      expect(other).not.toHaveAttribute("aria-current");
      expect(styleAttr(other)).not.toContain("--accentSoft");
    });

    it("links About and Contact to the Spanish twins on an /es page, and marks the one in view (spanish-seo FR-006)", () => {
      pathname = "/es/acerca-de";
      render(<MobileNavMenu open onClose={vi.fn()} />);

      const about = screen.getByTestId("mobile-nav-menu-about");
      expect(about).toHaveAttribute("href", "/es/acerca-de");
      expect(about).toHaveAttribute("aria-current", "page");
      expect(screen.getByTestId("mobile-nav-menu-contact")).toHaveAttribute(
        "href",
        "/es/contacto",
      );
      // One URL in every language: unchanged.
      expect(screen.getByTestId("mobile-nav-menu-help")).toHaveAttribute(
        "href",
        "/help",
      );
    });

    it("links About and Contact to the English pages elsewhere", () => {
      pathname = "/about";
      render(<MobileNavMenu open onClose={vi.fn()} />);

      expect(screen.getByTestId("mobile-nav-menu-about")).toHaveAttribute(
        "href",
        "/about",
      );
      expect(screen.getByTestId("mobile-nav-menu-contact")).toHaveAttribute(
        "href",
        "/contact",
      );
    });

    it("marks the organiser row on any /admin path", () => {
      pathname = "/admin/dev-login/events";
      render(<MobileNavMenu open onClose={vi.fn()} />);

      expect(screen.getByTestId("mobile-nav-menu-dashboard")).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
  });

  describe("head", () => {
    it("keeps the 2px structural rule and sp-4 padding", () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);

      const head = screen.getByTestId("mobile-nav-menu-head");
      // --bw-structure on --color-border: the head rule is NOT a hairline.
      expect(head).toHaveAttribute("data-tamagui-borderbottomwidth", "2");
      expect(head).toHaveAttribute(
        "data-tamagui-borderbottomcolor",
        "$borderColor",
      );
      expect(head).toHaveAttribute("data-tamagui-padding", "$4");
      expect(head).toHaveAttribute("data-tamagui-gap", "$3");
    });
  });

  describe("dismissal", () => {
    it("closes on scrim click", () => {
      const onClose = vi.fn();
      render(<MobileNavMenu open onClose={onClose} />);

      fireEvent.click(scrim());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape", () => {
      const onClose = vi.fn();
      render(<MobileNavMenu open onClose={onClose} />);

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes from the close button", () => {
      const onClose = vi.fn();
      render(<MobileNavMenu open onClose={onClose} />);

      fireEvent.click(closeButton());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps the scrim out of the a11y tree and out of the tab order", () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);

      // It sits outside role="dialog", so the trap cannot reach it — and a
      // second focusable "Close" would collide with the close button's name.
      expect(scrim()).toHaveAttribute("aria-hidden", "true");
      expect(scrim()).toHaveAttribute("tabindex", "-1");
    });
  });

  describe("focus", () => {
    it("lands on the first CONTROL, not the panel", async () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);

      await waitFor(() => expect(document.activeElement).toBe(closeButton()));
    });

    it("returns to the opener on close", async () => {
      render(<Harness />);

      const opener = screen.getByTestId("opener");
      opener.focus();
      fireEvent.click(opener);

      await waitFor(() => expect(document.activeElement).toBe(closeButton()));

      fireEvent.click(closeButton());
      await waitFor(() => expect(document.activeElement).toBe(opener));
    });

    it("wraps Tab from the last stop back to the first", async () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);
      await waitFor(() => expect(document.activeElement).toBe(closeButton()));

      const last = screen.getByTestId("mobile-nav-menu-dashboard");
      last.focus();
      fireEvent.keyDown(last, { key: "Tab" });

      expect(document.activeElement).toBe(closeButton());
    });

    it("wraps Shift+Tab from the first stop to the last", async () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);
      await waitFor(() => expect(document.activeElement).toBe(closeButton()));

      fireEvent.keyDown(closeButton(), { key: "Tab", shiftKey: true });

      expect(document.activeElement).toBe(
        screen.getByTestId("mobile-nav-menu-dashboard"),
      );
    });

    it("pulls focus back in if it has escaped the sheet", async () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);
      await waitFor(() => expect(document.activeElement).toBe(closeButton()));

      (document.activeElement as HTMLElement).blur();
      fireEvent.keyDown(document.body, { key: "Tab" });

      expect(document.activeElement).toBe(closeButton());
    });

    it("leaves Tab alone in the middle of the list", async () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);
      await waitFor(() => expect(document.activeElement).toBe(closeButton()));

      const middle = screen.getByTestId("mobile-nav-menu-about");
      middle.focus();
      // Not a wrap point, so the browser's own Tab must run: no preventDefault,
      // and focus is left where jsdom left it.
      const handled = fireEvent.keyDown(middle, { key: "Tab" });
      expect(handled).toBe(true);
      expect(document.activeElement).toBe(middle);
    });
  });

  describe("preferences", () => {
    it("toggles the theme and shows the active mode", () => {
      themeMode = "dark";
      render(<MobileNavMenu open onClose={vi.fn()} />);

      const row = screen.getByTestId("mobile-nav-menu-theme");
      expect(row).toHaveTextContent("theme Dark");

      fireEvent.click(row);
      expect(toggleTheme).toHaveBeenCalledTimes(1);
    });

    it("prompts with a native picker of every supported locale", () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);

      // The interactive element is a <select>, so a phone opens its OS picker
      // sheet; the old row was a button that silently cycled on tap.
      const select = screen.getByTestId("mobile-nav-menu-language");
      expect(select.tagName).toBe("SELECT");
      expect(select).toHaveAccessibleName("language");
      expect(select).toHaveValue("en");
      expect(
        Array.from((select as HTMLSelectElement).options).map((o) => [
          o.value,
          o.text,
        ]),
      ).toEqual([
        ["en", "English"],
        ["es", "Español"],
      ]);
      // Stretched transparently over the row, so the row's look is unchanged.
      const style = styleAttr(select);
      expect(style).toContain("opacity: 0");
      expect(style).toContain("position: absolute");
      // Under 16px iOS Safari zooms the page when the picker takes focus.
      expect(style).toContain("font-size: 16px");
      expect(
        screen.getByTestId("mobile-nav-menu-language-row"),
      ).toHaveTextContent("languageEnglish");
    });

    it("switches the locale live and keeps the sheet open", () => {
      const onClose = vi.fn();
      render(<MobileNavMenu open onClose={onClose} />);

      fireEvent.change(screen.getByTestId("mobile-nav-menu-language"), {
        target: { value: "es" },
      });

      expect(setAppLocaleMock).toHaveBeenCalledWith("es");
      // The visible value follows without a reload.
      expect(screen.getByTestId("mobile-nav-menu-language")).toHaveValue("es");
      expect(
        screen.getByTestId("mobile-nav-menu-language-row"),
      ).toHaveTextContent("Español");
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("keeps the language row in the inset-ring family", () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);

      const row = screen.getByTestId("mobile-nav-menu-language-row");
      expect(row).toHaveAttribute("data-focus-inset");
      expect(styleAttr(row)).toContain("min-height: 44px");
      expect(styleAttr(row)).toContain(
        "border-bottom: 1px solid var(--borderColorSoft, rgba(33, 28, 22, 0.3))",
      );
    });

    it("leaves the picker in the focus trap's tab stops", async () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);
      await waitFor(() => expect(document.activeElement).toBe(closeButton()));

      const select = screen.getByTestId("mobile-nav-menu-language");
      select.focus();
      expect(document.activeElement).toBe(select);
      // Not a wrap point: the browser's own Tab runs.
      expect(fireEvent.keyDown(select, { key: "Tab" })).toBe(true);
    });
  });

  describe("motion", () => {
    it("uses one 240ms slide on the sanctioned easing", async () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);

      await waitFor(() =>
        expect(styleAttr(panel())).toContain(
          "transition: transform 240ms cubic-bezier(0.2, 0.8, 0.3, 1)",
        ),
      );
    });

    it("drops the transition entirely under prefers-reduced-motion", async () => {
      setPrefersReducedMotion(true);
      render(<MobileNavMenu open onClose={vi.fn()} />);

      await waitFor(() =>
        expect(styleAttr(panel())).toContain("transform: translateY(0)"),
      );
      expect(styleAttr(panel())).not.toContain("transition");
      expect(styleAttr(scrim())).not.toContain("transition");
    });
  });

  describe("shell", () => {
    it("is a labelled modal sheet at the drawer layer, capped at 86vh", () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);

      expect(panel()).toHaveAttribute("aria-modal", "true");
      expect(panel()).toHaveAccessibleName("menu");

      const style = styleAttr(panel());
      expect(style).toContain("max-height: 86vh");
      // --shadow-4: a hard offset, not a blur.
      expect(style).toContain("box-shadow: 10px 10px 0 rgba(33, 28, 22, 0.90)");
      // margin-top:auto is what pins the sheet to the BOTTOM edge.
      expect(style).toContain("margin-top: auto");

      // zIndexTokens.drawer, read through the `tokens` bag rather than inlined.
      expect(styleAttr(screen.getByTestId("mobile-nav-menu"))).toContain(
        "z-index: 1350",
      );
      expect(styleAttr(scrim())).toContain(
        "background: rgba(33, 28, 22, 0.72)",
      );
    });

    it("locks the page behind it and restores the previous overflow", () => {
      document.body.style.overflow = "scroll";
      const { rerender } = render(<MobileNavMenu open onClose={vi.fn()} />);

      expect(document.body.style.overflow).toBe("hidden");

      rerender(<MobileNavMenu open={false} onClose={vi.fn()} />);
      expect(document.body.style.overflow).toBe("scroll");
    });

    it("carries the three overflow groups and no bottom-bar destination", () => {
      render(<MobileNavMenu open onClose={vi.fn()} />);

      for (const id of ["features", "help", "about", "contact", "dashboard"]) {
        expect(screen.getByTestId(`mobile-nav-menu-${id}`)).toBeInTheDocument();
      }
      // Home / Search / Tickets / Support live in the bottom bar and must not
      // be duplicated here.
      expect(screen.queryByTestId("mobile-nav-menu-my-tickets")).toBeNull();
      expect(screen.queryByRole("searchbox")).toBeNull();
    });
  });
});
