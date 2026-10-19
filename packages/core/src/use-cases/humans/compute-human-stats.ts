import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/types";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const DEFAULT_PAGE_SIZE = 100;
const PUBLIC_SCAN_PAGE_SIZE = 500;
const LAST_90_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export const computeHumanStatsInputSchema = z
  .object({
    humanId: z.string().uuid().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .default(DEFAULT_PAGE_SIZE),
  })
  .strict()
  .optional()
  .default({ limit: DEFAULT_PAGE_SIZE });

export type ComputeHumanStatsInput = z.infer<
  typeof computeHumanStatsInputSchema
>;

export type ComputeHumanStatsOutput = {
  humansProcessed: number;
  humanIds: string[];
};

export type ComputeHumanStatsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

type TicketAttributionRecord = Awaited<
  ReturnType<Repos["ticketAttributions"]["listByAttributedHuman"]>
>[number];

type CountMap = Map<string, number>;

type TopCity = {
  city: string;
  state?: string;
  country: string;
  tickets: number;
};

function increment(map: CountMap, key: string, amount: number) {
  if (!key || amount <= 0) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

function roundTo(value: number, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sumTicketQty(
  items: Array<{ kind?: string; qty?: number }> | undefined | null,
): number {
  return (items ?? []).reduce((sum, item) => {
    if (item.kind !== "ticket") return sum;
    return sum + (typeof item.qty === "number" ? item.qty : 0);
  }, 0);
}

function sortCountEntries(entries: Array<[string, number]>) {
  return entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (a[0] === "direct" && b[0] !== "direct") return 1;
    if (b[0] === "direct" && a[0] !== "direct") return -1;
    return a[0].localeCompare(b[0]);
  });
}

function topKeys(map: CountMap, limit = 5): string[] | null {
  if (map.size === 0) return null;
  return sortCountEntries([...map.entries()])
    .slice(0, limit)
    .map(([key]) => key);
}

function topChannelBreakdown(
  map: CountMap,
  limit = 5,
): Array<{ source: string; tickets: number }> | null {
  if (map.size === 0) return null;
  return sortCountEntries([...map.entries()])
    .slice(0, limit)
    .map(([source, tickets]) => ({ source, tickets }));
}

function topCities(map: Map<string, TopCity>, limit = 5): TopCity[] | null {
  if (map.size === 0) return null;
  return [...map.values()]
    .sort((a, b) => {
      if (b.tickets !== a.tickets) return b.tickets - a.tickets;
      if (a.city !== b.city) return a.city.localeCompare(b.city);
      return (a.state ?? "").localeCompare(b.state ?? "");
    })
    .slice(0, limit);
}

function channelForAttribution(attribution: TicketAttributionRecord): string {
  if (attribution.utmSource?.trim())
    return attribution.utmSource.trim().toLowerCase();
  if (attribution.source === "CHECKOUT_SELECT") return "checkout_select";
  if (attribution.source === "REF_LINK") return "ref_link";
  return "direct";
}

function isEligibleDrawEvent(
  event: EventRecord | undefined,
  now: Date,
): event is EventRecord {
  return Boolean(
    event &&
    event.status !== "CANCELLED" &&
    event.status !== "ARCHIVED" &&
    event.startsAt.getTime() <= now.getTime(),
  );
}

async function listTargetHumanIds(
  repos: Repos,
  explicitHumanId: string | undefined,
  pageSize: number,
): Promise<string[]> {
  if (explicitHumanId) {
    return [explicitHumanId];
  }

  const humanIds: string[] = [];
  let offset = 0;

  while (true) {
    const page = await repos.humans.listAllWithMemberships({
      status: "ACTIVE",
      limit: pageSize,
      offset,
      sort: "createdAt_desc",
    });

    for (const item of page.items) {
      humanIds.push(item.human.id);
    }

    offset += page.items.length;
    const total =
      "pageInfo" in page ? (page as any).pageInfo.total : (page as any).total;
    if (page.items.length === 0 || offset >= total) break;
  }

  return humanIds;
}

async function buildPublishedPerformerEventMap(
  repos: Repos,
  targetHumanIds: string[],
): Promise<Map<string, Set<string>>> {
  const targetSet = new Set(targetHumanIds);
  const humanEventMap = new Map<string, Set<string>>();
  let offset = 0;

  while (true) {
    const page = await repos.events.listPublished({
      limit: PUBLIC_SCAN_PAGE_SIZE,
      offset,
    });

    for (const event of page.items) {
      const performers = await repos.eventHumans.listByEvent(event.id);
      for (const performer of performers) {
        if (
          performer.role !== "PERFORMER" ||
          !performer.humanId ||
          !targetSet.has(performer.humanId)
        ) {
          continue;
        }

        const existing =
          humanEventMap.get(performer.humanId) ?? new Set<string>();
        existing.add(event.id);
        humanEventMap.set(performer.humanId, existing);
      }
    }

    offset += page.items.length;
    const total =
      "pageInfo" in page ? (page as any).pageInfo.total : (page as any).total;
    if (page.items.length === 0 || offset >= total) break;
  }

  return humanEventMap;
}

async function getFollowerCount(
  repos: Repos,
  ownerType: "HUMAN" | "ORGANIZATION",
  ownerId: string,
): Promise<number> {
  const page = await repos.entityPages.getByOwner(ownerType, ownerId);
  if (!page) return 0;
  return repos.follows.countByEntity(page.id);
}

export async function computeHumanStats(
  deps: ComputeHumanStatsDeps,
  rawInput?: unknown,
): Promise<ComputeHumanStatsOutput> {
  const input = parseInput(computeHumanStatsInputSchema, rawInput ?? {});
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - LAST_90_DAYS_MS);

  const targetHumanIds = await listTargetHumanIds(
    deps.repos,
    input.humanId,
    input.limit ?? DEFAULT_PAGE_SIZE,
  );
  if (targetHumanIds.length === 0) {
    return { humansProcessed: 0, humanIds: [] };
  }

  const publishedPerformerEvents = await buildPublishedPerformerEventMap(
    deps.repos,
    targetHumanIds,
  );
  const processedHumanIds: string[] = [];
  const categoryNameCache = new Map<string, string | null>();

  for (const humanId of targetHumanIds) {
    const human = await deps.repos.humans.getById(humanId);
    if (!human) {
      if (input.humanId === humanId) {
        throw fail("HUMAN_NOT_FOUND");
      }
      continue;
    }

    const attributions =
      await deps.repos.ticketAttributions.listByAttributedHuman(humanId);
    const attributionEventIds = new Set(
      attributions.map((item) => item.eventId),
    );
    const performedEventIds = new Set<string>([
      ...attributionEventIds,
      ...(publishedPerformerEvents.get(humanId) ?? new Set<string>()),
    ]);

    const eventIds = [...performedEventIds];
    const eventMap = new Map<string, EventRecord>();
    if (eventIds.length > 0) {
      const events = await deps.repos.events.findManyByIds(eventIds);
      for (const event of events) {
        eventMap.set(event.id, event);
      }
    }

    const orderQtyCache = new Map<string, number>();
    const placeCounts = new Map<string, number>();
    const genreCounts = new Map<string, number>();
    const channelCounts = new Map<string, number>();
    const cityCounts = new Map<string, TopCity>();
    const consentedFanIds = new Set<string>();
    const repeatFanEvents = new Map<string, Set<string>>();
    const eligiblePerformedEventIds = new Set<string>();

    let totalTicketsAttributed = 0;
    let last90DayTickets = 0;
    const last90DayEventIds = new Set<string>();

    for (const attribution of attributions) {
      const event = eventMap.get(attribution.eventId);
      if (!isEligibleDrawEvent(event, now)) {
        continue;
      }

      eligiblePerformedEventIds.add(event.id);

      let ticketQty = orderQtyCache.get(attribution.orderId);
      if (ticketQty === undefined) {
        const order = await deps.repos.orders.getById(attribution.orderId);
        ticketQty = sumTicketQty(order?.items);
        orderQtyCache.set(attribution.orderId, ticketQty);
      }

      totalTicketsAttributed += ticketQty;

      const activityDate = event.startsAt;
      if (activityDate.getTime() >= cutoff.getTime()) {
        last90DayTickets += ticketQty;
        last90DayEventIds.add(attribution.eventId);
      }

      if (attribution.trackingConsent === "GRANTED") {
        if (attribution.fanHumanId) {
          consentedFanIds.add(attribution.fanHumanId);
          const fanEvents =
            repeatFanEvents.get(attribution.fanHumanId) ?? new Set<string>();
          fanEvents.add(attribution.eventId);
          repeatFanEvents.set(attribution.fanHumanId, fanEvents);
        }

        if (ticketQty > 0 && attribution.fanCity && attribution.fanCountry) {
          const cityKey = `${attribution.fanCity}||${attribution.fanState ?? ""}||${attribution.fanCountry}`;
          const existing = cityCounts.get(cityKey) ?? {
            city: attribution.fanCity,
            state: attribution.fanState ?? undefined,
            country: attribution.fanCountry,
            tickets: 0,
          };
          existing.tickets += ticketQty;
          cityCounts.set(cityKey, existing);
        }
      }

      increment(channelCounts, channelForAttribution(attribution), ticketQty);

      if (event?.placeId) {
        increment(placeCounts, event.placeId, ticketQty);
      }

      if (event?.categoryId) {
        let categoryName = categoryNameCache.get(event.categoryId);
        if (categoryName === undefined) {
          categoryName =
            (await deps.repos.categories.getById(event.categoryId))?.name ??
            null;
          categoryNameCache.set(event.categoryId, categoryName);
        }
        if (categoryName) {
          increment(genreCounts, categoryName, ticketQty);
        }
      }
    }

    for (const eventId of performedEventIds) {
      if (attributionEventIds.has(eventId)) continue;
      const event = eventMap.get(eventId);
      if (!isEligibleDrawEvent(event, now)) continue;

      eligiblePerformedEventIds.add(event.id);

      if (event.placeId) {
        increment(placeCounts, event.placeId, 1);
      }

      if (event.categoryId) {
        let categoryName = categoryNameCache.get(event.categoryId);
        if (categoryName === undefined) {
          categoryName =
            (await deps.repos.categories.getById(event.categoryId))?.name ??
            null;
          categoryNameCache.set(event.categoryId, categoryName);
        }
        if (categoryName) {
          increment(genreCounts, categoryName, 1);
        }
      }

      if (event.startsAt.getTime() >= cutoff.getTime()) {
        last90DayEventIds.add(eventId);
      }
    }

    const repeatFanCount = [...repeatFanEvents.values()].filter(
      (events) => events.size >= 2,
    ).length;
    const followerCount = await getFollowerCount(deps.repos, "HUMAN", humanId);
    const totalEventsPerformed = eligiblePerformedEventIds.size;

    await deps.repos.humanStats.upsert(humanId, {
      totalEventsPerformed,
      totalTicketsAttributed,
      avgDrawPerEvent:
        totalEventsPerformed > 0
          ? roundTo(totalTicketsAttributed / totalEventsPerformed)
          : null,
      topCities: topCities(cityCounts),
      topPlaceIds: topKeys(placeCounts),
      topGenres:
        topKeys(genreCounts) ??
        (human.genreTags.length > 0 ? [...human.genreTags].slice(0, 5) : null),
      channelBreakdown: topChannelBreakdown(channelCounts),
      totalConsentedFans: consentedFanIds.size,
      repeatFanCount,
      followerCount,
      last90DayTickets,
      last90DayEvents: last90DayEventIds.size,
      computedAt: now,
    });

    processedHumanIds.push(humanId);
  }

  deps.logger?.info("humans.compute-human-stats.completed", {
    humansProcessed: processedHumanIds.length,
    humanIds: processedHumanIds,
  });

  return {
    humansProcessed: processedHumanIds.length,
    humanIds: processedHumanIds,
  };
}
