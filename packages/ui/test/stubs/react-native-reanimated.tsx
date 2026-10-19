import {
  act,
  forwardRef,
  type ComponentType,
  type PropsWithChildren,
} from "react";

type SharedValue<T> = { value: T };

type AnimatedStyle = Record<string, unknown>;

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

export const useAnimatedStyle = (factory: () => AnimatedStyle): AnimatedStyle =>
  factory() ?? {};

export const withTiming = <T,>(
  value: T,
  _config?: unknown,
  callback?: (finished: boolean) => void,
): T => {
  if (callback) {
    Promise.resolve().then(() => {
      act(() => {
        callback(true);
      });
    });
  }
  return value;
};

export const withRepeat = <T,>(value: T): T => value;

export const cancelAnimation = <T,>(_value: SharedValue<T>): void => {
  return;
};

export const Easing = {
  linear: easingIdentity,
  cubic: easingIdentity,
  in: (fn?: EasingFunction) => wrapEasing(fn),
  out: (fn?: EasingFunction) => wrapEasing(fn),
  inOut: (fn?: EasingFunction) => wrapEasing(fn),
} as const;

export const runOnJS =
  <Args extends any[]>(fn: (...args: Args) => void) =>
  (...args: Args) =>
    fn?.(...args);

const AnimatedView = forwardRef<
  HTMLDivElement,
  PropsWithChildren<Record<string, any>>
>(({ children, ...rest }, ref) => (
  <div ref={ref} {...rest}>
    {children}
  </div>
));

export const createAnimatedComponent = (
  Component: ComponentType<any>,
): ComponentType<any> =>
  forwardRef<any, any>((props, ref) => (
    <Component {...props} ref={ref} />
  )) as unknown as ComponentType<any>;

export const Animated = {
  View: AnimatedView,
  createAnimatedComponent,
};

// Export the Animated object as the default export so `import Animated from "react-native-reanimated"` works
export default Animated;
