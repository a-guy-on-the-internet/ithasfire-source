import { cache } from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";

import {
  fetchEventGateState,
  isLockedByEventGate,
  loadEventSeo,
  resolveEventSlug,
} from "@/server/events";
import { getServerTrpcClient } from "@/server/trpc-client";
import {
  forwardSearchParams,
  type PageSearchParams,
} from "@/lib/forward-search-params";
import {
  eventUnlockCookieName,
  verifyEventUnlockCookie,
} from "@/lib/event-unlock-cookie";
import { hasStripeRedirectParams } from "@/lib/stripe-redirect-return";
import { Checkout } from "./_components/Checkout";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const revalidate = 60;

const getEvent = cache(async (slug: string) => loadEventSeo(slug));
type LoadedEventGateState = Awaited<ReturnType<typeof fetchEventGateState>>;

async function hasValidPasswordUnlockCookie(
  eventId: string,
  gateState: LoadedEventGateState,
): Promise<boolean> {
  if (gateState?.gateType !== "PASSWORD") return false;
  const cookieStore = await cookies();
  return verifyEventUnlockCookie(
    eventId,
    cookieStore.get(eventUnlockCookieName(eventId))?.value,
  );
}

type CheckoutPageParams = {
  params: Promise<{
    slug: string[];
  }>;
  searchParams: Promise<
    {
      resumeOrderId?: string;
    } & PageSearchParams
  >;
};

export default async function CheckoutPage({
  params,
  searchParams,
}: CheckoutPageParams) {
  const { slug: slugSegments } = await params;
  const slug = slugSegments.join("/");
  const query = await searchParams;
  const { resumeOrderId } = query;

  const client = getServerTrpcClient();

  // Gate: ticket purchasing must be enabled
  const gates = await client.features.getFeatureGates.query();
  if (!gates.buyTickets) {
    notFound();
  }

  // Resolved AS THE VIEWER (this route is `private, no-store`, never
  // edge-cached): an old slug of an event that is not publicly readable — a
  // DRAFT, or cancelled / archived without ever going live — redirects only
  // its editors, who can check it out on the canonical URL; for anyone else it
  // is `null`, the same 404 as an unknown slug (N3, `resolveEventBySlug`).
  const resolution = await resolveEventSlug(slug);
  if (!resolution) {
    notFound();
  }

  if (resolution.redirect) {
    // Old slug (from `EventSlugHistory`) → canonical. PERMANENT (308) so the
    // old URL — which may carry a person's name — drops out of indexes. All
    // query params ride along (`resumeOrderId`, `ref`, UTM tags).
    permanentRedirect(
      `/events/checkout/${resolution.currentSlug}${forwardSearchParams(query)}`,
    );
  }

  const gateState = await fetchEventGateState(resolution.eventId);
  const cookieUnlocked = await hasValidPasswordUnlockCookie(
    resolution.eventId,
    gateState,
  );
  if (isLockedByEventGate(gateState, cookieUnlocked)) {
    redirect(`/events/${resolution.currentSlug}`);
  }

  const eventData = await getEvent(resolution.currentSlug);
  if (!eventData) {
    notFound();
  }

  const ticketTypes = await client.events.listEventTicketTypes.query({
    eventId: resolution.eventId,
  });

  // Fetch waiver for this event (if any)
  let waiverData: {
    waiver: { id: string; name: string; body: string; version: number } | null;
  } = { waiver: null };
  try {
    waiverData = await client.waivers.getEventWaiver.query({
      eventId: resolution.eventId,
    });
  } catch (error) {
    // Non-fatal: proceed without waiver if fetch fails.
    console.warn("[checkout/page] getEventWaiver failed", {
      eventId: resolution.eventId,
      error,
    });
  }

  // Fetch the place layout if one is assigned so the checkout can render a seat map.
  let placeLayout: Awaited<
    ReturnType<typeof client.placeLayouts.getPublicPlaceLayout.query>
  > | null = null;
  if (ticketTypes.placeLayoutId) {
    try {
      placeLayout = await client.placeLayouts.getPublicPlaceLayout.query({
        placeLayoutId: ticketTypes.placeLayoutId,
        includeGlyphs: true,
      });
    } catch (error) {
      // Non-fatal: fall back to GA grid if layout fetch fails.
      console.warn("[checkout/page] getPublicPlaceLayout failed", {
        placeLayoutId: ticketTypes.placeLayoutId,
        error,
      });
    }
  }

  return (
    <Checkout
      event={eventData}
      ticketTypes={ticketTypes.ticketTypes}
      placeLayout={placeLayout?.layout ?? null}
      resumeOrderId={resumeOrderId}
      // A Stripe redirect return, read HERE so the server render and the
      // first client render agree (the client reading `window` made the
      // server render the steps and the client the interstitial). Key
      // PRESENCE, the same rule the client hook uses, so a repeated or empty
      // param can never seed "being verified" for a return the hook skips.
      isStripeRedirectReturn={hasStripeRedirectParams(
        (key) => query[key] !== undefined,
      )}
      waiver={waiverData.waiver}
      // Sync an anonymous grant into the buyer's durable unlock before their
      // own API calls (which never carry web-host cookies): the password
      // cookie, or an application grant the API has just confirmed is still
      // APPROVED (`viewerHasApplicationGrant`; persisted for its subject only),
      // or an invite grant the API has just re-checked (`viewerHasInviteGrant`).
      shouldSyncSignedUnlock={Boolean(
        gateState &&
          !gateState.viewerIsUnlocked &&
          (cookieUnlocked ||
            gateState.viewerHasApplicationGrant ||
            gateState.viewerHasInviteGrant),
      )}
      // Tells the sync route which proof belongs to this gate, so a stale
      // cookie of the other kind is never tried.
      signedUnlockGateType={gateState?.gateType ?? null}
    />
  );
}
