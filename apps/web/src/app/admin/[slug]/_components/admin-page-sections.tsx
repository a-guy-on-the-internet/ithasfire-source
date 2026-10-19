"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { parseNamespacedPathname } from "@th/ui";

/**
 * In-page sections for ORG WORKSPACE routes (today: Payouts).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A rail child like `/admin/<slug>/payouts#ledger` is an anchor into a page,
 * not a route. While that page is mounted a click must scroll to the section
 * (not re-navigate), and the rail must light the section the reader is in.
 * The event builder solves the same problem through its nested `railContext`
 * (`event-nav-context.tsx`), but the org workspace rail has no rail context —
 * AdminShell only consulted one for nested routes. This is the workspace-level
 * twin, kept deliberately small:
 *
 *   - a page REGISTERS a jump handler for its route id while its sections are
 *     on screen, and REPORTS which section is current (scroll-spy);
 *   - AdminShell asks `jumpToSection` before routing a `#section` href, and
 *     reads the current section to set its rail children's `active`.
 *
 * Off the page nothing is registered, so the shell falls through to the
 * router and the page lands on the fragment once its sections exist.
 *
 * Hash, not `?section=`: a fragment is a real anchor (works with no script,
 * middle-click lands on the section), a hash-only change never refetches the
 * route, and it cannot collide with the query string Stripe sends back to the
 * onboarding `returnUrl`. The event builder keeps `?section=` on its own path.
 *
 * Same actions/state split as `EventNavProvider`: the actions value never
 * changes identity, so a page that registers never re-renders on its own
 * scroll-spy reports; only the rail (AdminShell) consumes the state.
 */

type JumpHandler = (sectionId: string) => boolean;

export type AdminPageSection = { routeId: string; sectionId: string };

export type AdminPageSectionsActions = {
  /** Register a page's jump handler for `routeId`; returns the cleanup. */
  register: (routeId: string, jump: JumpHandler) => () => void;
  /**
   * Scroll the mounted page to a section. False when that page is not mounted
   * (or does not know the section), so the caller navigates instead.
   */
  jumpToSection: (routeId: string, sectionId: string) => boolean;
  /** Scroll-spy report from the mounted page; null withdraws it. */
  setActiveSection: (routeId: string, sectionId: string | null) => void;
};

export type AdminPageSectionsState = {
  activeSection: AdminPageSection | null;
};

const ActionsContext = createContext<AdminPageSectionsActions | null>(null);
const StateContext = createContext<AdminPageSectionsState | null>(null);

export function AdminPageSectionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [activeSection, setActiveSectionState] =
    useState<AdminPageSection | null>(null);
  const handlersRef = useRef(new Map<string, JumpHandler>());

  const setActiveSection = useCallback(
    (routeId: string, sectionId: string | null) => {
      setActiveSectionState((current) => {
        if (sectionId === null) {
          return current?.routeId === routeId ? null : current;
        }
        return current?.routeId === routeId && current.sectionId === sectionId
          ? current
          : { routeId, sectionId };
      });
    },
    [],
  );

  const register = useCallback(
    (routeId: string, jump: JumpHandler) => {
      handlersRef.current.set(routeId, jump);
      return () => {
        if (handlersRef.current.get(routeId) === jump) {
          handlersRef.current.delete(routeId);
        }
        // The page unmounted — its scroll-spy report is stale.
        setActiveSection(routeId, null);
      };
    },
    [setActiveSection],
  );

  const jumpToSection = useCallback((routeId: string, sectionId: string) => {
    const handler = handlersRef.current.get(routeId);
    return handler ? handler(sectionId) : false;
  }, []);

  const actions = useMemo(
    () => ({ register, jumpToSection, setActiveSection }),
    [register, jumpToSection, setActiveSection],
  );
  const state = useMemo(() => ({ activeSection }), [activeSection]);

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

/** Null-safe: pages render without the provider (tests, print frames). */
export function useAdminPageSectionsActions(): AdminPageSectionsActions | null {
  return useContext(ActionsContext);
}

/** Null-safe. Re-renders on every scroll-spy report — the rail only. */
export function useAdminPageSectionsState(): AdminPageSectionsState | null {
  return useContext(StateContext);
}

const SECTION_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * `/admin/acme/payouts#ledger` → `{ routeId: "payouts", sectionId: "ledger" }`.
 * Null for an href with no usable fragment or outside this workspace.
 */
export function sectionTargetFromHref(
  href: string,
  adminBasePath: string,
): AdminPageSection | null {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return null;
  const sectionId = href.slice(hashIndex + 1);
  if (!SECTION_ID_PATTERN.test(sectionId)) return null;
  // No fallback route id: an href outside the workspace must not resolve.
  const routeId = parseNamespacedPathname(href, { adminBasePath });
  if (!routeId) return null;
  return { routeId, sectionId };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The reading line sits a third of the way down the viewport: the current
 * section is the LAST one whose heading has crossed it. At the very bottom of
 * a scrolled page the last section wins, so a short final section still
 * lights up once it is reached.
 */
export function computeActiveSection(
  sectionIds: readonly string[],
  getTop: (id: string) => number | null,
  viewport: { innerHeight: number; scrollY: number; scrollHeight: number },
): string | null {
  const line = viewport.innerHeight * 0.35;
  let active: string | null = null;
  let last: string | null = null;
  for (const id of sectionIds) {
    const top = getTop(id);
    if (top === null) continue;
    if (active === null) active = id;
    last = id;
    if (top <= line) active = id;
  }
  const atBottom =
    viewport.scrollY > 0 &&
    viewport.innerHeight + viewport.scrollY >= viewport.scrollHeight - 2;
  return atBottom && last ? last : active;
}

/** After a jump, scroll-spy holds its fire until the motion settles. */
const JUMP_SETTLE_MS = 900;

/**
 * Wires one page's sections to the rail and to its own jump chips:
 * registers the jump handler while `ready` (the section headings are in the
 * DOM), runs the scroll-spy, and lands once on a `#section` fragment.
 *
 * Each section id must be the DOM id of a focusable (`tabIndex={-1}`) heading.
 * A jump scrolls it to the top (instantly under reduced motion), moves
 * keyboard focus to it — a scroll alone leaves focus on the link, so the next
 * Tab would land back in the nav — and writes the fragment so the address bar
 * stays shareable.
 */
export function useInPageSections({
  routeId,
  sectionIds,
  ready,
  landingReady = ready,
  onJump,
}: {
  routeId: string;
  sectionIds: readonly string[];
  ready: boolean;
  /**
   * Called after every successful jump — rail, chip, or the landing jump to
   * the URL hash — with the section jumped to. A page uses it to open what
   * the link was for (Payouts opens a settings row's disclosure).
   */
  onJump?: (sectionId: string) => void;
  /**
   * Gates ONLY the one-time landing jump to the URL hash (default: `ready`).
   * A page whose content above a section can still grow (a late card) holds
   * this until the layout has settled: Safari has no scroll anchoring, so a
   * jump made earlier is pushed off target. Rail and chip jumps stay
   * immediate.
   */
  landingReady?: boolean;
}): { activeSectionId: string | null; jumpTo: (sectionId: string) => boolean } {
  const actions = useAdminPageSectionsActions();
  const [activeSectionId, setActiveSectionId] = useState<string | null>(
    sectionIds[0] ?? null,
  );
  const holdUntilRef = useRef(0);
  const sectionKey = sectionIds.join("|");
  // Latest callback without re-registering the jump handler on every render.
  const onJumpRef = useRef(onJump);
  useEffect(() => {
    onJumpRef.current = onJump;
  }, [onJump]);

  const report = useCallback(
    (id: string) => {
      setActiveSectionId(id);
      actions?.setActiveSection(routeId, id);
    },
    [actions, routeId],
  );

  const scrollToSection = useCallback(
    (sectionId: string, behavior: "auto" | "smooth") => {
      if (!sectionKey.split("|").includes(sectionId)) return false;
      const target = document.getElementById(sectionId);
      if (!target) return false;
      holdUntilRef.current = Date.now() + JUMP_SETTLE_MS;
      target.scrollIntoView({ block: "start", behavior });
      // preventScroll: the scrollIntoView above owns the motion; focusing
      // without it would snap the page and cancel a smooth scroll.
      target.focus({ preventScroll: true });
      if (window.location.hash !== `#${sectionId}`) {
        window.history.replaceState(null, "", `#${sectionId}`);
      }
      report(sectionId);
      onJumpRef.current?.(sectionId);
      return true;
    },
    [sectionKey, report],
  );

  const jumpTo = useCallback(
    (sectionId: string) =>
      scrollToSection(sectionId, prefersReducedMotion() ? "auto" : "smooth"),
    [scrollToSection],
  );

  // Rail anchors scroll in place only while the headings exist.
  useEffect(() => {
    if (!ready || !actions) return;
    return actions.register(routeId, jumpTo);
  }, [ready, actions, routeId, jumpTo]);

  // Landing on `/payouts#ledger` (a rail click from another page, a shared
  // link, the `/payments` redirect): the browser's own jump fired before the
  // sections rendered, so do it once they exist. Compared RAW — a hand-typed
  // `#%` must not reach `decodeURIComponent` and throw inside an effect.
  const landedRef = useRef(false);
  useEffect(() => {
    if (!ready || !landingReady || landedRef.current) return;
    landedRef.current = true;
    const id = window.location.hash.slice(1);
    if (id) scrollToSection(id, "auto");
  }, [ready, landingReady, scrollToSection]);

  // Scroll-spy: rAF-throttled, passive. Pure progressive enhancement — with
  // no events the first section simply stays current.
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const ids = sectionKey ? sectionKey.split("|") : [];
    let rafId: number | null = null;
    const compute = () => {
      rafId = null;
      if (Date.now() < holdUntilRef.current) return;
      const next = computeActiveSection(
        ids,
        (id) => document.getElementById(id)?.getBoundingClientRect().top ?? null,
        {
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
        },
      );
      if (next) report(next);
    };
    const schedule = () => {
      if (rafId === null) rafId = requestAnimationFrame(compute);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    schedule();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [ready, sectionKey, report]);

  return { activeSectionId, jumpTo };
}
