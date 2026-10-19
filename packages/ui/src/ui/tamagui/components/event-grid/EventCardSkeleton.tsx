"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform } from "react-native";
import {
  AnimatePresence,
  Stack,
  XStack,
  YStack,
  styled,
  type SizeTokens,
  type StackProps,
  useTheme,
} from "tamagui";

import {
  getEventCardMediaDimensions,
  getEventCardMinHeight,
  getEventCardSizeConfig,
  type EventCardSize,
} from "./sizes";
import { hexToRgba } from "../shared";
import { colorTokens } from "../../tokens/colors";

const isWeb = Platform.OS === "web";
// Mirrors EventCardSurface's frame ($surface panel + 2px structural ink) so
// the skeleton→loaded swap doesn't pop the card's background and border.
// Deliberately WITHOUT the v2 --shadow-card drop shadow: a shadow on a pulsing
// placeholder reads as a real, liftable object. The skeleton stays flat.
//
// `overflow: hidden` is load-bearing here as on the card: it is what clips the
// punch holes to half-circles.
const SkeletonBase = styled(Stack, {
  name: "EventCardSkeletonBase",
  width: "100%",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  position: "relative",
  overflow: "hidden",
});

/** Mirrors the card's tear and die-cuts — see `Perforation` in EventCard.tsx. */
const SKELETON_HOLE_R = 7;

/** Mirrors `POSTER_ASPECT_RATIO` in EventCard.tsx. */
const POSTER_ASPECT_RATIO = 2 / 3;

const SkeletonPerforation = styled(Stack, {
  name: "EventCardSkeletonPerforation",
  position: "relative",
  width: "100%",
  height: 0,
  flexShrink: 0,
  zIndex: 2,
  borderTopWidth: 2,
  borderRightWidth: 0,
  borderBottomWidth: 0,
  borderLeftWidth: 0,
  borderColor: "$borderColor",
  borderStyle: "dashed",
});

const SkeletonPunchHole = styled(Stack, {
  name: "EventCardSkeletonPunchHole",
  position: "absolute",
  top: -SKELETON_HOLE_R,
  width: SKELETON_HOLE_R * 2,
  height: SKELETON_HOLE_R * 2,
  borderRadius: 999,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$background",
  zIndex: 2,
});

const SkeletonFoot = styled(XStack, {
  name: "EventCardSkeletonFoot",
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  marginTop: "auto",
  borderTopWidth: 1,
  borderTopColor: "$borderColorSoft",
  paddingVertical: "$2",
  paddingHorizontal: "$4",
});

const SkeletonBlock = styled(Stack, {
  name: "EventCardSkeletonBlock",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  opacity: 0.35,
});

const MediaFrame = styled(Stack, {
  name: "EventCardSkeletonMediaFrame",
  width: "100%",
  backgroundColor: "$surfaceMuted",
  opacity: 0.7,
  position: "relative",
  overflow: "hidden",
});

const MediaOverlay = styled(Stack, {
  name: "EventCardSkeletonMediaOverlay",
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  height: "35%",
  backgroundColor: hexToRgba(colorTokens.color.brandPrimary, 0.08),
});

// DIAG: defer Animated.createAnimatedComponent to render-time to avoid
// "Cannot read property 'createAnimatedComponent' of undefined" at
// module-init time on scanner Android release builds. Revert when root
// cause found.
const _animCreate = (
  Animated as unknown as {
    createAnimatedComponent?: (c: unknown) => React.ComponentType<unknown>;
  }
)?.createAnimatedComponent;
const AnimatedSkeletonBlock = (_animCreate?.(SkeletonBlock) ??
  SkeletonBlock) as typeof SkeletonBlock;
const AnimatedSkeletonBase = (_animCreate?.(SkeletonBase) ??
  SkeletonBase) as typeof SkeletonBase;
if (typeof console !== "undefined" && !_animCreate) {
  // eslint-disable-next-line no-console
  console.warn(
    "[diag EventCardSkeleton] Animated.createAnimatedComponent is undefined at module-init",
  );
}

const styleTagId = "event-card-skeleton-animations";

if (
  isWeb &&
  typeof document !== "undefined" &&
  !document.getElementById(styleTagId)
) {
  const style = document.createElement("style");
  style.id = styleTagId;
  style.innerHTML = `
    @keyframes eventCardSkeletonInnerFade {
      0% { opacity: 0.3; }
      50% { opacity: 0.7; }
      100% { opacity: 0.3; }
    }
      @keyframes eventCardSkeletonPulse {
        0% { opacity: 0.4; }
        50% { opacity: 0.75; }
        100% { opacity: 0.4; }
      }
  `;
  document.head.appendChild(style);
}

const getWebFadeAnimationStyle = (
  delay = 0,
): StackProps["style"] | undefined =>
  isWeb
    ? {
        animationName: "eventCardSkeletonInnerFade",
        animationDuration: "1.6s",
        animationIterationCount: "infinite" as const,
        animationTimingFunction: "ease-in-out" as const,
        animationDirection: "alternate" as const,
        animationDelay: `${delay}ms`,
      }
    : undefined;

const mergeNativeStyles = (
  base: StackProps["style"] | undefined,
  addition: StackProps["style"] | undefined,
): StackProps["style"] => {
  if (!addition) {
    return base;
  }

  if (!base) {
    return addition;
  }

  return Array.isArray(base) ? [...base, addition] : [base, addition];
};

const mergeWebStyles = (
  base: StackProps["style"] | undefined,
  addition: StackProps["style"] | undefined,
): StackProps["style"] => {
  if (!addition) {
    return base;
  }

  if (!base) {
    return addition;
  }

  const toObject = (value: StackProps["style"]) => {
    if (Array.isArray(value)) {
      return value.reduce<Record<string, unknown>>((acc, item) => {
        if (item && typeof item === "object") {
          Object.assign(acc, item as Record<string, unknown>);
        }
        return acc;
      }, {});
    }

    return value && typeof value === "object"
      ? { ...(value as Record<string, unknown>) }
      : {};
  };

  return { ...toObject(base), ...toObject(addition) };
};

const fadeMin = 0.35;
const fadeMax = 0.7;
const fadeDuration = 1000;

const useNativeFadeAnimation = (enabled: boolean, delayMs: number) => {
  const opacity = useRef(new Animated.Value(fadeMin)).current;

  useEffect(() => {
    if (!enabled || isWeb) {
      opacity.stopAnimation?.(() => {
        opacity.setValue(fadeMin);
      });
      return;
    }

    let loop: Animated.CompositeAnimation | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const startLoop = () => {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: fadeMax,
            duration: fadeDuration,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: fadeMin,
            duration: fadeDuration,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
    };

    if (delayMs > 0) {
      timeout = setTimeout(startLoop, delayMs);
    } else {
      startLoop();
    }

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      loop?.stop();
    };
  }, [enabled, delayMs, opacity]);

  return opacity;
};

export interface EventCardSkeletonProps {
  layout?: "vertical" | "horizontal";
  animate?: boolean;
  loading?: boolean;
  width?: number | string;
  height?: number | string;
  testIdBase?: string;
  qaId?: string;
  size?: EventCardSize;
  style?: StackProps["style"];
}

const resolveAutomationProps = (base?: string, qa?: string) => {
  if (!base) {
    return {};
  }

  if (isWeb) {
    return {
      "data-testid": base,
      ...(qa ? { "data-qa": qa } : {}),
    };
  }

  return {
    testID: base,
    ...(qa ? { accessibilityLabel: qa } : {}),
  };
};

const AnimatedBlock = ({
  height,
  width,
  borderRadius,
  animate,
  delay = 0,
}: {
  height: number | string;
  width: number | string;
  borderRadius?: SizeTokens | number;
  animate: boolean;
  delay?: number;
}) => {
  const opacity = useNativeFadeAnimation(animate, delay);

  if (!animate) {
    return (
      <SkeletonBlock
        height={height}
        width={width}
        borderRadius={borderRadius}
        aria-hidden
      />
    );
  }

  if (isWeb) {
    const animationStyle = getWebFadeAnimationStyle(delay);
    return (
      <SkeletonBlock
        height={height}
        width={width}
        borderRadius={borderRadius}
        aria-hidden
        style={animationStyle}
      />
    );
  }

  return (
    <AnimatedSkeletonBlock
      height={height}
      width={width}
      borderRadius={borderRadius}
      aria-hidden
      style={{ opacity }}
    />
  );
};

const textBlockConfigs = [{ height: 20, width: "80%", delay: 0 }] as const;

/** Icon-row shimmers: small circle (icon) + text bar */
const metaRowConfigs = [
  { iconDelay: 120, textWidth: "55%", textDelay: 160 },
  { iconDelay: 200, textWidth: "45%", textDelay: 240 },
] as const;

const priceBlockConfig = { height: 14, width: "30%", delay: 320 } as const;
const mediaBlockDelay = 180;

type ThemeTone = "light" | "dark";

const resolveThemeTone = (themeName?: string): ThemeTone =>
  themeName?.toLowerCase().includes("dark") ? "dark" : "light";

const usePrefersReducedMotion = () => {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (
      !isWeb ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
    } else {
      mediaQuery.addListener(handleChange);
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", handleChange);
      } else {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, []);

  return prefersReducedMotion;
};

export const EventCardSkeleton = memo<EventCardSkeletonProps>(
  ({
    layout = "vertical",
    animate = true,
    loading = true,
    width,
    height,
    testIdBase = "event-card-skeleton",
    qaId,
    size = "md",
    style,
  }) => {
    const theme = useTheme();
    const themeNameValue = theme?.name as string | { val?: string } | undefined;
    const themeName =
      typeof themeNameValue === "string"
        ? themeNameValue
        : typeof themeNameValue?.val === "string"
          ? themeNameValue.val
          : undefined;
    const tone = resolveThemeTone(themeName);
    const prefersReducedMotion = usePrefersReducedMotion();
    const animationEnabled = Boolean(
      loading && animate !== false && !prefersReducedMotion,
    );
    const containerOpacity = useNativeFadeAnimation(
      animationEnabled && !isWeb,
      60,
    );

    const sizeConfig = getEventCardSizeConfig(size);
    const resolvedWidth = width;

    const mediaDimensions = getEventCardMediaDimensions(size, layout);
    const mediaHeight = mediaDimensions.height;
    const cardMinHeight = getEventCardMinHeight(size, layout);
    const resolvedHeight = height ?? cardMinHeight;
    const mediaOverlayColor = hexToRgba(
      colorTokens.color.brandPrimary,
      tone === "dark" ? 0.35 : 0.08,
    );
    const shadowColor = hexToRgba(
      colorTokens.color.brandPrimary,
      tone === "dark" ? 0.45 : 0.08,
    );

    const body = (
      <YStack padding="$5" gap="$4" minHeight={sizeConfig.contentMinHeight}>
        {/* Title shimmer */}
        <YStack gap="$2">
          {textBlockConfigs.map((config, index) => (
            <AnimatedBlock
              key={`text-line-${index}`}
              height={config.height}
              width={config.width}
              animate={animationEnabled}
              delay={config.delay}
            />
          ))}
        </YStack>
        {/* Date & venue icon-row shimmers */}
        <YStack gap="$2">
          {metaRowConfigs.map((config, index) => (
            <XStack key={`meta-row-${index}`} gap="$2" alignItems="center">
              <AnimatedBlock
                height={14}
                width={14}
                borderRadius={0}
                animate={animationEnabled}
                delay={config.iconDelay}
              />
              <AnimatedBlock
                height={14}
                width={config.textWidth}
                animate={animationEnabled}
                delay={config.textDelay}
              />
            </XStack>
          ))}
        </YStack>
        {/* Spacer so the body owns the slack and the foot stays pinned */}
        <Stack flex={1} />
      </YStack>
    );

    // The card's foot: serial left, price block right. Mirrored here because a
    // skeleton that omits it makes the card grow a whole row on load.
    const footContent = (
      <SkeletonFoot>
        <AnimatedBlock
          height={priceBlockConfig.height}
          width={priceBlockConfig.width}
          animate={animationEnabled}
          delay={priceBlockConfig.delay}
        />
        <AnimatedBlock
          height={38}
          width={84}
          animate={animationEnabled}
          delay={priceBlockConfig.delay + 60}
        />
      </SkeletonFoot>
    );

    const mediaContent = (
      <MediaFrame
        height={layout === "horizontal" ? resolvedHeight : mediaHeight}
        borderRadius={0}
      >
        <AnimatedBlock
          height={layout === "horizontal" ? resolvedHeight : mediaHeight}
          width="100%"
          borderRadius={0}
          animate={animationEnabled}
          delay={mediaBlockDelay}
        />
        <MediaOverlay aria-hidden backgroundColor={mediaOverlayColor} />
      </MediaFrame>
    );

    const perforation = (
      <SkeletonPerforation aria-hidden>
        <SkeletonPunchHole left={-SKELETON_HOLE_R} />
        <SkeletonPunchHole right={-SKELETON_HOLE_R} />
      </SkeletonPerforation>
    );

    /**
     * The vertical skeleton mirrors the POSTER, because that is what the card
     * resolves to: one tall 2:3 block and nothing else.
     *
     * The ticket's shimmer — a landscape block, a tear, then title/meta/foot
     * rows — described a card the grid no longer renders, so the placeholder
     * and the loaded card were different heights and different shapes and the
     * swap jumped. The poster's own body sits ON the art, so there is nothing
     * below it to pre-draw.
     */
    const posterContent = (
      <MediaFrame
        width="100%"
        height={undefined}
        borderRadius={0}
        style={{ aspectRatio: String(POSTER_ASPECT_RATIO) }}
      >
        <AnimatedBlock
          height="100%"
          width="100%"
          borderRadius={0}
          animate={animationEnabled}
          delay={mediaBlockDelay}
        />
      </MediaFrame>
    );

    const children =
      layout === "horizontal" ? (
        <XStack width="100%" minHeight={resolvedHeight} alignItems="stretch">
          <Stack flexBasis="38%" maxWidth="38%" justifyContent="flex-start">
            {mediaContent}
          </Stack>
          <YStack flex={1} justifyContent="center">
            {body}
            {footContent}
          </YStack>
        </XStack>
      ) : (
        <YStack height="100%">{posterContent}</YStack>
      );

    const ContainerComponent =
      animationEnabled && !isWeb ? AnimatedSkeletonBase : SkeletonBase;
    const animationStyle: StackProps["style"] | undefined = animationEnabled
      ? isWeb
        ? ({
            animationName: "eventCardSkeletonPulse",
            animationDuration: "1.8s",
            animationIterationCount: "infinite" as const,
            animationTimingFunction: "ease-in-out" as const,
          } as StackProps["style"])
        : ({
            opacity: containerOpacity,
          } as StackProps["style"])
      : undefined;

    const resolvedStyle = animationStyle
      ? isWeb
        ? mergeWebStyles(style, animationStyle)
        : mergeNativeStyles(style, animationStyle)
      : style;

    return (
      <ContainerComponent
        {...(typeof resolvedWidth !== "undefined"
          ? { width: resolvedWidth }
          : {})}
        height={resolvedHeight}
        style={resolvedStyle}
        {...resolveAutomationProps(testIdBase, qaId ?? testIdBase)}
        aria-hidden
        pointerEvents="none"
      >
        {children}
      </ContainerComponent>
    );
  },
);

EventCardSkeleton.displayName = "EventCardSkeleton";

export const EventCardSkeletonGroup = ({
  count,
  layout,
  animate,
  loading,
  size = "md",
}: {
  count: number;
  layout?: "vertical" | "horizontal";
  animate?: boolean;
  loading?: boolean;
  size?: EventCardSize;
}) => {
  const skeletons = Array.from({ length: count }).map((_, index) => (
    <EventCardSkeleton
      key={index}
      layout={layout}
      animate={animate}
      loading={loading}
      size={size}
    />
  ));

  if (layout === "horizontal") {
    return (
      <AnimatePresence initial={false}>
        <YStack gap="$4" aria-hidden>
          {skeletons}
        </YStack>
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence initial={false}>
      <XStack gap="$4" flexWrap="wrap" aria-hidden>
        {skeletons}
      </XStack>
    </AnimatePresence>
  );
};
