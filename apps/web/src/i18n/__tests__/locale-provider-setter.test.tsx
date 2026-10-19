/**
 * `useSetAppLocale()` switches the language LIVE. Before it existed the only
 * way to change language was to write localStorage and reload the page; the
 * mobile menu's Language row wrote localStorage and did not reload, so nothing
 * changed until the next refresh (owner report, 2026-10-16).
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale, useTranslations } from "@th/ui";

const refreshMock = vi.fn();
// An app page: these tests pin the viewer's-choice behaviour. URL-language
// pages are covered in `locale-provider-public.test.tsx`.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
  usePathname: () => "/search",
}));

import {
  AppLocaleProvider,
  setLocalePreference,
  useSetAppLocale,
} from "../locale-provider";

const STORAGE_KEY = "th-locale";
const COOKIE = "th-locale";

const readCookie = (): string | undefined =>
  document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

const clearCookie = () => {
  document.cookie = `${COOKIE}=;path=/;max-age=0`;
};

const originalLanguage = Object.getOwnPropertyDescriptor(
  window.navigator,
  "language",
);
const setNavigatorLanguage = (value: string) => {
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    get: () => value,
  });
};

let setLocale: ReturnType<typeof useSetAppLocale> | undefined;

const Consumer = () => {
  const t = useTranslations();
  const locale = useLocale();
  setLocale = useSetAppLocale();
  return (
    <p data-testid="copy" lang={locale}>
      {String(t("common.language"))}
    </p>
  );
};

beforeEach(() => {
  localStorage.clear();
  clearCookie();
  refreshMock.mockClear();
  setLocale = undefined;
});

afterEach(() => {
  localStorage.clear();
  clearCookie();
  if (originalLanguage) {
    Object.defineProperty(window.navigator, "language", originalLanguage);
  } else {
    delete (window.navigator as { language?: string }).language;
  }
});

describe("useSetAppLocale", () => {
  it("re-renders consumers with the new catalog and persists the choice", () => {
    render(
      <AppLocaleProvider serverLocale="en">
        <Consumer />
      </AppLocaleProvider>,
    );
    expect(screen.getByTestId("copy")).toHaveTextContent("Language");

    act(() => setLocale!("es"));

    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    expect(screen.getByTestId("copy")).toHaveAttribute("lang", "es");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("es");
    expect(document.documentElement.lang).toBe("es");
  });

  it("writes the th-locale cookie so the server's next render follows the choice", () => {
    render(
      <AppLocaleProvider serverLocale="en">
        <Consumer />
      </AppLocaleProvider>,
    );
    expect(readCookie()).toBeUndefined();

    act(() => setLocale!("es"));

    expect(readCookie()).toBe("es");
  });

  it("soft-refreshes server components after a switch", () => {
    render(
      <AppLocaleProvider serverLocale="en">
        <Consumer />
      </AppLocaleProvider>,
    );
    expect(refreshMock).not.toHaveBeenCalled();

    act(() => setLocale!("es"));

    expect(refreshMock).toHaveBeenCalledTimes(1);
    // The cookie is in place before the refresh's server request goes out.
    expect(readCookie()).toBe("es");
  });

  it("keeps a forced provider pinned but still persists the choice", () => {
    render(
      <AppLocaleProvider locale="en">
        <Consumer />
      </AppLocaleProvider>,
    );

    act(() => setLocale!("es"));

    expect(screen.getByTestId("copy")).toHaveTextContent("Language");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("es");
  });

  it("only persists outside a provider, without throwing", () => {
    render(<Consumer />);

    expect(() => act(() => setLocale!("es"))).not.toThrow();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("es");
    expect(readCookie()).toBe("es");
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe("when the cookie cannot be written", () => {
  // Cookies blocked while localStorage works, or a cross-site embed frame
  // where a SameSite=Lax cookie is not stored: writes are silently dropped.
  const blockCookies = () => {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: () => {},
    });
  };
  afterEach(() => {
    // Drop the own-property stub; the jsdom accessor on the prototype returns.
    delete (document as { cookie?: string }).cookie;
  });

  it("skips the refresh and keeps <html lang> on the chosen locale", () => {
    blockCookies();
    render(
      <AppLocaleProvider serverLocale="en">
        <Consumer />
      </AppLocaleProvider>,
    );

    act(() => setLocale!("es"));

    expect(refreshMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    expect(document.documentElement.lang).toBe("es");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("es");
  });
});

describe("<html lang> after a server re-render", () => {
  it("re-asserts the active locale when a refresh brings a new serverLocale", () => {
    localStorage.setItem(STORAGE_KEY, "es");
    const { rerender } = render(
      <AppLocaleProvider serverLocale="es">
        <Consumer />
      </AppLocaleProvider>,
    );
    expect(document.documentElement.lang).toBe("es");

    // A refresh re-renders the root layout: React commits the server's
    // `<html lang>` and AppProviders passes the new serverLocale down.
    document.documentElement.lang = "en";
    rerender(
      <AppLocaleProvider serverLocale="en">
        <Consumer />
      </AppLocaleProvider>,
    );

    expect(document.documentElement.lang).toBe("es");
  });
});

describe("setLocalePreference", () => {
  it("ignores an unsupported locale", () => {
    setLocalePreference("fr" as never);

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(readCookie()).toBeUndefined();
  });
});

describe("cookie backfill on mount", () => {
  it("copies a stored localStorage choice into a missing cookie", () => {
    localStorage.setItem(STORAGE_KEY, "es");

    render(
      <AppLocaleProvider serverLocale="en">
        <Consumer />
      </AppLocaleProvider>,
    );

    expect(readCookie()).toBe("es");
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    // Backfill alone never refreshes; it only fixes the NEXT load.
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("overwrites a cookie that disagrees with the stored choice", () => {
    localStorage.setItem(STORAGE_KEY, "en");
    document.cookie = `${COOKIE}=es;path=/`;

    render(
      <AppLocaleProvider serverLocale="es">
        <Consumer />
      </AppLocaleProvider>,
    );

    expect(readCookie()).toBe("en");
  });

  it("keeps a cookie choice that outlived localStorage over navigator.language", () => {
    setNavigatorLanguage("en-US");
    document.cookie = `${COOKIE}=es;path=/`;

    render(
      <AppLocaleProvider serverLocale="es">
        <Consumer />
      </AppLocaleProvider>,
    );

    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    expect(document.documentElement.lang).toBe("es");
    expect(readCookie()).toBe("es");
    expect(refreshMock).not.toHaveBeenCalled();
    // Backfill runs only from localStorage; it does not copy the cookie back.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("never writes a cookie from navigator.language detection", () => {
    setNavigatorLanguage("es-MX");

    render(
      <AppLocaleProvider serverLocale="en">
        <Consumer />
      </AppLocaleProvider>,
    );

    // Detection still switches the rendered language...
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    // ...but only an explicit choice is persisted.
    expect(readCookie()).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("ignores an unsupported stored value", () => {
    localStorage.setItem(STORAGE_KEY, "fr");

    render(
      <AppLocaleProvider serverLocale="en">
        <Consumer />
      </AppLocaleProvider>,
    );

    expect(readCookie()).toBeUndefined();
  });

  it("does not backfill under a forced locale", () => {
    localStorage.setItem(STORAGE_KEY, "es");

    render(
      <AppLocaleProvider locale="en">
        <Consumer />
      </AppLocaleProvider>,
    );

    expect(readCookie()).toBeUndefined();
  });
});
