/**
 * `LanguageSwitcher` applies the choice live through `useSetAppLocale()`.
 * It used to write localStorage and call `window.location.reload()`; these
 * tests pin that neither picker reloads the page any more.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { HTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setAppLocaleMock = vi.fn();
let isSmall = false;

vi.mock("@/i18n", () => ({
  SUPPORTED_LOCALES: ["en", "es"] as const,
  LOCALE_LABELS: { en: "English", es: "Español" },
  useSetAppLocale: () => setAppLocaleMock,
}));

// Tamagui primitives as plain elements; `onPress` maps to `onClick` and the
// style-only props are dropped so they do not land on the DOM.
vi.mock("tamagui", () => {
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
    XStack: make(),
    YStack: make(),
    styled: () => make(),
    useMedia: () => ({ sm: isSmall }),
  };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

import { LanguageSwitcher } from "../LanguageSwitcher";

const reloadMock = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  setAppLocaleMock.mockClear();
  reloadMock.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: reloadMock },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

describe("LanguageSwitcher", () => {
  it("native picker (small screens) switches live without a reload", () => {
    isSmall = true;
    render(<LanguageSwitcher />);

    const select = screen.getByTestId("language-switcher");
    expect(select.tagName).toBe("SELECT");
    // Under 16px iOS Safari zooms the page when the picker takes focus.
    expect(select.getAttribute("style")).toContain("font-size: 16px");
    fireEvent.change(select, { target: { value: "es" } });

    expect(setAppLocaleMock).toHaveBeenCalledWith("es");
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("custom dropdown (desktop) switches live without a reload", () => {
    isSmall = false;
    render(<LanguageSwitcher />);

    fireEvent.click(screen.getByTestId("language-switcher"));
    fireEvent.click(screen.getByRole("option", { name: "Español" }));

    expect(setAppLocaleMock).toHaveBeenCalledWith("es");
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("does nothing when the current locale is picked again", () => {
    isSmall = false;
    render(<LanguageSwitcher />);

    fireEvent.click(screen.getByTestId("language-switcher"));
    fireEvent.click(screen.getByRole("option", { name: "English" }));

    expect(setAppLocaleMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
