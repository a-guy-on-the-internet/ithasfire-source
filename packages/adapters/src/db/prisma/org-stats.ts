import type { Prisma } from "@prisma/client";
import type { OrgStatsRepo, OrgStatsRecord } from "@th/ports/repos/org-stats";
import type { PrismaClientOrTx } from "./types";

type OrgStatsRow = Prisma.OrgStatsGetPayload<object>;

function toRecord(row: OrgStatsRow): OrgStatsRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    totalEventsOrganized: row.totalEventsOrganized,
    totalTicketsSold: row.totalTicketsSold,
    totalVenues: row.totalVenues,
    avgTicketsPerEvent: row.avgTicketsPerEvent,
    topPlaceIds: row.topPlaceIds as OrgStatsRecord["topPlaceIds"],
    topArtistHumanIds:
      row.topArtistHumanIds as OrgStatsRecord["topArtistHumanIds"],
    uniqueAttendees: row.uniqueAttendees,
    repeatAttendees: row.repeatAttendees,
    attributionSummary:
      row.attributionSummary as OrgStatsRecord["attributionSummary"],
    topGenres: row.topGenres as OrgStatsRecord["topGenres"],
    followerCount: row.followerCount,
    last90DayTickets: row.last90DayTickets,
    last90DayEvents: row.last90DayEvents,
    computedAt: row.computedAt,
  };
}

export function makeOrgStatsRepo(p: PrismaClientOrTx): OrgStatsRepo {
  return {
    async upsert(orgId, data) {
      const payload = {
        totalEventsOrganized: data.totalEventsOrganized,
        totalTicketsSold: data.totalTicketsSold,
        totalVenues: data.totalVenues,
        avgTicketsPerEvent: data.avgTicketsPerEvent,
        topPlaceIds: data.topPlaceIds as unknown as Prisma.InputJsonValue,
        topArtistHumanIds:
          data.topArtistHumanIds as unknown as Prisma.InputJsonValue,
        uniqueAttendees: data.uniqueAttendees,
        repeatAttendees: data.repeatAttendees,
        attributionSummary:
          data.attributionSummary as unknown as Prisma.InputJsonValue,
        topGenres: data.topGenres as unknown as Prisma.InputJsonValue,
        followerCount: data.followerCount,
        last90DayTickets: data.last90DayTickets,
        last90DayEvents: data.last90DayEvents,
        computedAt: data.computedAt,
      };

      const row = await p.orgStats.upsert({
        where: { orgId },
        create: { orgId, ...payload },
        update: payload,
      });
      return toRecord(row);
    },

    async findByOrgId(orgId) {
      const row = await p.orgStats.findUnique({ where: { orgId } });
      return row ? toRecord(row) : null;
    },
  };
}
