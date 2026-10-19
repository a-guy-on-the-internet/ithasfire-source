import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const DEFAULT_PAGE_SIZE = 100;
const LAST_90_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export const computeOrgStatsInputSchema = z
  .object({
    orgId: z.string().uuid().optional(),
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

export type ComputeOrgStatsInput = z.infer<typeof computeOrgStatsInputSchema>;

export type ComputeOrgStatsOutput = {
  orgsProcessed: number;
  orgIds: string[];
};

export type ComputeOrgStatsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

type CountMap = Map<string, number>;

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

function topKeys(map: CountMap, limit = 5): string[] | null {
  if (map.size === 0) return null;
  return [...map.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([key]) => key);
}

async function listTargetOrgIds(
  repos: Repos,
  explicitOrgId: string | undefined,
  pageSize: number,
): Promise<string[]> {
  if (explicitOrgId) {
    return [explicitOrgId];
  }

  const orgIds: string[] = [];
  let offset = 0;

  while (true) {
    const page = await repos.organizations.listActive({
      limit: pageSize,
      offset,
    });
    for (const org of page.items) {
      orgIds.push(org.id);
    }

    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }

  return orgIds;
}

async function listAllOrdersForEvent(
  repos: Repos,
  eventId: string,
): Promise<
  Array<Awaited<ReturnType<Repos["orders"]["listAll"]>>["items"][number]>
> {
  const orders: Array<
    Awaited<ReturnType<Repos["orders"]["listAll"]>>["items"][number]
  > = [];
  let offset = 0;

  while (true) {
    const page = await repos.orders.listAll({
      eventId,
      statuses: ["SUCCEEDED", "PROCESSING", "PART_REFUNDED", "REFUNDED"],
      limit: 1000,
      offset,
    });

    orders.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }

  return orders;
}

async function getFollowerCount(repos: Repos, orgId: string): Promise<number> {
  const page = await repos.entityPages.getByOwner("ORGANIZATION", orgId);
  if (!page) return 0;
  return repos.follows.countByEntity(page.id);
}

export async function computeOrgStats(
  deps: ComputeOrgStatsDeps,
  rawInput?: unknown,
): Promise<ComputeOrgStatsOutput> {
  const input = parseInput(computeOrgStatsInputSchema, rawInput ?? {});
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - LAST_90_DAYS_MS);

  const targetOrgIds = await listTargetOrgIds(
    deps.repos,
    input.orgId,
    input.limit ?? DEFAULT_PAGE_SIZE,
  );
  if (targetOrgIds.length === 0) {
    return { orgsProcessed: 0, orgIds: [] };
  }

  const processedOrgIds: string[] = [];
  const categoryNameCache = new Map<string, string | null>();

  for (const orgId of targetOrgIds) {
    const org = await deps.repos.organizations.getById(orgId);
    if (!org) {
      if (input.orgId === orgId) {
        throw fail("ORG_NOT_FOUND");
      }
      continue;
    }

    const allEvents: Array<
      Awaited<ReturnType<Repos["events"]["listByOwner"]>>["items"][number]
    > = [];
    let offset = 0;

    while (true) {
      const page = await deps.repos.events.listByOwner({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        status: ["PUBLISHED", "COMPLETED", "CANCELLED"],
        limit: input.limit ?? DEFAULT_PAGE_SIZE,
        offset,
      });

      allEvents.push(...page.items);
      offset += page.items.length;
      const total =
        "pageInfo" in page ? (page as any).pageInfo.total : (page as any).total;
      if (page.items.length === 0 || offset >= total) break;
    }

    const eligibleEvents = allEvents.filter(
      (event) =>
        event.status !== "CANCELLED" &&
        event.status !== "ARCHIVED" &&
        event.startsAt.getTime() <= now.getTime(),
    );

    const placeCounts = new Map<string, number>();
    const artistCounts = new Map<string, number>();
    const genreCounts = new Map<string, number>();
    const attendeeEvents = new Map<string, Set<string>>();
    const attributionSummary: Array<{
      eventId: string;
      attributed: number;
      walkIn: number;
    }> = [];

    let totalTicketsSold = 0;
    let last90DayTickets = 0;
    let last90DayEvents = 0;

    for (const event of eligibleEvents) {
      const orders = await listAllOrdersForEvent(deps.repos, event.id);

      const orderQtyById = new Map<string, number>();
      let eventTicketQty = 0;

      for (const order of orders) {
        const qty = sumTicketQty(
          order.items as Array<{ kind?: string; qty?: number }>,
        );
        orderQtyById.set(order.id, qty);
        eventTicketQty += qty;
        totalTicketsSold += qty;

        if (order.occurredAt.getTime() >= cutoff.getTime()) {
          last90DayTickets += qty;
        }

        if (order.buyerHumanId) {
          const existing =
            attendeeEvents.get(order.buyerHumanId) ?? new Set<string>();
          existing.add(event.id);
          attendeeEvents.set(order.buyerHumanId, existing);
        }
      }

      if (event.startsAt.getTime() >= cutoff.getTime()) {
        last90DayEvents += 1;
      }

      if (event.placeId) {
        increment(placeCounts, event.placeId, eventTicketQty);
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
          increment(genreCounts, categoryName, Math.max(eventTicketQty, 1));
        }
      }

      const attributions = await deps.repos.ticketAttributions.listByEvent(
        event.id,
      );
      const countedOrderIds = new Set<string>();
      let attributedTickets = 0;

      for (const attribution of attributions) {
        const qty = orderQtyById.get(attribution.orderId) ?? 0;

        if (
          (attribution.attributedToHumanId ||
            attribution.attributedToEventHumanId) &&
          !countedOrderIds.has(attribution.orderId)
        ) {
          attributedTickets += qty;
          countedOrderIds.add(attribution.orderId);
        }

        if (attribution.attributedToHumanId) {
          increment(artistCounts, attribution.attributedToHumanId, qty);
        }
      }

      if (eventTicketQty > 0 || attributedTickets > 0) {
        attributionSummary.push({
          eventId: event.id,
          attributed: attributedTickets,
          walkIn: Math.max(0, eventTicketQty - attributedTickets),
        });
      }
    }

    const followerCount = await getFollowerCount(deps.repos, orgId);
    const uniqueAttendees = attendeeEvents.size;
    const repeatAttendees = [...attendeeEvents.values()].filter(
      (events) => events.size >= 2,
    ).length;

    await deps.repos.orgStats.upsert(orgId, {
      totalEventsOrganized: eligibleEvents.length,
      totalTicketsSold,
      totalVenues: new Set(
        eligibleEvents.map((event) => event.placeId).filter(Boolean),
      ).size,
      avgTicketsPerEvent:
        eligibleEvents.length > 0
          ? roundTo(totalTicketsSold / eligibleEvents.length)
          : null,
      topPlaceIds: topKeys(placeCounts),
      topArtistHumanIds: topKeys(artistCounts),
      uniqueAttendees,
      repeatAttendees,
      attributionSummary:
        attributionSummary.length > 0 ? attributionSummary : null,
      topGenres: topKeys(genreCounts),
      followerCount,
      last90DayTickets,
      last90DayEvents,
      computedAt: now,
    });

    processedOrgIds.push(orgId);
  }

  deps.logger?.info("orgs.compute-org-stats.completed", {
    orgsProcessed: processedOrgIds.length,
    orgIds: processedOrgIds,
  });

  return {
    orgsProcessed: processedOrgIds.length,
    orgIds: processedOrgIds,
  };
}
