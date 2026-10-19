import { memo } from "react";
import { Platform } from "react-native";
import { Stack, XStack, YStack, styled, useThemeName } from "tamagui";
import type { GetProps } from "tamagui";

import { Text } from "../typography/Text";

/**
 * MetaList — Design System v2 molecule (section 05).
 *
 * Vertical meta rows (12px, tabular digits), each led by a 7px square dot:
 * accent for time
 * rows, structure for place rows (support in the Stub theme, where structure
 * is the ink and would read as body text — v2 doc override).
 */
const MetaListFrame = styled(YStack, {
  name: "MetaList",
  gap: 6,
});

const MetaListRow = styled(XStack, {
  name: "MetaListRow",
  alignItems: "center",
  gap: "$2",
});

const MetaDot = styled(Stack, {
  name: "MetaListDot",
  width: 7,
  height: 7,
  flexShrink: 0,
});

export type MetaListItemKind = "time" | "place";

export interface MetaListItem {
  /** Row semantics — drives the dot color (accent = time, structure = place). */
  kind: MetaListItemKind;
  label: string;
}

export interface MetaListProps extends Omit<
  GetProps<typeof MetaListFrame>,
  "children"
> {
  items: MetaListItem[];
  /** Single-line rows with ellipsis (for constrained cards/stubs). */
  truncate?: boolean;
  /**
   * Reverse the rows out over a dark surface — the event card's `feature`
   * poster, which is the only place in the system where meta sits on an image.
   * Muted ink would vanish there. The dots keep their accent/support hues:
   * they read as markers on either ground.
   */
  inverse?: boolean;
  testId?: string;
}

const isWeb = Platform.OS === "web";

export const MetaList = memo<MetaListProps>(
  ({ items, truncate = false, inverse = false, testId, ...rest }) => {
    const themeName = useThemeName();
    // Stub theme: structure IS the ink — the v2 doc swaps place dots to the
    // amber support fill so they stay a distinct marker on paper.
    const placeDotColor = themeName?.startsWith("stub")
      ? "$support"
      : "$structure";

    return (
      <MetaListFrame
        {...(testId
          ? isWeb
            ? { "data-testid": testId }
            : { testID: testId }
          : {})}
        {...rest}
      >
        {items.map((item, index) => (
          <MetaListRow key={`${item.kind}-${index}`}>
            <MetaDot
              backgroundColor={
                item.kind === "time" ? "$accent" : placeDotColor
              }
              {...(isWeb ? { "aria-hidden": true } : {})}
            />
            {/*
              The meta line rides IBM Plex Mono at the `md` rung — 11.5px with
              1.4px tracking, uppercase.

              It was Montserrat 12px, left over from the 2026-07-28
              Montserrat-only sweep that the 2026-08-26 two-font decision
              reversed. The tracked uppercase mono label is the single most
              identifying mark of the brand, and the meta line is exactly the
              kind of line that decision names. `TicketWalletCard` already sets
              its meta this way, so a wallet row and a browse card disagreed
              about the same field.

              Size and tracking travel together — they are the pair from
              `monoScale.md`, and `variant="overline"` carries the uppercase so
              a caller cannot apply half the idiom. Tabular digits keep times
              and dates steady across rows.
            */}
            <Text
              variant="overline"
              fontSize={11.5}
              lineHeight={15}
              letterSpacing={1.4}
              {...(inverse
                ? { color: "$onStructure" as const }
                : { tone: "muted" as const })}
              style={{ fontVariantNumeric: "tabular-nums" }}
              truncate={truncate}
              flex={1}
              minWidth={0}
            >
              {item.label}
            </Text>
          </MetaListRow>
        ))}
      </MetaListFrame>
    );
  },
);

MetaList.displayName = "MetaList";
