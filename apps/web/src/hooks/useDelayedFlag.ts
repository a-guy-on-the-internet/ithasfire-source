"use client";

import { useEffect, useState } from "react";

/**
 * Returns `true` only after `active` has been continuously true for
 * `delayMs`. Resets immediately when `active` flips to `false`.
 *
 * Use to gate loading skeletons / spinners so fast operations
 * (cached queries, sub-200ms responses) skip the loading UI entirely
 * instead of flashing it on screen mid-route-transition.
 *
 * ```tsx
 * const showSkeleton = useDelayedFlag(query.isLoading, 200);
 * if (showSkeleton) return <Skeleton />;
 * if (query.isLoading) return null; // still loading, but too soon to flash
 * ```
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!active) {
      setDelayed(false);
      return;
    }
    const id = window.setTimeout(() => setDelayed(true), delayMs);
    return () => window.clearTimeout(id);
  }, [active, delayMs]);

  return delayed;
}
