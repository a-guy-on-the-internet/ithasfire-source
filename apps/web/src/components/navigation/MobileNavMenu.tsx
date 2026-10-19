"use client";

/**
 * The consumer mobile top bar's hamburger menu.
 *
 * Once the bottom bar took navigation (Home · Search · Tickets · Support plus
 * one contextual primary), the top bar was left holding a 38px wordmark and
 * two preference toggles — one of which spent ~100px spelling out "English".
 * Approved design (2026-08-28): the top bar does two jobs, identity and
 * account, and everything else moves in here.
 *
 * A hamburger rather than a "⋯" because it earns the space: it absorbs the
 * secondary destinations that are otherwise reachable only by scrolling to the
 * footer. Three groups is the ceiling — past that it is a sitemap, not a menu.
 *
 * SHAPE IS SPECIFIED, not invented: the design system folder defines this as
 * `MobileNavSheet` (components/navigation/MobileNavSheet.prompt.md,
 * navigation.css:36-45). It is a BOTTOM sheet — "the thumb is at the bottom of
 * the phone" — rising on translateY(100%), the one sanctioned slide, over a
 * 72%-ink scrim that dismisses on click, capped at 86vh so the page stays
 * visible behind it. Rows are mono/uppercase/tracked, and the current route
 * carries the accent wash plus a 3px inset accent bar.
 *
 * Three deliberate departures, because the architecture moved after the folder
 * was written: no search in the head (it is a permanent bottom-bar tab now), no
 * pinned foot actions (sign-in lives in the top bar), and the link list is
 * overflow — Browse / Preferences / Organisers — rather than the primary nav.
 *
 * Deliberately absent: Home, Search, Tickets, Support. They are one thumb-reach
 * away in the bottom bar and must not be duplicated here.
 *
 * DIFFED AGAINST `MobileNavSheet.jsx`, for the things its CSS cannot say. DOM
 * order matches (scrim, then panel; head, then body). Four places we knowingly
 * do MORE than the reference, none of them a departure from the design: it puts
 * `role="dialog"` on the OUTER wrapper — which contains the scrim — where ours
 * is on the panel, so the scrim is not announced as part of the dialog; it
 * labels with `aria-label="Menu"` where ours points `aria-labelledby` at a
 * visually-hidden heading; it has no focus trap, no focus restore and no scroll
 * lock; and it returns null the instant `open` goes false, which throws away the
 * exit half of the slide its own CSS animates in. Its "focus the first control"
 * is `querySelector('a,button,input')` — with search gone from our head, that
 * resolves to the close button, which is what `firstControlRef` points at.
 *
 * BREAKPOINT — 900, the folder's number. `prompt.md` opens with "the public
 * nav below 900px", so that is `PUBLIC_NAV_BREAKPOINT` and where `AppNavbar`'s
 * stylesheet (`APP_NAVBAR_CSS`) shows the burger. (The folder does not agree
 * with itself: its own CSS switches the burger in at `max-width:1100px`,
 * navigation.css:33. The prompt wins.) The sheet has no media query of its
 * own — it is reachable only through that burger.
 *
 * The bar collapses in TWO stages, and they are not the same decision. At 900
 * the burger appears and theme + language move in here, because they are set
 * once and a duplicate toggle in the bar would be two controls for one setting.
 * At 600 (`MOBILE_BREAKPOINT`) the bar runs out of room and drops to identity,
 * bell and account. Between the two it keeps the saved-heart and My Tickets as
 * well — folding those into 900 would strand them across 300px of viewport.
 * Both stages are CSS media queries in `AppNavbar`, not the viewport hooks, so
 * the server HTML is already right at every width. Neither number is
 * `useIsCompactViewport`'s 960: that governs the bottom nav and the admin
 * drawer, a different affordance.
 */

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { HIT_MIN, Text, tokens, useLocale, useTranslations } from "@th/ui";
import { XStack, YStack } from "tamagui";
import { useAppTheme } from "@/components/theme/AppThemeProvider";
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  useSetAppLocale,
  type AppLocale,
} from "@/i18n";
import type { PublicLinkPage } from "@/i18n/public-paths";
import { usePublicLinks } from "@/i18n/use-public-links";

/** Honours the OS "reduce motion" setting; SSR-safe (defaults to false). */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

export interface MobileNavMenuProps {
  open: boolean;
  onClose: () => void;
}

/**
 * A destination with one URL (`href`), or a page with language twins
 * (`page`), linked in the language of the page in view (spanish-seo FR-006).
 * `id` names the test id, so it stays put whatever the language.
 */
type MenuLink = { id: string; labelKey: string } & (
  | { href: string }
  | { page: PublicLinkPage }
);

/** Browse group — the same destinations the footer already carries. */
const BROWSE_LINKS: MenuLink[] = [
  { id: "features", href: "/features", labelKey: "common.footerFeatures" },
  { id: "help", href: "/help", labelKey: "common.footerHelpCentre" },
  { id: "about", page: { kind: "about" }, labelKey: "common.footerAbout" },
  {
    id: "contact",
    page: { kind: "contact" },
    labelKey: "common.footerContact",
  },
];

export const MobileNavMenu = ({ open, onClose }: MobileNavMenuProps) => {
  const t = useTranslations();
  const { mode, toggle } = useAppTheme();
  const currentLocale = useLocale() as AppLocale;
  const setAppLocale = useSetAppLocale();
  const pathname = usePathname() ?? "";
  const links = usePublicLinks();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstControlRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Capture the opener before the panel mounts so close returns focus to the
  // exact control the user activated (WCAG 2.4.3).
  useEffect(() => {
    if (open) {
      openerRef.current =
        (document.activeElement as HTMLElement | null) ?? null;
      // Focus moves in the `mounted` effect below — on this pass the portal
      // has not committed yet, so `firstControlRef` is still null.
    } else {
      openerRef.current?.focus?.();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // The page behind must not scroll while the sheet is up.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Kept mounted for the exit transition; `visible` drives the transform so
  // the sheet slides out rather than vanishing.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const reduceMotion = usePrefersReducedMotion();
  const motionMs = reduceMotion ? 0 : MOTION_MS;

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames: the first paints the closed state, the second animates to
      // open. One frame is not enough — the browser batches them.
      const id = requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true)),
      );
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const timer = setTimeout(() => setMounted(false), motionMs);
    return () => clearTimeout(timer);
  }, [open, motionMs]);

  // Spec: focus the first CONTROL on open, not the container. Keyed on
  // `mounted` so the portal is in the DOM by the time this runs.
  useEffect(() => {
    if (!mounted || !open) return;
    const id = requestAnimationFrame(() => firstControlRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [mounted, open]);

  // `aria-modal` tells a screen reader the rest of the page is inert; it does
  // NOT stop Tab walking out of the sheet into the page behind it. Keyed on
  // `mounted`, not `open` — on the `open` pass the portal has not committed and
  // `panelRef` is still null.
  useEffect(() => {
    if (!mounted || !open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;

      const stops = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      // No stops at all: hold focus on the panel rather than letting it escape.
      if (stops.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      // Focus is on the panel itself (it carries tabIndex -1 and is the target
      // of the empty-sheet fallback above) or has already escaped: pull it back
      // to whichever end the user is tabbing towards.
      if (!active || !panel.contains(active) || active === panel) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mounted, open]);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        // The folder's `--z-drawer`. `zIndexTokens` itself is not re-exported
        // from `@th/ui`, but the `tokens` bag that wraps it is — so this reads
        // the real value (1350) rather than restating it.
        zIndex: tokens.zIndex.drawer,
        display: "flex",
        flexDirection: "column",
      }}
      data-testid="mobile-nav-menu"
    >
      {/* Scrim: dismisses on click, and keeps the page visible behind the sheet
          so the buyer never loses their place. */}
      <button
        type="button"
        /* The scrim sits OUTSIDE `role="dialog"`, so the focus trap below
           cannot reach it — and a keyboard user already has two ways out
           (Escape, the close button). Hiding it from the a11y tree also
           removes a second element whose accessible name is "Close". */
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        data-testid="mobile-nav-menu-scrim"
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(33, 28, 22, 0.72)",
          border: 0,
          padding: 0,
          cursor: "pointer",
          opacity: visible ? 1 : 0,
          transition: reduceMotion
            ? undefined
            : `opacity ${motionMs}ms ${EASE_OUT}`,
        }}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: "relative",
          marginTop: "auto",
          maxHeight: "86vh",
          overflowY: "auto",
          background: "var(--surface, #FDFAF3)",
          borderTop: "2px solid var(--structure, #211C16)",
          // --shadow-4: the system's hard offset, not a blur.
          boxShadow: "10px 10px 0 rgba(33, 28, 22, 0.90)",
          outline: "none",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          transform: visible ? "translateY(0)" : "translateY(100%)",
          transition: reduceMotion
            ? undefined
            : `transform ${motionMs}ms ${EASE_OUT}`,
          willChange: "transform",
        }}
      >
        <h2 id={titleId} style={srOnlyStyle}>
          {String(t("common.menu"))}
        </h2>

        {/* `.if-navsheet__head`: `padding: var(--sp-4)` (= `$4`, 16px) with
            `gap: var(--sp-3)`. The head's rule is `--bw-structure` on
            `--color-border` — 2px of full ink, unlike the rows below. */}
        <XStack
          alignItems="center"
          justifyContent="flex-end"
          padding="$4"
          gap="$3"
          borderBottomWidth={tokens.border.structure}
          borderBottomColor="$borderColor"
          data-testid="mobile-nav-menu-head"
        >
          <button
            type="button"
            ref={firstControlRef}
            onClick={onClose}
            aria-label={String(t("common.close"))}
            data-testid="mobile-nav-menu-close"
            style={{
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "none",
              border: "2px solid var(--structure, #211C16)",
              borderRadius: 0,
              color: "inherit",
              cursor: "pointer",
            }}
          >
            <X size={18} aria-hidden />
          </button>
        </XStack>

        <MenuGroup label={String(t("common.menuBrowse"))}>
          {BROWSE_LINKS.map((link) => {
            const href = "page" in link ? links.path(link.page) : link.href;
            return (
              <MenuRow
                key={link.id}
                href={href}
                label={String(t(link.labelKey))}
                current={pathname === href}
                onSelect={onClose}
                testId={`mobile-nav-menu-${link.id}`}
              />
            );
          })}
        </MenuGroup>

        <MenuGroup label={String(t("common.menuPreferences"))}>
          <MenuRow
            label={String(t("common.theme"))}
            value={String(
              t(mode === "dark" ? "common.themeDark" : "common.themeLight"),
            )}
            onSelect={toggle}
            testId="mobile-nav-menu-theme"
          />
          <LanguageRow
            label={String(t("common.language"))}
            currentLocale={currentLocale}
            onChange={setAppLocale}
            testId="mobile-nav-menu-language"
          />
        </MenuGroup>

        <MenuGroup label={String(t("common.menuOrganisers"))}>
          <MenuRow
            href="/admin"
            label={String(t("common.footerDashboard"))}
            current={pathname.startsWith("/admin")}
            onSelect={onClose}
            testId="mobile-nav-menu-dashboard"
          />
        </MenuGroup>
      </div>
    </div>,
    document.body,
  );
};

MobileNavMenu.displayName = "MobileNavMenu";

/**
 * `--dur-slow` from the design system's motion tokens, paired with its
 * `--ease-out`. One duration for the sheet, so enter/exit and the unmount timer
 * can never drift apart.
 */
const MOTION_MS = 240;

/** `--ease-out` from the system's motion tokens. */
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.3, 1)";

/**
 * Tab stops the trap cycles through. Everything focusable in this sheet is
 * always rendered and always visible, so there is deliberately no visibility
 * filter — `offsetParent` is unimplemented in jsdom and would silently empty
 * this list under test while working in the browser.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled]):not([tabindex='-1'])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

const MenuGroup = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <YStack tag="section" paddingBottom="$2">
    <Text
      variant="overline"
      tone="muted"
      paddingHorizontal="$4"
      paddingTop="$4"
      paddingBottom="$2"
    >
      {label}
    </Text>
    {children}
  </YStack>
);

/** The row chrome every sheet row shares; see `MenuRow`. */
const rowStyle = ({
  hasValue,
  current,
}: {
  hasValue: boolean;
  current: boolean;
}): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: hasValue ? "space-between" : "flex-start",
  // `.if-navsheet__body a`: `padding: var(--sp-4)`, `gap: var(--sp-3)`,
  // `min-height: var(--hit-min)`.
  gap: tokens.space.$3,
  minHeight: HIT_MIN,
  padding: tokens.space.$4,
  width: "100%",
  textAlign: "left",
  // `var(--token, <stub value>)`: the theme injector sets `--<key>` at
  // runtime, and the fallback is what SSR paints — so it MUST be the Stub
  // value, not a placeholder.
  background: current ? "var(--accentSoft, rgba(226, 72, 29, 0.10))" : "none",
  boxShadow: current ? "inset 3px 0 0 var(--accent, #E2481D)" : undefined,
  // A row divider is an INNER rule: `--bw-hair` on `--color-border-soft`
  // (ink at 30%), not the 2px full-ink `--color-border` the head carries.
  border: 0,
  borderBottom: `${tokens.border.hair}px solid var(--borderColorSoft, rgba(33, 28, 22, 0.3))`,
  // A `tag="a"` row would otherwise inherit the global anchor ink and rule;
  // inline style beats every class, which is what makes this reset stick.
  color: "inherit",
  font: "inherit",
  textDecoration: "none",
  cursor: "pointer",
});

/**
 * A sheet row. Mono, uppercase, tracked at the system's `sm` rung — the folder's
 * `.if-navsheet__body a`.
 *
 * `data-focus-inset` because the row is full-bleed inside a panel that scrolls:
 * at the system's +2px offset the ring's vertical strokes are drawn outside the
 * panel and clipped, so it reads as two loose horizontal rules. Measured at
 * 760px before the fix: row 0-760 inside a panel 0-760, ring -2 to 762. The
 * attribute flips only the OFFSET (globals.css) — width and colour still come
 * from the system ring. The current route carries the accent wash plus its
 * 3px inset bar, which is how the sheet says where you are.
 */
const MenuRow = ({
  label,
  value,
  href,
  current = false,
  onSelect,
  testId,
}: {
  label: string;
  value?: string;
  href?: string;
  current?: boolean;
  onSelect: () => void;
  testId: string;
}) => {
  const content = (
    <>
      {/* The current row is marked by the accent wash and its 3px inset bar;
          `.if-navsheet__body a[aria-current]` leaves the ink alone, so the
          label keeps the default tone either way. */}
      <Text variant="overline">{label}</Text>
      {value ? (
        <Text variant="overline" tone="muted">
          {value}
        </Text>
      ) : null}
    </>
  );

  const style = rowStyle({ hasValue: Boolean(value), current });

  if (href) {
    return (
      <a
        href={href}
        onClick={onSelect}
        style={style}
        data-focus-inset=""
        data-testid={testId}
        {...(current ? { "aria-current": "page" as const } : {})}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      style={style}
      data-focus-inset=""
      data-testid={testId}
    >
      {content}
    </button>
  );
};

/**
 * The Language row. It looks exactly like a `MenuRow` with a value, but the
 * interactive element is a native `<select>` stretched transparently over it,
 * the same pattern as `LanguageSwitcher`'s mobile picker: a tap opens the OS
 * picker sheet (iOS wheel, Android dialog) instead of silently cycling.
 * The choice applies live and the sheet stays open, so the person sees the
 * menu itself switch language.
 *
 * Focus ring: the select is `opacity: 0`, which hides its own outline, so the
 * row draws the system ring while the select is `:focus-visible`. The row
 * carries `data-focus-inset`, so the ring is inset like every other row's.
 */
const LanguageRow = ({
  label,
  currentLocale,
  onChange,
  testId,
}: {
  label: string;
  currentLocale: AppLocale;
  onChange: (locale: AppLocale) => void;
  testId: string;
}) => {
  const [focusVisible, setFocusVisible] = useState(false);
  const value = LOCALE_LABELS[currentLocale] ?? currentLocale;

  return (
    <div
      data-focus-inset=""
      data-testid={`${testId}-row`}
      style={{
        ...rowStyle({ hasValue: true, current: false }),
        position: "relative",
        ...(focusVisible
          ? {
              outline: "var(--focus-width) solid var(--focus-color)",
              outlineOffset: "var(--focus-offset)",
            }
          : {}),
      }}
    >
      <Text variant="overline" aria-hidden>
        {label}
      </Text>
      <Text variant="overline" tone="muted" aria-hidden>
        {value}
      </Text>
      <select
        value={currentLocale}
        onChange={(e) => {
          const next = e.target.value as AppLocale;
          if (next !== currentLocale) onChange(next);
        }}
        onFocus={(e) => setFocusVisible(matchesFocusVisible(e.currentTarget))}
        onBlur={() => setFocusVisible(false)}
        aria-label={label}
        data-testid={testId}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          margin: 0,
          border: 0,
          cursor: "pointer",
          // iOS Safari zooms the page on focus of any control under 16px,
          // even at opacity 0; 16 keeps the sheet where it is.
          fontSize: 16,
        }}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </option>
        ))}
      </select>
    </div>
  );
};

/** `:focus-visible`, or false where the engine cannot parse it. */
const matchesFocusVisible = (el: Element): boolean => {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
};
