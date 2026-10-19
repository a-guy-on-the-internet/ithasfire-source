"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { FeatureGatesSnapshot } from "./types";

const ServerFeatureGatesContext = createContext<
  FeatureGatesSnapshot | undefined
>(undefined);

export function ServerFeatureGatesProvider({
  gates,
  children,
}: {
  gates?: FeatureGatesSnapshot;
  children: ReactNode;
}) {
  return (
    <ServerFeatureGatesContext.Provider value={gates}>
      {children}
    </ServerFeatureGatesContext.Provider>
  );
}

export function useServerFeatureGates(): FeatureGatesSnapshot | undefined {
  return useContext(ServerFeatureGatesContext);
}
