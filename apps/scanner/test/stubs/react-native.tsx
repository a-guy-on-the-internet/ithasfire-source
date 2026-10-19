import {
  createElement,
  forwardRef,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * jsdom stand-in for `react-native`, for the scanner's SCREEN tests.
 *
 * It EXTENDS `@th/ui-native`'s stub rather than copying it: `View`, `Text`,
 * `Pressable`, `ScrollView`, `Animated` and `StyleSheet` come from there
 * unchanged, so the two packages' render tests agree on what a primitive
 * turns into. Only what the scanner's screen tree uses on top of that is
 * added here.
 *
 * Same limit as the original: these tests prove STRUCTURE and BEHAVIOUR
 * (what text is on screen, what fired, in what order), never layout.
 */
export {
  Animated,
  AnimatedValue,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "../../../../packages/ui-native/test/stubs/react-native";

/**
 * Every announcement the screen tree made, in order. Replaces the shared
 * stub's array so each test can reset it (see `test/harness/setup.ts`).
 */
export const announcements: string[] = [];

export const AccessibilityInfo = {
  announceForAccessibility: (message: string) => {
    announcements.push(message);
  },
  isScreenReaderEnabled: async () => false,
  isReduceMotionEnabled: async () => false,
  addEventListener: () => ({ remove: () => {} }),
};

type Style = CSSProperties | false | null | undefined;
type AnyStyle = Style | Style[] | AnyStyle[];

const flatten = (style: AnyStyle): CSSProperties =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten))
    : ((style || {}) as CSSProperties);

type PressState = { pressed: boolean };

type PressableProps = {
  children?: ReactNode | ((state: PressState) => ReactNode);
  style?: AnyStyle | ((state: PressState) => AnyStyle);
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  disabled?: boolean | null;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: string;
  accessibilityState?: { disabled?: boolean | null };
  accessibilityLiveRegion?: string;
};

/**
 * Replaces the shared stub's `Pressable`, which renders `children` and
 * `style` as given. `@th/ui-native`'s square buttons and the search rows pass
 * RN's `({ pressed }) => …` render functions for both, which React cannot
 * render. Those are resolved here with `pressed: false`. `onPressIn` and
 * `onPressOut` map to pointer down and up (the express dwell's hold).
 *
 * `disabled` OR `accessibilityState.disabled` → `aria-disabled`, and the
 * press is swallowed, as on device.
 */
export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(
  (props, ref) => {
    const state = { pressed: false };
    const inert = !!props.disabled || !!props.accessibilityState?.disabled;
    const style =
      typeof props.style === "function" ? props.style(state) : props.style;
    return createElement(
      "button",
      {
        ref,
        type: "button",
        style: flatten(style),
        "data-testid": props.testID,
        "aria-label": props.accessibilityLabel,
        "data-a11y-hint": props.accessibilityHint,
        "data-a11y-role": props.accessibilityRole,
        "aria-live": props.accessibilityLiveRegion,
        "aria-disabled": inert || undefined,
        disabled: !!props.disabled,
        onClick: inert ? undefined : props.onPress,
        onPointerDown: inert ? undefined : props.onPressIn,
        onPointerUp: inert ? undefined : props.onPressOut,
      },
      typeof props.children === "function"
        ? props.children(state)
        : props.children,
    );
  },
);
Pressable.displayName = "ScannerPressableStub";

export const ActivityIndicator = (_props: { color?: string }) =>
  createElement("span", { "data-testid": "activity-indicator" });

export const KeyboardAvoidingView = (props: {
  children?: ReactNode;
  style?: AnyStyle;
  behavior?: string;
}) => createElement("div", null, props.children);

export const Modal = (props: { children?: ReactNode; visible?: boolean }) =>
  props.visible ? createElement("div", null, props.children) : null;

type TextInputProps = {
  value?: string;
  onChangeText?: (text: string) => void;
  onSubmitEditing?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  testID?: string;
  accessibilityLabel?: string;
  style?: AnyStyle;
  autoFocus?: boolean;
};

/**
 * A controlled `<input>`. `onChangeText` gets the string, and Enter fires
 * `onSubmitEditing`, which is all the scanner's code-entry and search fields
 * use.
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  (props, ref) =>
    createElement("input", {
      ref,
      value: props.value ?? "",
      placeholder: props.placeholder,
      "data-testid": props.testID,
      "aria-label": props.accessibilityLabel,
      onChange: (e: { target: { value: string } }) =>
        props.onChangeText?.(e.target.value),
      onKeyDown: (e: { key: string }) => {
        if (e.key === "Enter") props.onSubmitEditing?.();
      },
      onFocus: props.onFocus,
      onBlur: props.onBlur,
    }),
);
TextInput.displayName = "TextInputStub";

export const Linking = {
  openSettings: async () => {},
  openURL: async (_url: string) => {},
};

export const Easing = {
  linear: (t: number) => t,
  ease: (t: number) => t,
  out: (f: (t: number) => number) => f,
  in: (f: (t: number) => number) => f,
  inOut: (f: (t: number) => number) => f,
  cubic: (t: number) => t,
  quad: (t: number) => t,
  bezier: (_x1: number, _y1: number, _x2: number, _y2: number) => (t: number) =>
    t,
};

export const AppState = {
  currentState: "active",
  addEventListener: () => ({ remove: () => {} }),
};

export const Dimensions = {
  get: () => ({ width: 375, height: 667, scale: 2, fontScale: 1 }),
  addEventListener: () => ({ remove: () => {} }),
};

/** Types the screen tree imports. Erased at runtime; listed for `tsc`. */
export type LayoutChangeEvent = {
  nativeEvent: {
    layout: { x: number; y: number; width: number; height: number };
  };
};
export type StyleProp<T> = T | T[] | null | undefined | false;
export type ViewStyle = CSSProperties;
