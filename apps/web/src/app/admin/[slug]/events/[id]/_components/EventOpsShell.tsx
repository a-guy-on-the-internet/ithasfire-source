"use client";

import type { ReactNode } from "react";
import { XStack, YStack } from "tamagui";

import { Text } from "@th/ui";

export type EventOpsShellProps = {
  /**
   * Surface name — rendered as the page's only `h1`, uppercase.
   *
   * Deliberately NOT the event's title. The admin rail already shows the event
   * name and status above its section list; repeating them here is what
   * produced five different competing headings (an h3 in sentence case, two
   * uppercase h4s, a weight-900 h2, one visually-hidden h2, and on Attendees
   * no heading at all). The rail answers "which event", this answers "which
   * surface".
   */
  title: string;
  /**
   * One line on what this surface is for. Optional, but write one — it is the
   * cheapest way to stop an ops page opening cold on a search field.
   */
  purpose?: string;
  /**
   * Surface-level actions (Export CSV, Issue comps, …). Right-aligned beside
   * the title on desktop, wrapping beneath it on phones.
   *
   * Per the v2 one-primary rule this slot holds AT MOST one
   * `variant="primary"` — the table's row and bulk actions are the other
   * candidates on these pages, so if a surface has a primary here, those stay
   * secondary.
   */
  actions?: ReactNode;
  /**
   * Filter row — a `<FilterRow>` holding `<SearchBar>` and/or
   * `<FilterChips>`. Rendered between the header and the body so every ledger
   * surface puts its controls in the same place.
   *
   * Passed as a slot rather than left to the body so the spacing is the
   * shell's business, and so `SearchBar` cannot be dropped bare into a column
   * again — the axis bug that started this work.
   */
  filters?: ReactNode;
  children: ReactNode;
};

/**
 * Page frame for the standalone event-ops surfaces (attendees / volunteers /
 * comp tickets / suggested edits / attendee feedback).
 *
 * Replaces `EventOpsPageFrame`, which was a bare `min-height: 100vh` div: it
 * owned no header, no container and no action slot, so each of the five
 * surfaces invented its own. The result was four container widths (720 / 960 /
 * 1440 / full), two centring idioms (`alignSelf` vs `marginHorizontal: auto`)
 * and five header treatments across pages that do the same kind of job.
 *
 * Container tokens match the sibling admin surfaces (orders, places, promos,
 * team): `maxWidth={1440}` + `marginHorizontal="auto"` + a flat `padding="$4"`.
 *
 * That is deliberately NOT the literal reading of DS v2 §5 ("content 1200,
 * side padding $6 desktop / $4 mobile"). Two reasons, and the DS's own
 * "Divergences — code wins" section is the tie-breaker:
 *
 *  1. This shell renders INSIDE `NavigationShell`'s `ContentArea`, which
 *     already applies `paddingVertical="$5"` and `paddingHorizontal="$5"`.
 *     §5's side padding is a once-per-page figure; applying it again here just
 *     nests two padding boxes (24 + 32 = 56px of desktop gutter).
 *  2. Every other admin list surface already uses 1440 + flat `$4`. The point
 *     of this shell is to make these six pages agree with each other and with
 *     the rest of admin — picking different numbers to satisfy the doc's
 *     letter would defeat that.
 *
 * Three things `EventOpsPageFrame` did that are deliberately NOT carried over,
 * because `ContentArea` already owns each of them:
 *
 *  - `paddingBottom: 100`. `NavigationShell` reserves bottom clearance for the
 *    mobile bottom bar itself (`96` on mobile, `$5` on desktop), tracking the
 *    bar's real height. The `100` stacked on top of that — roughly 220px of
 *    dead space at the end of every ops page on a phone, and 100px of it on
 *    desktop where there is no bottom bar at all.
 *  - `backgroundColor: "$surface"`. `ContentArea` already paints it.
 *  - `minHeight: "100vh"`. This one actively fought the shell: `ContentArea` is
 *    `minHeight: 0` on purpose so it grows with its content and the DOCUMENT
 *    stays the scrollport (its own comment explains that sticky descendants
 *    depend on it). A 100vh child sits below a top bar, a `$3` margin and
 *    `$5` of vertical padding, so it guaranteed a scrollbar and a trailing
 *    band of empty page on every ops surface regardless of content.
 */
export function EventOpsShell({
  title,
  purpose,
  actions,
  filters,
  children,
}: EventOpsShellProps) {
  return (
    // Identical root to OrdersTable / PlacesTable / PromosView / TeamView, so
    // an ops page sits on the same gutter and measure as every other admin
    // surface. One box, no outer wrapper.
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      {/* ── Header ─────────────────────────────────────────────────────
            Title and actions share a row and wrap together; `alignItems:
            flex-end` keeps a button's baseline on the title's rather than
            floating it against the cap height. */}
      <YStack gap="$2">
        <XStack
          gap="$4"
          alignItems="flex-end"
          justifyContent="space-between"
          flexWrap="wrap"
        >
          <Text
            tag="h1"
            variant="h3"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={0.5}
            flexShrink={1}
            minWidth={0}
          >
            {title}
          </Text>
          {actions ? (
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              {actions}
            </XStack>
          ) : null}
        </XStack>
        {purpose ? (
          <Text variant="bodySmall" tone="muted" maxWidth={640}>
            {purpose}
          </Text>
        ) : null}
      </YStack>

      {filters}

      {/* Body. `minHeight: 0` so a flex-1 table child can scroll internally
            instead of growing the page. */}
      <YStack flex={1} minHeight={0}>
        {children}
      </YStack>
    </YStack>
  );
}

EventOpsShell.displayName = "EventOpsShell";
