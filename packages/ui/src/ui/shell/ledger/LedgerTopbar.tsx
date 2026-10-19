"use client";

import type { ReactNode } from "react";
import { XStack, YStack, styled } from "tamagui";

import { Text } from "../../tamagui/components/typography/Text";
import { monoScale } from "../../tamagui/tokens/typography";

/**
 * Register 1 of the ledger shell — who you are and which account you are in.
 * Never page navigation: anything that changes per page belongs in
 * `LedgerSectionTabs` (register 2) or `LedgerContextStrip` (register 3).
 *
 * Non-sticky by design (DS `AppShell`: sticky is an opt-in wrapper; the
 * builder header measures its own offset — see the shell map, R2).
 */
export interface LedgerTopbarProps {
  /**
   * Wordmark slot. `undefined` renders the default "Ithas Fire" lockup;
   * pass `null` to render no brand at all (the mobile shell does this — the
   * workspace switcher is the identity anchor there).
   */
  brand?: ReactNode;
  /**
   * Surface name beside the wordmark — "Organizer", "Admin", "Scanner". The
   * DS Topbar calls this `role`; named `surfaceRole` so it never reads as
   * the ARIA attribute.
   */
  surfaceRole?: ReactNode;
  /** Extra content after the role, left-aligned (e.g. a back affordance). */
  left?: ReactNode;
  /**
   * Search affordance. Its own flexible slot between `left` and the right
   * cluster — the same shape the consumer `Navbar` gives `searchAccessory`,
   * so the trigger grows into the free width instead of sitting at its
   * content size. Pass `null` (mobile) to render no slot at all.
   */
  search?: ReactNode;
  /** Right cluster — notifications, workspace switcher. */
  right?: ReactNode;
  /** Max width of the inner row; matches admin's navbar (1400) by default. */
  contentMaxWidth?: number;
  /**
   * Tighter edge padding + inter-slot gap for the mobile layout (<960px),
   * mirroring NavigationNavbar's mobile row — the shell passes this so a
   * 320px viewport fits hamburger + switcher + one control.
   */
  compact?: boolean;
  testIdBase?: string;
}

export const LEDGER_TOPBAR_HEIGHT = 56;

const TopbarFrame = styled(YStack, {
  name: "LedgerTopbar",
  width: "100%",
  backgroundColor: "$background",
  // Swiss structural rule — same 2px ink line NavigationShell's
  // TopBarContainer draws under the navbar.
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
});

const TopbarRow = styled(XStack, {
  name: "LedgerTopbarRow",
  width: "100%",
  height: LEDGER_TOPBAR_HEIGHT,
  alignItems: "center",
  gap: "$4",
  paddingHorizontal: "$4",
  marginHorizontal: "auto",
  minWidth: 0,
  variants: {
    compact: {
      true: {
        paddingHorizontal: "$2",
        gap: "$2",
      },
    },
  } as const,
  defaultVariants: {
    compact: false,
  },
});

const RoleChip = styled(XStack, {
  name: "LedgerTopbarRole",
  alignItems: "center",
  flexShrink: 0,
  // Hairline left rule separates the surface name from the wordmark.
  borderLeftWidth: 1,
  borderLeftColor: "$borderColorSoft",
  paddingLeft: "$4",
});

// Mirrors `Navbar`'s SearchSlot: flex-grow so the trigger fills the gap the
// brand and the right cluster leave, capped so it never turns into a
// full-bleed field on a 1400-wide row. `minWidth: 0` gives the trigger's
// ellipsis a box to truncate against when the row tightens.
const SearchSlot = styled(XStack, {
  name: "LedgerTopbarSearch",
  flex: 1,
  flexShrink: 1,
  minWidth: 0,
  maxWidth: 600,
  alignItems: "center",
});

const RightCluster = styled(XStack, {
  name: "LedgerTopbarRight",
  alignItems: "center",
  gap: "$3",
  // `margin: auto` pinning is the one sanctioned margin use.
  marginLeft: "auto",
  flexShrink: 1,
  minWidth: 0,
});

const DefaultBrand = () => (
  <Text
    variant="span"
    weight="black"
    fontSize={15}
    lineHeight={20}
    letterSpacing={-0.5}
    textTransform="uppercase"
    whiteSpace="nowrap"
  >
    Ithas Fire
  </Text>
);

export const LedgerTopbar = ({
  brand,
  surfaceRole,
  left,
  search,
  right,
  contentMaxWidth = 1400,
  compact = false,
  testIdBase = "ledger-topbar",
}: LedgerTopbarProps) => (
  <TopbarFrame data-testid={testIdBase}>
    <TopbarRow maxWidth={contentMaxWidth} compact={compact}>
      {brand === null ? null : (
        // `null` = no brand at all (mobile): render nothing, so the row gap is not
        // spent on an empty box. `undefined` = the default wordmark.
        <XStack alignItems="center" flexShrink={0}>
          {brand === undefined ? <DefaultBrand /> : brand}
        </XStack>
      )}
      {surfaceRole ? (
        <RoleChip data-testid={`${testIdBase}-role`}>
          {typeof surfaceRole === "string" ? (
            // Mono 2xs rung — the tag/stamp size. Size + tracking travel
            // together from `monoScale`.
            <Text
              variant="overline"
              tone="muted"
              weight="regular"
              lineHeight={12}
              whiteSpace="nowrap"
              {...monoScale["2xs"]}
            >
              {surfaceRole}
            </Text>
          ) : (
            surfaceRole
          )}
        </RoleChip>
      ) : null}
      {left}
      {search ? (
        <SearchSlot data-testid={`${testIdBase}-search`}>{search}</SearchSlot>
      ) : null}
      <RightCluster data-testid={`${testIdBase}-right`}>{right}</RightCluster>
    </TopbarRow>
  </TopbarFrame>
);

LedgerTopbar.displayName = "LedgerTopbar";
