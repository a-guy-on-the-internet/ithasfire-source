"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getSnapshot = () =>
  typeof window !== "undefined" && window.parent !== window;
const getServerSnapshot = () => false;

/**
 * True when the embed is running inside an iframe (the hf-resize /
 * hf-embed bridge case). The host's resize listener grows the iframe to
 * the full content height, so `position: fixed` elements pin to the END
 * of the widget instead of the visitor's screen — components use this to
 * swap fixed chrome for in-flow equivalents.
 *
 * `useSyncExternalStore` keeps SSR/hydration consistent: the server
 * snapshot is `false`; React re-evaluates on the client after hydration.
 */
export function useIsFramed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
