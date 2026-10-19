"use client";

import type { ReactNode } from "react";
import { AppProgressProvider } from "@bprogress/next";

/**
 * Client boundary for the global navigation progress bar (soft chrome).
 *
 * `@bprogress/next` ships its dist WITHOUT a "use client" banner, so importing
 * `AppProgressProvider` directly into the (server) root layout pulls its
 * `createContext` call into the RSC/server graph and crashes the production
 * build ("createContext is not a function" while collecting `/_not-found`).
 * Re-exporting it from this "use client" module establishes the boundary so the
 * provider is only ever evaluated on the client.
 *
 * A thin steel-blue bar animates during ANY client navigation. It auto-covers
 * <Link>/anchor clicks and back/forward; programmatic navigation is covered by
 * importing `useRouter` from `@bprogress/next/app` at the call sites.
 * `showSpinner: false` drops the corner spinner (not Swiss).
 */
export function NavigationProgressProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <AppProgressProvider
      // 3px + warm-orange (brand action color) so the bar is unmistakable
      // against the app's dark-navy chrome, where a thin steel-blue line was
      // easy to miss. `startPosition`/`minimum` at 0.3 make it jump straight to
      // 30% on click — visible immediately instead of creeping in from the
      // off-screen left, which for quick navigations looked like nothing.
      height="3px"
      color="#E2481D"
      startPosition={0.3}
      options={{ showSpinner: false, minimum: 0.3 }}
    >
      {children}
    </AppProgressProvider>
  );
}
