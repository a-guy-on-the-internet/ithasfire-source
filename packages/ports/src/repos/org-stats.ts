import type { OrgStatsRecord } from "@th/types/repos/org-stats";

export interface OrgStatsRepo {
  upsert(
    orgId: string,
    data: Omit<OrgStatsRecord, "id" | "orgId">,
  ): Promise<OrgStatsRecord>;
  findByOrgId(orgId: string): Promise<OrgStatsRecord | null>;
}

export type { OrgStatsRecord } from "@th/types/repos/org-stats";
