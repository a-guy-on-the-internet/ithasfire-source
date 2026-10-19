import { forwardRef, type ReactNode } from "react";
import { Platform } from "react-native";
import {
  XStack,
  YStack,
  styled,
  type GetProps,
  type TamaguiElement,
} from "tamagui";

import { Text } from "../typography/Text";

const isWeb = Platform.OS === "web";

const NavbarSurface = styled(YStack, {
  name: "NavbarSurface",
  backgroundColor: "$surface",
  width: "100%",
  gap: 0,
  variants: {
    border: {
      none: {
        borderBottomWidth: 0,
      },
      hairline: {
        borderBottomWidth: 2,
        borderBottomColor: "$borderColor",
      },
    },
    elevated: {
      true: {
        shadowColor: "transparent",
        shadowOpacity: 0,
        shadowOffset: { width: 0, height: 0 },
        shadowRadius: 0,
        elevation: 0,
      },
      false: {
        shadowColor: "transparent",
        shadowOpacity: 0,
        elevation: 0,
      },
    },
  },
  defaultVariants: {
    border: "none",
    elevated: false,
  },
});

const NavbarRow = styled(XStack, {
  name: "NavbarRow",
  alignItems: "center",
  justifyContent: "space-between",
  paddingHorizontal: "$4",
  paddingVertical: "$3",
  minHeight: 64,
  gap: "$4",
  flexWrap: "nowrap",
  // Tighten the inter-slot gap and edge padding on narrow phones so the
  // trailing controls stay fully visible (with a small right inset) at
  // 360–390px. NOTE: this $sm block only covers ≤640px; the shell's "mobile"
  // layout runs to 959px, so NavigationNavbar ALSO passes these row props
  // explicitly when layout === "mobile". Desktop/tablet spacing is unchanged.
  $sm: {
    paddingHorizontal: "$2",
    gap: "$2",
  },
});

const LeadingSlot = styled(XStack, {
  name: "NavbarLeadingSlot",
  alignItems: "center",
  justifyContent: "center",
  gap: "$2",
  flexShrink: 0,
});

const BrandSlot = styled(XStack, {
  name: "NavbarBrandSlot",
  alignItems: "center",
  justifyContent: "center",
  gap: "$2",
  flexShrink: 0,
  // Safety valve: on very narrow phones let the brand give up space (only if
  // the row would otherwise overflow) so the trailing account avatar is never
  // clipped. With the tightened mobile padding/gap this rarely engages, and
  // the brand's own intrinsic width keeps the logo undistorted.
  $sm: {
    flexShrink: 1,
    minWidth: 0,
  },
});

const TrailingSlot = styled(XStack, {
  name: "NavbarTrailingSlot",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "$2",
  flexShrink: 0,
  marginLeft: "auto",
});

const TitleContainer = styled(YStack, {
  name: "NavbarTitle",
  minWidth: 0,
  flexShrink: 1,
  gap: "$0",
  justifyContent: "center",
});

const SearchSlot = styled(XStack, {
  name: "NavbarSearchSlot",
  flex: 1,
  flexShrink: 1,
  minWidth: 0,
  maxWidth: 820,
  alignItems: "stretch",
});

const ChildrenContainer = styled(YStack, {
  name: "NavbarChildrenContainer",
  paddingHorizontal: "$4",
  paddingBottom: "$3",
  paddingTop: 0,
  gap: "$3",
});

export type NavbarBorder = NonNullable<
  GetProps<typeof NavbarSurface>["border"]
>;

export interface NavbarProps extends Omit<
  GetProps<typeof NavbarRow>,
  "children" | "title"
> {
  brand?: ReactNode;
  title?: ReactNode;
  searchAccessory?: ReactNode;
  leadingAccessory?: ReactNode;
  trailingAccessory?: ReactNode;
  border?: NavbarBorder;
  elevated?: boolean;
  children?: ReactNode;
  testIdBase?: string;
  qaId?: string;
  /** Max width for the content row. When set, the row is centered within this width. */
  contentMaxWidth?: number;
}

const resolveAutomationProps = (baseId: string, qaId: string) =>
  isWeb
    ? ({ "data-testid": baseId, "data-qa": qaId } as const)
    : ({ testID: baseId, accessibilityLabel: qaId } as const);

const resolveSlotIds = (baseId: string, qaId: string, slot: string) =>
  resolveAutomationProps(`${baseId}-${slot}`, `${qaId}-${slot}`);

export const Navbar = forwardRef<TamaguiElement, NavbarProps>(
  (
    {
      brand,
      title,
      searchAccessory,
      leadingAccessory,
      trailingAccessory,
      border = "hairline",
      elevated = false,
      children,
      testIdBase = "navbar",
      qaId,
      contentMaxWidth,
      ...rowProps
    },
    ref,
  ) => {
    const resolvedQaId = qaId ?? testIdBase;
    const automationProps = resolveAutomationProps(testIdBase, resolvedQaId);
    const shouldRenderBrand = brand !== undefined && brand !== null;
    const shouldRenderTitle = title !== undefined && title !== null;
    const shouldRenderSearch =
      searchAccessory !== undefined && searchAccessory !== null;
    const shouldRenderLeading =
      leadingAccessory !== undefined && leadingAccessory !== null;
    const shouldRenderTrailing =
      trailingAccessory !== undefined && trailingAccessory !== null;

    const { role, accessibilityRole, ...restRowProps } = rowProps;

    return (
      <NavbarSurface ref={ref} border={border} elevated={elevated}>
        <NavbarRow
          role={isWeb ? (role ?? "navigation") : role}
          accessibilityRole={
            !isWeb ? (accessibilityRole ?? "header") : accessibilityRole
          }
          {...automationProps}
          {...restRowProps}
          {...(contentMaxWidth
            ? {
                maxWidth: contentMaxWidth,
                marginHorizontal: "auto",
                width: "100%",
              }
            : {})}
        >
          {shouldRenderLeading ? (
            <LeadingSlot
              {...resolveSlotIds(testIdBase, resolvedQaId, "leading")}
            >
              {leadingAccessory}
            </LeadingSlot>
          ) : null}

          {shouldRenderBrand ? (
            <BrandSlot {...resolveSlotIds(testIdBase, resolvedQaId, "brand")}>
              {brand}
            </BrandSlot>
          ) : null}

          {shouldRenderTitle ? (
            <TitleContainer
              {...resolveSlotIds(testIdBase, resolvedQaId, "title")}
              flex={shouldRenderSearch ? 0 : 1}
            >
              {typeof title === "string" ? (
                <Text variant="h6" weight="bold" truncate>
                  {title}
                </Text>
              ) : (
                title
              )}
            </TitleContainer>
          ) : null}

          {shouldRenderSearch ? (
            <SearchSlot {...resolveSlotIds(testIdBase, resolvedQaId, "search")}>
              {searchAccessory}
            </SearchSlot>
          ) : null}

          {shouldRenderTrailing ? (
            <TrailingSlot
              {...resolveSlotIds(testIdBase, resolvedQaId, "trailing")}
            >
              {trailingAccessory}
            </TrailingSlot>
          ) : null}
        </NavbarRow>
        {children ? <ChildrenContainer>{children}</ChildrenContainer> : null}
      </NavbarSurface>
    );
  },
);

Navbar.displayName = "Navbar";
