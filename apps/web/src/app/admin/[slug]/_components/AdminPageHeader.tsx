"use client";

import type { ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Text } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Swiss-style section header for admin pages
//
// Renders the monospaced section number prefix (e.g. "02.") in accent orange,
// followed by the uppercase title and optional subtitle. The optional `trailing`
// slot is right-aligned (typically holds a primary CTA button).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Section number ↔ route mapping. Historical numbering — it intentionally does
 * NOT track the grouped nav order in `admin-nav-sections.tsx` (renumbering on
 * every nav reshuffle would churn page headers for no reader benefit).
 * Pages outside this map omit the number prefix.
 */
const SECTION_INDEX: Record<string, string> = {
  dashboard: "00",
  events: "01",
  places: "02",
  orders: "03",
  promos: "04",
  audiences: "05",
  announcements: "06",
  embeds: "07",
  team: "09",
  search: "10",
  settings: "11",
  payouts: "12",
};

export interface AdminPageHeaderProps {
  /** Title text displayed as the page heading */
  title: string;
  /** Optional subtitle rendered below the title */
  subtitle?: string;
  /**
   * Section key matching one of the ADMIN_SECTIONS route ids.
   * Controls the numeric prefix (e.g. "02."). Omit to skip the number.
   */
  section?: string;
  /**
   * Override the automatically determined section number.
   * Useful for sub-pages (attendees, applications) that want
   * to inherit the parent section's number.
   */
  sectionNumber?: string;
  /** Right-aligned trailing content (buttons, filters, etc.) */
  trailing?: ReactNode;
}

export function AdminPageHeader({
  title,
  subtitle,
  section,
  sectionNumber,
  trailing,
}: AdminPageHeaderProps) {
  const num = sectionNumber ?? (section ? SECTION_INDEX[section] : undefined);

  return (
    <XStack
      justifyContent="space-between"
      alignItems="center"
      flexWrap="wrap"
      gap="$3"
    >
      <YStack gap="$1" flex={1} minWidth={200}>
        {/* Phones: the admin frame leaves ~205px of content at a 320px
            viewport, and one uppercase 40px word ("APPLICATION") is ~276px —
            an unbreakable min-content that panned the whole document (measured
            375 vs 320). So at $sm the kicker may wrap above the title, the
            title steps down to the h5 rung (a breakpoint step, not fluid
            type), and as a last resort a word too long for its line breaks
            rather than overflowing. minWidth 0 lets the flex item shrink.
            20px, not 24: at 24px "ANNOUNCEMENTS" split mid-word at 320 and
            es "CONFIGURACIÓN" filled its 205px line exactly. One $sm step on
            purpose — a separate $xs rung is dead code ($sm wins at ≤480). */}
        <XStack gap="$3" alignItems="baseline" $sm={{ flexWrap: "wrap" }}>
          {num != null && (
            <Text tag="span" variant="kicker" tone="accent">
              {num}.
            </Text>
          )}
          <Text
            variant="h2"
            flexShrink={1}
            minWidth={0}
            $sm={{ fontSize: "$5", lineHeight: "$5" }}
            style={{
              textTransform: "uppercase",
              letterSpacing: -1,
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </Text>
        </XStack>
        {subtitle && (
          <Text
            fontSize="$2"
            tone="muted"
            style={{
              textTransform: "uppercase",
              letterSpacing: 0.8,
              fontSize: 11,
            }}
          >
            {subtitle}
          </Text>
        )}
      </YStack>
      {trailing && (
        /* flexShrink + minWidth 0 are load-bearing: without them this flex
           item's automatic minimum size is the UN-wrapped sum of its buttons
           (Chromium computes a wrap container's min-content width as if
           nowrap), so after wrapping below the title the action row kept a
           fixed ~320px+ intrinsic width and panned the whole document on
           phones (measured 76px horizontal overflow at 320px). Letting the
           item shrink to the line width makes the inner flexWrap actually
           engage, so actions wrap instead of overflowing. */
        <XStack
          gap="$2"
          alignItems="center"
          flexWrap="wrap"
          flexShrink={1}
          minWidth={0}
        >
          {trailing}
        </XStack>
      )}
    </XStack>
  );
}
