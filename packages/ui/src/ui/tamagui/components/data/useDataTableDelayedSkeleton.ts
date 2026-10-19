"use client";

import { useEffect, useState } from "react";

/**
 * Returns true only after `active` has been continuously true for `delayMs`.
 * Resets immediately when `active` flips false. Used to gate the loading
 * skeleton so cached / sub-200ms responses don't flash: if the request
 * resolves quickly the skeleton is never rendered; if it takes longer, the
 * skeleton appears and stays for at least the remainder of its natural
 * duration.
 *
 * Inlined here (rather than imported from apps/web/src/hooks) because
 * `@th/ui` is consumed by mobile + scanner too.
 */
export function useDataTableDelayedSkeleton(
  active: boolean,
  delayMs: number,
): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!active) {
      setDelayed(false);
      return;
    }
    const id = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(id);
  }, [active, delayMs]);
  return delayed;
}
