"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

// useLayoutEffect on the client (the ref must hold the committed render's
// handler before any user event can fire); a no-op useEffect during SSR to
// silence React's server-side useLayoutEffect warning.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Wraps a handler in a callback with a PERMANENTLY stable identity that always
 * invokes the latest version.
 *
 * Why the event builder needs it: react-query returns a fresh mutation result
 * object on every render (`useMutation` spreads its state), so any
 * `useCallback` that depends on a mutation — the save funnel, the publish
 * funnel, the upload handlers — churns identity every single render. Passing
 * those directly into a memoized child silently defeats `React.memo`. This
 * wrapper is the standard latest-ref pattern (assigned in a layout effect, so
 * it is safe under concurrent rendering) and changes no behaviour: the call
 * always lands on the handler from the most recent commit.
 *
 * Only use it for handlers invoked from events/effects — never for a value
 * read during render.
 */
export function useStableHandler<A extends unknown[], R>(
  handler: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(handler);

  useIsomorphicLayoutEffect(() => {
    ref.current = handler;
  }, [handler]);

  return useCallback((...args: A) => ref.current(...args), []);
}
