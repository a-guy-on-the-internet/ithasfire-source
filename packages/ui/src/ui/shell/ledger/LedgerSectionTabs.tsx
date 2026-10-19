"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Platform } from "react-native";
import { XStack, YStack, styled } from "tamagui";

import { Text } from "../../tamagui/components/typography/Text";
import { monoScale } from "../../tamagui/tokens/typography";

const isWeb = Platform.OS === "web";

export const LEDGER_SECTION_TABS_HEIGHT = 40;

export interface LedgerSectionTabItem {
  href: string;
  label: string;
  /** Mono count after the label — only where the number changes behaviour. */
  count?: number | string;
}

export interface LedgerSectionTabsProps {
  items: LedgerSectionTabItem[];
  /** href of the active section. */
  current?: string;
  /**
   * Accessible name of the `<nav>` landmark. REQUIRED and must differ from
   * the rail's "Main navigation" — two landmarks with one name break
   * strict-mode locators and read as a duplicate to screen readers.
   */
  label: string;
  /**
   * Client-side activate handler. With it, a plain click is intercepted
   * (`preventDefault` → `onSelect(href)`) while modifier-clicks fall through
   * to the browser so ⌘/Ctrl-click and middle-click still open a new tab.
   * Without it the anchors navigate natively.
   */
  onSelect?: (href: string) => void;
  /** A menu for sections that do not fit. Admin needs this. */
  overflow?: ReactNode;
  contentMaxWidth?: number;
  testIdBase?: string;
}

const STYLE_ID = "th-ledger-sections-style";
const SCROLL_CLASS = "th-ledger-sections__scroll";
const TAB_CLASS = "th-ledger-tab";
const TAB_LABEL_CLASS = "th-ledger-tab__label";

/**
 * Web-only CSS Tamagui cannot express as style props: a hidden scrollbar on
 * the horizontal rail, the ≤640px scroll-snap, and the hover label colour
 * (a parent hover cannot restyle a child through `hoverStyle`). Injected
 * once, same mechanism as DataTable's `ensureWebStyles`. Colour comes from
 * the theme's own `--color` variable — no literal here.
 */
function ensureWebStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${SCROLL_CLASS} {
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .${SCROLL_CLASS}::-webkit-scrollbar { display: none; }
    .${TAB_CLASS}:hover:not([aria-current]) .${TAB_LABEL_CLASS} {
      color: var(--color) !important;
    }
    .${TAB_CLASS}:focus-visible {
      outline: 2px solid var(--outlineColor);
      outline-offset: -2px;
    }
    @media (max-width: 640px) {
      .${SCROLL_CLASS} { scroll-snap-type: x mandatory; }
      .${TAB_CLASS} { scroll-snap-align: start; }
    }
  `;
  document.head.appendChild(style);
}

const SectionsFrame = styled(YStack, {
  name: "LedgerSectionTabs",
  width: "100%",
  backgroundColor: "$background",
  // Structural 2px rule, like the topbar above it.
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
});

const SectionsRow = styled(XStack, {
  name: "LedgerSectionTabsRow",
  width: "100%",
  marginHorizontal: "auto",
  alignItems: "stretch",
  minWidth: 0,
});

const Tab = styled(XStack, {
  name: "LedgerSectionTab",
  height: LEDGER_SECTION_TABS_HEIGHT,
  alignItems: "center",
  gap: "$2",
  paddingHorizontal: "$4",
  flexShrink: 0,
  // Hairline between tabs; the active fill paints over it.
  borderRightWidth: 1,
  borderRightColor: "$borderColorSoft",
  backgroundColor: "transparent",
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$surfaceRaised",
  },
  variants: {
    active: {
      // The one place ink fills a control in the shell (D-055) — a pressed
      // key, not an underline, so it stays distinct from in-page Tabs.
      true: {
        backgroundColor: "$color",
        hoverStyle: {
          backgroundColor: "$color",
        },
      },
    },
  } as const,
  defaultVariants: {
    active: false,
  },
});

const isModifiedClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey ||
  event.button !== 0;

export const LedgerSectionTabs = ({
  items,
  current,
  label,
  onSelect,
  overflow,
  contentMaxWidth = 1400,
  testIdBase = "ledger-sections",
}: LedgerSectionTabsProps) => {
  // Inject the scrollbar/snap/hover CSS once for the lifetime of the page
  // (same shape as DataTable's ensureWebStyles effect).
  useEffect(() => {
    if (isWeb) ensureWebStyles();
  }, []);

  const navRef = useRef<HTMLElement | null>(null);

  // ArrowLeft/ArrowRight/Home/End move focus across the tab links (the DS
  // ships no keyboard model for SectionTabs; the rail owns ArrowUp/Down).
  // Every link stays in the tab order — these are links, not a composite
  // widget, so a roving tabindex would only hide them from Tab. A native
  // listener on the landmark, like the rail's, because Tamagui's View props
  // do not type `onKeyDown`.
  useEffect(() => {
    if (!isWeb) return undefined;
    const nav = navRef.current;
    if (!nav) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      const { key } = event;
      // Alt/Cmd+ArrowLeft is browser Back and Ctrl+Home/End is page
      // scrolling — never swallow a modified key.
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      if (
        key !== "ArrowLeft" &&
        key !== "ArrowRight" &&
        key !== "Home" &&
        key !== "End"
      ) {
        return;
      }
      const tabs = Array.from(
        nav.querySelectorAll<HTMLAnchorElement>(`a.${TAB_CLASS}`),
      );
      if (!tabs.length) return;
      const activeIndex = tabs.findIndex(
        (tab) => tab === document.activeElement,
      );
      if (activeIndex === -1) return;

      event.preventDefault();
      let nextIndex = activeIndex;
      if (key === "Home") nextIndex = 0;
      else if (key === "End") nextIndex = tabs.length - 1;
      else if (key === "ArrowRight")
        nextIndex = (activeIndex + 1) % tabs.length;
      else nextIndex = (activeIndex - 1 + tabs.length) % tabs.length;

      const next = tabs[nextIndex];
      next?.focus();
      next?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };

    nav.addEventListener("keydown", handleKeyDown);
    return () => nav.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <SectionsFrame
      ref={navRef}
      tag="nav"
      role={isWeb ? "navigation" : undefined}
      aria-label={label}
      data-testid={testIdBase}
    >
      <SectionsRow
        maxWidth={contentMaxWidth}
        className={isWeb ? SCROLL_CLASS : undefined}
      >
        {items.map((item) => {
          const active = current === item.href;
          const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
            if (!onSelect || isModifiedClick(event)) return;
            event.preventDefault();
            onSelect(item.href);
          };
          const labelColor = active ? "$colorInverted" : "$colorMuted";
          return (
            <Tab
              key={item.href}
              active={active}
              className={isWeb ? TAB_CLASS : undefined}
              data-testid={`${testIdBase}-tab`}
              {...(isWeb
                ? {
                    tag: "a" as const,
                    href: item.href,
                    role: "link" as const,
                    "aria-current": active ? ("page" as const) : undefined,
                    onClick: handleClick,
                    // The anchor itself must carry a colour, or the UA link
                    // blue leaks into anything that reads currentColor.
                    style: {
                      textDecoration: "none",
                      color: "inherit",
                    } as const,
                  }
                : { onPress: () => onSelect?.(item.href) })}
            >
              <Text
                variant="overline"
                color={labelColor}
                className={isWeb ? TAB_LABEL_CLASS : undefined}
                whiteSpace="nowrap"
              >
                {item.label}
              </Text>
              {item.count != null ? (
                <Text
                  variant="overline"
                  color={labelColor}
                  {...monoScale["2xs"]}
                  emphasis="subtle"
                  className={isWeb ? TAB_LABEL_CLASS : undefined}
                  whiteSpace="nowrap"
                >
                  {item.count}
                </Text>
              ) : null}
            </Tab>
          );
        })}
        {overflow ? (
          <XStack alignItems="center" flexShrink={0} paddingHorizontal="$2">
            {overflow}
          </XStack>
        ) : null}
      </SectionsRow>
    </SectionsFrame>
  );
};

LedgerSectionTabs.displayName = "LedgerSectionTabs";
