"use client";

import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import {
  ORG_EDIT_OR_FINANCE_ROLES,
  ORG_EDIT_ROLES,
  ORG_FINANCE_ROLES,
} from "@th/types";
import { Button, Spinner, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import type { OwnerEntityWithSlug } from "@/hooks/useEventOwnerEntities";

/**
 * Owner context handed to event-admin route pages once the URL slug resolves
 * to an entity the viewer administers. Mirrors what the old tab-driven
 * `/events/[id]` page derived inline before rendering EventBuilder.
 */
export type EventAdminOwnerContext = {
  /** The admin WORKSPACE in the URL (the rail, the "back to events" links). */
  currentOwner: OwnerEntityWithSlug;
  /**
   * The EVENT's owner — what owner-scoped pickers (saved locations, places,
   * promos, share dialog, order-migration targets) must be scoped to. Equal
   * to the URL workspace in the normal case; the PRINCIPAL when a delegate
   * manages a principal's personal event (owner ruling 2026-09-28).
   */
  ownerType: "human" | "org";
  ownerId: string;
  /**
   * Whether the viewer can mutate this event. Humans editing their own
   * profile-owned events always can; for orgs only OWNER/ADMIN/EDITOR can —
   * Non-editing roles reach some of these pages for read paths (FINANCE:
   * attendees and the comps ledger).
   */
  canEditEvent: boolean;
  /**
   * Whether the viewer may take ADMIN-LEVEL actions on this event: unpublish,
   * cancel, regenerate a PUBLISHED event's slug. Narrower than
   * `canEditEvent` — ORG_ADMIN_ROLES on an org event; the owner or an
   * OWNER/ADMIN delegate on a personal one — the bar `unpublish-event`,
   * `cancel-event` and `regenerate-event-slug` enforce. An EDITOR can edit
   * and publish but is not offered the takedown actions the server refuses.
   */
  canManageEvent: boolean;
};

export type EventAdminPageShellProps = {
  slug: string;
  eventId: string;
  /**
   * Route-level parity with EventBuilder's tab gating (FR-203): require edit
   * rights to view this surface. Viewers without them are redirected to the
   * org's events list — the same terminal the in-builder tab fallback gave
   * them (they never saw the tab at all).
   */
  requireEdit?: boolean;
  /**
   * Require edit OR finance rights. Attendees and the comps ledger are the
   * cases: reading the door list / who got in free is part of running the
   * event (EDITOR), and it is also finance data (FINANCE) — but VIEWER and
   * SCANNER get neither. Matches the role set `searchEventAttendees` /
   * `listCompOrders` enforce server-side, so the rail, the route and the
   * query agree instead of routing two roles into a 403.
   */
  requireEditOrFinance?: boolean;
  /**
   * Require finance rights. Volunteer rewards is the case: reward config and
   * the grant ledger are ORG_FINANCE_ROLES-gated server-side, and while it was
   * a tab the client simply didn't render it for non-finance actors. As a
   * route it is directly addressable, so the gate has to move here.
   */
  requireFinance?: boolean;
  /**
   * Require the EVENT to be org-owned. The volunteer roles / signups / badges
   * / rewards reads throw `EVENT_NOT_ORG_OWNED` for a person's event whoever
   * asks — the owner included — so no role gate can express it. Checked
   * against the event meta (not the URL workspace), after the role gates;
   * a failing event gets the same redirect to the events list.
   */
  requireOrgEvent?: boolean;
  /**
   * Refuse a COMMUNITY listing: the surface serves nothing on one, whoever
   * asks (comps, the order-backed door list, volunteer setup, private
   * feedback; owner ruling 2026-10-07). The rail already hides these; this
   * covers a typed URL. Checked against the loaded event meta, like
   * `requireOrgEvent`, with the same redirect to the events list.
   */
  forbidCommunity?: boolean;
  /**
   * FR-203: this surface only exists for PUBLISHED events (comp tickets,
   * suggested edits — both were tabs gated on `eventStatus === "PUBLISHED"`).
   * Implies the read gate of whichever role requirement the caller set —
   * `requireEdit` semantics by default, widened to edit-or-finance when
   * combined with `requireEditOrFinance` (the comps ledger). On a
   * non-PUBLISHED event, editors redirect to the event's edit route;
   * non-editing readers (FINANCE) to the events list.
   */
  requirePublished?: boolean;
  children: (ctx: EventAdminOwnerContext) => ReactNode;
};

/**
 * Shared scaffolding for every route under `/admin/[slug]/events/[id]`
 * (edit / attendees / volunteers / comp-tickets / suggestions / feedback):
 * resolves the admin owner from the slug, renders the loading / error /
 * no-access states, applies route-level RBAC + status gates, and only then
 * hands the resolved owner context to the page. Extracted from the old
 * tab-driven `/events/[id]` page so the six routes don't copy-paste it.
 */
export function EventAdminPageShell({
  slug,
  eventId,
  requireEdit = false,
  requireEditOrFinance = false,
  requireFinance = false,
  requireOrgEvent = false,
  forbidCommunity = false,
  requirePublished = false,
  children,
}: EventAdminPageShellProps) {
  const router = useRouter();
  const t = useTranslations();
  const { currentOwner, isLoading, isError, ownerEntities } =
    useCurrentAdminOwner(slug);

  const handleRetry = useCallback(() => {
    void ownerEntities.refetch();
  }, [ownerEntities]);

  // The EVENT's owner and the server's answer on the viewer's rights, from
  // the LIGHT `getEventTitle` query — same `{ eventId }` key + 60s staleTime
  // the `[id]` layout and AdminShell's rail already use, so React Query
  // dedupes it into the fetch those already made. It used to run only for
  // the status gate; it now always runs, because the URL workspace is not
  // proof of anything about the event: `/admin/@<delegate>/events/<the
  // principal's event>/edit` resolves `currentOwner` to the DELEGATE, and
  // deriving rights and picker scope from that handed a VIEWER delegate an
  // edit UI and scoped every picker to the wrong human.
  const eventTitleQuery = trpc.events.getEventTitle.useQuery(
    { eventId },
    { enabled: Boolean(currentOwner), staleTime: 60_000 },
  );
  const eventMeta = eventTitleQuery.data;
  // True when the event belongs to someone other than the URL workspace —
  // a delegate managing the principal's personal event. Only then do the
  // gates below defer to the server; the normal path is unchanged.
  const eventOwnerDiffers = Boolean(
    currentOwner &&
    eventMeta &&
    (eventMeta.ownerOrgId
      ? currentOwner.kind !== "org" ||
        currentOwner.orgId !== eventMeta.ownerOrgId
      : eventMeta.ownerHumanId
        ? currentOwner.kind !== "human" ||
          currentOwner.humanId !== eventMeta.ownerHumanId
        : false),
  );
  // An OWNERLESS event (a COMMUNITY listing: no org, no human) is no
  // workspace's, so the URL workspace's role says nothing about it: a
  // community moderator who is ADMIN of the URL's org passed every gate below
  // on that role, for pages the server then refused. Once the meta says
  // "no owner", the gates are the server's answer, the same deferral as a
  // differing owner. Before it loads, nothing changes.
  const eventOwnerless = Boolean(
    eventMeta &&
    eventMeta.stewardship === "COMMUNITY" &&
    !eventMeta.ownerOrgId &&
    !eventMeta.ownerHumanId,
  );
  const deferToServer = eventOwnerDiffers || eventOwnerless;

  // The three role gates below use the canonical @th/types sets (client
  // mirrors of core/lib/rbac.ts) — the same constants the event rail's
  // `rbac` annotations reference, so the rail and the routes cannot drift.
  // Personal workspaces err open on every gate: a human always has every
  // right over their own profile-owned event. `kind === "human"` failing is
  // what narrows the union to the org variant carrying `role`. When the
  // event is NOT the workspace's own (or is no one's), every gate is the
  // server's answer.
  const canEditEvent = deferToServer
    ? Boolean(eventMeta?.viewerCanEdit)
    : currentOwner
      ? currentOwner.kind === "human" ||
        ORG_EDIT_ROLES.includes(currentOwner.role)
      : false;

  // Admin-level actions (unpublish / cancel / regenerate a published slug).
  // The URL workspace's answer is the events list's `canManage` (same hook);
  // when the event is someone else's, only the server can tell an ADMIN
  // delegate from an EDITOR one.
  const { canManage: workspaceCanManage } =
    useAdminOwnerCapabilities(currentOwner);
  const canManageEvent = deferToServer
    ? Boolean(eventMeta?.viewerCanManage)
    : workspaceCanManage;

  const canEditOrFinanceEvent = deferToServer
    ? Boolean(eventMeta?.viewerCanEdit)
    : currentOwner
      ? currentOwner.kind === "human" ||
        ORG_EDIT_OR_FINANCE_ROLES.includes(currentOwner.role)
      : false;

  // Volunteer rewards: OWNER / ADMIN / FINANCE only, which is what the
  // reward procedures enforce server-side. A delegate is not the principal's
  // finance: payout-adjacent surfaces stay with the owner.
  const canFinanceEvent = deferToServer
    ? Boolean(eventMeta?.viewerCanManagePayouts)
    : currentOwner
      ? currentOwner.kind === "human" ||
        ORG_FINANCE_ROLES.includes(currentOwner.role)
      : false;

  // The role set that may READ a `requirePublished` surface. Historically
  // this was hard-coupled to `canEditEvent`, which silently narrowed any
  // `requireEditOrFinance + requirePublished` combination back down to
  // edit-only: FINANCE passed the role gate and then bounced off the
  // published gate's edit-rights precondition (the comp-tickets ledger hit
  // exactly this — its read contract is ORG_EDIT_OR_FINANCE_ROLES). When the
  // caller widened the role gate, the published gate must key off the same
  // widened set; for every other caller this resolves to `canEditEvent`
  // exactly as before.
  const canReadPublishedSurface = requireEditOrFinance
    ? canEditOrFinanceEvent
    : canEditEvent;

  // Status gate (comp / suggestions): the LIGHT `getEventTitle` query (which
  // carries `status`) with the same `{ eventId }` key + 60s staleTime the
  // `[id]` layout and AdminShell's rail already use — React Query dedupes all
  // three into one fetch that stays warm (and observed, so never GC'd) for
  // the whole time the user is on any event route. Ops-route navigations
  // therefore gate against cached data instantly instead of spinning on a
  // fresh fetch of the heavy `getEventForEdit` payload per navigation. Only
  // enabled when a PUBLISHED gate applies and the viewer can read the
  // surface — otherwise we redirect before status matters. Gate semantics
  // are unchanged for edit-gated callers: same status field, same error →
  // edit-route redirect.
  const needsStatus =
    requirePublished && Boolean(currentOwner) && canReadPublishedSurface;
  const eventStatusQuery = eventTitleQuery;

  const editHref = `/admin/${slug}/events/${eventId}/edit`;
  const eventsHref = `/admin/${slug}/events`;

  // FR-203 fallback: a viewer landing on a route they couldn't see as a tab
  // gets redirected (never a broken page) — to the edit route when only the
  // status gate fails, or to the events list when they lack edit rights.
  const redirectTarget = useMemo(() => {
    if (!currentOwner) return null;
    if (requireEdit && !canEditEvent) return eventsHref;
    // `requirePublished` implies the read gate of whichever role requirement
    // the caller set (edit by default, edit-or-finance when widened) — NOT
    // unconditionally `canEditEvent`, which would bounce FINANCE off a
    // surface whose role gate just admitted them.
    if (requirePublished && !canReadPublishedSurface) return eventsHref;
    if (requireEditOrFinance && !canEditOrFinanceEvent) return eventsHref;
    if (requireFinance && !canFinanceEvent) return eventsHref;
    // Waits for the meta (the spinner below covers the gap); a FAILED meta
    // renders the retry card rather than guessing either way.
    if (requireOrgEvent && eventMeta && !eventMeta.ownerOrgId) {
      return eventsHref;
    }
    if (forbidCommunity && eventMeta?.stewardship === "COMMUNITY") {
      return eventsHref;
    }
    if (needsStatus) {
      // Editors go to the edit surface, which owns the real error/status
      // presentation for this event. A FINANCE-only viewer can't act there —
      // an unpublished event simply has no readable surface for them yet, so
      // they go back to the events list. A FAILED fetch no longer redirects:
      // it renders the retry state below, because without the event meta the
      // shell cannot tell whose event this is.
      const statusFailHref = canEditEvent ? editHref : eventsHref;
      if (
        eventStatusQuery.data &&
        eventStatusQuery.data.status !== "PUBLISHED"
      ) {
        return statusFailHref;
      }
    }
    return null;
  }, [
    currentOwner,
    requireEdit,
    requireEditOrFinance,
    requireFinance,
    requireOrgEvent,
    forbidCommunity,
    requirePublished,
    eventMeta,
    canEditEvent,
    canEditOrFinanceEvent,
    canFinanceEvent,
    canReadPublishedSurface,
    needsStatus,
    eventStatusQuery.data,
    editHref,
    eventsHref,
  ]);

  useEffect(() => {
    if (redirectTarget) {
      router.replace(redirectTarget);
    }
  }, [redirectTarget, router]);

  // 1. Loading — session resolving or owner query in flight. Only this state
  // shows an open-ended spinner.
  //
  // `isPending` (React Query v5 `status: "pending"`) is true whenever there's
  // no data yet and no error — this includes the window where the query is
  // still disabled because the auth session hasn't resolved. Treat that as
  // loading so we don't briefly flash the "no access" terminal state below.
  const isPendingResult = ownerEntities.isPending && !isError;
  if (isLoading || isPendingResult) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$3"
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.loadingEventBuilder"))}
        </Text>
      </YStack>
    );
  }

  // 2. Error — the owner query failed (e.g. transient UNAUTHORIZED while the
  // API was down). Offer an actionable retry instead of hanging forever.
  if (isError) {
    return (
      <LoadErrorCard
        onRetry={handleRetry}
        retrying={ownerEntities.isFetching}
      />
    );
  }

  // 3. No access / not found — the query succeeded but the slug matches none of
  // the user's owned entities. Terminal state; retrying won't help.
  if (!currentOwner) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$3"
      >
        <Text variant="h3" tone="muted">
          {String(t("admin.eventBuilderNoAccessTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("admin.eventBuilderNoAccessDescription"))}
        </Text>
        <Button
          size="$3"
          variant="secondary"
          onPress={() => {
            router.push("/admin");
          }}
        >
          {String(t("admin.eventBuilderBackToAdmin"))}
        </Button>
      </YStack>
    );
  }

  // 3b. The event meta failed. It is what says whose event this is and what
  // the server lets this viewer do; falling back to the URL workspace's
  // rights and picker scope would reopen the `/admin/@<delegate>/events/
  // <principal's event>` hole. Retry, don't guess. (Role-gate redirects above
  // only ever narrow, so one that already fired still wins.)
  // Only when there is NO cached meta: a failed BACKGROUND refetch keeps the
  // last good answer (React Query retains `data` alongside `isError`), and
  // tearing the builder down over a transient refetch error would throw away
  // unsaved edits.
  if (eventTitleQuery.isError && !eventTitleQuery.data && !redirectTarget) {
    return (
      <LoadErrorCard
        onRetry={() => {
          void eventTitleQuery.refetch();
        }}
        retrying={eventTitleQuery.isFetching}
      />
    );
  }

  // 4. Gate resolving / redirecting — keep the spinner up while the event
  // meta settles or while the useEffect above performs the replace, so a
  // gated page never flashes its (forbidden) content — including an edit UI
  // on an event the URL workspace does not own. With cached meta (`data`
  // present — the title query is primed by the [id] layout and kept warm
  // across ops-route navigations) this branch is skipped entirely, so the
  // spinner only appears on a genuinely cold load. A FAILED meta fetch is the
  // retry card above, never the page.
  const eventMetaPending = !eventTitleQuery.data && !eventTitleQuery.isError;
  if (
    redirectTarget ||
    (needsStatus && !eventStatusQuery.data) ||
    eventMetaPending
  ) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$3"
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.loadingEventBuilder"))}
        </Text>
      </YStack>
    );
  }

  // Owner-scoped pickers follow the EVENT's owner (see the context type).
  let ownerType: "human" | "org" = currentOwner.kind;
  let ownerId =
    currentOwner.kind === "human" ? currentOwner.humanId : currentOwner.orgId;
  if (eventOwnerDiffers && eventMeta) {
    if (eventMeta.ownerOrgId) {
      ownerType = "org";
      ownerId = eventMeta.ownerOrgId;
    } else if (eventMeta.ownerHumanId) {
      ownerType = "human";
      ownerId = eventMeta.ownerHumanId;
    }
  }

  const page = children({
    currentOwner,
    ownerType,
    ownerId,
    canEditEvent,
    canManageEvent,
  });
  if (!eventOwnerDiffers) {
    return <>{page}</>;
  }
  return (
    <>
      <ManagingOtherOwnerBanner ownerName={eventMeta?.ownerHumanName ?? null} />
      {page}
    </>
  );
}

/** The load-failure card: title, one line, and a Retry button. */
function LoadErrorCard({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useTranslations();
  return (
    <YStack
      padding="$5"
      alignItems="center"
      justifyContent="center"
      minHeight={300}
      gap="$3"
    >
      <Text variant="h3" tone="muted">
        {String(t("admin.eventBuilderLoadErrorTitle"))}
      </Text>
      <Text variant="body" tone="muted" textAlign="center">
        {String(t("admin.eventBuilderLoadErrorDescription"))}
      </Text>
      <Button size="$3" variant="primary" onPress={onRetry} disabled={retrying}>
        {retrying ? <Spinner size="sm" /> : null}
        {String(
          t(
            retrying ? "admin.eventBuilderRetrying" : "admin.eventBuilderRetry",
          ),
        )}
      </Button>
    </YStack>
  );
}

/**
 * One line above an event page whose event belongs to someone other than the
 * URL workspace — a delegate managing their principal's personal event. No
 * navigation of its own: there is no principal switcher yet (a reported
 * product gap), so this only says whose event is being changed.
 */
function ManagingOtherOwnerBanner({ ownerName }: { ownerName: string | null }) {
  const t = useTranslations();
  return (
    <YStack
      role="status"
      data-testid="managing-other-owner-banner"
      paddingHorizontal="$4"
      paddingVertical="$2"
      backgroundColor="$surfaceMuted"
    >
      <Text variant="caption" tone="muted">
        {String(
          ownerName
            ? t("admin.ebManagingPrincipalEvent", { name: ownerName })
            : t("admin.ebManagingDelegatedEvent"),
        )}
      </Text>
    </YStack>
  );
}

// `EventOpsPageFrame` used to live here: a bare `min-height: 100vh` div that
// owned no header, no container and no action slot, so all five ops surfaces
// invented their own (four container widths, two centring idioms, five heading
// treatments). Replaced by `EventOpsShell`, which each surface renders itself
// so it can fill the shell's filter slot from its own state.
