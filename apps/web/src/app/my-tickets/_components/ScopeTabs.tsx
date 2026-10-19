"use client";

import { XStack, styled } from "tamagui";

import { Text } from "@th/ui";

import type { SavedScope } from "@/components/saves/useSavedEventList";

/**
 * The ONE top-level control on `/my-tickets`: Upcoming | Past.
 *
 * Why a hand-rolled tablist and not `@th/ui`'s `SegmentedControl` — which is
 * what `/saved` used for this exact axis before the merge:
 *
 *  - `SegmentedControl` is a `role="radiogroup"`. That is right for a FILTER
 *    over one list; it is wrong here, where each option swaps a whole panel of
 *    sections. The tabs pattern is what a screen-reader user needs to hear.
 *  - `@th/ui` exports no tablist primitive. `LedgerSectionTabs` is a `<nav>` of
 *    anchors (URL-driven, admin chrome), and `AdminTabBar` puts `role="tab"` on
 *    divs with no tablist parent, no roving tabindex and no arrow keys.
 *
 * So this mirrors the house tablist that DOES get it right — the org bookings
 * workspace (`admin/[slug]/bookings/_components/BookingsWorkspace.tsx`): a
 * real `role="tablist"`, real `<button>` tabs (Enter/Space for free), a roving
 * tabindex, and Left/Right arrows that move focus AND selection.
 */

export const SCOPE_PANEL_ID = "my-events-panel";

export const scopeTabId = (scope: SavedScope): string =>
  `my-events-tab-${scope}`;

const TabStrip = styled(XStack, {
  name: "MyEventsTabs",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  gap: "$1",
  // Two short labels clear 320px with room to spare, but Tamagui inherits RN's
  // `flexShrink: 0` — wrapping is the cheap insurance against a longer
  // translation pushing the DOCUMENT wider than the viewport.
  flexWrap: "wrap",
});

// A real <button>, so Enter and Space activate without a bespoke key handler.
const TabButton = styled(XStack, {
  name: "MyEventsTab",
  tag: "button",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderStyle: "solid",
  paddingHorizontal: "$3",
  paddingVertical: "$3",
  minHeight: 44,
  flexShrink: 1,
  minWidth: 0,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  borderBottomWidth: 2,
  borderBottomColor: "transparent",
  marginBottom: -2,
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: -2,
  },
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  variants: {
    active: {
      true: { borderBottomColor: "$accent" },
    },
  } as const,
});

export interface ScopeTabsProps {
  scope: SavedScope;
  onChange: (scope: SavedScope) => void;
  /** Ordered labels, keyed by scope. */
  labels: Record<SavedScope, string>;
  /** Accessible name for the tablist. */
  ariaLabel: string;
}

const ORDER: readonly SavedScope[] = ["upcoming", "past"] as const;

export const ScopeTabs = ({
  scope,
  onChange,
  labels,
  ariaLabel,
}: ScopeTabsProps) => (
  <TabStrip role="tablist" aria-label={ariaLabel}>
    {ORDER.map((key) => {
      const active = key === scope;
      // Web-only ARIA wiring — valid on the rendered <button>, absent from
      // Tamagui's RN prop types, so a scoped spread is the escape hatch.
      // `type` too: a styled `tag: "button"` otherwise defaults to submit.
      const a11y = {
        type: "button",
        id: scopeTabId(key),
        "aria-controls": SCOPE_PANEL_ID,
        tabIndex: active ? 0 : -1,
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const step = e.key === "ArrowRight" ? 1 : -1;
          const from = ORDER.indexOf(key);
          const next = ORDER[(from + step + ORDER.length) % ORDER.length]!;
          onChange(next);
          document.getElementById(scopeTabId(next))?.focus();
        },
      };

      return (
        <TabButton
          key={key}
          active={active}
          role="tab"
          aria-selected={active}
          onPress={() => onChange(key)}
          data-testid={`my-events-tab-${key}`}
          {...a11y}
        >
          {/* The label idiom: Plex Mono 11/2px uppercase. `overline` carries
              its own transform + tracking so the pair cannot drift apart. */}
          <Text
            variant="overline"
            weight="bold"
            color={active ? "$color" : "$colorMuted"}
          >
            {labels[key]}
          </Text>
        </TabButton>
      );
    })}
  </TabStrip>
);

ScopeTabs.displayName = "ScopeTabs";
