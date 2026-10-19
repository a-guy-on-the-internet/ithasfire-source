import {
  forwardRef,
  useCallback,
  useReducer,
  useRef,
  type PropsWithChildren,
} from "react";
import { View } from "react-native";

type SkiaValue<T> = {
  current: T;
};

const useForceUpdate = () => {
  const [, dispatch] = useReducer((count: number) => count + 1, 0);
  return useCallback(() => dispatch(), []);
};

export const useValue = <T,>(initial: T): SkiaValue<T> => {
  const forceUpdate = useForceUpdate();
  const ref = useRef<({ _value: T } & SkiaValue<T>) | null>(null);

  if (!ref.current) {
    const holder: any = { _value: initial };
    Object.defineProperty(holder, "current", {
      get() {
        return holder._value;
      },
      set(next: T) {
        holder._value = next;
        forceUpdate();
      },
    });
    ref.current = holder;
  }

  return ref.current as SkiaValue<T>;
};

export const runTiming = <T,>(value: SkiaValue<T>, toValue: T) => {
  if (value) {
    value.current = toValue;
  }
  return Promise.resolve();
};

export const vec = (x: number, y: number) => ({ x, y });

export const Easing = {
  cubic: (value: number) => value ** 3,
  inOut: (easing: (value: number) => number) => (value: number) =>
    easing(value),
};

const createPrimitive = () => {
  return forwardRef<unknown, PropsWithChildren<Record<string, unknown>>>(
    (props, ref) => <View ref={ref as any} {...props} />,
  );
};

export const Canvas = createPrimitive();
export const Circle = createPrimitive();
export const Group = createPrimitive();
export const LinearGradient = createPrimitive();

export default {
  Canvas,
  Circle,
  Group,
  LinearGradient,
  runTiming,
  useValue,
  vec,
  Easing,
};
