import type { Placement } from "@floating-ui/core";

export type { Placement };

export const offset = (_options?: unknown) => ({
  name: "offset" as const,
  fn: () => ({}),
});

export const flip = (_options?: unknown) => ({
  name: "flip" as const,
  fn: () => ({}),
});

export const shift = (_options?: unknown) => ({
  name: "shift" as const,
  fn: () => ({}),
});

export const size = (_options?: unknown) => ({
  name: "size" as const,
  fn: () => ({}),
});

export const autoUpdate = () => () => {};

export const useFloating = (_options?: unknown) => ({
  x: 0,
  y: 0,
  strategy: "absolute" as const,
  placement: "bottom" as Placement,
  middlewareData: {},
  isPositioned: false,
  floatingStyles: {},
  refs: {
    reference: { current: null },
    floating: { current: null },
    setReference: () => {},
    setFloating: () => {},
  },
  elements: {
    reference: null,
    floating: null,
  },
  update: () => {},
  context: {} as unknown,
});
