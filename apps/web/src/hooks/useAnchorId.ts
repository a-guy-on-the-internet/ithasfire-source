"use client";

import { useId } from "react";

/**
 * A DOM id that is unique per component INSTANCE.
 *
 * Module-level id constants are fine while a layout renders once per document.
 * The entity page editor broke that assumption: Preview mounts a second copy of
 * the real page while the authoring canvas stays mounted (display:none), so a
 * hard-coded `id` exists twice and `getElementById` / fragment navigation both
 * resolve to whichever copy comes first in document order — the hidden one.
 * That silently killed the heroes' in-page CTAs.
 *
 * `useId`'s raw output carries delimiter characters (React 19 emits `«r1»`),
 * which are legal in `id` and in a URL fragment but NOT in a CSS selector, so
 * they are stripped here. The `prefix` survives verbatim to keep the id
 * readable in devtools: `org-contact` → `org-contact-r1`.
 */
export function useAnchorId(prefix: string): string {
  const reactId = useId();
  return `${prefix}-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
