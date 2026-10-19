import { type PropsWithChildren } from "react";

type SkiaProps = PropsWithChildren<Record<string, any>>;

export const Canvas = ({ children, ...rest }: SkiaProps) => (
  <div data-skia-canvas {...rest}>
    {children}
  </div>
);

export const Group = ({ children, ...rest }: SkiaProps) => (
  <div data-skia-group {...rest}>
    {children}
  </div>
);

export const Circle = (_props: SkiaProps) => null;
export const Path = (_props: SkiaProps) => null;
export const LinearGradient = (_props: SkiaProps) => null;

export const Paint = function Paint() {
  return {
    setAntiAlias: () => {},
    setStyle: () => {},
    setStrokeWidth: () => {},
    setColor: () => {},
  };
};

export const Skia = {
  Paint,
  RuntimeEffect: {
    Make: () => ({ makeShaderWithChildren: () => null }),
  },
} as const;

export const vec = (x: number, y: number) => ({ x, y });

const stub = {
  Canvas,
  Circle,
  Group,
  Paint,
  Path,
  LinearGradient,
  Skia,
  vec,
};

export default stub;
