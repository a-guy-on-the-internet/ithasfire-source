"use client";

/**
 * SettingsNav — the single grouped navigation for every settings surface.
 *
 * It replaced the two near-duplicate private `SettingsSideRail` copies (account
 * settings + org settings), which rendered a FLAT list and were hidden outright
 * below `$md`, leaving mobile with no settings navigation at all. Both are now
 * deleted and both surfaces render this component: `/account/settings` via
 * `_lib/settings-sections.tsx`, `/admin/[slug]/settings` via
 * `_lib/org-settings-sections.tsx`. There is no other settings rail left in the
 * app — if you are about to write one, extend this instead.
 *
 * One DOM tree serves both presentations. Tamagui media props compile to real
 * CSS media queries on web, so the desktop rail and the mobile index are the
 * SAME markup restyled — never two rendered copies (which would duplicate every
 * link in the accessibility tree and emit two `nav` landmarks).
 *
 * Presentational only: it takes already-translated strings and real `href`s.
 * It calls no hooks, fetches nothing, and owns no routing policy.
 */

import type { MouseEvent, ReactNode } from "react";
import { XStack, YStack, type XStackProps, type YStackProps } from "tamagui";
import { NextLinkAnchor, Text } from "@th/ui";
import { ChevronRight } from "lucide-react";

import { DANGER, FOREGROUND, MUTED_TEXT } from "@/lib/design-tokens";

export interface SettingsNavItem {
  id: string;
  /** Already-translated label. This component never calls `t()`. */
  label: string;
  icon: ReactNode;
  /** Real route, e.g. `/account/settings/security`. Rendered as an anchor. */
  href: string;
  /** Optional badge, e.g. pending booking requests. */
  count?: number;
  /**
   * Already-translated accessible name for the whole row, overriding the
   * label + badge text that would otherwise be concatenated.
   *
   * Needed whenever `count` is set: the badge is a bare numeral inside the
   * anchor, so the link would otherwise announce "Booking requests 3" — a
   * number with no unit and no meaning. Pass something like "Booking requests,
   * 3 awaiting response".
   */
  ariaLabel?: string;
  tone?: "default" | "danger";
}

export interface SettingsNavGroup {
  id: string;
  /** Already-translated group header, e.g. "Account" / "Your work". */
  label: string;
  items: SettingsNavItem[];
  /** Rendered INSTEAD of items when `items` is empty. */
  emptyState?: ReactNode;
}

export interface SettingsNavProps {
  groups: SettingsNavGroup[];
  /** Pinned to the bottom, outside all groups (danger zone). */
  footerItems?: SettingsNavItem[];
  activeId: string;
  /**
   * Optional client-side selection handler for INSTANT section swaps.
   *
   * When provided, a plain left-click on a row is intercepted
   * (`preventDefault()` + `onSelect`) so the owning surface can swap the
   * content panel and update the URL via `history.pushState` WITHOUT a Next
   * navigation/remount. Modified clicks (⌘/ctrl/shift/alt, or any non-left
   * button) are left alone, so "open in new tab" and middle-click still do a
   * real navigation to the row's real `href`. When omitted, rows behave as
   * ordinary links (the org-settings surface relies on this).
   */
  onSelect?: (id: string, href: string) => void;
  /**
   * Mobile presentation.
   * - `"auto"` (default): sticky rail on `$gtMd`, stacked full-width list at `$md` and below.
   * - `"index"`: always the stacked full-width list (the mobile settings index page).
   */
  variant?: "auto" | "index";
  /** Landmark label. Defaults to "Settings sections". */
  ariaLabel?: string;
  testId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Style tables
//
// Desktop values live in the BASE props; `$md` (maxWidth 900) overrides them.
// The `index` variant simply promotes the `$md` values into the base and drops
// the media query, so a settings *index page* looks the same at every width.
// ─────────────────────────────────────────────────────────────────────────────

const RAIL_CONTAINER: YStackProps = {
  width: 220,
  gap: "$4",
  paddingVertical: "$2",
  // Tamagui's `position` union has no "sticky" — the house cast (see the two
  // side rails this replaces).
  position: "sticky" as "relative",
  top: 24,
  alignSelf: "flex-start",
};

const LIST_CONTAINER: YStackProps = {
  width: "100%",
  gap: "$4",
  paddingVertical: 0,
  position: "relative",
  top: 0,
  alignSelf: "stretch",
};

/** Extra row treatment for the stacked list: hairline rules + a real tap target. */
const LIST_ROW: XStackProps = {
  paddingVertical: "$3",
  minHeight: 44,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColorSoft",
};

const ROW_BASE: XStackProps = {
  width: "100%",
  gap: "$2",
  alignItems: "center",
  paddingVertical: "$2",
  paddingHorizontal: "$3",
  borderRadius: 0,
  cursor: "pointer",
  // Held at a constant 3px so activating an item never reflows the label.
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
  hoverStyle: { backgroundColor: "$backgroundHover" },
};

/** Anchors carry the row; strip the UA underline and let the row paint colour. */
const ANCHOR_STYLE = {
  width: "100%",
  textDecoration: "none",
  color: "inherit",
} as const;

// ─────────────────────────────────────────────────────────────────────────────

function NavRow({
  item,
  isActive,
  isIndex,
  onSelect,
}: {
  item: SettingsNavItem;
  isActive: boolean;
  isIndex: boolean;
  onSelect?: (id: string, href: string) => void;
}) {
  const isDanger = item.tone === "danger";

  // `dangerSoft` is the danger hue at small-text legibility in every theme
  // (on Stub it IS `danger`; on Ember `danger` alone is ~4.0:1 as text).
  const labelColor = isDanger
    ? "$dangerSoft"
    : isActive
      ? "$color"
      : "$colorMuted";

  // Lucide inherits `currentColor` — the icon never carries its own colour prop,
  // so the wrapper sets CSS `color` (var() form, Stub value as the SSR fallback).
  const iconColor = isDanger ? DANGER : isActive ? FOREGROUND : MUTED_TEXT;

  const rowProps: XStackProps = isIndex
    ? { ...ROW_BASE, ...LIST_ROW }
    : { ...ROW_BASE, $md: LIST_ROW };

  const activeProps: XStackProps = isActive
    ? {
        backgroundColor: "$surfaceRaised",
        borderLeftColor: isDanger ? "$danger" : "$accent",
      }
    : {};

  return (
    <NextLinkAnchor
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      // When set, this REPLACES the row's computed name — which is why the
      // badge below is `aria-hidden` in that case rather than read twice.
      aria-label={item.ariaLabel}
      data-testid={`settings-nav-item-${item.id}`}
      // Intercept PLAIN left-clicks only. Modified clicks (new tab / new
      // window) and non-left buttons fall through to the real `href` so the
      // link stays a link. The real `href` is always present for a11y, SSR
      // and middle-click regardless.
      onClick={
        onSelect
          ? (e: MouseEvent<HTMLAnchorElement>) => {
              if (
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey ||
                e.button !== 0
              ) {
                return;
              }
              e.preventDefault();
              onSelect(item.id, item.href);
            }
          : undefined
      }
      style={ANCHOR_STYLE}
    >
      <XStack {...rowProps} {...activeProps}>
        <XStack
          aria-hidden
          flexShrink={0}
          opacity={isActive ? 1 : 0.7}
          style={{ color: iconColor }}
        >
          {item.icon}
        </XStack>

        <Text
          variant="body"
          weight={isActive ? "bold" : "regular"}
          color={labelColor}
          flex={1}
        >
          {item.label}
        </Text>

        {typeof item.count === "number" && item.count > 0 ? (
          <XStack
            // The numeral is decoration once `ariaLabel` states the count in
            // words; without one it stays exposed so the number isn't lost.
            aria-hidden={item.ariaLabel ? true : undefined}
            backgroundColor="$color"
            borderRadius={0}
            minWidth={20}
            height={18}
            paddingHorizontal="$1"
            alignItems="center"
            justifyContent="center"
            flexShrink={0}
          >
            <Text
              variant="caption"
              weight="bold"
              color="$background"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {item.count}
            </Text>
          </XStack>
        ) : null}

        {/* Trailing chevron = "takes you somewhere". List presentation only. */}
        <XStack
          aria-hidden
          flexShrink={0}
          {...(isIndex
            ? { display: "flex" }
            : { display: "none", $md: { display: "flex" } })}
          style={{ color: MUTED_TEXT }}
        >
          <ChevronRight size={16} />
        </XStack>
      </XStack>
    </NextLinkAnchor>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <Text
      variant="overline"
      color="$colorMuted"
      fontSize={10}
      letterSpacing={2.5}
      paddingHorizontal="$3"
    >
      {label}
    </Text>
  );
}

export function SettingsNav({
  groups,
  footerItems,
  activeId,
  onSelect,
  variant = "auto",
  ariaLabel = "Settings sections",
  testId = "settings-nav",
}: SettingsNavProps) {
  const isIndex = variant === "index";
  const containerProps: YStackProps = isIndex
    ? LIST_CONTAINER
    : { ...RAIL_CONTAINER, $md: LIST_CONTAINER };

  const itemsGap: YStackProps = isIndex
    ? { gap: 0 }
    : { gap: "$1", $md: { gap: 0 } };

  return (
    <YStack
      tag="nav"
      aria-label={ariaLabel}
      data-testid={testId}
      {...containerProps}
    >
      {groups.map((group, index) => {
        const hasRule = index > 0;
        return (
          <YStack
            key={group.id}
            gap="$2"
            paddingTop={hasRule ? "$3" : 0}
            borderTopWidth={hasRule ? 1 : 0}
            borderTopColor="$borderColorSoft"
            data-testid={`settings-nav-group-${group.id}`}
          >
            <GroupHeader label={group.label} />

            {group.items.length === 0 ? (
              group.emptyState ?? null
            ) : (
              <YStack {...itemsGap}>
                {group.items.map((item) => (
                  <NavRow
                    key={item.id}
                    item={item}
                    isActive={item.id === activeId}
                    isIndex={isIndex}
                    onSelect={onSelect}
                  />
                ))}
              </YStack>
            )}
          </YStack>
        );
      })}

      {footerItems && footerItems.length > 0 ? (
        <YStack
          {...itemsGap}
          // `margin: auto` pinning is the one sanctioned margin (v2 §4).
          marginTop="auto"
          paddingTop="$3"
          borderTopWidth={1}
          borderTopColor="$borderColorSoft"
          data-testid="settings-nav-footer"
        >
          {footerItems.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              isActive={item.id === activeId}
              isIndex={isIndex}
              onSelect={onSelect}
            />
          ))}
        </YStack>
      ) : null}
    </YStack>
  );
}

SettingsNav.displayName = "SettingsNav";
