"use client";

import { useCallback, useMemo } from "react";

import { ORG_EDIT_OR_FINANCE_ROLES } from "@th/types";
import type { NavigationRailBack } from "@th/ui";

import { guardedNavigate } from "@/hooks/navigation-guard";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { trpc } from "@/trpc";

import type {
  AdminRailContext,
  AdminRailContextDeps,
} from "./admin-context-registry";
import {
  isEventBuildSectionId,
  useEventNavActions,
  useEventNavIdentity,
  useEventNavState,
} from "./event-nav-context";
import {
  buildEventNavSections,
  type EventAdminPathContext,
  type EventDerivedRights,
} from "./event-nav-sections";
import { EventRailContextHeader } from "./EventRailContextHeader";

/** The six event surfaces warmed on context entry (rail clicks feel like tabs). */
const EVENT_PREFETCH_SEGMENTS = [
  "edit",
  "attendees",
  "volunteers",
  "comp-tickets",
  "suggestions",
  "feedback",
] as const;

/**
 * Event-context rail descriptor hook (event-builder regroup FR-202, lifted
 * out of AdminShell by place-admin-rail-context FR-101). On
 * `/admin/[slug]/events/[id]/*` (not the list, not `/events/new`) the rail
 * shows event context: "← All events" back slot, event title + status chip,
 * a Build group of scroll anchors into the edit surface, and a Manage group
 * of the real ops routes.
 *
 * Registered on ADMIN_CONTEXT_REGISTRY; called unconditionally on every
 * AdminShell render with the parsed event path (or null off event routes).
 */
export function useEventRailContext(
  eventContext: EventAdminPathContext | null,
  deps: AdminRailContextDeps,
): AdminRailContext | null {
  const { slug, persistKeyBase, router, t, currentOwner } = deps;

  // Split contexts: actions (stable identities — jump requests down) and
  // state (churny scroll-spy result up). This rail hook consumes both; the
  // edit surface consumes actions only, so scroll-spy never re-renders it.
  const eventNavActions = useEventNavActions();
  const eventNavState = useEventNavState();
  const onEditSurface = eventContext?.subRoute === "edit";

  // What the mounted edit surface already read through `getEventForEdit`.
  // Null off the edit surface and until that read resolves.
  const identity = useEventNavIdentity(eventContext?.eventId);

  // Edit-or-finance rights (ORG_EDIT_OR_FINANCE_ROLES, same derivation as
  // EventAdminPageShell.canEditOrFinanceEvent): humans always edit their own
  // events; orgs need OWNER/ADMIN/EDITOR — plus FINANCE, because FINANCE now
  // reaches a status-gated surface (the comps ledger), so the status that
  // enables it in the rail must resolve for FINANCE too. Without this, the
  // widened comp-tickets rbac showed FINANCE a permanently "post-pub"-disabled
  // item on a live event.
  const workspaceCanEditOrFinance = currentOwner
    ? currentOwner.kind === "human" ||
      ORG_EDIT_OR_FINANCE_ROLES.includes(currentOwner.role)
    : false;

  // Title + status: same query + key the [id] layout primes — React Query
  // dedupes. `getEventTitle` returns `status` too, so ops routes no longer
  // fetch the full `getEventForEdit` payload just for the chip. Status is
  // gated to the roles whose UI consumes it (the chip and the post-publish
  // enablement of comps/suggestions): edit-or-finance since the comps ledger
  // admitted FINANCE. VIEWER and SCANNER keep today's exact behavior (chip
  // hidden, gated items rbac-hidden) even though the title query runs for
  // everyone.
  //
  // NOT on the edit surface, though. On `/edit` the builder is the single
  // reader and publishes title/status/slug/stewardship through
  // `EventNavIdentity`; this query is for the ops routes, where nothing else
  // reads the event. (It was first skipped there because `getEventTitle`
  // refused ownerless COMMUNITY listings; it now admits a community
  // moderator, the same arm as `getEventForEdit`, and still refuses everyone
  // else.)
  const eventTitleQuery = trpc.events.getEventTitle.useQuery(
    { eventId: eventContext?.eventId ?? "" },
    { enabled: Boolean(eventContext) && !onEditSurface, staleTime: 60_000 },
  );
  // One shape for both sources so nothing downstream has to know which one
  // answered.
  const eventFacts = identity ?? eventTitleQuery.data ?? null;

  // An OWNERLESS event (a COMMUNITY listing: no org, no human) belongs to no
  // workspace, so the URL workspace's role says nothing about it — a
  // community moderator who is ADMIN of the URL's org was shown every item
  // that role admits, and the server refused them. Once `getEventTitle` has
  // answered with no owner, the rail's rights are the server's answer about
  // THIS event; until then (and for every owned event) they stay the URL
  // role's, exactly as before. Read off the title query, which on `/edit`
  // still resolves from the cache EventAdminPageShell fills (see `eventMeta`
  // below); the edit surface's identity carries no rights.
  const ownerlessMeta =
    eventTitleQuery.data &&
    eventTitleQuery.data.stewardship === "COMMUNITY" &&
    !eventTitleQuery.data.ownerOrgId &&
    !eventTitleQuery.data.ownerHumanId
      ? eventTitleQuery.data
      : null;
  const ownerlessCanEdit = ownerlessMeta?.viewerCanEdit;
  const ownerlessCanFinance = ownerlessMeta?.viewerCanManagePayouts;
  const eventRights = useMemo<EventDerivedRights | null>(
    () =>
      ownerlessCanEdit === undefined || ownerlessCanFinance === undefined
        ? null
        : {
            canEdit: ownerlessCanEdit,
            // Same mapping as EventAdminPageShell's server-deferred
            // `canEditOrFinanceEvent`: no separate finance answer exists.
            canEditOrFinance: ownerlessCanEdit,
            canFinance: ownerlessCanFinance,
          },
    [ownerlessCanEdit, ownerlessCanFinance],
  );
  const canEditOrFinanceEvents = eventRights
    ? eventRights.canEditOrFinance
    : workspaceCanEditOrFinance;

  const eventStatus =
    eventContext && canEditOrFinanceEvents
      ? (eventFacts?.status ?? undefined)
      : undefined;
  // A person's event: the volunteer roles / signups / badges / rewards reads
  // throw `EVENT_NOT_ORG_OWNED` for it whoever asks, so the rail drops those
  // children. Same rule as EventAdminPageShell's `requireOrgEvent`, which
  // redirects on a loaded meta with no `ownerOrgId`; before the meta loads
  // (or when it failed) the rail keeps its default. An ownerless COMMUNITY
  // listing loads its meta for a community moderator with `ownerOrgId: null`,
  // so it drops those children too — correctly: the volunteer reads refuse
  // an orgless event the same way. Read straight off the
  // title query, not `eventFacts`: the edit surface's identity does not carry
  // the owner, and on `/edit` this still resolves from the cache
  // EventAdminPageShell's own `getEventTitle` fills.
  const eventMeta = eventTitleQuery.data;
  const orgOwned = eventMeta ? Boolean(eventMeta.ownerOrgId) : undefined;
  // Seat prices follow the builder's Seating map button gate. The rail has no
  // seat facts; on an event without seats the page says so.
  const { gates } = useFeatureGates();
  const seatPricesEnabled = Boolean(gates?.seatingLayouts);

  const sections = useMemo(() => {
    if (!eventContext) return null;
    return buildEventNavSections({
      eventId: eventContext.eventId,
      status: eventStatus,
      activeSection: eventNavState?.activeSection ?? null,
      onEditSurface,
      // The edit surface's identity on `/edit`; the title query elsewhere
      // (and on `/edit` too before the builder publishes, via the cache
      // EventAdminPageShell fills). Unknown until either answers, which keeps
      // the full ticketed rail, exactly as before.
      stewardship: identity?.stewardship ?? eventMeta?.stewardship ?? null,
      eventRights,
      orgOwned,
      seatPricesEnabled,
      t,
    });
  }, [
    eventContext,
    eventStatus,
    eventNavState?.activeSection,
    onEditSurface,
    identity?.stewardship,
    eventMeta?.stewardship,
    eventRights,
    orgOwned,
    seatPricesEnabled,
    t,
  ]);

  const eventsListHref = `/admin/${slug}/events`;
  const railBack = useMemo<NavigationRailBack>(
    () => ({
      label: String(t("admin.evNavAllEvents")),
      href: eventsListHref,
      // Through the builder's unsaved-changes guard (rendered as a button
      // on some surfaces, so no link click reaches it).
      onPress: () => guardedNavigate(() => router.push(eventsListHref)),
    }),
    [eventsListHref, router, t],
  );

  /**
   * "View event" target — the same gate the builder header used to apply:
   * PUBLISHED *and* a slug assigned. Read off the query rather than the
   * role-gated `eventStatus`, because a published event's page is public to
   * anyone; withholding the link from a VIEWER or SCANNER would protect
   * nothing and strand the two roles most likely to want it.
   */
  const viewHref = useMemo(() => {
    if (!eventFacts?.slug || eventFacts.status !== "PUBLISHED") return null;
    return `/events/${eventFacts.slug}`;
  }, [eventFacts]);

  const railContextHeader = useMemo(() => {
    if (!eventContext) return undefined;
    const title = eventFacts
      ? eventFacts.title?.trim() || String(t("admin.ebUntitledEvent"))
      : null;
    if (!title && !eventStatus && !viewHref) return undefined;
    return (
      <EventRailContextHeader
        title={title}
        status={eventStatus}
        viewHref={viewHref}
      />
    );
  }, [eventContext, eventFacts, eventStatus, viewHref, t]);

  // Keyed on the event ID — not the match object, which is fresh per pathname
  // — so navigating between one event's surfaces never refires the shell's
  // prefetch effect (same cadence as the old `[eventIdForPrefetch]` effect).
  const eventId = eventContext?.eventId ?? null;
  const prefetchRoutes = useMemo(() => {
    if (!eventId) return null;
    const base = `/admin/${slug}/events/${eventId}`;
    return EVENT_PREFETCH_SEGMENTS.map((segment) => `${base}/${segment}`);
  }, [eventId, slug]);

  // Build anchors (…/edit?section=x): when the edit surface is mounted,
  // scroll in place instead of re-navigating; from an ops route (no jump
  // handler registered) return false so the shell falls through to the
  // router.
  const interceptRouteSelect = useCallback(
    (href: string) => {
      const sectionParam = /\/edit\?section=([a-z]+)$/.exec(href)?.[1];
      return Boolean(
        sectionParam &&
        isEventBuildSectionId(sectionParam) &&
        eventNavActions?.jumpToSection(sectionParam),
      );
    },
    [eventNavActions],
  );

  // FR-202: event context keeps its own collapse state per event id.
  const persistKey = eventId ? `${persistKeyBase}:event:${eventId}` : null;

  // Memoized so unrelated shell re-renders keep a stable context identity —
  // shell consumers (e.g. the SCAN center-action gate) dep on the object.
  return useMemo(() => {
    if (!sections || !persistKey || !prefetchRoutes) return null;
    return {
      descriptorId: "event",
      sections,
      railBack,
      railContextHeader,
      persistKey,
      prefetchRoutes,
      interceptRouteSelect,
    };
  }, [
    sections,
    railBack,
    railContextHeader,
    persistKey,
    prefetchRoutes,
    interceptRouteSelect,
  ]);
}
