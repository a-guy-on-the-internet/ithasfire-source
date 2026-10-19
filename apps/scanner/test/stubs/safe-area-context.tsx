import { createElement, type ReactNode } from "react";

/** `react-native-safe-area-context`: no notch in jsdom, so a plain box. */
export const SafeAreaView = (props: {
  children?: ReactNode;
  edges?: readonly string[];
  style?: unknown;
}) => createElement("div", null, props.children);

export const SafeAreaProvider = (props: { children?: ReactNode }) =>
  createElement("div", null, props.children);

export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
