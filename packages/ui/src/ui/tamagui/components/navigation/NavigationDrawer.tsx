"use client";

import { X } from "lucide-react";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Platform, useWindowDimensions } from "react-native";
import { Stack, XStack, YStack, styled } from "tamagui";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { colorTokens } from "../../tokens/colors";
import { Button } from "../forms/Button";
import { hexToRgba } from "../shared";
import { Text } from "../typography/Text";

const drawerOverlayColor = hexToRgba(colorTokens.color.brandPrimary, 0.45);

const isWeb = Platform.OS === "web";

const DrawerRoot = styled(Stack, {
  name: "NavigationDrawerRoot",
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  pointerEvents: "box-none",
  zIndex: 2000,
});

const DrawerOverlay = styled(Stack, {
  name: "NavigationDrawerOverlay",
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: drawerOverlayColor,
  pointerEvents: "auto",
});

const DrawerSurface = styled(YStack, {
  name: "NavigationDrawerSurface",
  position: "absolute",
  top: 0,
  bottom: 0,
  backgroundColor: "$surface",
  padding: "$5",
  gap: "$4",
  variants: {
    side: {
      left: {
        left: 0,
        right: "auto",
      },
      right: {
        right: 0,
        left: "auto",
      },
    },
  },
  defaultVariants: {
    side: "left",
  },
});

const DrawerHeader = styled(YStack, {
  name: "NavigationDrawerHeader",
  gap: "$2",
  // Header stays pinned at the top: it must never be compressed by an
  // overflowing body below it.
  flexShrink: 0,
});

const DrawerBody = styled(YStack, {
  name: "NavigationDrawerBody",
  gap: "$3",
  flex: 1,
  // The classic flexbox overflow trap: on web, a flex child's min-height
  // defaults to its CONTENT height, so `flex: 1` alone never constrained the
  // body — 18 admin nav items painted past the surface with no scrollable
  // ancestor, leaving deep items (and the pinned footer's would-be space)
  // unreachable. minHeight 0 lets the body actually shrink to the surface;
  // the web-only overflowY: auto (applied at the usage site — RN styles have
  // no overflowY) makes it the scroll region.
  minHeight: 0,
  overflow: "visible",
});

const DrawerFooter = styled(YStack, {
  name: "NavigationDrawerFooter",
  gap: "$3",
  // Pinned below the scrollable body — must keep its intrinsic height.
  flexShrink: 0,
});

// DIAG: defer createAnimatedComponent for module-init safety on RN.
const _navDrawerAnimCreate = (
  Animated as unknown as {
    createAnimatedComponent?: (c: unknown) => React.ComponentType<unknown>;
  }
)?.createAnimatedComponent;
const AnimatedDrawerOverlay = (_navDrawerAnimCreate?.(DrawerOverlay) ??
  DrawerOverlay) as typeof DrawerOverlay;
const AnimatedDrawerSurface = (_navDrawerAnimCreate?.(DrawerSurface) ??
  DrawerSurface) as typeof DrawerSurface;

const CloseButtonRow = styled(XStack, {
  name: "NavigationDrawerCloseRow",
  justifyContent: "flex-end",
  alignItems: "center",
  // Pinned above the scrollable body, like the header.
  flexShrink: 0,
});

const getAutomationProps = (baseId: string, qaId: string) =>
  isWeb
    ? ({ "data-testid": baseId, "data-qa": qaId } as const)
    : ({ testID: baseId, accessibilityLabel: qaId } as const);

const MIN_DRAWER_WIDTH = 320;
const MAX_DRAWER_WIDTH = 448;
const WIDTH_FRACTION = 0.92;
const ANIMATION_DURATION_MS = 280;

const clampWidth = (viewportWidth: number, maxWidth?: number): number => {
  const effectiveMax = Math.min(MAX_DRAWER_WIDTH, maxWidth ?? MAX_DRAWER_WIDTH);
  const candidate = Math.min(viewportWidth * WIDTH_FRACTION, effectiveMax);
  return Math.max(MIN_DRAWER_WIDTH, Math.round(candidate));
};

export interface NavigationDrawerProps {
  /** Controls whether the drawer is visible. */
  open?: boolean;
  /** Called whenever the open state should change. */
  onOpenChange?: (nextOpen: boolean) => void;
  /** Title rendered in the header. */
  title?: ReactNode;
  /** Optional description beneath the title. */
  description?: ReactNode;
  /** Optional footer content, typically actions. */
  footer?: ReactNode;
  /** Main navigation content. */
  children?: ReactNode;
  /** Accessible label for the close button. */
  closeLabel?: string;
  /** Test identifier base; used for QA hooks. */
  testIdBase?: string;
  /** Optional QA identifier override. */
  qaId?: string;
  /** Custom maximum width for large viewports. */
  maxWidth?: number;
  /** Which side of the viewport the drawer should originate from. */
  side?: "left" | "right";
}

export const NavigationDrawer = ({
  open = false,
  onOpenChange,
  title,
  description,
  footer,
  children,
  closeLabel = "Close drawer",
  testIdBase = "navigation-drawer",
  qaId,
  maxWidth,
  side = "left",
}: NavigationDrawerProps) => {
  const { width: viewportWidth = 360 } = useWindowDimensions();
  const resolvedQaId = qaId ?? testIdBase;
  const [visible, setVisible] = useState(open);

  const drawerWidth = useMemo(
    () => clampWidth(viewportWidth || 360, maxWidth),
    [viewportWidth, maxWidth],
  );
  const titleId = `${testIdBase}-title`;
  const descriptionId = `${testIdBase}-description`;
  const animationProgress = useSharedValue(open ? 1 : 0);
  const gestureEnabled = !isWeb;
  const handleClose = useCallback(() => {
    onOpenChange?.(false);
  }, [onOpenChange]);
  const closeSwipeGesture = useMemo(() => {
    if (!gestureEnabled) {
      return Gesture.Pan().enabled(false);
    }

    const threshold = drawerWidth * 0.3;
    return Gesture.Pan()
      .maxPointers(1)
      .activeOffsetX([-5, 5])
      .onEnd((event) => {
        const translation =
          side === "left" ? event.translationX : -event.translationX;
        const velocity = side === "left" ? event.velocityX : -event.velocityX;
        if (translation < -threshold || velocity < -600) {
          runOnJS(handleClose)();
        }
      });
  }, [drawerWidth, gestureEnabled, handleClose, side]);

  useEffect(() => {
    if (open) {
      setVisible(true);
    }
  }, [open]);

  useEffect(() => {
    animationProgress.value = withTiming(
      open ? 1 : 0,
      {
        duration: ANIMATION_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      },
      (finished) => {
        if (!open && finished) {
          runOnJS(setVisible)(false);
        }
      },
    );
  }, [animationProgress, open]);

  useEffect(() => {
    if (!isWeb || !open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleClose, open]);

  useEffect(() => {
    if (!isWeb || !open) {
      return undefined;
    }

    const originalOverflow = document.body?.style.overflow ?? "";
    if (document.body) {
      document.body.style.overflow = "hidden";
    }

    return () => {
      if (document.body) {
        document.body.style.overflow = originalOverflow;
      }
    };
  }, [open]);

  // Hooks must run unconditionally — on native, useAnimatedStyle is a real
  // hook, so it cannot sit below the `!visible` early return.
  const overlayStyle = useAnimatedStyle(() => ({
    opacity: animationProgress.value,
  }));

  const direction = side === "left" ? -1 : 1;
  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          animationProgress.value,
          [0, 1],
          [direction * drawerWidth, 0],
        ),
      },
    ],
  }));

  if (!visible) {
    return null;
  }

  const automationProps = getAutomationProps(testIdBase, resolvedQaId);
  const overlayProps = getAutomationProps(
    `${testIdBase}-overlay`,
    `${resolvedQaId}-overlay`,
  );

  const drawerSurfaceElement = (
    <AnimatedDrawerSurface
      side={side}
      width={drawerWidth}
      aria-modal={isWeb ? true : undefined}
      role={isWeb ? "dialog" : undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      {...getAutomationProps(
        `${testIdBase}-surface`,
        `${resolvedQaId}-surface`,
      )}
      style={[isWeb ? { position: "fixed" } : undefined, surfaceStyle]}
    >
      <CloseButtonRow>
        <Button
          size="$2"
          variant="ghost"
          icon
          accessibilityLabel={closeLabel}
          onPress={handleClose}
          {...getAutomationProps(
            `${testIdBase}-close`,
            `${resolvedQaId}-close`,
          )}
        >
          <X size={18} strokeWidth={1.5} />
        </Button>
      </CloseButtonRow>

      {(title || description) && (
        <DrawerHeader>
          {typeof title === "string" ? (
            <Text id={titleId} variant="h5" weight="bold">
              {title}
            </Text>
          ) : title ? (
            <YStack id={titleId}>{title}</YStack>
          ) : null}
          {description ? (
            typeof description === "string" ? (
              <Text id={descriptionId} variant="body" tone="muted">
                {description}
              </Text>
            ) : (
              <YStack id={descriptionId}>{description}</YStack>
            )
          ) : null}
        </DrawerHeader>
      )}

      <DrawerBody
        {...getAutomationProps(`${testIdBase}-body`, `${resolvedQaId}-body`)}
        // Web scroll region (see DrawerBody). Native keeps the prior
        // overflow: visible — RN Views don't scroll without a ScrollView, and
        // no native surface mounts this drawer today.
        {...(isWeb
          ? { style: { overflowY: "auto", overflowX: "hidden" } }
          : {})}
      >
        {children}
      </DrawerBody>

      {footer ? (
        <DrawerFooter
          {...getAutomationProps(
            `${testIdBase}-footer`,
            `${resolvedQaId}-footer`,
          )}
        >
          {footer}
        </DrawerFooter>
      ) : null}
    </AnimatedDrawerSurface>
  );

  return (
    <DrawerRoot
      {...automationProps}
      role={isWeb ? "none" : undefined}
      style={isWeb ? { position: "fixed" } : undefined}
    >
      <AnimatedDrawerOverlay
        {...overlayProps}
        onPress={handleClose}
        accessibilityRole={!isWeb ? "button" : undefined}
        accessibilityLabel={closeLabel}
        style={overlayStyle}
      />
      {isWeb ? (
        drawerSurfaceElement
      ) : (
        <GestureDetector gesture={closeSwipeGesture}>
          {drawerSurfaceElement}
        </GestureDetector>
      )}
    </DrawerRoot>
  );
};

NavigationDrawer.displayName = "NavigationDrawer";
