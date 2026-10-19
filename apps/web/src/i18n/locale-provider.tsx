"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { TranslationProvider, type Messages } from "@th/ui";

import enPackage from "@th/locale/messages/en.json" with { type: "json" };
import esPackage from "@th/locale/messages/es.json" with { type: "json" };

import enApp from "./messages/en";
import esApp from "./messages/es";

import { DEFAULT_LOCALE, type AppLocale } from "./config";
import {
  clientLocaleForPath,
  currentPageTwins,
  pathLanguage,
  twinMoveTarget,
  type PathLanguage,
  type PublicTwinSet,
} from "./client-locale";
import {
  readExplicitChoice,
  readLocaleCookie,
  readNavigatorLocale,
  readStoredPreference,
  setLocalePreference,
  writeLocaleCookie,
} from "./locale-storage";
import { PublicTwinsContext } from "./public-twins";

export { setLocalePreference } from "./locale-storage";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const packageCatalogs: Record<AppLocale, Messages> = {
  en: enPackage as unknown as Messages,
  es: esPackage as unknown as Messages,
};

const appCatalogs: Record<AppLocale, Messages> = {
  en: enApp,
  es: esApp,
};

/** Deep-merge two message catalogs. App-level keys override package-level. */
const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];

    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }

  return result as Messages;
};

// ─────────────────────────────────────────────────────────────────────────────
// Setter context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Outside an `AppLocaleProvider` there is no state to update, so the fallback
 * only persists the choice: the next mount reads it back. Harmless rather than
 * throwing, so a story or an isolated render of a switcher still works.
 */
const SetAppLocaleContext =
  createContext<(locale: AppLocale) => void>(setLocalePreference);

/**
 * Switch the app's language live: persists the choice (localStorage and the
 * `th-locale` cookie), re-renders every `useLocale()` / `useTranslations()`
 * consumer with the new catalog, and soft-refreshes server components so
 * server-rendered text follows. No full page reload.
 *
 * On a page with language twins (`<PublicTwins>`), it saves the choice and
 * NAVIGATES to that language's twin instead (FR-004; one language per URL),
 * noindex twins included.
 */
export const useSetAppLocale = (): ((locale: AppLocale) => void) =>
  useContext(SetAppLocaleContext);

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export interface AppLocaleProviderProps {
  children: ReactNode;
  /** Force a specific locale (overrides detection). Useful for tests.
   *  A forced provider stays pinned: `useSetAppLocale()` still persists the
   *  choice, but the rendered locale only follows the prop. */
  locale?: AppLocale;
  /** Server-resolved locale: the URL's language on public pages, else the
   *  `th-locale` cookie, else Accept-Language (`pickServerLocale`). Used as
   *  initial value so SSR and hydration agree, preventing flicker. */
  serverLocale?: AppLocale;
}

/** Carry the current query string and fragment onto a twin's path. */
const withQueryAndHash = (path: string): string =>
  `${path}${window.location.search}${window.location.hash}`;

export const AppLocaleProvider = ({
  children,
  locale: forcedLocale,
  serverLocale,
}: AppLocaleProviderProps) => {
  const [detectedLocale, setLocale] = useState<AppLocale>(
    forcedLocale ?? serverLocale ?? DEFAULT_LOCALE,
  );
  const locale = forcedLocale ?? detectedLocale;
  // Every mount site sits inside the App Router (app/providers.tsx); tests
  // that render this provider mock `next/navigation`.
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [registeredTwins, registerTwins] = useState<PublicTwinSet | null>(null);
  const twins = currentPageTwins(registeredTwins, pathname);

  const setAppLocale = useCallback(
    (next: AppLocale) => {
      const rule = pathLanguage(pathname).kind;
      // FR-004: a page with twins changes language by changing URL. Replace,
      // not push: the twin is another view of the same page, not a new step.
      // A push left the English page under the Spanish one in history, so
      // Back landed there and the FR-003 move sent the reader straight back.
      const twin = forcedLocale ? undefined : twins?.[next];
      if (twin) {
        setLocalePreference(next);
        if (twin.path !== pathname) router.replace(withQueryAndHash(twin.path));
        return;
      }
      setLocalePreference(next);
      // A URL-language page with no twin for `next` (only if a page forgot to
      // register its twins) keeps the URL's language: one language per URL,
      // so an English R1 page never shows Spanish chrome in place. The choice
      // is saved and acts on the next page.
      if (!forcedLocale && (rule === "twinned" || rule === "url")) return;
      setLocale(next);
      // Server components (Help Center, `<html lang>`) re-render against the
      // new cookie. A soft refresh: client state (an open menu sheet, form
      // input) is kept and there is no full page load. Skipped when the cookie
      // did not stick (cookies blocked, a cross-site embed frame): the server
      // would only re-render from Accept-Language, so a refresh cannot help.
      // Skipped too where the URL fixes the server's language (public pages):
      // the server ignores the cookie there.
      if (readLocaleCookie() === next && rule === "app") {
        router.refresh();
      }
    },
    [router, twins, pathname, forcedLocale],
  );

  // The language each path calls for (see `client-locale.ts`), on mount and
  // after every client navigation, unless forced:
  //   - /es/...: the URL's language, over any saved choice; saves it as the
  //     choice only when nothing is saved yet (R6);
  //   - unprefixed R1 page: English (a Spanish choice acts by moving, below);
  //   - event / place / org page: the explicit choice, else English (R22);
  //   - app page: explicit choice > navigator > default. Re-detected only when
  //     arriving from a public page, so an app→app navigation keeps a live
  //     choice whose persistence failed (cookies blocked).
  const previousRule = useRef<PathLanguage["kind"] | null>(null);
  useEffect(() => {
    if (forcedLocale) return;
    // A choice made before the cookie existed lives only in localStorage:
    // copy it into the cookie so the next load's server render follows it.
    // Only an EXPLICIT stored choice; navigator detection never sets a cookie.
    const stored = readStoredPreference();
    if (stored && readLocaleCookie() !== stored) writeLocaleCookie(stored);

    const rule = pathLanguage(pathname);
    const arrivingFrom = previousRule.current;
    previousRule.current = rule.kind;
    if (rule.kind === "app" && arrivingFrom === "app") return;

    const explicit = readExplicitChoice();
    if (rule.kind === "url" && !explicit) setLocalePreference(rule.locale);
    const detected = clientLocaleForPath(pathname, {
      explicit,
      navigatorLocale: readNavigatorLocale(),
    });
    setLocale((prev) => (prev !== detected ? detected : prev));
  }, [forcedLocale, pathname]);

  // FR-003: on an unprefixed R1 page, a visitor whose explicit choice has an
  // indexable twin here is moved there after load. Replace, not push: Back
  // must not return to a page that moves them again. Never on navigator alone.
  // One move per arrival: a re-render while the navigation is in flight must
  // not fire a second replace.
  const movedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (forcedLocale) return;
    const target = twinMoveTarget({
      pathname,
      twins,
      explicit: readExplicitChoice(),
    });
    if (!target) {
      movedFrom.current = null;
      return;
    }
    if (movedFrom.current === pathname) return;
    movedFrom.current = pathname;
    router.replace(withQueryAndHash(target));
  }, [forcedLocale, pathname, twins, router]);

  // Keep <html lang="…"> in sync with the active locale. `serverLocale` is a
  // dep too: when a refresh brings a new server value, React commits it onto
  // <html lang> (the root layout renders it), and this re-asserts the locale
  // the text is actually in, so a screen reader never gets the wrong voice.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale, serverLocale]);

  const messages = useMemo(
    () => mergeCatalogs(packageCatalogs[locale], appCatalogs[locale]),
    [locale],
  );

  const twinsContext = useMemo(
    () => ({ twins, register: registerTwins }),
    [twins],
  );

  return (
    <SetAppLocaleContext.Provider value={setAppLocale}>
      <PublicTwinsContext.Provider value={twinsContext}>
        <TranslationProvider locale={locale} messages={messages}>
          {children}
        </TranslationProvider>
      </PublicTwinsContext.Provider>
    </SetAppLocaleContext.Provider>
  );
};

AppLocaleProvider.displayName = "AppLocaleProvider";
