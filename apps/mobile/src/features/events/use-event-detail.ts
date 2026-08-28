import { useCallback, useMemo } from "react";

import {
  resolveCheckoutPath,
  type CheckoutPath,
} from "@/features/checkout/checkout-eligibility";
import { trpc, type RouterOutputs } from "@/lib/trpc";

export type EventGateState = RouterOutputs["events"]["getGateState"];
export type EventSeo = RouterOutputs["events"]["getEventSeo"];
export type EventBodyPayload = RouterOutputs["events"]["getPublicEventBody"];
export type EventTicketTypes = RouterOutputs["events"]["listEventTicketTypes"];
export type EventGatedPreview = RouterOutputs["events"]["getGatedPreview"];

export type EventDetailStatus = "loading" | "error" | "locked" | "ready";

/**
 * Bundles every query behind the event detail screen.
 *
 * Flow: resolve slug → gate state (+ feature gates) → either the gated
 * preview (locked) or the full detail set (SEO, body, ticket types, waiver).
 * The gated detail procedures are FORBIDDEN while the gate is locked, so
 * they stay disabled until `passwordRequired`/`applicationRequired` clear —
 * `EventPasswordSheet` invalidates the gate state on unlock, which flips
 * `enabled` and fetches them fresh.
 */
export const useEventDetail = (eventSlug: string) => {
  const resolveQuery = trpc.events.resolveEventBySlug.useQuery(
    { slug: eventSlug },
    { enabled: eventSlug.length > 0 },
  );
  const eventId = resolveQuery.data?.eventId;
  // Old slugs resolve with redirect=true; slug-based procedures 404 on them,
  // so always query with the canonical slug.
  const currentSlug = resolveQuery.data?.currentSlug;

  const gateQuery = trpc.events.getGateState.useQuery(
    { eventId: eventId ?? "" },
    { enabled: !!eventId },
  );
  const featureGatesQuery = trpc.features.getFeatureGates.useQuery(undefined, {
    staleTime: 60_000,
  });

  const gate = gateQuery.data;
  const isLocked =
    !!gate && (gate.passwordRequired || gate.applicationRequired);
  const detailEnabled = !!eventId && !!currentSlug && !!gate && !isLocked;

  const seoQuery = trpc.events.getEventSeo.useQuery(
    { slug: currentSlug ?? "" },
    { enabled: detailEnabled },
  );
  const bodyQuery = trpc.events.getPublicEventBody.useQuery(
    { slug: currentSlug ?? "" },
    { enabled: detailEnabled },
  );
  const ticketTypesQuery = trpc.events.listEventTicketTypes.useQuery(
    { eventId: eventId ?? "" },
    { enabled: detailEnabled },
  );
  const waiverQuery = trpc.waivers.getEventWaiver.useQuery(
    { eventId: eventId ?? "" },
    { enabled: detailEnabled },
  );
  const gatedPreviewQuery = trpc.events.getGatedPreview.useQuery(
    { eventId: eventId ?? "" },
    { enabled: !!eventId && isLocked },
  );

  const status: EventDetailStatus =
    resolveQuery.isError || gateQuery.isError
      ? "error"
      : !resolveQuery.data || !gate
        ? "loading"
        : isLocked
          ? gatedPreviewQuery.isError
            ? "error"
            : "locked"
          : seoQuery.isError
            ? "error"
            : seoQuery.data
              ? "ready"
              : "loading";

  /**
   * Null until every input that can still change the answer has loaded —
   * the CTA area renders nothing in the meantime (no flash of the wrong CTA).
   */
  const checkoutPath: CheckoutPath | null = useMemo(() => {
    const featureGates = featureGatesQuery.data;
    if (!gate || !featureGates) return null;
    if (!isLocked && (!ticketTypesQuery.data || !waiverQuery.data)) {
      return null;
    }
    return resolveCheckoutPath({
      enableBuyTickets: featureGates.buyTickets,
      sellabilityAvailable:
        ticketTypesQuery.data?.sellability.available ?? null,
      gateType: gate.gateType,
      passwordRequired: gate.passwordRequired,
      viewerCanBypass: gate.viewerCanBypass,
      viewerIsUnlocked: gate.viewerIsUnlocked,
      placeLayoutId: ticketTypesQuery.data?.placeLayoutId ?? null,
      hasWaiver: waiverQuery.data ? waiverQuery.data.waiver !== null : null,
    });
  }, [
    featureGatesQuery.data,
    gate,
    isLocked,
    ticketTypesQuery.data,
    waiverQuery.data,
  ]);

  const queries = [
    resolveQuery,
    gateQuery,
    featureGatesQuery,
    seoQuery,
    bodyQuery,
    ticketTypesQuery,
    waiverQuery,
    gatedPreviewQuery,
  ];
  const isRefreshing = queries.some((q) => q.isFetching && !q.isLoading);

  const refresh = useCallback(() => {
    void Promise.all([
      resolveQuery.refetch(),
      gateQuery.refetch(),
      featureGatesQuery.refetch(),
      ...(detailEnabled
        ? [
            seoQuery.refetch(),
            bodyQuery.refetch(),
            ticketTypesQuery.refetch(),
            waiverQuery.refetch(),
          ]
        : []),
      ...(isLocked ? [gatedPreviewQuery.refetch()] : []),
    ]);
  }, [
    bodyQuery,
    detailEnabled,
    featureGatesQuery,
    gateQuery,
    gatedPreviewQuery,
    isLocked,
    resolveQuery,
    seoQuery,
    ticketTypesQuery,
    waiverQuery,
  ]);

  return {
    status,
    eventId,
    currentSlug,
    gate,
    checkoutPath,
    seo: seoQuery.data,
    body: bodyQuery.data,
    ticketTypes: ticketTypesQuery.data,
    ticketTypesFailed: ticketTypesQuery.isError,
    ticketTypesPending: detailEnabled && ticketTypesQuery.isPending,
    gatedPreview: gatedPreviewQuery.data,
    isRefreshing,
    refresh,
  };
};
