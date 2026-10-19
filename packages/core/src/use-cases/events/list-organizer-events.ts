import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const listOrganizerEventsInputSchema = z
  .object({
    /** The event to find siblings for. We exclude this event from results. */
    eventId: z.string().uuid(),
    /** Max number of events to return. */
    limit: z.number().int().min(1).max(20).optional().default(6),
  })
  .strict();

const eventSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  slug: z.string().nullable(),
  startsAt: z.string(),
  heroImageUrl: z.string().nullable(),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  priceCents: z.number().nullable(),
  currency: z.string().nullable(),
});

export const listOrganizerEventsOutputSchema = z.object({
  organizerName: z.string().nullable(),
  events: z.array(eventSummarySchema),
});

export type ListOrganizerEventsInput = z.infer<
  typeof listOrganizerEventsInputSchema
>;
export type ListOrganizerEventsOutput = z.infer<
  typeof listOrganizerEventsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export type ListOrganizerEventsDeps = {
  repos: Repos;
  /**
   * Required (FR-003). Also replaces the bare `new Date()` this use case used
   * for its upcoming-events filter, so the "is it still upcoming" cut and the
   * "what does it cost" read share one injected instant.
   */
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Public use case: given an event, return other upcoming published events by
 * the same organizer (org). Used for the "More by this organizer" section.
 */
export async function listOrganizerEvents(
  deps: ListOrganizerEventsDeps,
  rawInput: unknown,
): Promise<ListOrganizerEventsOutput> {
  const input = parseInput(listOrganizerEventsInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    return { organizerName: null, events: [] };
  }

  if (!event.orgId) {
    // Personal (human-only) events don't have an org to list siblings from.
    return { organizerName: null, events: [] };
  }

  const org = await deps.repos.organizations.getById(event.orgId);
  if (!org) {
    return { organizerName: null, events: [] };
  }

  const result = await deps.repos.events.listByOwner({
    ownerType: "ORGANIZATION",
    ownerId: org.id,
    status: ["PUBLISHED"],
    limit: input.limit + 1, // fetch one extra to account for excluding self
  });

  // Filter: exclude the current event, only upcoming, and limit
  const now = deps.clock.now();
  const siblings = result.items
    .filter((e) => {
      if (e.id === input.eventId) return false;
      if (!e.slug) return false;
      const effectiveEnd = e.endsAt ?? e.startsAt;
      return effectiveEnd >= now;
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, input.limit);

  // Bulk-fetch ticket types for all siblings, then find cheapest per event
  const allTicketTypes = await deps.repos.events.listTicketTypesForEventIds(
    siblings.map((e) => e.id),
  );

  // FR-004: cheapest EFFECTIVE price at `now`, so a "More by this organizer"
  // card stops advertising the early-bird price once the flip has happened.
  // Note this rollup deliberately keeps its pre-existing shape (no ACTIVE
  // filter, no free/paid split) — swapping in the shared `summarizePricing`
  // would change which tiers count and what the card renders, which NFR-001
  // forbids in this migration.
  const cheapestByEventId = new Map<string, number | null>();
  for (const tt of allTicketTypes) {
    const effectiveCents = resolveUnitPriceCents(tt, { now });
    // Same defensive guard as before, moved past the resolver: a row with a
    // non-numeric price still contributes nothing.
    if (typeof effectiveCents !== "number") continue;
    const current = cheapestByEventId.get(tt.eventId);
    if (current == null || effectiveCents < current) {
      cheapestByEventId.set(tt.eventId, effectiveCents);
    }
  }

  // Moderation gate (FR-005): "More by this organizer" is a PUBLIC section, so
  // drop any pending/flagged sibling hero (absent record = legacy = visible).
  // One batched resolveByKeys for the whole list.
  const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, siblings);

  const eventsWithPrices = siblings.map((e) => ({
    id: e.id,
    title: e.title,
    slug: e.slug,
    startsAt: e.startsAt.toISOString(),
    heroImageUrl: gateHeroUrl(e, visibleHeroKeys),
    locality: e.locality ?? null,
    region: e.region ?? null,
    priceCents: cheapestByEventId.get(e.id) ?? null,
    currency: e.currency ?? null,
  }));

  deps.logger?.info("events.list_organizer_events", {
    eventId: input.eventId,
    orgId: org.id,
    resultCount: eventsWithPrices.length,
  });

  return {
    organizerName: org.name,
    events: eventsWithPrices,
  };
}
