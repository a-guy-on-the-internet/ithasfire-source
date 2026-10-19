"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * The six Build sections of the event edit surface, in visual order. These
 * ids are shared by the contextual rail (anchor items), the `?section=` deep
 * link on the edit route, and EventBuilder's scroll-spy/jump wiring.
 */
export const EVENT_BUILD_SECTION_IDS = [
  "essentials",
  "details",
  "tickets",
  "lineup",
  "splits",
  "settings",
] as const;

export type EventBuildSectionId = (typeof EVENT_BUILD_SECTION_IDS)[number];

export const isEventBuildSectionId = (
  value: string | null | undefined,
): value is EventBuildSectionId =>
  EVENT_BUILD_SECTION_IDS.includes(value as EventBuildSectionId);

type JumpHandler = (sectionId: EventBuildSectionId) => void;

/**
 * What the mounted edit surface knows about the event it is editing, published
 * upward for the rail and the `[id]` layout to consume.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The rail and the document-title layout each fired `events.getEventTitle` for
 * the title/status/slug. That procedure is OWNER-gated, so on a COMMUNITY
 * listing (an ownerless row) both answered `NOT_RESOURCE_OWNER` — two FORBIDDEN
 * console errors on every community builder load, for facts the edit surface
 * had already read successfully through `getEventForEdit`.
 *
 * So on the edit surface the builder is the single reader and publishes what it
 * learned here; the rail and the layout stop making a second, narrower,
 * owner-gated request for a subset of it. Off the edit surface (attendees,
 * feedback, …) nothing publishes and `getEventTitle` runs exactly as before.
 *
 * `stewardship` rides along because the rail needs it too: an ownerless listing
 * must not be offered Tickets / Revenue splits / Settings anchors that deep-link
 * into panels the builder does not render and whose writes the server refuses.
 */
export type EventNavIdentity = {
  /** Guards against a stale publish from a previous event's unmounting tree. */
  eventId: string;
  title: string | null;
  /** `Event.status` — "DRAFT" | "PUBLISHED" | … */
  status: string | null;
  /** Public slug, or null when none has been assigned yet. */
  slug: string | null;
  /** `Event.stewardship` — "OWNED" | "COMMUNITY". */
  stewardship: string | null;
};

const identityEquals = (
  a: EventNavIdentity | null,
  b: EventNavIdentity | null,
): boolean =>
  a === b ||
  Boolean(
    a &&
      b &&
      a.eventId === b.eventId &&
      a.title === b.title &&
      a.status === b.status &&
      a.slug === b.slug &&
      a.stewardship === b.stewardship,
  );

export type EventNavActionsValue = {
  /** Reported by EventBuilder's IntersectionObserver scroll-spy. */
  setActiveSection: (sectionId: EventBuildSectionId | null) => void;
  /**
   * EventBuilder registers its section-jump handler here while the edit
   * surface is mounted; returns an unregister cleanup.
   */
  registerJumpHandler: (handler: JumpHandler) => () => void;
  /**
   * Ask the mounted edit surface to scroll to a Build section. Returns false
   * when no handler is registered (i.e. we're not on the edit surface) so the
   * caller can navigate to the edit route instead.
   */
  jumpToSection: (sectionId: EventBuildSectionId) => boolean;
  /**
   * The edit surface reports the event it has loaded (or `null` to withdraw).
   * A no-op when the value is unchanged, so calling it every render is safe.
   */
  publishIdentity: (identity: EventNavIdentity | null) => void;
};

export type EventNavStateValue = {
  /** Scroll-spy result reported by the edit surface; null off the edit page. */
  activeSection: EventBuildSectionId | null;
};

/**
 * Split contexts under one provider (perf): the ACTIONS context holds only
 * stable callback identities, the STATE context carries the churny scroll-spy
 * result. EventBuilder consumes actions ONLY — its own scroll-spy reports
 * must never re-render the whole builder tree on every section crossing.
 * The rail (AdminShell) consumes both.
 */
const EventNavActionsContext = createContext<EventNavActionsValue | null>(
  null,
);
const EventNavStateContext = createContext<EventNavStateValue | null>(null);
/**
 * Identity gets its OWN context rather than riding on the state context: the
 * `[id]` layout wraps every event route, and subscribing it to the churny
 * scroll-spy value would re-render the whole event subtree on every section
 * crossing — the exact cost the actions/state split was made to avoid.
 */
const EventNavIdentityContext = createContext<EventNavIdentity | null>(null);

/**
 * Bridges the admin rail (which lives ABOVE the event routes in the tree) and
 * the event edit surface: scroll-spy state flows up, jump requests flow down.
 * Mounted once in the /admin/[slug] layout, wrapping AdminShell.
 */
export function EventNavProvider({ children }: { children: ReactNode }) {
  const [activeSection, setActiveSectionState] =
    useState<EventBuildSectionId | null>(null);
  const [identity, setIdentityState] = useState<EventNavIdentity | null>(null);
  const jumpHandlerRef = useRef<JumpHandler | null>(null);

  const setActiveSection = useCallback(
    (sectionId: EventBuildSectionId | null) => {
      setActiveSectionState(sectionId);
    },
    [],
  );

  const registerJumpHandler = useCallback((handler: JumpHandler) => {
    jumpHandlerRef.current = handler;
    return () => {
      if (jumpHandlerRef.current === handler) {
        jumpHandlerRef.current = null;
      }
      // The edit surface unmounted — its scroll-spy report is stale.
      setActiveSectionState(null);
    };
  }, []);

  const jumpToSection = useCallback((sectionId: EventBuildSectionId) => {
    const handler = jumpHandlerRef.current;
    if (!handler) return false;
    handler(sectionId);
    return true;
  }, []);

  // Value-equal writes are dropped inside the updater rather than by the
  // caller: the edit surface derives its identity object fresh from query data
  // on every render, so a naive publish would set state in a loop.
  const publishIdentity = useCallback((next: EventNavIdentity | null) => {
    setIdentityState((current) => (identityEquals(current, next) ? current : next));
  }, []);

  // All four callbacks are stable, so this value NEVER changes identity —
  // actions-only consumers (EventBuilder) don't re-render on scroll-spy.
  const actionsValue = useMemo(
    () => ({
      setActiveSection,
      registerJumpHandler,
      jumpToSection,
      publishIdentity,
    }),
    [setActiveSection, registerJumpHandler, jumpToSection, publishIdentity],
  );

  const stateValue = useMemo(() => ({ activeSection }), [activeSection]);

  return (
    <EventNavActionsContext.Provider value={actionsValue}>
      <EventNavIdentityContext.Provider value={identity}>
        <EventNavStateContext.Provider value={stateValue}>
          {children}
        </EventNavStateContext.Provider>
      </EventNavIdentityContext.Provider>
    </EventNavActionsContext.Provider>
  );
}

/**
 * Null-safe actions consumer: surfaces render fine without the provider
 * (tests, storybook) — rail anchors then fall back to route navigation.
 * Value identity is stable for the provider's lifetime.
 */
export function useEventNavActions(): EventNavActionsValue | null {
  return useContext(EventNavActionsContext);
}

/**
 * Null-safe state consumer: re-renders on every scroll-spy report. Only the
 * rail (AdminShell) should consume this — never the edit surface itself.
 */
export function useEventNavState(): EventNavStateValue | null {
  return useContext(EventNavStateContext);
}

/**
 * The event facts the mounted edit surface published, scoped to `eventId` so a
 * consumer can never read a previous event's title through a stale publish
 * (route transitions unmount the old builder AFTER the new route commits).
 * Returns null off the edit surface and until `getEventForEdit` resolves.
 */
export function useEventNavIdentity(
  eventId: string | null | undefined,
): EventNavIdentity | null {
  const identity = useContext(EventNavIdentityContext);
  if (!identity || !eventId || identity.eventId !== eventId) return null;
  return identity;
}
