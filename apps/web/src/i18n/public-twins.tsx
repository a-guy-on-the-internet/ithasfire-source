"use client";

import { createContext, useContext, useEffect } from "react";

import type { PublicTwinSet } from "./client-locale";

/**
 * How a page tells the client its language twins (Spanish SEO FR-003, FR-004).
 *
 * A page with twins renders `<PublicTwins twins={...} />` (a server page can:
 * the props are plain data). It registers the set with `AppLocaleProvider`,
 * which uses it for the automatic move to the chosen language's twin and the
 * language picker's navigation. No page offers another language inline: the
 * picker is the only switch (owner, 2026-10-18, R23).
 *
 * Why a registration and not the `<link rel="alternate" hreflang>` tags: those
 * exist only for INDEXABLE twins (R9), but the picker on an /es/ page whose
 * category has no Spanish name must still reach the English page, and a
 * noindex /es/ twin is still where the picker sends a Spanish chooser. The set
 * carries `indexable` per language so the automatic steps can skip noindex
 * twins while the picker does not. It also survives client navigation without
 * waiting on Next's head updates.
 */

type PublicTwinsContextValue = {
  /** The twins of the page in view (already checked against the pathname). */
  twins: PublicTwinSet | null;
  register: (twins: PublicTwinSet | null) => void;
};

export const PublicTwinsContext = createContext<PublicTwinsContextValue>({
  twins: null,
  register: () => {},
});

/**
 * Publish the page's language twins. Pass every language version, the page's
 * own included (its `path` must equal the canonical pathname, which is how
 * the provider knows the set belongs to the page in view). Renders nothing.
 */
export const PublicTwins = ({ twins }: { twins: PublicTwinSet }) => {
  const { register } = useContext(PublicTwinsContext);
  // Server props arrive as a fresh object on every refresh; key on content.
  const key = JSON.stringify(twins);
  useEffect(() => {
    register(JSON.parse(key) as PublicTwinSet);
    return () => register(null);
  }, [key, register]);
  return null;
};

PublicTwins.displayName = "PublicTwins";
