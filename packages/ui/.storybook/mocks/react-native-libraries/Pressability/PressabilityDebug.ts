import { createElement, forwardRef } from "react";

type PressabilityDebugViewProps = Record<string, unknown>;

export const PressabilityDebugView = forwardRef<
  HTMLDivElement,
  PressabilityDebugViewProps
>((props, ref) => createElement("div", { ...props, ref }));

PressabilityDebugView.displayName = "PressabilityDebugView";

export default PressabilityDebugView;
