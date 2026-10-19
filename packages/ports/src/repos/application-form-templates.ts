import type {
  ApplicationFormPurpose,
  ApplicationFormTemplateRecord,
  ArchiveApplicationFormTemplateRepoInput,
  CreateApplicationFormTemplateRepoInput,
  TemplateOwnerScope,
  UpdateApplicationFormTemplateRepoInput,
} from "@th/types";

/**
 * Reusable application-form templates (application-driven-events spec Phase 4,
 * decision D4).
 *
 * Tenancy note, identical to {@link TicketTypeTemplatesRepo}: the table holds
 * OWNED rows (`ownerId` set, `isPlatform` false) and PLATFORM catalogue rows
 * (`ownerId` NULL, `isPlatform` true). Each method states which kind it means
 * — `ownerId` being nullable makes "not owner B's" a different test from
 * "not null".
 */
export interface ApplicationFormTemplatesRepo {
  /** Any row by id — callers MUST branch on `isPlatform` before authz. */
  getById(id: string): Promise<ApplicationFormTemplateRecord | null>;
  /**
   * OWNED rows only, non-archived, newest first, whose `purpose` is one of
   * `purposes` (open calls v1; required and non-empty — the caller states
   * which builders' templates it wants). `ownerId` equality can never match
   * a NULL catalogue row and `isPlatform: false` is pinned anyway.
   */
  list(
    ownerScope: TemplateOwnerScope,
    ownerId: string,
    purposes: readonly ApplicationFormPurpose[],
  ): Promise<ApplicationFormTemplateRecord[]>;
  /**
   * OWNED rows only, INCLUDING archived ones — the name-collision pre-check
   * must see an archived row so re-using its name is a deliberate act.
   */
  findByName(
    ownerScope: TemplateOwnerScope,
    ownerId: string,
    name: string,
  ): Promise<ApplicationFormTemplateRecord | null>;
  /**
   * The starter catalogue: non-archived `isPlatform: true` rows whose
   * `purpose` is one of `purposes` (required, non-empty), name order.
   * Visible to every authenticated organizer.
   */
  listPlatformTemplates(
    purposes: readonly ApplicationFormPurpose[],
  ): Promise<ApplicationFormTemplateRecord[]>;
  /** OWNED create. Cannot mint a platform row (`isPlatform` is not settable). */
  create(
    input: CreateApplicationFormTemplateRepoInput,
  ): Promise<ApplicationFormTemplateRecord>;
  /**
   * OWNED update, presence-guarded. PINNED to `isPlatform: false` so a
   * catalogue row's id passed here changes nothing and reports not-found.
   */
  update(
    input: UpdateApplicationFormTemplateRepoInput,
  ): Promise<ApplicationFormTemplateRecord>;
  /** OWNED archive, pinned to `isPlatform: false` for the same reason. */
  archive(
    input: ArchiveApplicationFormTemplateRepoInput,
  ): Promise<ApplicationFormTemplateRecord>;
}
