import type {
  ArchiveTicketTypeTemplateRepoInput,
  CreatePlatformTicketTypeTemplateInput,
  CreateTicketPackInput,
  CreateTicketTypeTemplateRepoInput,
  TemplateOwnerScope,
  TicketPackRecord,
  TicketPackStatus,
  TicketPackWithCountsRecord,
  TicketPackWithTemplatesRecord,
  TicketTypeTemplateRecord,
  UpdatePlatformTicketTypeTemplateInput,
  UpdateTicketPackInput,
} from "@th/types";

/**
 * Ticket-type templates + the platform pack catalogue (ticket-type-packs
 * spec). One port, same collapse as the volunteer spec: pack CRUD attaches
 * here rather than growing a second repo.
 *
 * Tenancy note: TicketTypeTemplate holds OWNED rows (`ownerId` set,
 * `isPlatform` false) and PLATFORM catalogue rows (`ownerId` NULL,
 * `isPlatform` true). Each method states which kind it means — `ownerId`
 * being nullable makes "not owner B's" a different test from "not null".
 */
export interface TicketTypeTemplatesRepo {
  /** Any row by id — callers MUST branch on `isPlatform` before authz. */
  getById(id: string): Promise<TicketTypeTemplateRecord | null>;
  /**
   * OWNED rows only (ownerId equality can never match a NULL catalogue
   * row, and `isPlatform: false` is pinned anyway). Includes archived rows —
   * name-collision prechecks must see them.
   */
  findByName(
    ownerScope: TemplateOwnerScope,
    ownerId: string,
    normalizedName: string,
  ): Promise<TicketTypeTemplateRecord | null>;
  /** OWNED create. Cannot mint a platform row (`isPlatform` is not settable). */
  create(
    input: CreateTicketTypeTemplateRepoInput,
  ): Promise<TicketTypeTemplateRecord>;
  /** Non-archived OWNED templates for an owner, newest first. */
  list(
    ownerScope: TemplateOwnerScope,
    ownerId: string,
  ): Promise<TicketTypeTemplateRecord[]>;
  archive(
    input: ArchiveTicketTypeTemplateRepoInput,
  ): Promise<TicketTypeTemplateRecord>;

  // ── Platform catalogue reads (organizer-facing) ───────────────────────────

  /**
   * LIVE-ONLY catalogue read: every platform template whose pack is LIVE,
   * ordered by (pack.sortOrder, pack.name, template name). DRAFT packs
   * cannot come back from here by construction (spec FR-006).
   */
  listLivePlatformTemplates(): Promise<TicketTypeTemplateRecord[]>;
  /** LIVE packs, curation order — pack metadata for grouping the list UI. */
  listLivePacks(): Promise<TicketPackRecord[]>;

  // ── Packs (staff catalogue; callers gate on STAFF_TECH) ───────────────────

  createPack(input: CreateTicketPackInput): Promise<TicketPackRecord>;
  updatePack(
    id: string,
    input: UpdateTicketPackInput,
  ): Promise<TicketPackRecord>;
  getPack(id: string): Promise<TicketPackRecord | null>;
  getPackByKey(key: string): Promise<TicketPackRecord | null>;
  /** STATUS-BLIND — the staff catalogue list, with counts (spec FR-012). */
  listPacks(opts?: {
    status?: TicketPackStatus;
  }): Promise<TicketPackWithCountsRecord[]>;
  /**
   * Pack row ONLY. Its catalogue templates must already be deleted — the
   * `TicketTypeTemplate_platform_pack_check` CHECK turns the FK's SET NULL
   * of a surviving platform row into a violation. Owned forks SET NULL and
   * survive.
   */
  deletePack(id: string): Promise<void>;
  /** STATUS-BLIND single-pack read — the staff preview. STAFF-only by contract. */
  getPackWithTemplates(
    id: string,
  ): Promise<TicketPackWithTemplatesRecord | null>;

  // ── Platform (catalogue) templates (staff-only writes) ────────────────────

  /** PLATFORM-ONLY write: `ownerId` NULL + `isPlatform` true, both fixed. */
  createPlatformTemplate(
    input: CreatePlatformTicketTypeTemplateInput,
  ): Promise<TicketTypeTemplateRecord>;
  /** ID-scoped update, pinned to `isPlatform: true` rows. */
  updatePlatformTemplate(
    id: string,
    input: UpdatePlatformTicketTypeTemplateInput,
  ): Promise<TicketTypeTemplateRecord>;
  /** PLATFORM-ONLY delete (`isPlatform: true` pinned in the where clause). */
  deletePlatformTemplates(ids: string[]): Promise<number>;
  /** PLATFORM-ONLY delete scoped to one pack; owned forks excluded. */
  deletePlatformTemplatesByPack(packId: string): Promise<number>;
  countPlatformTemplatesByPack(packId: string): Promise<number>;
}
