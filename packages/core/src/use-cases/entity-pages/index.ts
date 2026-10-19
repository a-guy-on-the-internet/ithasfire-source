export { getPublicPage } from "./get-public-page";
export type {
  GetPublicPageInput,
  GetPublicPageOutput,
  GetPublicPageDeps,
  VenueStatsBlockData,
} from "./get-public-page";
export {
  getPublicPageInputSchema,
  getPublicPageOutputSchema,
} from "./get-public-page";

export { entitySummarySchema, loadEntitySummary } from "./entity-summary";
export type { LoadEntitySummaryDeps } from "./entity-summary";

export { checkSlugAvailability } from "./check-slug-availability";
export type {
  CheckSlugAvailabilityInput,
  CheckSlugAvailabilityOutput,
  CheckSlugAvailabilityDeps,
} from "./check-slug-availability";
export {
  checkSlugAvailabilityInputSchema,
  checkSlugAvailabilityOutputSchema,
} from "./check-slug-availability";

export { getMyPage } from "./get-my-page";
export type {
  GetMyPageInput,
  GetMyPageOutput,
  GetMyPageDeps,
} from "./get-my-page";
export { getMyPageInputSchema, getMyPageOutputSchema } from "./get-my-page";

export { updatePage } from "./update-page";
export type {
  UpdatePageInput,
  UpdatePageOutput,
  UpdatePageDeps,
} from "./update-page";
export { updatePageInputSchema, updatePageOutputSchema } from "./update-page";

export { updatePageTheme } from "./update-page-theme";
export type {
  UpdatePageThemeInput,
  UpdatePageThemeOutput,
  UpdatePageThemeDeps,
} from "./update-page-theme";
export {
  updatePageThemeInputSchema,
  updatePageThemeOutputSchema,
} from "./update-page-theme";

export {
  ENTITY_PAGE_FONT_KEYS,
  ENTITY_PAGE_LAYOUT_KEYS,
  entityPageFontKeySchema,
  entityPageLayoutKeySchema,
  entityPageFontKeyInputSchema,
  entityPageLayoutKeyInputSchema,
  normalizeEntityPageFontKey,
  normalizeEntityPageLayoutKey,
  resolveDefaultEntityPageLayoutKey,
} from "./theme-options";
export type {
  EntityPageFontKey,
  EntityPageLayoutKey,
  EntityPageOwnerType,
} from "./theme-options";

export { requestPageImageUpload } from "./request-page-image-upload";
export type {
  RequestPageImageUploadInput,
  RequestPageImageUploadOutput,
  RequestPageImageUploadDeps,
} from "./request-page-image-upload";
export {
  requestPageImageUploadInputSchema,
  requestPageImageUploadOutputSchema,
} from "./request-page-image-upload";

export { finalizePageImageUpload } from "./finalize-page-image-upload";
export type {
  FinalizePageImageUploadInput,
  FinalizePageImageUploadOutput,
  FinalizePageImageUploadDeps,
} from "./finalize-page-image-upload";
export {
  finalizePageImageUploadInputSchema,
  finalizePageImageUploadOutputSchema,
} from "./finalize-page-image-upload";

export { managePageBlocks } from "./manage-page-blocks";
export type {
  ManagePageBlocksInput,
  ManagePageBlocksOutput,
  ManagePageBlocksDeps,
} from "./manage-page-blocks";
export {
  managePageBlocksInputSchema,
  managePageBlocksOutputSchema,
} from "./manage-page-blocks";

export {
  isValidBlockKind,
  getValidBlockKinds,
  UNIVERSAL_BLOCK_KINDS,
  HUMAN_BLOCK_KINDS,
  PLACE_BLOCK_KINDS,
  ORG_BLOCK_KINDS,
} from "./block-kinds";
export type { BlockKind } from "./block-kinds";

export {
  PAGE_BLOCK_SECTIONS,
  DEFAULT_PAGE_BLOCK_SECTION,
  pageBlockSectionSchema,
  isValidBlockSection,
  normalizeBlockSection,
} from "./block-sections";
export type { PageBlockSection } from "./block-sections";

export { seedPageTemplateBlocks } from "./seed-page-template-blocks";
export type {
  SeedPageTemplateBlocksInput,
  SeedPageTemplateBlocksDeps,
} from "./seed-page-template-blocks";

export {
  PAGE_TEMPLATES,
  getPageTemplate,
  resolveCategory,
  findTemplateKindViolations,
} from "./page-templates";
export type { TemplateBlockSpec } from "./page-templates";

export {
  BLOCK_CONFIGS,
  getBlockConfig,
  getAllBlockConfigs,
  getValidBlockConfigs,
  getPaletteBlockConfigs,
  getDefaultBlockData,
  getDefaultBlockSpan,
  getBlockLabelKey,
} from "./block-config";
export type {
  BlockConfigCategory,
  BlockFieldKind,
  BlockFieldOption,
  BlockFieldConfig,
  BlockDefaultData,
  BlockDefaultSpan,
  BlockConfig,
  EntityPageBlockConfig,
} from "./block-config";
export { hasBlockDataSchema } from "./block-config";
export type { PinnedRefusal } from "./manage-page-blocks";

export {
  PAGE_ZONE_LAYOUTS,
  PAGE_ZONE_LOCKS,
  PAGE_ZONE_REFUSALS,
  PAGE_REGIONS,
  resolvePageZoneLayout,
  zoneOf,
  lockOf,
  paletteGroupOf,
  canPlace,
  insertionIndexFor,
  moveRange,
  sortByZone,
} from "./page-zones";
export type {
  PageZone,
  PageZoneLayout,
  PageZoneLock,
  PageRegion,
  PagePlacement,
  PagePaletteGroup,
  PageZoneRefusal,
  PageZoneRefusalReason,
  PageZoneCheck,
} from "./page-zones";

// page-draft-ops.ts is deliberately NOT exported here: it is server-only
// (it imports upsert-place, which pulls node:crypto), and web client code
// imports this barrel. Server code imports it by subpath:
// `@th/core/use-cases/entity-pages/page-draft-ops`.
//
// The draft use cases import it, so they are server-only too and are NOT
// value-exported here either. Server code (the tRPC router, step 9) imports
// them by subpath: `@th/core/use-cases/entity-pages/get-page-draft`,
// `.../save-page-draft`, `.../discard-page-draft`,
// `.../publish-page-draft`. Their result TYPES are
// exported below with `export type`, which the compiler erases, so web
// can name them without pulling the server code into its bundle.
export type {
  GetPageDraftOutput,
  PageDraftEditorInfo,
  PageDraftLastEdit,
  PageDraftPathEditor,
} from "./get-page-draft";
export type { SavePageDraftOutput } from "./save-page-draft";
export type { DiscardPageDraftOutput } from "./discard-page-draft";
export type {
  PlaceConflictResolution,
  PlaceFieldConflict,
  PublishPageDraftOutput,
} from "./publish-page-draft";
export type { PageDraftSync, PageDraftSyncChange } from "./page-draft-shared";

// ── Moderator place page: the probe, attribution and owner handover ─────────
// (docs/specs/2026-10-14/moderator-place-page.spec.yaml FR-005..FR-007)
export {
  getPlacePageEditAccess,
  getPlacePageEditAccessInputSchema,
  getPlacePageEditAccessOutputSchema,
  PLACE_PAGE_EDIT_REFUSAL_REASONS,
} from "./get-place-page-edit-access";
export type {
  GetPlacePageEditAccessInput,
  GetPlacePageEditAccessOutput,
  GetPlacePageEditAccessDeps,
  PlacePageEditRefusalReason,
} from "./get-place-page-edit-access";

export {
  getCommunityHandover,
  getCommunityHandoverInputSchema,
  getCommunityHandoverOutputSchema,
} from "./get-community-handover";
export type {
  GetCommunityHandoverInput,
  GetCommunityHandoverOutput,
  GetCommunityHandoverDeps,
} from "./get-community-handover";

export {
  ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION,
  COMMUNITY_HANDOVER_MAX_UPDATES,
} from "./community-handover-state";
export type { CommunityAttribution } from "./community-handover-state";

// resolve-community-handover.ts imports page-draft-ops, so it is server-only
// like the draft use cases: server code imports it by subpath
// (`@th/core/use-cases/entity-pages/resolve-community-handover`). Types only
// here.
export type {
  CommunityHandoverChoice,
  ResolveCommunityHandoverInput,
  ResolveCommunityHandoverOutput,
} from "./resolve-community-handover";
