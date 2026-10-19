"use client";

/**
 * GlobalOverlays — single mount point for fixed/floating UI that must
 * be present across ALL routes regardless of which shell is active.
 *
 * Rendered once in AppChrome (the top-level layout wrapper) so neither
 * AppShell nor AdminShell need to duplicate these concerns.
 *
 * Included on every branch except the bare chrome-bypass routes
 * (auth callbacks, embeds, /login) which don't render AppChrome at all.
 *
 * It used to also register spotlight / my-tickets callbacks into the action
 * bar's store. There is no action bar: spotlight opens from the navbar and the
 * bottom nav's Search tab, and /my-tickets is a plain link.
 *
 * It also owns the ⌘K / Ctrl+K shortcut. That registration used to ride along
 * inside the action-bar wiring (`useSpotlightSearch`), so deleting the wiring
 * in dc66e1b22 silently deleted the shortcut with it. It is called directly
 * here now, beside the overlay it opens.
 */

import { SpotlightSearch } from "@/components/search/SpotlightSearch";
import { useSpotlightKeyboard } from "@/components/search/spotlight-store";
import { SupportWidget } from "@/components/support/SupportWidget";

export function GlobalOverlays() {
  useSpotlightKeyboard();

  return (
    <>
      <SpotlightSearch />
      <SupportWidget />
    </>
  );
}

GlobalOverlays.displayName = "GlobalOverlays";
