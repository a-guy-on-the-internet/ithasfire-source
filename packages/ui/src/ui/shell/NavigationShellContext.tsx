"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { NavigationShellContextValue } from "./NavigationShell.types";

const NavigationShellContext = createContext<
  NavigationShellContextValue | undefined
>(undefined);

export const NavigationShellProvider = ({
  value,
  children,
}: {
  value: NavigationShellContextValue;
  children?: ReactNode;
}) => (
  <NavigationShellContext.Provider value={value}>
    {children}
  </NavigationShellContext.Provider>
);

export const useNavigationShell = () => {
  const context = useContext(NavigationShellContext);

  if (!context) {
    throw new Error(
      "useNavigationShell must be used within a NavigationShellProvider",
    );
  }

  return context;
};

export { NavigationShellContext };
