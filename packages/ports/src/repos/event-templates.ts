import type {
  ArchiveEventTemplateRepoInput,
  CreateEventTemplateRepoInput,
  EventTemplateListFilters,
  EventTemplateListResult,
  EventTemplateRecord,
  TemplateOwnerScope,
  UpdateEventTemplateRepoPatch,
} from "@th/types";

export interface EventTemplateRepo {
  getById(id: string): Promise<EventTemplateRecord | null>;
  findByName(
    ownerScope: TemplateOwnerScope,
    ownerId: string,
    normalizedName: string,
  ): Promise<EventTemplateRecord | null>;
  create(input: CreateEventTemplateRepoInput): Promise<EventTemplateRecord>;
  update(
    templateId: string,
    patch: UpdateEventTemplateRepoPatch,
  ): Promise<EventTemplateRecord>;
  archive(input: ArchiveEventTemplateRepoInput): Promise<EventTemplateRecord>;
  list(filters: EventTemplateListFilters): Promise<EventTemplateListResult>;
}
