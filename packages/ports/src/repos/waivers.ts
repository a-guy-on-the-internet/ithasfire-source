import type {
  WaiverTemplateRecord,
  CreateWaiverTemplateInput,
  UpdateWaiverTemplateInput,
  ListWaiverTemplatesInput,
  WaiverClauseRecord,
  WaiverAcceptanceRecord,
  CreateWaiverAcceptanceInput,
  VolunteerWaiverAcceptanceRecord,
  CreateVolunteerWaiverAcceptanceInput,
} from "@th/types/repos/waivers";

export interface WaiverClausesRepo {
  listActive(): Promise<WaiverClauseRecord[]>;
}

export interface WaiverTemplatesRepo {
  getById(id: string): Promise<WaiverTemplateRecord | null>;
  create(input: CreateWaiverTemplateInput): Promise<WaiverTemplateRecord>;
  update(input: UpdateWaiverTemplateInput): Promise<WaiverTemplateRecord>;
  /** List templates for an org or human, optionally including platform defaults. */
  list(input: ListWaiverTemplatesInput): Promise<WaiverTemplateRecord[]>;
  /** Unset `isDefault` on all templates for a given org. */
  clearOrgDefault(orgId: string): Promise<void>;
  /** Unset `isDefault` on all templates for a given human. */
  clearHumanDefault(humanId: string): Promise<void>;
}

export interface WaiverAcceptancesRepo {
  create(input: CreateWaiverAcceptanceInput): Promise<WaiverAcceptanceRecord>;
  getByOrderAndTemplate(
    orderId: string,
    waiverTemplateId: string,
  ): Promise<WaiverAcceptanceRecord | null>;
  listByOrder(orderId: string): Promise<WaiverAcceptanceRecord[]>;
}

/**
 * Human-profile-keyed volunteer waiver acceptances (Gap 3). One row per
 * signup (signupId is unique); the "already on file" lookup is keyed by
 * (humanId, waiverTemplateId, waiverVersion) so a returning volunteer
 * skips re-signing until the template version bumps.
 */
export interface VolunteerWaiverAcceptancesRepo {
  /** Insert an acceptance row. Call inside the signup transaction. */
  create(
    input: CreateVolunteerWaiverAcceptanceInput,
  ): Promise<VolunteerWaiverAcceptanceRecord>;
  /**
   * Most recent acceptance by this human for the exact template + version,
   * or null. Powers the returning-volunteer "already on file" path.
   */
  findCurrentForHuman(
    humanId: string,
    waiverTemplateId: string,
    waiverVersion: number,
  ): Promise<VolunteerWaiverAcceptanceRecord | null>;
}

export type {
  WaiverTemplateRecord,
  WaiverTemplateKind,
  CreateWaiverTemplateInput,
  UpdateWaiverTemplateInput,
  ListWaiverTemplatesInput,
  WaiverClauseRecord,
  WaiverAcceptanceRecord,
  CreateWaiverAcceptanceInput,
  VolunteerWaiverAcceptanceRecord,
  CreateVolunteerWaiverAcceptanceInput,
} from "@th/types/repos/waivers";
