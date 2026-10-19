"use client";

import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { XStack, YStack, Stack, styled, useTheme } from "tamagui";
import { MoreHorizontal } from "lucide-react";

import { colorTokens } from "../../tokens/colors";
import { Badge } from "../feedback/Badge";
import { Text } from "../typography/Text";
import type {
  NavigationBottomBarCenterAction,
  NavigationSection,
  RouteMeta,
} from "../../../shell/NavigationShell.types";
import { isRouteActive } from "../../../shell/utils/route-active";

const isWeb = Platform.OS === "web";

// ─────────────────────────────────────────────────────────────
// Styled primitives — punky: hard edges, bold lines, no fluff
// ─────────────────────────────────────────────────────────────

const BottomBarFrame = styled(YStack, {
  name: "NavigationBottomBarFrame",
  width: "100%",
  borderTopWidth: 2,
  borderTopColor: "$accent",
  backgroundColor: "$surface",
  zIndex: 100,
  left: 0,
  right: 0,
  bottom: 0,
  // Prevent parent from being an accessibility element so children are individually accessible
  accessible: false,
});

const BottomBarItems = styled(XStack, {
  name: "NavigationBottomBarItems",
  justifyContent: "space-around",
  alignItems: "flex-start",
  paddingHorizontal: "$2",
  paddingTop: "$3",
  // Prevent parent from being an accessibility element so children are individually accessible
  accessible: false,
});

const NavItemContainer = styled(YStack, {
  name: "NavigationBottomBarItem",
  flex: 1,
  alignItems: "center",
  justifyContent: "flex-start",
  gap: "$1",
  // No width floor here. This is NOT the row's flex item — the wrapper <View>
  // in `NavItem` is (see NAV_ITEM_STYLE) — so a floor on this inner stack
  // would only stop the wrapper's shrink from reaching the content, and the
  // tab would overflow the bar instead of compressing.
});

// The tab wrapper's sizing, applied to the <View> that is actually the flex
// item of `BottomBarItems`.
//
// `flexShrink: 1` is the point: BOTH React Native and react-native-web default
// a View to `flexShrink: 0`, so a tab sized by its own label — a long word, or
// a longer translation of a short one — could only ever overflow the row. It
// now compresses instead, and `Label truncate` ellipsizes what no longer fits.
//
// `minWidth` bounds that compression. 64 is the resting tab. 44 is the design
// system's touch-target floor and is as small as a tab may ever get; it is the
// budget the raised 64px center action needs (4 x 44 + 64 + the row's 2 x $2
// padding = 256, inside a 320px viewport).
const NAV_ITEM_MIN_WIDTH = 64;
const NAV_ITEM_COMPACT_MIN_WIDTH = 44;
const NAV_ITEM_STYLE = {
  flexShrink: 1,
  minWidth: NAV_ITEM_MIN_WIDTH,
} as const;
const NAV_ITEM_COMPACT_STYLE = {
  flexShrink: 1,
  minWidth: NAV_ITEM_COMPACT_MIN_WIDTH,
} as const;

// Wrapper for nav item that properly exposes testID on iOS via Tamagui
const NavItemWrapper = styled(Stack, {
  name: "NavItemWrapper",
});

const IconWrapper = styled(Stack, {
  name: "NavigationBottomBarIcon",
  width: 24,
  height: 24,
  alignItems: "center",
  justifyContent: "center",
});

const Label = styled(Text, {
  name: "NavigationBottomBarLabel",
  fontSize: 10,
  textAlign: "center",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontFamily: "$body",
});

// Active tab affordance per the one-bottom-bar mock: a 3px accent rule across
// the TOP of the tab (above the icon, echoing the bar's accent top border).
// Always rendered (transparent when inactive) so toggling active state never
// shifts layout.
const ActiveTopRule = styled(Stack, {
  name: "NavigationBottomBarActiveRule",
  alignSelf: "stretch",
  height: 3,
  backgroundColor: "transparent",
  variants: {
    active: {
      true: { backgroundColor: "$accent" },
    },
  } as const,
});

// ─────────────────────────────────────────────────────────────
// Center action — raised accent square (e.g. the admin SCAN slot)
// ─────────────────────────────────────────────────────────────

// Geometry (approved mock): ~64px square, 2px ink border, raised ~14px proud
// of the bar's top edge. The items row starts 14px below the frame's outer top
// (2px border + 12px paddingTop), so -28 lifts the square 14px above the bar
// line. Negative margin, NOT a transform — Tamagui emits transforms inline,
// which then can't be overridden by state styles (repo footgun).
const CENTER_ACTION_RAISE = -28;

// Fill ladder: rests on `$brandSecondaryHover` (#B93312 on Stub) — the
// AA-compliant accent fill for small text (white 5.92:1); raw `$accent` fails
// AA in both polarities and never carries a label. Pressed/current moves to
// `$brandSecondaryStrong`, the next rung AWAY from `$onBrandSecondary`.
const CenterActionSquare = styled(YStack, {
  name: "NavigationBottomBarCenterAction",
  width: 64,
  height: 60,
  marginTop: CENTER_ACTION_RAISE,
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
  backgroundColor: "$brandSecondaryHover",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  variants: {
    engaged: {
      true: { backgroundColor: "$brandSecondaryStrong" },
    },
  } as const,
});

const CenterActionLabel = styled(Text, {
  name: "NavigationBottomBarCenterActionLabel",
  fontSize: 9,
  lineHeight: 11,
  fontWeight: "700",
  textAlign: "center",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontFamily: "$body",
  color: "$onBrandSecondary",
});

export interface NavigationBottomBarProps {
  sections: NavigationSection[];
  currentRoute: string;
  onSelect: (route: string, meta: RouteMeta) => void;
  testIdBase?: string;
  maxItems?: number;
  onOpenDrawer?: () => void;
  sticky?: boolean;
  /**
   * Optional raised action slot rendered mid-row (tabs split around it).
   * Not a tab: excluded from the swipe order and the active-rule treatment.
   * Default off — consumers that omit it get the classic row unchanged.
   */
  centerAction?: NavigationBottomBarCenterAction;
}

/**
 * Visible-tab budget before the bar demotes the overflow into a MORE tab.
 * Exported so `bottomBarShowsMore` callers and tests reference the SAME
 * number the bar renders with, instead of re-declaring a 4 that can drift.
 */
export const BOTTOM_BAR_DEFAULT_MAX_ITEMS = 4;
const SWIPE_ACTIVATION_DISTANCE = 40;

type FlattenedItem = {
  section: NavigationSection;
  route: NavigationSection["items"][number];
};

const flattenBottomBarItems = (
  sections: NavigationSection[],
): FlattenedItem[] => {
  const items: FlattenedItem[] = [];

  for (const section of sections) {
    for (const item of section.items) {
      if (item.disabled || item.hideInBottomBar) {
        continue;
      }
      items.push({ section, route: item });
    }
  }

  return items;
};

/**
 * True when the bottom bar rendered from `sections` will include the MORE
 * tab (its drawer entry point). The shell uses this to decide whether the
 * top-bar hamburger is still required: without MORE (≤ maxItems visible
 * items) the drawer would otherwise be unreachable on web, where the
 * edge-swipe gesture does not exist.
 *
 * This is a TOTAL model of the bar's own MORE condition, which is
 * `shouldShowMore && onOpenDrawer` — see the `tabNodes.push` guard below.
 * `hasDrawer` is required rather than defaulted precisely so a caller cannot
 * silently inherit half of that condition: answer it wrong and the shell
 * hides the hamburger while the bar renders no MORE tab, leaving the drawer
 * — and everything that lives only inside it, including the theme and
 * language controls — unreachable.
 *
 * `maxItems` shares `BOTTOM_BAR_DEFAULT_MAX_ITEMS` with the component, so
 * the two cannot drift. A caller that overrides `maxItems` here MUST pass
 * the same value to <NavigationBottomBar>.
 */
export const bottomBarShowsMore = (
  sections: NavigationSection[],
  options: { hasDrawer: boolean; maxItems?: number },
): boolean => {
  const { hasDrawer, maxItems = BOTTOM_BAR_DEFAULT_MAX_ITEMS } = options;
  return hasDrawer && flattenBottomBarItems(sections).length > maxItems;
};

export type BottomNavSwipeOutcome =
  | { kind: "route"; route: string; sectionId: string }
  | { kind: "drawer" }
  | { kind: "none" };

interface SwipeResolutionInput {
  currentRoute: string;
  primaryItems: FlattenedItem[];
  shouldShowMore: boolean;
  direction: "next" | "prev";
}

export const resolveBottomNavSwipe = ({
  currentRoute,
  primaryItems,
  shouldShowMore,
  direction,
}: SwipeResolutionInput): BottomNavSwipeOutcome => {
  const currentIndex = primaryItems.findIndex(
    ({ route }) => route.route === currentRoute,
  );
  if (currentIndex === -1) {
    return { kind: "none" };
  }

  if (direction === "next") {
    if (currentIndex < primaryItems.length - 1) {
      const target = primaryItems[currentIndex + 1];
      if (target) {
        return {
          kind: "route",
          route: target.route.route,
          sectionId: target.section.id,
        };
      }
    }

    if (shouldShowMore) {
      return { kind: "drawer" };
    }

    return { kind: "none" };
  }

  if (currentIndex > 0) {
    const target = primaryItems[currentIndex - 1];
    if (target) {
      return {
        kind: "route",
        route: target.route.route,
        sectionId: target.section.id,
      };
    }
  }

  return { kind: "none" };
};

export const NavigationBottomBar = memo(
  ({
    sections,
    currentRoute,
    onSelect,
    testIdBase = "navigation-bottom-bar",
    maxItems = BOTTOM_BAR_DEFAULT_MAX_ITEMS,
    onOpenDrawer,
    sticky = true,
    centerAction,
  }: NavigationBottomBarProps) => {
    const flattenedItems = useMemo(
      () => flattenBottomBarItems(sections),
      [sections],
    );

    const shouldShowMore = flattenedItems.length > maxItems;
    const primaryItems = shouldShowMore
      ? flattenedItems.slice(0, Math.max(maxItems - 1, 1))
      : flattenedItems.slice(0, maxItems);

    const bottomPadding = Platform.OS === "ios" ? "$5" : "$3";
    // iOS Safari / installed-PWA web: pad for the home-indicator safe area,
    // same technique as the consumer MobileBottomNav. RN-web passes string
    // style values through to CSS, so env() works here.
    const webSafeAreaStyle = isWeb
      ? ({
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
        } as const)
      : undefined;
    const gestureEnabled = Platform.OS !== "web";

    const handleSwipeSelect = useCallback(
      (direction: "next" | "prev") => {
        const outcome = resolveBottomNavSwipe({
          currentRoute,
          primaryItems,
          shouldShowMore,
          direction,
        });
        if (outcome.kind === "route") {
          onSelect(outcome.route, {
            source: "mobile-bottom",
            sectionId: outcome.sectionId,
          });
        } else if (outcome.kind === "drawer" && onOpenDrawer) {
          onOpenDrawer();
        }
      },
      [currentRoute, onOpenDrawer, onSelect, primaryItems, shouldShowMore],
    );

    const swipeGesture = useMemo(() => {
      if (!gestureEnabled) {
        return Gesture.Pan().enabled(false);
      }
      return Gesture.Pan()
        .maxPointers(1)
        .activeOffsetX([-5, 5])
        .onEnd((event) => {
          const shouldSwipe =
            Math.abs(event.translationX) > SWIPE_ACTIVATION_DISTANCE ||
            Math.abs(event.velocityX) > 600;
          if (!shouldSwipe) {
            return;
          }
          const direction = event.translationX < 0 ? "next" : "prev";
          runOnJS(handleSwipeSelect)(direction);
        });
    }, [gestureEnabled, handleSwipeSelect]);

    // Early return only after every hook above so hook order stays stable
    // when `sections` transitions between empty and non-empty on a mounted
    // instance.
    if (!flattenedItems.length) {
      return null;
    }

    const framePositionStyle = sticky
      ? isWeb
        ? ({
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 100,
          } as const)
        : ({
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 100,
          } as const)
      : undefined;

    // Tabs render as one flat list (primary items + More) so the optional
    // center action can split them evenly — with the standard 4 tabs the slot
    // lands between tabs 2 and 3. The center action is NOT a tab: it stays
    // out of `primaryItems`, so the swipe order is untouched.
    const tabNodes: ReactNode[] = primaryItems.map(({ section, route }) => {
      const isActive =
        route.active ??
        isRouteActive(currentRoute, route.route, route.activeMatch);
      const meta: RouteMeta = {
        source: "mobile-bottom",
        sectionId: section.id,
      };

      return (
        <NavItem
          key={route.id}
          id={route.id}
          label={route.label}
          icon={route.icon}
          isActive={isActive}
          badgeCount={route.badgeCount}
          onPress={() => onSelect(route.route, meta)}
          compact={Boolean(centerAction)}
        />
      );
    });
    if (shouldShowMore && onOpenDrawer) {
      tabNodes.push(
        <NavItem
          key="mobile-bottom-more"
          id="mobile-bottom-more"
          label="More"
          icon={<MoreHorizontal size={24} strokeWidth={2} />}
          isActive={false}
          onPress={onOpenDrawer}
          compact={Boolean(centerAction)}
        />,
      );
    }
    const centerIndex = Math.ceil(tabNodes.length / 2);

    const barContent = (
      <BottomBarFrame
        testID={testIdBase}
        data-testid={testIdBase}
        {...(isWeb ? {} : { paddingBottom: bottomPadding })}
        style={
          isWeb
            ? ({ ...framePositionStyle, ...webSafeAreaStyle } as never)
            : framePositionStyle
        }
      >
        <BottomBarItems>
          {centerAction ? (
            <>
              {tabNodes.slice(0, centerIndex)}
              <CenterNavAction
                action={centerAction}
                isCurrent={currentRoute === centerAction.id}
              />
              {tabNodes.slice(centerIndex)}
            </>
          ) : (
            tabNodes
          )}
        </BottomBarItems>
      </BottomBarFrame>
    );

    if (!gestureEnabled) {
      return barContent;
    }

    return (
      <GestureDetector gesture={swipeGesture}>{barContent}</GestureDetector>
    );
  },
);

NavigationBottomBar.displayName = "NavigationBottomBar";

// ─────────────────────────────────────────────────────────────
// NavItem — individual tab with icon, label, tap animation
// ─────────────────────────────────────────────────────────────

interface NavItemProps {
  id: string;
  label: string;
  icon?: ReactNode;
  isActive: boolean;
  badgeCount?: number;
  onPress: () => void;
  /**
   * True when the bar also renders a 64px center action: 4 tabs x 64px
   * minWidth + the square + padding = 336px, which overflows a 320px
   * viewport, so compact tabs drop to the 44px touch-target floor and share
   * what the square leaves (4 x 44 + 64 + 16 = 256).
   */
  compact?: boolean;
}

const NavItem = memo(
  ({ id, label, icon, isActive, badgeCount, onPress, compact }: NavItemProps) => {
    const theme = useTheme();
    const scale = useSharedValue(1);
    const opacity = useSharedValue(1);

    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ scale: scale.value }],
      opacity: opacity.value,
    }));

    const handlePressIn = useCallback(() => {
      scale.value = withTiming(0.92, { duration: 80 });
      opacity.value = withTiming(0.7, { duration: 80 });
    }, [opacity, scale]);

    const handlePressOut = useCallback(() => {
      scale.value = withTiming(1, { duration: 120 });
      opacity.value = withTiming(1, { duration: 120 });
    }, [opacity, scale]);

    const iconColor = isActive ? theme.accent?.val : theme.color?.val;
    const labelColor = isActive ? "$accent" : "$colorMuted";
    const showBadge = typeof badgeCount === "number" && badgeCount > 0;

    // Clone icon with correct color and stroke
    const renderedIcon = icon ? (
      <IconWrapper>
        {typeof icon === "object" && icon !== null && "type" in icon
          ? // Clone React element with new props
            {
              ...icon,
              props: {
                ...((icon as any).props ?? {}),
                color: iconColor,
                strokeWidth: 2,
                size: 24,
              },
            }
          : icon}
      </IconWrapper>
    ) : null;

    const navTestId = `nav-item-${id}`;
    const navLabel = `${label} tab`;
    return (
      <View
        testID={navTestId}
        accessibilityLabel={navLabel}
        accessible={false}
        style={compact ? NAV_ITEM_COMPACT_STYLE : NAV_ITEM_STYLE}
      >
        <Pressable
          onPress={onPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          accessibilityRole="button"
          accessibilityState={{ selected: isActive }}
          accessible={true}
          accessibilityLabel={navLabel}
        >
          <Animated.View style={animatedStyle}>
            <NavItemContainer>
              <ActiveTopRule active={isActive} />
              {renderedIcon}
              {/* `truncate`, not wrap: a compressed tab that reflowed to two
                  lines would change the bar's height, which both shells
                  reserve as a fixed clearance. */}
              <Label color={labelColor} truncate>
                {label}
              </Label>
              {showBadge ? (
                <Badge
                  tone="neutral"
                  size="xs"
                  style={{ position: "absolute", top: -4, right: 8 }}
                >
                  {badgeCount}
                </Badge>
              ) : null}
            </NavItemContainer>
          </Animated.View>
        </Pressable>
      </View>
    );
  },
);

NavItem.displayName = "NavItem";

// ─────────────────────────────────────────────────────────────
// CenterNavAction — raised accent square between the tabs
// ─────────────────────────────────────────────────────────────

interface CenterNavActionProps {
  action: NavigationBottomBarCenterAction;
  /** True while the bar's currentRoute IS the action's destination. */
  isCurrent: boolean;
}

const CenterNavAction = memo(({ action, isCurrent }: CenterNavActionProps) => {
  const theme = useTheme();
  // Plain pressed state (fill moves one rung up the ladder) instead of the
  // tabs' reanimated scale/opacity dip: transforms are emitted inline by
  // Tamagui and the square's raised negative-margin geometry must stay put.
  const [pressed, setPressed] = useState(false);
  const handlePressIn = useCallback(() => setPressed(true), []);
  const handlePressOut = useCallback(() => setPressed(false), []);

  const iconColor = theme.onBrandSecondary?.val;
  const renderedIcon = action.icon ? (
    <IconWrapper>
      {typeof action.icon === "object" &&
      action.icon !== null &&
      "type" in action.icon
        ? {
            ...action.icon,
            props: {
              ...((action.icon as any).props ?? {}),
              color: iconColor,
              strokeWidth: 2,
              size: 24,
            },
          }
        : action.icon}
    </IconWrapper>
  ) : null;

  const testId = action.testId ?? `nav-center-${action.id}`;
  return (
    <View testID={testId} accessible={false}>
      <Pressable
        onPress={action.onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityRole="button"
        accessibilityState={{ selected: isCurrent }}
        accessible={true}
        accessibilityLabel={action.ariaLabel ?? action.label}
      >
        <CenterActionSquare engaged={isCurrent || pressed}>
          {renderedIcon}
          <CenterActionLabel>{action.label}</CenterActionLabel>
        </CenterActionSquare>
      </Pressable>
    </View>
  );
});

CenterNavAction.displayName = "CenterNavAction";
