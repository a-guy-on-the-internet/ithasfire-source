import { createElement, type ReactNode } from "react";

/**
 * `tamagui` — `@th/ui-native`'s `primitives.tsx` lays out `TopBar` and
 * `ScreenSurface` with `XStack` / `YStack`. The real ones need a Tamagui
 * provider and compiled config; layout is not what these tests are about, so
 * both are plain boxes and every style prop is dropped.
 */
type StackProps = { children?: ReactNode; testID?: string };

const stack = (name: string) => {
  const Stack = (props: StackProps) =>
    createElement("div", { "data-testid": props.testID }, props.children);
  Stack.displayName = `${name}Stub`;
  return Stack;
};

export const XStack = stack("XStack");
export const YStack = stack("YStack");
