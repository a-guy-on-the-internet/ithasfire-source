// Ticket packs (staff-curated ticket-type catalogue) — barrel export.
//
// Every use case here gates on STAFF_TECH (ADMIN + DEVELOPER), matching the
// volunteer-packs set. The organizer-facing catalogue read is the FR-006
// union inside `use-cases/ticket-type-templates/list-ticket-type-templates`.

export {
  ticketPackStatusSchema,
  ticketPackKeySchema,
  ticketPackTemplateInputSchema,
  ticketPackRecordSchema,
  ticketPackWithCountsSchema,
  ticketPackWithTemplatesSchema,
  platformTicketTemplateSchema,
  MAX_PACK_TEMPLATES,
  type TicketPackTemplateInput,
} from "./schema";

export {
  listTicketPacksAdmin,
  listTicketPacksAdminInputSchema,
  listTicketPacksAdminOutputSchema,
  type ListTicketPacksAdminInput,
  type ListTicketPacksAdminOutput,
  type ListTicketPacksAdminDeps,
} from "./list-ticket-packs-admin";

export {
  getTicketPackAdmin,
  getTicketPackAdminInputSchema,
  getTicketPackAdminOutputSchema,
  type GetTicketPackAdminInput,
  type GetTicketPackAdminOutput,
  type GetTicketPackAdminDeps,
} from "./get-ticket-pack-admin";

export {
  upsertTicketPack,
  upsertTicketPackInputSchema,
  upsertTicketPackInputSchemaBase,
  upsertTicketPackOutputSchema,
  type UpsertTicketPackInput,
  type UpsertTicketPackOutput,
  type UpsertTicketPackDeps,
} from "./upsert-ticket-pack";

export {
  setTicketPackStatus,
  setTicketPackStatusInputSchema,
  setTicketPackStatusOutputSchema,
  type SetTicketPackStatusInput,
  type SetTicketPackStatusOutput,
  type SetTicketPackStatusDeps,
} from "./set-ticket-pack-status";

export {
  removeTicketPack,
  removeTicketPackInputSchema,
  removeTicketPackOutputSchema,
  type RemoveTicketPackInput,
  type RemoveTicketPackOutput,
  type RemoveTicketPackDeps,
} from "./remove-ticket-pack";
