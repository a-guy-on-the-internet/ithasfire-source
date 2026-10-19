"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useConsent, type UseConsentResult } from "@/hooks/useConsent";

const ConsentContext = createContext<UseConsentResult | null>(null);

/** Wrap the app so any descendant can read / mutate cookie-consent state. */
export function ConsentProvider({ children }: { children: ReactNode }) {
  const consent = useConsent();
  return (
    <ConsentContext.Provider value={consent}>
      {children}
    </ConsentContext.Provider>
  );
}

/** Access the shared consent state. Must be rendered inside `<ConsentProvider>`. */
export function useConsentContext(): UseConsentResult {
  const ctx = useContext(ConsentContext);
  if (!ctx) {
    throw new Error(
      "useConsentContext must be used within a <ConsentProvider>",
    );
  }
  return ctx;
}
