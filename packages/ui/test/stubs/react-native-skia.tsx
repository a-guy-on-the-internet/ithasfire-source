import { Fragment, type PropsWithChildren } from "react";

export const Canvas = ({
  children,
  ...rest
}: PropsWithChildren<Record<string, any>>) => (
  <div data-skia-canvas {...rest}>
    {children}
  </div>
);

export const Group = ({
  children,
  ...rest
}: PropsWithChildren<Record<string, any>>) => (
  <div data-skia-group {...rest}>
    {children}
  </div>
);

export const Circle = () => null;
export const Path = () => null;

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

export default {
  Canvas,
  Circle,
  Group,
  Paint,
  Path,
  Skia,
  vec,
};
