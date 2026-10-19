"use client";

import { Spinner } from "@th/ui";

import { TEXT_CAPTION } from "./embed-theme";

/**
 * The widget's one loading affordance, shared by two callers so they can't
 * drift: EmbedWidget's own browse-loading state, and the route's Suspense
 * fallback (the widget reads `?view=`/`?scope=` via useSearchParams, which
 * suspends during the route's static render).
 *
 * `minHeight` is what stops a framed embed from collapsing: hf-resize.js
 * reports content height to the host page, so a bare spinner would shrink a
 * ~760px calendar iframe to a sliver and yank the host's scroll position while
 * the other view loads. Callers pass the outgoing view's measured height.
 */
export function EmbedWidgetFallback({ minHeight = 200 }: { minHeight?: number }) {
  return (
    <div
      className="th-embed-fade-in"
      style={{
        display: "flex",
        minHeight,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      {/* The embed's own tertiary-text token, not a raw hex: same value the
          loading spinner has always painted, now owned by embed-theme.ts. */}
      <Spinner size="md" indicatorColor={TEXT_CAPTION} />
    </div>
  );
}
