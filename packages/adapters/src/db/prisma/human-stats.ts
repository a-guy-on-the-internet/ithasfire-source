import type { Prisma } from "@prisma/client";
import type {
  HumanStatsRepo,
  HumanStatsRecord,
} from "@th/ports/repos/human-stats";
import type { PrismaClientOrTx } from "./types";

type HumanStatsRow = Prisma.HumanStatsGetPayload<object>;

function toRecord(row: HumanStatsRow): HumanStatsRecord {
  return {
    id: row.id,
    humanId: row.humanId,
    totalEventsPerformed: row.totalEventsPerformed,
    totalTicketsAttributed: row.totalTicketsAttributed,
    avgDrawPerEvent: row.avgDrawPerEvent,
    topCities: row.topCities as HumanStatsRecord["topCities"],
    topPlaceIds: row.topPlaceIds as HumanStatsRecord["topPlaceIds"],
    topGenres: row.topGenres as HumanStatsRecord["topGenres"],
    channelBreakdown:
      row.channelBreakdown as HumanStatsRecord["channelBreakdown"],
    totalConsentedFans: row.totalConsentedFans,
    repeatFanCount: row.repeatFanCount,
    followerCount: row.followerCount,
    last90DayTickets: row.last90DayTickets,
    last90DayEvents: row.last90DayEvents,
    computedAt: row.computedAt,
  };
}

export function makeHumanStatsRepo(p: PrismaClientOrTx): HumanStatsRepo {
  return {
    async upsert(humanId, data) {
      const payload = {
        totalEventsPerformed: data.totalEventsPerformed,
        totalTicketsAttributed: data.totalTicketsAttributed,
        avgDrawPerEvent: data.avgDrawPerEvent,
        topCities: data.topCities as unknown as Prisma.InputJsonValue,
        topPlaceIds: data.topPlaceIds as unknown as Prisma.InputJsonValue,
        topGenres: data.topGenres as unknown as Prisma.InputJsonValue,
        channelBreakdown:
          data.channelBreakdown as unknown as Prisma.InputJsonValue,
        totalConsentedFans: data.totalConsentedFans,
        repeatFanCount: data.repeatFanCount,
        followerCount: data.followerCount,
        last90DayTickets: data.last90DayTickets,
        last90DayEvents: data.last90DayEvents,
        computedAt: data.computedAt,
      };

      const row = await p.humanStats.upsert({
        where: { humanId },
        create: { humanId, ...payload },
        update: payload,
      });
      return toRecord(row);
    },

    async findByHumanId(humanId) {
      const row = await p.humanStats.findUnique({ where: { humanId } });
      return row ? toRecord(row) : null;
    },
  };
}
