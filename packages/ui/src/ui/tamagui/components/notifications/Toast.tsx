"use client";

import { memo, useCallback, useMemo, type ComponentType } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Info,
  ShieldAlert,
  X,
} from "lucide-react";

import { Platform } from "react-native";

import { Stack, XStack, YStack, styled, type StackProps } from "tamagui";

import { motionTokens } from "../../tokens/motion";
import { getNotificationToneTokens, type IntentVariant } from "../shared";
import { Badge } from "../feedback/Badge";
import { Button } from "../forms/Button";
import { Text } from "../typography/Text";
import {
  TOAST_ACTION_ATTRIBUTE,
  TOAST_CLOSE_ATTRIBUTE,
  TOAST_DATA_ATTRIBUTE,
  type NotificationProviderProps,
  type ToastInternal,
  type ToastIntent,
  type ToastPosition,
  type ToastVariant,
} from "./types";

// CSS keyframe animations for web fallback
const CSS_ANIMATION_KEYFRAMES = `
@keyframes th-toast-slide-in-right {
	from {
		opacity: 0;
		transform: translateX(100%);
	}
	to {
		opacity: 1;
		transform: translateX(0);
	}
}
@keyframes th-toast-slide-out-right {
	from {
		opacity: 1;
		transform: translateX(0);
	}
	to {
		opacity: 0;
		transform: translateX(100%);
	}
}
@keyframes th-toast-slide-in-left {
	from {
		opacity: 0;
		transform: translateX(-100%);
	}
	to {
		opacity: 1;
		transform: translateX(0);
	}
}
@keyframes th-toast-slide-out-left {
	from {
		opacity: 1;
		transform: translateX(0);
	}
	to {
		opacity: 0;
		transform: translateX(-100%);
	}
}
@keyframes th-toast-slide-in-down {
	from {
		opacity: 0;
		transform: translateY(-20px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}
@keyframes th-toast-slide-out-up {
	from {
		opacity: 1;
		transform: translateY(0);
	}
	to {
		opacity: 0;
		transform: translateY(-20px);
	}
}
@keyframes th-toast-slide-in-up {
	from {
		opacity: 0;
		transform: translateY(20px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}
@keyframes th-toast-slide-out-down {
	from {
		opacity: 1;
		transform: translateY(0);
	}
	to {
		opacity: 0;
		transform: translateY(20px);
	}
}
@keyframes th-toast-fade-in {
	from {
		opacity: 0;
		transform: scale(0.95);
	}
	to {
		opacity: 1;
		transform: scale(1);
	}
}
@keyframes th-toast-fade-out {
	from {
		opacity: 1;
		transform: scale(1);
	}
	to {
		opacity: 0;
		transform: scale(0.95);
	}
}
`;

// Inject CSS keyframes once on web
let cssInjected = false;
const injectCssAnimations = () => {
  if (cssInjected || Platform.OS !== "web" || typeof document === "undefined") {
    return;
  }
  const style = document.createElement("style");
  style.id = "th-toast-animations";
  style.textContent = CSS_ANIMATION_KEYFRAMES;
  document.head.appendChild(style);
  cssInjected = true;
};

type CssAnimationName =
  | "th-toast-slide-in-right"
  | "th-toast-slide-out-right"
  | "th-toast-slide-in-left"
  | "th-toast-slide-out-left"
  | "th-toast-slide-in-down"
  | "th-toast-slide-out-up"
  | "th-toast-slide-in-up"
  | "th-toast-slide-out-down"
  | "th-toast-fade-in"
  | "th-toast-fade-out";

const getCssAnimationsForPosition = (
  position: ToastPosition,
): { enter: CssAnimationName; exit: CssAnimationName } => {
  const isTop = position.startsWith("top");
  const isBottom = position.startsWith("bottom");
  const isRight = position.includes("right");
  const isLeft = position.includes("left");
  const isCenter = position === "middle-center";

  if (isCenter) {
    return { enter: "th-toast-fade-in", exit: "th-toast-fade-out" };
  }
  if (isRight) {
    return {
      enter: "th-toast-slide-in-right",
      exit: "th-toast-slide-out-right",
    };
  }
  if (isLeft) {
    return { enter: "th-toast-slide-in-left", exit: "th-toast-slide-out-left" };
  }
  if (isTop) {
    return { enter: "th-toast-slide-in-down", exit: "th-toast-slide-out-up" };
  }
  if (isBottom) {
    return { enter: "th-toast-slide-in-up", exit: "th-toast-slide-out-down" };
  }
  // fallback
  return { enter: "th-toast-slide-in-right", exit: "th-toast-slide-out-right" };
};

type ToastViewportProps = {
  toasts: ToastInternal[];
  position: NonNullable<NotificationProviderProps["position"]>;
  onDismiss: (id: string) => void;
  pauseOnHover: NonNullable<NotificationProviderProps["pauseOnHover"]>;
  reducedMotion: boolean;
  pauseToast: (id: string) => void;
  resumeToast: (id: string) => void;
  renderContainer?: NotificationProviderProps["renderContainer"];
};

type ReanimatedAnimationConfig = {
  duration?: (value: number) => ReanimatedAnimationConfig | undefined;
  easing?: (value: unknown) => ReanimatedAnimationConfig | undefined;
  delay?: (value: number) => ReanimatedAnimationConfig | undefined;
} & Record<string, unknown>;

type ReanimatedSpringConfig = {
  damping?: (value: number) => ReanimatedSpringConfig | undefined;
  stiffness?: (value: number) => ReanimatedSpringConfig | undefined;
} & Record<string, unknown>;

type ReanimatedLayoutConfig = {
  springify?: () => ReanimatedSpringConfig | undefined;
} & Record<string, unknown>;

type ReanimatedBridge = {
  default?: {
    createAnimatedComponent?: (
      component: typeof Stack,
    ) => ComponentType<StackProps>;
  };
  createAnimatedComponent?: (
    component: typeof Stack,
  ) => ComponentType<StackProps>;
  FadeInDown?: ReanimatedAnimationConfig;
  FadeOutUp?: ReanimatedAnimationConfig;
  SlideInRight?: ReanimatedAnimationConfig;
  SlideOutRight?: ReanimatedAnimationConfig;
  SlideInLeft?: ReanimatedAnimationConfig;
  SlideOutLeft?: ReanimatedAnimationConfig;
  Layout?: ReanimatedLayoutConfig;
};

type ToastTone = IntentVariant;

const getToastTokens = getNotificationToneTokens;

const toastVariantToneMap: Record<ToastVariant, ToastTone> = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
  neutral: "neutral",
};

const toastToneLabels: Record<ToastTone, string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  danger: "Alert",
  error: "Error",
  neutral: "Notice",
};

const toastIntentBadgeMap: Record<
  ToastIntent,
  { label: string; tone: IntentVariant }
> = {
  system: { label: "System", tone: "neutral" },
  user: { label: "User action", tone: "info" },
  network: { label: "Network", tone: "warning" },
  payment: { label: "Payment", tone: "danger" },
  success: { label: "Success", tone: "success" },
};

type LucideGlyph = typeof Info;

const toastToneIconMap: Record<ToastTone, LucideGlyph> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: ShieldAlert,
  error: ShieldAlert,
  neutral: Bell,
};

const toastIconLibrary: Record<string, LucideGlyph> = {
  info: Info,
  information: Info,
  success: CheckCircle2,
  check: CheckCircle2,
  confirm: CheckCircle2,
  warning: AlertTriangle,
  alert: AlertTriangle,
  danger: ShieldAlert,
  error: ShieldAlert,
  payment: ShieldAlert,
  shield: ShieldAlert,
  notice: Bell,
  bell: Bell,
};

const resolveToastTone = (variant?: ToastVariant): ToastTone => {
  if (!variant) {
    return "info";
  }
  return toastVariantToneMap[variant] ?? "info";
};

const resolveToneLabel = (tone: ToastTone): string =>
  toastToneLabels[tone] ?? toastToneLabels.info;

const resolveReanimatedBridge = (): ReanimatedBridge | null => {
  if (typeof globalThis === "undefined") {
    return null;
  }
  const bridge = (globalThis as { __TH_REANIMATED__?: ReanimatedBridge })
    .__TH_REANIMATED__;
  return bridge ?? null;
};

const configureAnimation = (
  config: ReanimatedAnimationConfig | undefined,
  durationMs: number,
  easingToken: unknown,
) => {
  if (!config) {
    return undefined;
  }
  let result: ReanimatedAnimationConfig | undefined = config;
  // NOTE: `react-native-reanimated` layout presets expose fluent builders like
  // `duration(ms)`, `easing(token)`, and `delay(ms)`. On web we sometimes bridge
  // these presets (or stub them) and want to be resilient to missing pieces.
  try {
    if (typeof result?.duration === "function") {
      result = result.duration(durationMs) ?? result;
    }
  } catch {
    // ignore bridge configuration errors
  }
  try {
    if (typeof result?.easing === "function") {
      result = result.easing(easingToken) ?? result;
    }
  } catch {
    // ignore bridge configuration errors
  }
  try {
    // Default to 0ms delay; some bridged configs accidentally resolve to
    // `undefined` between calls, so keep returning the last known good config.
    if (typeof result?.delay === "function") {
      result = result.delay(0) ?? result;
    }
  } catch {
    // ignore bridge configuration errors
  }
  return result;
};

const configureLayout = (config: ReanimatedLayoutConfig | undefined) => {
  if (!config) {
    return undefined;
  }
  let result: ReanimatedLayoutConfig | ReanimatedSpringConfig | undefined =
    config;
  try {
    const spring = config.springify?.();
    if (spring) {
      result = spring;
      const { damping, stiffness } = motionTokens.spring.base;
      if (typeof spring.damping === "function") {
        result = spring.damping(damping) ?? result;
      }
      if (typeof spring.stiffness === "function") {
        result = spring.stiffness(stiffness) ?? result;
      }
    }
  } catch {
    // ignore bridge configuration errors
  }
  return result;
};

const ViewportFrame = styled(YStack, {
  name: "ToastViewportFrame",
  pointerEvents: "box-none",
  gap: "$3",
  maxWidth: 360,
  width: "100%",
});

interface ToastFrameProps extends StackProps {
  tone?: ToastTone;
}

const AccentStripe = styled(Stack, {
  name: "ToastAccentStripe",
  position: "absolute",
  left: 0,
  top: 12,
  bottom: 12,
  width: 4,
  borderRadius: 0,
  pointerEvents: "none",
});

const IconBadge = styled(Stack, {
  name: "ToastIconBadge",
  width: 32,
  height: 32,
  borderRadius: 0,
  borderWidth: 2,
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
});

const ToastFrame = ({ tone = "info", ...props }: ToastFrameProps) => {
  const tokens = getToastTokens(tone);
  return (
    <YStack
      backgroundColor={tokens.frameBackground}
      borderColor={tokens.frameBorder}
      borderWidth={2}
      borderRadius={0}
      padding="$4"
      paddingLeft="$5"
      gap="$3"
      position="relative"
      {...props}
    >
      <AccentStripe backgroundColor={tokens.accent} />
      {props.children}
    </YStack>
  );
};

const ToastHeader = ({
  title,
  count,
  tone,
  intent,
  iconName,
  onDismiss,
}: {
  title?: string;
  count: number;
  tone: ToastTone;
  intent: ToastIntent;
  iconName?: string;
  onDismiss?: () => void;
}) => {
  const intentBadge = toastIntentBadgeMap[intent];
  const toneLabel = resolveToneLabel(tone);
  const tokens = getToastTokens(tone);
  const normalizedIcon = iconName?.trim().toLowerCase();
  const allowIcon = normalizedIcon !== "none";
  const IconComponent = allowIcon
    ? normalizedIcon && toastIconLibrary[normalizedIcon]
      ? toastIconLibrary[normalizedIcon]
      : toastToneIconMap[tone]
    : null;

  return (
    <XStack gap="$3" alignItems="flex-start" justifyContent="space-between">
      <XStack gap="$2" alignItems="flex-start" flex={1} minWidth={0}>
        {IconComponent ? (
          <IconBadge
            backgroundColor={tokens.iconBackground}
            borderColor={tokens.iconBorder}
          >
            <IconComponent
              size={18}
              strokeWidth={1.75}
              color={tokens.iconColor}
            />
          </IconBadge>
        ) : null}
        <YStack flex={1} gap="$2" minWidth={0}>
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            {intentBadge ? (
              <Badge size="xs" tone={intentBadge.tone} variant="outline">
                {intentBadge.label}
              </Badge>
            ) : null}
            <Badge size="xs" tone={tone} variant="soft">
              {toneLabel}
            </Badge>
          </XStack>
          {title ? (
            <Text
              variant="body"
              weight="bold"
              lineHeight={20}
              color={tokens.textPrimary}
            >
              {title}
            </Text>
          ) : null}
        </YStack>
      </XStack>
      <XStack gap="$2" alignItems="center" flexShrink={0}>
        {count > 1 ? (
          <Badge tone="neutral" size="xs" variant="solid">
            ×{count}
          </Badge>
        ) : null}
        {onDismiss ? (
          <Button
            size="$1"
            icon
            variant="ghost"
            aria-label="Dismiss notification"
            data-th={TOAST_CLOSE_ATTRIBUTE}
            onPress={onDismiss}
          >
            <X size={14} strokeWidth={2} color={tokens.textSecondary} />
          </Button>
        ) : null}
      </XStack>
    </XStack>
  );
};

const ToastBody = ({
  message,
  action,
  onAction,
  tone,
}: {
  message?: string;
  action?: ToastInternal["action"];
  onAction?: () => void;
  tone: ToastTone;
}) => {
  const tokens = getToastTokens(tone);
  return (
    <YStack gap="$3">
      {message ? (
        <Text variant="bodySmall" color={tokens.textSecondary} lineHeight={20}>
          {message}
        </Text>
      ) : null}
      {action ? (
        <XStack
          gap="$2"
          alignItems="center"
          justifyContent="flex-end"
          flexWrap="wrap"
        >
          <Button
            size="$2"
            variant="ghost"
            onPress={onAction}
            data-th={TOAST_ACTION_ATTRIBUTE}
          >
            {action.label}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
};

type AnimatedStackProps = StackProps & {
  entering?: unknown;
  exiting?: unknown;
  layout?: unknown;
};

type AnimatedStackResult = {
  Component: ComponentType<StackProps> | typeof Stack;
  props: AnimatedStackProps;
  useCssFallback: boolean;
  cssAnimations: { enter: CssAnimationName; exit: CssAnimationName } | null;
};

const getAnimationBuildersForPosition = (
  bridge: ReanimatedBridge,
  position: ToastPosition,
) => {
  const isRightAligned = position.includes("right");
  const isLeftAligned = position.includes("left");
  const isCenter = position === "middle-center";

  if (isCenter) {
    // Center position uses fade for a subtle effect
    return {
      enter: bridge.FadeInDown,
      exit: bridge.FadeOutUp,
    };
  }
  if (isRightAligned) {
    return {
      enter: bridge.SlideInRight ?? bridge.FadeInDown,
      exit: bridge.SlideOutRight ?? bridge.FadeOutUp,
    };
  }
  if (isLeftAligned) {
    return {
      enter: bridge.SlideInLeft ?? bridge.FadeInDown,
      exit: bridge.SlideOutLeft ?? bridge.FadeOutUp,
    };
  }
  // top-center, bottom-center use vertical fade
  return {
    enter: bridge.FadeInDown,
    exit: bridge.FadeOutUp,
  };
};

const useAnimatedStack = (
  reducedMotion: boolean,
  position: ToastPosition,
): AnimatedStackResult => {
  return useMemo(() => {
    if (reducedMotion) {
      return {
        Component: Stack,
        props: {} as AnimatedStackProps,
        useCssFallback: false,
        cssAnimations: null,
      };
    }

    // On web, always use CSS animations for reliability
    // react-native-reanimated animations on web can be inconsistent
    if (Platform.OS === "web") {
      injectCssAnimations();
      return {
        Component: Stack,
        props: {} as AnimatedStackProps,
        useCssFallback: true,
        cssAnimations: getCssAnimationsForPosition(position),
      };
    }

    // On native, try to use reanimated
    const bridge = resolveReanimatedBridge();
    if (!bridge) {
      return {
        Component: Stack,
        props: {} as AnimatedStackProps,
        useCssFallback: false,
        cssAnimations: null,
      };
    }

    const AnimatedComponent =
      bridge.createAnimatedComponent?.(Stack) ??
      bridge.default?.createAnimatedComponent?.(Stack) ??
      Stack;

    const { enter, exit } = getAnimationBuildersForPosition(bridge, position);
    const entering = configureAnimation(
      enter,
      motionTokens.duration.base,
      motionTokens.easing.easeOut,
    );
    const exiting = configureAnimation(
      exit,
      motionTokens.duration.fast,
      motionTokens.easing.easeIn,
    );
    const layout = configureLayout(bridge.Layout);

    return {
      Component: AnimatedComponent ?? Stack,
      props: {
        ...(entering ? { entering } : {}),
        ...(exiting ? { exiting } : {}),
        ...(layout ? { layout } : {}),
      } as AnimatedStackProps,
      useCssFallback: false,
      cssAnimations: null,
    };
  }, [position, reducedMotion]);
};

const getPositionStyle = (position: ToastPosition): StackProps["style"] => {
  switch (position) {
    case "top-left":
      return {
        top: 16,
        left: 16,
        alignItems: "flex-start",
      };
    case "top-center":
      return {
        top: 16,
        left: "50%",
        transform: [{ translateX: "-50%" }],
        alignItems: "center",
      };
    case "middle-left":
      return {
        top: "50%",
        left: 16,
        transform: [{ translateY: "-50%" }],
        alignItems: "flex-start",
      };
    case "middle-center":
      return {
        top: "50%",
        left: "50%",
        transform: [{ translateX: "-50%" }, { translateY: "-50%" }],
        alignItems: "center",
      };
    case "middle-right":
      return {
        top: "50%",
        right: 16,
        transform: [{ translateY: "-50%" }],
        alignItems: "flex-end",
      };
    case "bottom-left":
      return {
        bottom: 16,
        left: 16,
        alignItems: "flex-start",
      };
    case "bottom-center":
      return {
        bottom: 16,
        left: "50%",
        transform: [{ translateX: "-50%" }],
        alignItems: "center",
      };
    case "bottom-right":
      return {
        bottom: 16,
        right: 16,
        alignItems: "flex-end",
      };
    case "top-right":
    default:
      return {
        top: 16,
        right: 16,
        alignItems: "flex-end",
      };
  }
};

const createDataAttributes = (attrs?: ToastInternal["dataAttrs"]) => {
  if (!attrs) {
    return {} as Record<string, string>;
  }
  return Object.entries(attrs).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (typeof value === "string" && value.length > 0) {
        const attrKey = key.startsWith("data-") ? key : `data-${key}`;
        acc[attrKey] = value;
      }
      return acc;
    },
    {},
  );
};

const ToastItem = memo(
  ({
    toast,
    onDismiss,
    pauseOnHover,
    reducedMotion,
    pauseToast,
    resumeToast,
    position,
  }: {
    toast: ToastInternal;
    onDismiss: (id: string) => void;
    pauseOnHover: boolean;
    reducedMotion: boolean;
    pauseToast: (id: string) => void;
    resumeToast: (id: string) => void;
    position: ToastPosition;
  }) => {
    const tone = resolveToastTone(toast.variant);
    const shouldPause = pauseOnHover && Platform.OS === "web";
    const {
      Component,
      props: animatedProps,
      useCssFallback,
      cssAnimations,
    } = useAnimatedStack(reducedMotion, position);
    const dataAttributes = useMemo(
      () => createDataAttributes(toast.dataAttrs),
      [toast.dataAttrs],
    );
    const ariaLive = toast.variant === "danger" ? "assertive" : "polite";

    const handlePointerEnter = useCallback(() => {
      if (!shouldPause) {
        return;
      }
      pauseToast(toast.id);
    }, [pauseToast, shouldPause, toast.id]);

    const handlePointerLeave = useCallback(() => {
      if (!shouldPause) {
        return;
      }
      resumeToast(toast.id);
    }, [resumeToast, shouldPause, toast.id]);

    const handleAction = useCallback(() => {
      toast.action?.onPress();
    }, [toast.action]);

    const handleDismiss = useCallback(() => {
      onDismiss(toast.id);
    }, [onDismiss, toast.id]);

    const handlePressIn = useCallback(() => {
      if (Platform.OS === "web") {
        return;
      }
      pauseToast(toast.id);
    }, [pauseToast, toast.id]);

    const handlePressOut = useCallback(() => {
      if (Platform.OS === "web") {
        return;
      }
      resumeToast(toast.id);
    }, [resumeToast, toast.id]);

    const animatedPropsForComponent = Component === Stack ? {} : animatedProps;

    // Build CSS animation style if using fallback
    const cssAnimationStyle = useMemo(() => {
      if (!useCssFallback || !cssAnimations) {
        return {};
      }
      const durationMs = motionTokens.duration.base;
      const easing = motionTokens.easing.easeOut;
      return {
        animation: `${cssAnimations.enter} ${durationMs}ms ${easing} forwards`,
      };
    }, [useCssFallback, cssAnimations]);

    return (
      <Component
        position="relative"
        width="100%"
        style={{
          pointerEvents: "auto",
          ...(useCssFallback ? cssAnimationStyle : {}),
        }}
        {...animatedPropsForComponent}
      >
        <ToastFrame
          tone={tone}
          role={toast.variant === "danger" ? "alert" : "status"}
          aria-live={ariaLive}
          data-th={TOAST_DATA_ATTRIBUTE}
          {...dataAttributes}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
        >
          <ToastHeader
            title={toast.title}
            count={toast.count}
            tone={tone}
            intent={toast.intent}
            iconName={toast.iconName}
            onDismiss={handleDismiss}
          />
          <ToastBody
            message={toast.message}
            action={toast.action}
            onAction={toast.action ? handleAction : undefined}
            tone={tone}
          />
        </ToastFrame>
      </Component>
    );
  },
);

ToastItem.displayName = "ToastItem";

export const ToastViewport = memo(
  ({
    toasts,
    position,
    onDismiss,
    pauseOnHover,
    reducedMotion,
    pauseToast,
    resumeToast,
    renderContainer,
  }: ToastViewportProps) => {
    const positionStyle = useMemo(() => {
      const result: Record<string, unknown> = {
        position: Platform.OS === "web" ? "fixed" : "absolute",
        zIndex: 1600,
      };
      Object.assign(result, getPositionStyle(position));
      return result;
    }, [position]);

    const content = (
      <ViewportFrame
        style={positionStyle}
        alignItems={position.includes("center") ? "center" : undefined}
      >
        {toasts.map((toast) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            onDismiss={onDismiss}
            pauseOnHover={pauseOnHover}
            reducedMotion={reducedMotion}
            pauseToast={pauseToast}
            resumeToast={resumeToast}
            position={position}
          />
        ))}
      </ViewportFrame>
    );

    return renderContainer ? renderContainer(content) : content;
  },
);

ToastViewport.displayName = "ToastViewport";
