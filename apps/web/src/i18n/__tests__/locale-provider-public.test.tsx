/**
 * The client language steps on public pages (Spanish SEO spec R5, R6, R22,
 * FR-003, FR-004, FR-015), through the real provider:
 *   - an explicit Spanish choice on an English R1 page moves to the indexable
 *     /es/ twin; navigator language alone never moves anyone;
 *   - nothing is offered inline: the picker is the only switch (R23);
 *   - landing on /es/ saves Spanish only when nothing is saved (R6);
 *   - an /es/ page is not flipped back by a stored "en" (the URL wins);
 *   - a twinless event/place/org page switches to an explicit Spanish choice
 *     after hydration (R22), never on navigator alone;
 *   - the picker on a page with twins saves and navigates (FR-004).
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale, useTranslations } from "@th/ui";

const nav = vi.hoisted(() => ({
  pathname: "/",
  router: {
    refresh: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
}));

import { AppLocaleProvider, useSetAppLocale } from "../locale-provider";
import { PublicTwins } from "../public-twins";
import type { PublicTwinSet } from "../client-locale";

const KEY = "th-locale";
const EN = "/events/category/music";
const ES = "/es/eventos/categoria/musica";
const twins: PublicTwinSet = {
  en: { path: EN, indexable: true },
  es: { path: ES, indexable: true },
};

const readCookie = (): string | undefined =>
  document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${KEY}=`))
    ?.slice(KEY.length + 1);
const clearCookie = () => {
  document.cookie = `${KEY}=;path=/;max-age=0`;
};
const saveChoice = (locale: string) => {
  localStorage.setItem(KEY, locale);
  document.cookie = `${KEY}=${locale};path=/`;
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

const renderAt = (
  pathname: string,
  serverLocale: "en" | "es",
  pageTwins: PublicTwinSet | null = null,
) => {
  nav.pathname = pathname;
  return render(
    <AppLocaleProvider serverLocale={serverLocale}>
      {pageTwins ? <PublicTwins twins={pageTwins} /> : null}
      <Consumer />
    </AppLocaleProvider>,
  );
};

beforeEach(() => {
  localStorage.clear();
  clearCookie();
  setNavigatorLanguage("en-US");
  // Reset, not clear: the history describe below installs implementations.
  nav.router.refresh.mockReset();
  nav.router.replace.mockReset();
  nav.router.push.mockReset();
  setLocale = undefined;
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  clearCookie();
  if (originalLanguage) {
    Object.defineProperty(window.navigator, "language", originalLanguage);
  } else {
    delete (window.navigator as { language?: string }).language;
  }
});

describe("English R1 page (FR-003, R5)", () => {
  it("moves an explicit Spanish chooser to the /es/ twin, once", () => {
    saveChoice("es");
    const { rerender } = renderAt(EN, "en", twins);

    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(nav.router.replace).toHaveBeenCalledWith(ES);
    // The page itself never flips to Spanish in place.
    expect(screen.getByTestId("copy")).toHaveTextContent("Language");

    rerender(
      <AppLocaleProvider serverLocale="en">
        <PublicTwins twins={twins} />
        <Consumer />
      </AppLocaleProvider>,
    );
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
  });

  it("does not move on navigator language alone, and saves nothing", () => {
    setNavigatorLanguage("es-MX");
    renderAt(EN, "en", twins);

    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("copy")).toHaveTextContent("Language");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readCookie()).toBeUndefined();
  });

  it("does not move to a noindex twin", () => {
    saveChoice("es");
    renderAt(EN, "en", {
      en: { path: EN, indexable: true },
      es: { path: "/es/eventos/categoria/music", indexable: false },
    });
    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("copy")).toHaveTextContent("Language");
  });

  it("does not move a Spanish browser that chose English", () => {
    setNavigatorLanguage("es-MX");
    saveChoice("en");
    renderAt(EN, "en", twins);
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it("ignores a twin set registered for another page", () => {
    saveChoice("es");
    renderAt("/about", "en", twins);
    expect(nav.router.replace).not.toHaveBeenCalled();
  });
});

describe("/es/ page (R2, R5, R6)", () => {
  it("saves Spanish when nothing is saved", () => {
    renderAt(ES, "es", twins);
    expect(localStorage.getItem(KEY)).toBe("es");
    expect(readCookie()).toBe("es");
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
  });

  it("keeps a saved English choice and is not flipped back by it", () => {
    saveChoice("en");
    renderAt(ES, "es", twins);
    expect(localStorage.getItem(KEY)).toBe("en");
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    expect(document.documentElement.lang).toBe("es");
    expect(nav.router.replace).not.toHaveBeenCalled();
  });
});

describe("language picker on a page with twins (FR-004)", () => {
  it("saves English and navigates to the English twin from /es/", () => {
    renderAt(ES, "es", twins);
    act(() => setLocale!("en"));
    expect(localStorage.getItem(KEY)).toBe("en");
    expect(nav.router.replace).toHaveBeenCalledWith(EN);
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(nav.router.refresh).not.toHaveBeenCalled();
  });

  it("reaches the English twin from a noindex /es/ page", () => {
    const noindex: PublicTwinSet = {
      en: { path: EN, indexable: true },
      es: { path: "/es/eventos/categoria/music", indexable: false },
    };
    renderAt("/es/eventos/categoria/music", "es", noindex);
    act(() => setLocale!("en"));
    expect(nav.router.replace).toHaveBeenCalledWith(EN);
    expect(nav.router.push).not.toHaveBeenCalled();
  });

  it("saves Spanish and navigates to the /es/ twin from the English page", () => {
    renderAt(EN, "en", twins);
    act(() => setLocale!("es"));
    expect(localStorage.getItem(KEY)).toBe("es");
    expect(nav.router.replace).toHaveBeenCalledWith(ES);
    expect(nav.router.push).not.toHaveBeenCalled();
    // No in-place flip: the English URL stays English.
    expect(screen.getByTestId("copy")).toHaveTextContent("Language");
  });
});

describe("twinless public page (R22, FR-015)", () => {
  const EVENT = "/events/us/nashville/some-show";

  it("switches the chrome to an explicit Spanish choice after hydration", () => {
    saveChoice("es");
    renderAt(EVENT, "en");
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it("stays English for a Spanish browser with no choice", () => {
    setNavigatorLanguage("es-MX");
    renderAt(EVENT, "en");
    expect(screen.getByTestId("copy")).toHaveTextContent("Language");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("picking Spanish switches the chrome in place, with no refresh", () => {
    renderAt(EVENT, "en");
    act(() => setLocale!("es"));
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    expect(nav.router.push).not.toHaveBeenCalled();
    // The server ignores the cookie here; a refresh could not help.
    expect(nav.router.refresh).not.toHaveBeenCalled();
  });
});

describe("app page (unchanged)", () => {
  it("still follows navigator language with no choice", () => {
    setNavigatorLanguage("es-MX");
    renderAt("/search", "en");
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("picker on a URL-language page with no registered twins", () => {
  it("saves Spanish on an English R1 page without flipping it", () => {
    renderAt("/", "en");
    act(() => setLocale!("es"));
    expect(localStorage.getItem(KEY)).toBe("es");
    expect(screen.getByTestId("copy")).toHaveTextContent("Language");
    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(nav.router.refresh).not.toHaveBeenCalled();
  });

  it("saves English on an /es/ page without flipping it", () => {
    renderAt("/es", "es");
    act(() => setLocale!("en"));
    expect(localStorage.getItem(KEY)).toBe("en");
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
  });
});

describe("query string and fragment", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `${EN}?near=nashville#list`);
  });

  it("ride along on the picker's switch", () => {
    renderAt(EN, "en", twins);
    act(() => setLocale!("es"));
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(nav.router.replace).toHaveBeenCalledWith(
      `${ES}?near=nashville#list`,
    );
  });

  it("ride along on the FR-003 move", () => {
    saveChoice("es");
    renderAt(EN, "en", twins);
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(nav.router.replace).toHaveBeenCalledWith(
      `${ES}?near=nashville#list`,
    );
  });
});

/**
 * Client navigations: the root layout (and so this provider) stays mounted
 * while the pathname changes and pages swap their `<PublicTwins>`. A tiny
 * history stack stands in for the browser's.
 */
describe("navigation sequences", () => {
  const ABOUT = "/about";
  const ACERCA = "/es/acerca-de";
  const aboutTwins: PublicTwinSet = {
    en: { path: ABOUT, indexable: true },
    es: { path: ACERCA, indexable: true },
  };
  const TWINS_BY_PATH: Record<string, PublicTwinSet> = {
    [EN]: twins,
    [ES]: twins,
    [ABOUT]: aboutTwins,
    [ACERCA]: aboutTwins,
  };
  let stack: string[] = [];
  let rerenderTree: (ui: React.ReactElement) => void = () => {};

  /** The tree a page at `pathname` renders, with `pageTwins` registered. */
  const view = (pageTwins: PublicTwinSet | null, pageKey: string) => (
    <AppLocaleProvider serverLocale="en">
      {pageTwins ? <PublicTwins key={pageKey} twins={pageTwins} /> : null}
      <Consumer />
    </AppLocaleProvider>
  );

  const start = (path: string, history: string[] = [path]) => {
    stack = [...history];
    nav.pathname = path;
    rerenderTree = render(view(TWINS_BY_PATH[path] ?? null, path)).rerender;
  };

  /** Render the top of the stack until no further navigation fires. */
  const settle = () => {
    for (let i = 0; i < 5; i += 1) {
      const top = stack[stack.length - 1]!;
      if (top === nav.pathname) return;
      nav.pathname = top;
      act(() => rerenderTree(view(TWINS_BY_PATH[top] ?? null, top)));
    }
    throw new Error(`navigation did not settle: ${stack.join(" → ")}`);
  };

  const back = () => {
    stack.pop();
    settle();
  };

  beforeEach(() => {
    nav.router.push.mockImplementation((p: string) => {
      stack.push(p);
    });
    nav.router.replace.mockImplementation((p: string) => {
      stack[stack.length - 1] = p;
    });
  });

  it("Back after a picker switch leaves the page instead of bouncing", () => {
    start(ABOUT, ["/search", ABOUT]);
    act(() => setLocale!("es"));
    settle();
    expect(nav.pathname).toBe(ACERCA);
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");

    back();
    expect(nav.pathname).toBe("/search");
    expect(stack).toEqual(["/search"]);
    // Only the picker's own switch; no FR-003 move fired on the way back.
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(nav.router.push).not.toHaveBeenCalled();
  });

  it("an app page keeps a live, unsaved choice on the next app page", () => {
    start("/search");
    expect(screen.getByTestId("copy")).toHaveTextContent("Language");
    act(() => setLocale!("es"));
    // Persistence failed (cookies and storage blocked): nothing is saved.
    localStorage.clear();
    clearCookie();

    stack.push("/account/settings");
    settle();
    expect(screen.getByTestId("copy")).toHaveTextContent("Idioma");
  });

  it("ignores the previous page's twin set; moves once its own registers", () => {
    saveChoice("es");
    // An /es/ page whose set has an INDEXABLE es twin: if the provider used
    // it on the next page, both the move and the picker would go to ACERCA.
    nav.pathname = ACERCA;
    const { rerender } = render(view(aboutTwins, ACERCA));
    expect(nav.router.replace).not.toHaveBeenCalled();

    // Client navigation to the English category page; the old page's set is
    // still the registered one for this render.
    nav.pathname = EN;
    act(() => rerender(view(aboutTwins, ACERCA)));
    expect(nav.router.replace).not.toHaveBeenCalled();

    // The picker during that render must not use the stale set either.
    act(() => setLocale!("es"));
    expect(nav.router.replace).not.toHaveBeenCalledWith(ACERCA);
    expect(nav.router.replace).not.toHaveBeenCalled();

    // The category page's own set lands.
    act(() => rerender(view(twins, EN)));
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(nav.router.replace).toHaveBeenCalledWith(ES);
  });

  it("moves again on a later arrival at the same English page", () => {
    saveChoice("es");
    start(EN, ["/search", EN]);
    settle();
    expect(nav.pathname).toBe(ES);
    expect(nav.router.replace).toHaveBeenCalledTimes(1);

    // An English link back to the same page: the guard has reset.
    stack.push(EN);
    settle();
    expect(nav.pathname).toBe(ES);
    expect(nav.router.replace).toHaveBeenCalledTimes(2);
    expect(nav.router.replace).toHaveBeenNthCalledWith(2, ES);
  });
});
