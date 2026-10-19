import { Fragment, type PropsWithChildren } from "react";

const createChain = () => {
  const chain = {
    enabled: () => chain,
    maxPointers: () => chain,
    activeOffsetX: () => chain,
    activeOffsetY: () => chain,
    onBegin: () => chain,
    onStart: () => chain,
    onUpdate: () => chain,
    onEnd: () => chain,
    onFinalize: () => chain,
  };

  return chain;
};

export const Gesture = {
  Pan: () => createChain(),
};

export const GestureDetector = ({
  children,
}: PropsWithChildren<{ gesture?: unknown }>) => <Fragment>{children}</Fragment>;

export default {
  Gesture,
  GestureDetector,
};
