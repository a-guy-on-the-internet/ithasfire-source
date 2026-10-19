import type {
  ComponentType,
  CSSProperties,
  HTMLAttributes,
  MutableRefObject,
  PropsWithChildren,
  UIEventHandler,
} from "react";
import { createElement, forwardRef } from "react";

const Platform = {
  OS: "web" as const,
  select<T extends Record<string, unknown>>(spec: T): T[keyof T] | undefined {
    if (!spec) return undefined;
    if (Object.prototype.hasOwnProperty.call(spec, Platform.OS)) {
      return spec[Platform.OS as keyof T] as T[keyof T];
    }
    if (Object.prototype.hasOwnProperty.call(spec, "native")) {
      return spec.native as T[keyof T];
    }
    return spec.default as T[keyof T];
  },
};

type ViewProps = PropsWithChildren<
  {
    testID?: string;
    accessibilityLabel?: string;
    accessible?: boolean;
    style?: CSSProperties | Array<CSSProperties | false | null | undefined>;
    onLayout?: (event: {
      nativeEvent: { layout: { width: number; height: number } };
    }) => void;
  } & Omit<HTMLAttributes<HTMLDivElement>, "style">
>;

// Minimal View mock — a div that maps the RN props our components rely on
// (testID → data-testid, accessibilityLabel → aria-label) and strips the
// rest so React doesn't warn about unknown DOM attributes.
const View = forwardRef<HTMLDivElement, ViewProps>((props, forwardedRef) => {
  const {
    children,
    testID,
    accessibilityLabel,
    accessible: _accessible,
    onLayout,
    style,
    ...rest
  } = props;

  const assignRef = (node: HTMLDivElement | null) => {
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef) {
      (forwardedRef as MutableRefObject<HTMLDivElement | null>).current = node;
    }
    if (node && onLayout) {
      onLayout({
        nativeEvent: {
          layout: { width: node.clientWidth, height: node.clientHeight },
        },
      });
    }
  };

  const domProps: Record<string, unknown> = {
    ...rest,
    ref: assignRef,
    style: Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean))
      : style,
  };
  if (testID != null) domProps["data-testid"] = testID;
  if (accessibilityLabel != null) domProps["aria-label"] = accessibilityLabel;

  return createElement("div", domProps, children);
});

View.displayName = "ViewMock";

type ScrollViewProps = PropsWithChildren<
  {
    horizontal?: boolean;
    nestedScrollEnabled?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    contentContainerStyle?: CSSProperties;
    onScroll?: (event: {
      nativeEvent: {
        contentOffset: { x: number; y: number };
        layoutMeasurement?: { width: number; height: number };
        contentSize?: { width: number; height: number };
      };
    }) => void;
    onLayout?: (event: {
      nativeEvent: { layout: { width: number; height: number } };
    }) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    scrollEventThrottle?: number;
  } & HTMLAttributes<HTMLDivElement>
>;

const ScrollView = forwardRef<HTMLDivElement, ScrollViewProps>(
  (props, forwardedRef) => {
    const {
      children,
      horizontal,
      nestedScrollEnabled: _nestedScrollEnabled,
      showsHorizontalScrollIndicator: _showsHorizontalScrollIndicator,
      scrollEventThrottle: _scrollEventThrottle,
      contentContainerStyle,
      onScroll,
      onLayout,
      onContentSizeChange,
      style,
      ...rest
    } = props;

    const assignRef = (node: HTMLDivElement | null) => {
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        (forwardedRef as MutableRefObject<HTMLDivElement | null>).current =
          node;
      }
      if (node) {
        const width = node.clientWidth;
        const height = node.clientHeight;
        onLayout?.({ nativeEvent: { layout: { width, height } } });
        onContentSizeChange?.(node.scrollWidth, node.scrollHeight);
      }
    };

    const handleScroll: UIEventHandler<HTMLDivElement> | undefined = onScroll
      ? (event) => {
          onScroll({
            nativeEvent: {
              contentOffset: {
                x: event.currentTarget.scrollLeft,
                y: event.currentTarget.scrollTop,
              },
              layoutMeasurement: {
                width: event.currentTarget.clientWidth,
                height: event.currentTarget.clientHeight,
              },
              contentSize: {
                width: event.currentTarget.scrollWidth,
                height: event.currentTarget.scrollHeight,
              },
            },
          });
        }
      : undefined;

    const containerStyle: CSSProperties = {
      display: "flex",
      flexDirection: horizontal ? "row" : "column",
      overflowX: horizontal ? "auto" : undefined,
      overflowY: horizontal ? undefined : "auto",
      WebkitOverflowScrolling: "touch",
      ...style,
    };

    return createElement(
      "div",
      {
        ...rest,
        ref: assignRef,
        onScroll: handleScroll,
        style: containerStyle,
      },
      createElement("div", { style: contentContainerStyle }, children),
    );
  },
);

ScrollView.displayName = "ScrollViewMock";

type AnimationHandle = {
  start: (callback?: (result: { finished: boolean }) => void) => void;
  stop: () => void;
};

const createAnimationHandle = (onStart?: () => void): AnimationHandle => ({
  start: (callback) => {
    onStart?.();
    callback?.({ finished: true });
  },
  stop: () => {
    /* no-op */
  },
});

class AnimatedValue {
  private current: number;

  constructor(initial: number) {
    this.current = initial;
  }

  setValue(next: number) {
    this.current = next;
  }

  stopAnimation(callback?: (value: number) => void) {
    callback?.(this.current);
  }
}

const Animated = {
  Value: AnimatedValue,
  timing: () => createAnimationHandle(),
  sequence: (animations: AnimationHandle[]) =>
    createAnimationHandle(() => {
      animations.forEach((animation) => animation.start());
    }),
  loop: (animation: AnimationHandle) =>
    createAnimationHandle(() => {
      animation.start();
    }),
  createAnimatedComponent: <T extends ComponentType<any>>(Component: T) =>
    Component,
};

const identityEasing = (value: number) => value;
const Easing = {
  linear: identityEasing,
  ease: identityEasing,
  cubic: identityEasing,
  inOut: (_easing: (value: number) => number) => identityEasing,
  out: (_easing: (value: number) => number) => identityEasing,
  bezier: (..._args: number[]) => identityEasing,
};

// Minimal Pressable mock for tests. Maps onPress → onClick and, like the
// View mock above, translates the RN accessibility props our components use
// (accessibilityLabel → aria-label, accessibilityState.selected/disabled →
// aria-*) instead of leaking them onto the DOM as unknown attributes — so
// tests can assert the same accessible semantics react-native-web renders.

type PressableProps = PropsWithChildren<
  {
    onPress?: () => void;
    onPressIn?: () => void;
    onPressOut?: () => void;
    testID?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean; disabled?: boolean };
    accessible?: boolean;
    style?: CSSProperties;
  } & HTMLAttributes<HTMLButtonElement>
>;

const Pressable = forwardRef<HTMLButtonElement, PressableProps>(
  (props, ref) => {
    const {
      onPress,
      onPressIn,
      onPressOut,
      children,
      style,
      testID,
      accessibilityRole: _accessibilityRole, // native <button> already has role button
      accessibilityLabel,
      accessibilityState,
      accessible: _accessible,
      ...rest
    } = props;
    const domProps: Record<string, unknown> = {
      ...rest,
      ref,
      onClick: onPress as any,
      onMouseDown: onPressIn as any,
      onMouseUp: onPressOut as any,
      style,
    };
    if (testID != null) domProps["data-testid"] = testID;
    if (accessibilityLabel != null) domProps["aria-label"] = accessibilityLabel;
    if (accessibilityState?.selected != null) {
      domProps["aria-selected"] = accessibilityState.selected;
    }
    if (accessibilityState?.disabled != null) {
      domProps["aria-disabled"] = accessibilityState.disabled;
    }
    // Use a button so keyboard interaction works in tests
    return createElement("button", domProps, children);
  },
);

Pressable.displayName = "PressableMock";

// StyleSheet mock - just returns the styles as-is
const StyleSheet = {
  create: <T extends Record<string, CSSProperties>>(styles: T): T => styles,
  flatten: <T extends CSSProperties | CSSProperties[]>(
    styles: T,
  ): CSSProperties => {
    if (Array.isArray(styles)) {
      return Object.assign({}, ...styles.filter(Boolean));
    }
    return styles || {};
  },
  absoluteFill: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  absoluteFillObject: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  hairlineWidth: 1,
};

export { Animated, Easing, Platform, ScrollView, Pressable, StyleSheet, View };
export default {
  Animated,
  Easing,
  Platform,
  ScrollView,
  Pressable,
  StyleSheet,
  View,
};
