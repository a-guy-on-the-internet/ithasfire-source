"use client";

import { type ReactNode } from "react";
import {
  TicketTierRevealProvider,
  type EventCardTiersResult,
} from "@th/ui";

import { trpc } from "@/trpc";

// Repeat hovers are served from cache rather than re-fetched. Sold-out state can
// drift within this window — acceptable for a discovery hover affordance; the
// event page (one click away) is authoritative.
const TIER_REVEAL_STALE_TIME_MS = 120_000;

/**
 * The lazy tier-fetching hook handed to `EventCard` via `@th/ui`. `enabled`
 * gates the query on the card's hover/focus intent, so it fires only when a
 * pointer or keyboard actually asks for it — never on grid render.
 */
function useEventCardTiers(
  eventId: string,
  enabled: boolean,
): EventCardTiersResult {
  const query = trpc.events.ticketTiersForCard.useQuery(
    { eventId },
    {
      enabled,
      staleTime: TIER_REVEAL_STALE_TIME_MS,
      // A discovery hover panel should never nag the user with an error toast;
      // it simply fails to reveal.
      meta: { silent: true },
    },
  );

  return {
    tiers: query.data?.tiers,
    isPending: query.isPending,
    isError: query.isError,
  };
}

export function EventCardTierRevealProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <TicketTierRevealProvider useEventCardTiers={useEventCardTiers}>
      {children}
    </TicketTierRevealProvider>
  );
}
