import {
  forwardRef,
  useEffect,
  useState,
  type ComponentType,
  type PropsWithChildren,
} from "react";

type SharedValue<T> = { value: T };

type AnimatedStyle = Record<string, unknown>;

type FadeConfig = {
  duration?: (value: number) => FadeConfig | undefined;
  easing?: (value: unknown) => FadeConfig | undefined;
  delay?: (value: number) => FadeConfig | undefined;
} & Record<string, unknown>;

type SpringConfig = {
  damping?: (value: number) => SpringConfig | undefined;
  stiffness?: (value: number) => SpringConfig | undefined;
} & Record<string, unknown>;

type LayoutConfig = {
  springify?: () => SpringConfig | undefined;
} & Record<string, unknown>;

const identity = <T,>(value: T): T => value;

type EasingFunction = (value: number) => number;

const easingIdentity: EasingFunction = (value) => value;

const wrapEasing = (fn?: EasingFunction): EasingFunction =>
  typeof fn === "function" ? (value: number) => fn(value) : easingIdentity;

export const Extrapolation = {
  CLAMP: "CLAMP",
  EXTEND: "EXTEND",
  IDENTITY: "IDENTITY",
} as const;

export const interpolate = (
  value: number,
  inputRange: number[],
  outputRange: number[],
): number => {
  if (inputRange.length !== outputRange.length || inputRange.length < 2) {
    throw new Error("Invalid interpolation ranges");
  }

  const lastIndex = inputRange.length - 1;
  const firstValue = inputRange[0]!;
  const lastValue = inputRange[lastIndex]!;

  if (value <= firstValue) {
    return outputRange[0]!;
  }

  if (value >= lastValue) {
    return outputRange[lastIndex]!;
  }

  let segmentIndex = 0;

  for (let i = 0; i < lastIndex; i += 1) {
    const start = inputRange[i]!;
    const end = inputRange[i + 1]!;
    if (value >= start && value <= end) {
      segmentIndex = i;
      break;
    }
  }

  const inputStart = inputRange[segmentIndex]!;
  const inputEnd = inputRange[segmentIndex + 1]!;
  const outputStart = outputRange[segmentIndex]!;
  const outputEnd = outputRange[segmentIndex + 1]!;

  if (inputEnd === inputStart) {
    return outputStart;
  }

  const progress = (value - inputStart) / (inputEnd - inputStart);
  return outputStart + progress * (outputEnd - outputStart);
};

export const useSharedValue = <T,>(initial: T): SharedValue<T> => ({
  value: initial,
});

export const useAnimatedStyle = (
  factory: () => AnimatedStyle,
  _deps?: unknown[],
): AnimatedStyle => factory() ?? {};

/**
 * The completion callback must fire: callers gate teardown on it (e.g.
 * NavigationDrawer only unmounts its full-viewport overlay when the close
 * animation reports finished — dropping the callback leaves an invisible
 * scrim that swallows every click on the page). The shim "animates"
 * instantly, so report completion in a microtask (after the current
 * render/effect, mirroring reanimated's async timing). Always reports
 * finished=true — real reanimated reports false on interruption and fires
 * per-segment inside withSequence/withRepeat; no current caller relies on
 * either.
 */
export const withTiming = <T,>(
  value: T,
  _config?: unknown,
  callback?: (finished: boolean) => void,
): T => {
  if (callback) queueMicrotask(() => callback(true));
  return value;
};

export const withRepeat = <T,>(
  value: T,
  _count?: number,
  _reverse?: boolean,
): T => value;

export const withDelay = <T,>(_delay: number, value: T): T => value;

export const withSequence = <T,>(...values: T[]): T =>
  values[values.length - 1] as T;

export const runOnJS = <T extends (...args: any[]) => any>(fn: T): T => fn;

export const cancelAnimation = <T,>(_value: SharedValue<T>): void => {
  return;
};

const createFadeConfig = (): FadeConfig => ({
  duration: () => undefined,
  easing: () => undefined,
  delay: () => undefined,
});

const createSlideConfig = (): FadeConfig => ({
  duration: () => undefined,
  easing: () => undefined,
  delay: () => undefined,
});

const createLayoutConfig = (): LayoutConfig => ({
  springify: () => ({
    damping: () => undefined,
    stiffness: () => undefined,
  }),
});

export const FadeInDown = createFadeConfig();
export const FadeOutUp = createFadeConfig();
export const SlideInLeft = createSlideConfig();
export const SlideInRight = createSlideConfig();
export const SlideOutLeft = createSlideConfig();
export const SlideOutRight = createSlideConfig();

export const LinearTransition = createLayoutConfig();

export const Easing = {
  linear: easingIdentity,
  cubic: easingIdentity,
  in: (fn?: EasingFunction) => wrapEasing(fn),
  out: (fn?: EasingFunction) => wrapEasing(fn),
  inOut: (fn?: EasingFunction) => wrapEasing(fn),
} as const;

/**
 * Reanimated-only props that mean nothing in the web shim. Strip them
 * before forwarding to a real DOM element / Tamagui component — left
 * intact, they leak through `{...props}` spreads onto `<div>` and cause
 * SSR/client hydration mismatches when React serializes the prop's
 * function/object value differently on the two sides.
 */
const REANIMATED_ONLY_PROPS = new Set([
  "entering",
  "exiting",
  "layout",
  "sharedTransitionTag",
  "sharedTransitionStyle",
  "animatedProps",
]);

const stripReanimatedProps = <P extends Record<string, unknown>>(
  props: P,
): P => {
  // Fast-path: nothing to strip → return original ref so React doesn't see
  // a new props object identity and rebuild downstream memoization.
  let hasAny = false;
  for (const key of REANIMATED_ONLY_PROPS) {
    if (key in props) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return props;
  const out: Record<string, unknown> = {};
  for (const key in props) {
    if (!REANIMATED_ONLY_PROPS.has(key)) out[key] = props[key];
  }
  return out as P;
};

/**
 * Raw-<div> style guard. RN callers pass `style` as (possibly nested)
 * arrays and encode transforms as `[{ translateX: 12 }]`. React DOM
 * assigns array indices straight onto CSSStyleDeclaration — Chrome
 * throws ("Indexed property setter is not supported") — and RN
 * transform arrays are meaningless as CSS. Only the raw-<div> paths
 * need this; the real wrapped component normalizes RN styles itself
 * once mounted.
 */
const TRANSFORM_PX_KEYS = new Set(["translateX", "translateY", "perspective"]);
const TRANSFORM_DEG_KEYS = new Set([
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "skewX",
  "skewY",
]);

const serializeTransformPart = (key: string, value: unknown): string => {
  if (typeof value === "number") {
    if (TRANSFORM_PX_KEYS.has(key)) return `${key}(${value}px)`;
    if (TRANSFORM_DEG_KEYS.has(key)) return `${key}(${value}deg)`;
    return `${key}(${value})`;
  }
  return `${key}(${String(value)})`;
};

const serializeTransform = (transform: unknown[]): string =>
  transform
    .flatMap((entry) =>
      entry && typeof entry === "object"
        ? Object.entries(entry).map(([key, value]) =>
            serializeTransformPart(key, value),
          )
        : [],
    )
    .join(" ");

const mergeStyle = (style: unknown, out: Record<string, unknown>): void => {
  if (!style) return;
  if (Array.isArray(style)) {
    for (const entry of style) mergeStyle(entry, out);
    return;
  }
  if (typeof style === "object") Object.assign(out, style);
};

export const normalizeDomStyle = (
  style: unknown,
): React.CSSProperties | undefined => {
  if (!style || typeof style !== "object") return undefined;
  // Fast-path: a plain object with a non-array transform needs no work —
  // return the original reference so downstream memoization keyed on
  // style identity survives (same pattern as stripReanimatedProps).
  if (!Array.isArray(style)) {
    const { transform } = style as { transform?: unknown };
    if (!Array.isArray(transform)) return style as React.CSSProperties;
  }
  const merged: Record<string, unknown> = {};
  mergeStyle(style, merged);
  if (Array.isArray(merged.transform)) {
    merged.transform = serializeTransform(merged.transform);
  }
  return merged as React.CSSProperties;
};

const AnimatedView = forwardRef<
  HTMLDivElement,
  PropsWithChildren<Record<string, any>>
>(({ children, ...rest }, ref) => {
  const cleaned = stripReanimatedProps(rest);
  return (
    <div ref={ref} {...cleaned} style={normalizeDomStyle(cleaned.style)}>
      {children}
    </div>
  );
});

/**
 * `createAnimatedComponent` defers the wrapped component until after
 * client hydration. SSR + the first client render emit a stable
 * `<div>` placeholder (preserving static `style` + `className` so
 * layout isn't disturbed). After mount, we swap in the real component.
 *
 * Why: the wrapped component (typically a Tamagui/RN-Web primitive)
 * branches on `typeof window` internally — that's exactly the case
 * React's "won't be patched up" hydration error covers. Serving the
 * placeholder during hydration means React only ever sees the dynamic
 * tree during a *post-hydration update*, which is allowed to differ
 * from the server markup.
 */
export const createAnimatedComponent = (
  Component: ComponentType<any>,
): ComponentType<any> =>
  forwardRef<any, any>((props, ref) => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
      setMounted(true);
    }, []);

    const cleaned = stripReanimatedProps(props);

    if (!mounted) {
      // Render only the props that are safe on a vanilla <div>. Anything
      // dynamic (transforms from useAnimatedStyle, RN-only props) is held
      // back until after hydration.
      const { style, className, children } = cleaned as {
        style?: unknown;
        className?: string;
        children?: React.ReactNode;
      };
      return (
        <div
          ref={ref as React.Ref<HTMLDivElement>}
          style={normalizeDomStyle(style)}
          className={className}
          suppressHydrationWarning
        >
          {children}
        </div>
      );
    }

    return <Component {...cleaned} ref={ref} />;
  }) as unknown as ComponentType<any>;

export const Animated = {
  View: AnimatedView,
  createAnimatedComponent,
};

const stub = {
  ...Animated,
  Easing,
  Extrapolation,
  FadeInDown,
  FadeOutUp,
  SlideInLeft,
  SlideInRight,
  SlideOutLeft,
  SlideOutRight,
  LinearTransition,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withRepeat,
  withDelay,
  withSequence,
  runOnJS,
  cancelAnimation,
  createAnimatedComponent,
};
export default stub;
