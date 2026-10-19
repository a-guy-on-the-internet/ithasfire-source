import {
  createElement,
  forwardRef,
  useImperativeHandle,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * Minimal jsdom stand-in for `react-native`, for RENDER tests of this package.
 *
 * ## Why a stub and not the real module
 *
 * `react-native` ships Flow-typed source that Vite cannot parse, and the repo
 * has no `react-test-renderer` / `@testing-library/react-native` installed.
 * `packages/ui` solved the identical problem the identical way
 * (`packages/ui/test/stubs/react-native.ts`); this is the same trick, scoped
 * to the handful of primitives `@th/ui-native` actually uses.
 *
 * ## What these tests can and cannot prove
 *
 * They assert STRUCTURE — which nodes exist, what they are labelled, what they
 * do on press. They cannot assert layout (Yoga is not running), so nothing
 * here should claim a thing about flexbox, clipping or the SE vertical budget.
 * The bug this suite exists to catch was structural: a detail band and a
 * "⌄ MORE" row rendering on states that had no detail.
 *
 * ## No index signature
 *
 * A `[key: string]: unknown` catch-all looks convenient and is a trap:
 * `forwardRef` wraps its props in `PropsWithoutRef<P>`, which becomes
 * `Omit<P, "ref">` the moment `"ref" extends keyof P` — true for any type with
 * a string index signature — and `Omit` over such a type discards every NAMED
 * property, so `props.children` degrades to `unknown`. Props are therefore
 * listed explicitly.
 */

type Style = CSSProperties | false | null | undefined;
type AnyStyle = Style | Style[] | AnyStyle[];

const flatten = (style: AnyStyle): CSSProperties =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten))
    : ((style || {}) as CSSProperties);

type LayoutEvent = {
  nativeEvent: {
    layout: { x: number; y: number; width: number; height: number };
  };
};

type BaseProps = {
  children?: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: string;
  accessibilityLiveRegion?: string;
  accessibilityState?: Record<string, unknown>;
  accessible?: boolean;
  pointerEvents?: string;
  style?: AnyStyle;
  onLayout?: (e: LayoutEvent) => void;
  "aria-hidden"?: boolean;
};

const domProps = (props: BaseProps): Record<string, unknown> => {
  const out: Record<string, unknown> = { style: flatten(props.style) };
  if (props.testID != null) out["data-testid"] = props.testID;
  if (props.accessibilityLabel != null) {
    out["aria-label"] = props.accessibilityLabel;
  }
  if (props.accessibilityHint != null) {
    out["data-a11y-hint"] = props.accessibilityHint;
  }
  if (props.accessibilityRole != null) {
    out["data-a11y-role"] = props.accessibilityRole;
  }
  if (props.accessibilityLiveRegion != null) {
    out["aria-live"] = props.accessibilityLiveRegion;
  }
  if (props.accessibilityState?.disabled) out["aria-disabled"] = true;
  if (props["aria-hidden"]) out["aria-hidden"] = true;
  return out;
};

export const View = forwardRef<HTMLDivElement, BaseProps>((props, ref) =>
  createElement("div", { ...domProps(props), ref }, props.children),
);
View.displayName = "ViewStub";

export const Text = forwardRef<
  HTMLSpanElement,
  BaseProps & { numberOfLines?: number }
>((props, ref) =>
  createElement(
    "span",
    { ...domProps(props), ref, "data-lines": props.numberOfLines },
    props.children,
  ),
);
Text.displayName = "TextStub";

type PressableProps = BaseProps & {
  onPress?: () => void;
  disabled?: boolean;
  hitSlop?: unknown;
};

export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(
  (props, ref) =>
    createElement(
      "button",
      {
        ...domProps(props),
        ref,
        type: "button",
        disabled: props.disabled,
        onClick: props.onPress,
      },
      props.children,
    ),
);
Pressable.displayName = "PressableStub";

export type ScrollViewHandle = {
  scrollTo: (opts: { y?: number; animated?: boolean }) => void;
};

/** Test-only spy: every `scrollTo` call made through the stub, in order. */
export const scrollCalls: Array<{ y?: number; animated?: boolean }> = [];

export const ScrollView = forwardRef<
  ScrollViewHandle,
  BaseProps & {
    contentContainerStyle?: AnyStyle;
    keyboardShouldPersistTaps?: string;
  }
>((props, ref) => {
  useImperativeHandle(ref, () => ({
    scrollTo: (opts) => {
      scrollCalls.push(opts);
    },
  }));
  return createElement("div", domProps(props), props.children);
});
ScrollView.displayName = "ScrollViewStub";

/**
 * Minimal `Animated` stand-in.
 *
 * It does NOT animate: it holds a value, lets `interpolate` map it through a
 * piecewise-linear range, and records that a timing was started (and whether
 * it was stopped). A started timing never moves its value. That is enough for
 * the only things a jsdom test can honestly assert — the express dwell rule
 * EXISTS and is full-width when frozen or static, a hold does not restart it,
 * and the verdict stamp starts at its 0% keyframe, rests at its final frame
 * under reduced motion, and replays only on a new key. Whether the motion
 * LOOKS right is a device question, not a jsdom one.
 *
 * `interpolate` is evaluated when it is called (at render), not live, so a
 * test that needs a value after an effect reads the `AnimatedValue` itself —
 * `timingCalls[i].value.getValue()`.
 */
type InterpolateConfig = {
  inputRange: number[];
  outputRange: Array<string | number>;
  extrapolate?: string;
};

export class AnimatedValue {
  constructor(private value: number) {}
  setValue(next: number): void {
    this.value = next;
  }
  stopAnimation(): void {
    // No RAF loop to stop — the value simply stays where it is.
  }
  /** Test-only accessor. */
  getValue(): number {
    return this.value;
  }
  interpolate(config: InterpolateConfig): string | number {
    // Pick the segment the value falls in (clamped at both ends), then map
    // linearly within it — two stops behave exactly as before.
    const ins = config.inputRange;
    let i = 0;
    while (i < ins.length - 2 && this.value > (ins[i + 1] ?? 1)) i += 1;
    const inLo = ins[i] ?? 0;
    const inHi = ins[i + 1] ?? 1;
    const outLo = config.outputRange[i] ?? 0;
    const outHi = config.outputRange[i + 1] ?? 1;
    const span = inHi - inLo || 1;
    const t = Math.min(1, Math.max(0, (this.value - inLo) / span));
    if (typeof outLo === "string" || typeof outHi === "string") {
      const num = (v: string | number) =>
        typeof v === "number" ? v : Number.parseFloat(v);
      const unit = typeof outHi === "string" ? outHi.replace(/[\d.-]/g, "") : "";
      return `${num(outLo) + (num(outHi) - num(outLo)) * t}${unit}`;
    }
    return outLo + (outHi - outLo) * t;
  }
}

type TimingConfig = {
  toValue: number;
  duration?: number;
  easing?: (t: number) => number;
  useNativeDriver?: boolean;
};

/** Test-only spy: every timing created through the stub, in order. */
export const timingCalls: Array<
  TimingConfig & { value: AnimatedValue; stopped: boolean }
> = [];

type Anim = {
  start: (cb?: (r: { finished: boolean }) => void) => void;
  stop: () => void;
};

const composite = (anims: Anim[]): Anim => ({
  start: (cb) => {
    anims.forEach((a) => a.start());
    cb?.({ finished: true });
  },
  stop: () => anims.forEach((a) => a.stop()),
});

/** An `AnimatedValue` in a style resolves to its current number. */
const resolveStyle = (style: CSSProperties): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(style)) {
    out[k] = v instanceof AnimatedValue ? v.getValue() : v;
  }
  return out;
};

export const Animated = {
  Value: AnimatedValue,
  View: forwardRef<HTMLDivElement, BaseProps>((props, ref) => {
    const { transform, ...style } = resolveStyle(flatten(props.style));
    return createElement(
      "div",
      {
        ...domProps(props),
        style,
        ref,
        // Surface the resolved width so a test can read it without touching
        // jsdom's CSS parser (which rejects an interpolated object outright).
        "data-width": String((style as { width?: unknown }).width ?? ""),
        "data-opacity":
          style.opacity == null ? undefined : String(style.opacity),
        // RN's transform is an array of objects, which no DOM style accepts.
        "data-transform":
          transform == null ? undefined : JSON.stringify(transform),
      },
      props.children,
    );
  }),
  timing: (value: AnimatedValue, config: TimingConfig): Anim => {
    const call = { ...config, value, stopped: false };
    timingCalls.push(call);
    return {
      start: (cb) => {
        cb?.({ finished: true });
      },
      stop: () => {
        call.stopped = true;
      },
    };
  },
  delay: (_ms: number): Anim => ({
    start: (cb) => cb?.({ finished: true }),
    stop: () => {},
  }),
  parallel: composite,
  sequence: composite,
};

/** Curves are identity here — the stub never runs them. */
export const Easing = {
  linear: (t: number) => t,
  bezier: (_x1: number, _y1: number, _x2: number, _y2: number) => (t: number) =>
    t,
};

export const StyleSheet = {
  create: <T extends Record<string, CSSProperties>>(styles: T): T => styles,
  flatten,
  hairlineWidth: 1,
  absoluteFillObject: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  } as CSSProperties,
  absoluteFill: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  } as CSSProperties,
};

export const Platform = {
  OS: "ios" as const,
  select: (spec: Record<string, unknown>): unknown =>
    spec.ios ?? spec.native ?? spec.default,
};

export const useWindowDimensions = () => ({ width: 375, height: 667 });

/** Test-only spy: everything announced through the stub, in order. */
export const announcements: string[] = [];

export const AccessibilityInfo = {
  announceForAccessibility: (message: string) => {
    announcements.push(message);
  },
};
