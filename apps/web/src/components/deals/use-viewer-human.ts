"use client";

import { useMemo } from "react";

import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";

import type { TellActor } from "./deal-names";

/**
 * The signed-in person as a payee (their own human), so "Saving tells …"
 * leaves them out the way the notice does. Null until it loads.
 */
export function useViewerHuman(): TellActor {
  const { ownersWithSlugs } = useEventOwnerEntities();
  return useMemo(() => {
    const me = ownersWithSlugs?.find((o) => o.kind === "human");
    return me && me.kind === "human"
      ? { humanId: me.humanId, name: me.humanName }
      : null;
  }, [ownersWithSlugs]);
}
