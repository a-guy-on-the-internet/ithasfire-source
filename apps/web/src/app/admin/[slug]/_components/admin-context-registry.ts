"use client";

import { useMemo, type ReactNode } from "react";

import type { NavigationRailBack, NavigationSection } from "@th/ui";

import type { OwnerEntityWithSlug } from "@/hooks/useEventOwnerEntities";

import { parseEventAdminPath } from "./event-nav-sections";
import { useEventRailContext } from "./event-rail-context";
import { parsePlaceAdminPath } from "./place-nav-sections";
import { usePlaceRailContext } from "./place-rail-context";

/**
 * Nested-context registry for the admin rail (place-admin-rail-context D2).
 *
 * AdminShell's context swap used to be a hard-coded binary (event context or
 * org workspace), so every new nested context meant another `??` branch,
 * another title query, another prefetch list inline in the shell. This module
 * generalizes it: an ordered list of descriptors, each pairing a pure
 * pathname matcher with a hook that produces everything the rail needs for
 * that context. First match wins; no match ⇒ the org workspace sections.
 */

/** Everything AdminShell already derives that a context descriptor may need. */
export type AdminRailContextDeps = {
  /** Raw URL slug segment, exactly as AdminShell received it. */
  slug: string;
  /** `normalizeAdminSlug(slug) ?? slug` — base of every collapse persist key. */
  persistKeyBase: string;
  /** App router (push only — prefetching stays a shell concern). */
  router: { push: (href: string) => void };
  /** Web translate fn (the same loose shape buildEventNavSections takes). */
  t: (key: string) => unknown;
  /** Resolved owner entity for the current workspace, once loaded. */
  currentOwner: OwnerEntityWithSlug | undefined;
};

/** What an active nested context contributes to the rail (spec D2). */
export type AdminRailContext = {
  /** Registry id of the descriptor that produced this context. */
  descriptorId: string;
  /** Sections that replace the org workspace sections. */
  sections: NavigationSection[];
  /** "← All …" back slot. */
  railBack: NavigationRailBack;
  /** Title/status header above the sections; undefined while unresolved. */
  railContextHeader: ReactNode | undefined;
  /** Full `sectionCollapsePersistKey` for this context. */
  persistKey: string;
  /** Concrete hrefs to warm on context entry (memoized by the descriptor). */
  prefetchRoutes: readonly string[];
  /** Return true to swallow a rail route-select (e.g. an in-page scroll). */
  interceptRouteSelect?: (href: string) => boolean;
};

export type AdminContextDescriptor<TMatch> = {
  id: string;
  /** Pure pathname parser; null ⇒ this context does not apply. */
  match: (pathname: string | null | undefined) => TMatch | null;
  /**
   * Called UNCONDITIONALLY on every AdminShell render (rules of hooks) with
   * the parsed match when this descriptor won, null otherwise. Must return
   * null exactly when `match` is null, and must keep its own queries disabled
   * while unmatched.
   */
  useContext: (
    match: TMatch | null,
    deps: AdminRailContextDeps,
  ) => AdminRailContext | null;
};

/**
 * Type-checks a descriptor's match/useContext pairing via inference — a
 * registry entry pairing (say) a place matcher with the event context hook
 * fails to compile here — then erases the match type for storage. The cast is
 * sound at this boundary because a descriptor's match result is only ever fed
 * back into that same descriptor's own useContext, and it is confined to this
 * helper: registry entries themselves are fully inference-checked.
 */
const defineAdminContext = <TMatch>(
  descriptor: AdminContextDescriptor<TMatch>,
): AdminContextDescriptor<unknown> =>
  descriptor as AdminContextDescriptor<unknown>;

/**
 * Ordered — FIRST match wins. Adding a nested admin context (e.g. the place
 * context, slice 2) is one `defineAdminContext` entry here plus its
 * descriptor module; AdminShell itself stays untouched.
 *
 * Every descriptor's `useContext` hook runs on every render regardless of
 * which (if any) matched, so this array must stay STATIC at module scope —
 * frozen so it can never grow or reorder at runtime (the rules-of-hooks
 * argument for the composer's loop rests on exactly that).
 */
const ADMIN_CONTEXT_REGISTRY: readonly AdminContextDescriptor<unknown>[] =
  Object.freeze([
    defineAdminContext({
      id: "event",
      match: parseEventAdminPath,
      useContext: useEventRailContext,
    }),
    // Second entry (place-admin-rail-context FR-202). Order between event and
    // place is IRRELEVANT for matching — their parsers key on disjoint path
    // segments (`/events/{id}` vs `/places/{id}`), so at most one can ever
    // match a pathname. Event stays first purely as the incumbent.
    defineAdminContext({
      id: "place",
      match: parsePlaceAdminPath,
      useContext: usePlaceRailContext,
    }),
  ]);

/**
 * Resolves the active nested rail context for the current pathname, or null
 * for the plain org workspace rail.
 */
export function useAdminRailContext(
  pathname: string | null,
  deps: AdminRailContextDeps,
): AdminRailContext | null {
  // Match phase is pure and memoized per pathname so descriptors receive
  // referentially-stable match objects (their useMemo deps rely on that,
  // exactly like the old `useMemo(() => parseEventAdminPath(pathname),
  // [pathname])` in AdminShell). First match wins: losers are nulled out so
  // their hooks stay on the unmatched branch (disabled queries, null result).
  const matches = useMemo(() => {
    const all = ADMIN_CONTEXT_REGISTRY.map((descriptor) =>
      descriptor.match(pathname),
    );
    const winner = all.findIndex((match) => match !== null);
    return all.map((match, index) => (index === winner ? match : null));
  }, [pathname]);

  let active: AdminRailContext | null = null;
  for (let index = 0; index < ADMIN_CONTEXT_REGISTRY.length; index += 1) {
    // Hook call in a loop, deliberately: the registry is static and
    // module-frozen, so the same hooks run in the same order on every render.
    const context = ADMIN_CONTEXT_REGISTRY[index]!.useContext(
      matches[index] ?? null,
      deps,
    );
    if (context && !active) active = context;
  }
  return active;
}
