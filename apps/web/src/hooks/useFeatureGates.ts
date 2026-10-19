"use client";

import { trpc } from "@/trpc";
import { useServerFeatureGates } from "@/lib/feature-gates/ServerFeatureGatesContext";

export function useFeatureGates() {
  const serverGates = useServerFeatureGates();

  const query = trpc.features.getFeatureGates.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    initialData: serverGates,
  });

  return {
    gates: query.data ?? undefined,
    isLoading: serverGates ? false : query.isLoading,
  };
}
