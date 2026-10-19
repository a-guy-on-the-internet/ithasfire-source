import {
  forwardRef,
  useCallback,
  useReducer,
  useRef,
  type ComponentType,
  type PropsWithChildren,
} from "react";
import { View } from "react-native";

type TimingSignal<T> = {
  __type: "timing";
  toValue: T;
  duration: number;
  easing: (value: number) => number;
  onFinish?: (finished: boolean) => void;
};

const isTimingSignal = <T,>(value: unknown): value is TimingSignal<T> =>
  Boolean(
    value &&
    typeof value === "object" &&
    (value as TimingSignal<T>).__type === "timing",
  );

const raf = (
  cb: (timestamp: number) => void,
): number | ReturnType<typeof setTimeout> => {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(cb);
  }
  return setTimeout(() => cb(Date.now()), 16);
};

const caf = (handle: number | ReturnType<typeof setTimeout>) => {
  if (
    typeof handle === "number" &&
    typeof globalThis.cancelAnimationFrame === "function"
  ) {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

type SharedValue<T> = {
  value: T;
};

const useForceUpdate = () => {
  const [, dispatch] = useReducer((count: number) => count + 1, 0);
  return useCallback(() => dispatch(), []);
};

export const useSharedValue = <T,>(initial: T): SharedValue<T> => {
  const forceUpdate = useForceUpdate();
  const ref = useRef<({ _value: T } & SharedValue<T>) | null>(null);

  if (!ref.current) {
    const holder: any = { _value: initial };
    let cancelAnimation: (() => void) | null = null;

    const assignValue = (next: T) => {
      holder._value = next;
      forceUpdate();
    };

    Object.defineProperty(holder, "value", {
      get() {
        return holder._value;
      },
      set(next: T) {
        if (
          isTimingSignal<T>(next) &&
          typeof holder._value === "number" &&
          typeof next.toValue === "number"
        ) {
          cancelAnimation?.();
          const { toValue, duration, easing, onFinish } = next;

          if (duration <= 0) {
            assignValue(toValue);
            onFinish?.(true);
            return;
          }

          const start = holder._value as number;
          const delta = toValue - start;
          const startedAt = Date.now();

          const step = () => {
            const elapsed = Date.now() - startedAt;
            const t = Math.min(elapsed / duration, 1);
            const eased = easing(t);
            assignValue((start + delta * eased) as unknown as T);

            if (t < 1) {
              animationHandle = raf(step);
            } else {
              cancelAnimation = null;
              onFinish?.(true);
            }
          };

          let animationHandle: number | ReturnType<typeof setTimeout> =
            raf(step);
          cancelAnimation = () => caf(animationHandle);
          return;
        }

        cancelAnimation?.();
        cancelAnimation = null;
        assignValue(next);
      },
    });
    ref.current = holder;
  }

  return ref.current as SharedValue<T>;
};

export const useAnimatedStyle = <T,>(create: () => T): T => create();

type TimingConfig = {
  duration?: number;
  easing?: (value: number) => number;
};

export const withTiming = <T,>(
  value: T,
  config?: TimingConfig,
  callback?: (finished: boolean) => void,
) => {
  return {
    __type: "timing" as const,
    toValue: value,
    duration: config?.duration ?? 0,
    easing: config?.easing ?? ((t: number) => t),
    onFinish: callback,
  } as unknown as T;
};

export const withRepeat = <T,>(value: T) => value;

export const withDelay = <T,>(_delay: number, value: T): T => value;

export const withSequence = <T,>(...values: T[]): T =>
  values[values.length - 1] as T;

export const cancelAnimation = () => {
  // no-op for Storybook mock environment
};

export const Easing = {
  out: (easing: (value: number) => number) => (value: number) => easing(value),
  cubic: (value: number) => value ** 3,
};

export const Extrapolation = {
  CLAMP: "clamp",
  EXTEND: "extend",
  IDENTITY: "identity",
} as const;

export const runOnJS =
  <Fn extends (...args: any[]) => any>(fn: Fn) =>
  (...args: Parameters<Fn>) =>
    fn(...args);

export const interpolate = (
  value: number,
  inputRange: number[],
  outputRange: number[],
): number => {
  if (inputRange.length !== outputRange.length || inputRange.length < 2) {
    return outputRange[0] ?? value;
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

const AnimatedView = forwardRef<
  unknown,
  PropsWithChildren<Record<string, unknown>>
>((props, ref) => {
  return <View ref={ref as any} {...props} />;
});

const createAnimatedComponent = (
  Component: ComponentType<any>,
): ComponentType<any> =>
  forwardRef<any, any>((props, ref) => <Component ref={ref} {...props} />);

const Animated = {
  View: AnimatedView,
  createAnimatedComponent,
};

export default Animated;
