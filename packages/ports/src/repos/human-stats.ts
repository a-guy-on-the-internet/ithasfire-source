import type { HumanStatsRecord } from "@th/types/repos/human-stats";

export interface HumanStatsRepo {
  upsert(
    humanId: string,
    data: Omit<HumanStatsRecord, "id" | "humanId">,
  ): Promise<HumanStatsRecord>;
  findByHumanId(humanId: string): Promise<HumanStatsRecord | null>;
}

export type { HumanStatsRecord } from "@th/types/repos/human-stats";
