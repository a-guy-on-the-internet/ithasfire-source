// Volunteer packs (staff-curated catalogue) — barrel export.
//
// Every use case here gates on STAFF_TECH (ADMIN + DEVELOPER), matching the
// fees and jobs panels rather than the wider STAFF_ALL that `featured` uses
// (FR-014). The organizer-facing catalogue read lives in
// `use-cases/volunteering/list-volunteer-packs.ts` and is org-scoped.

export {
  volunteerPackStatusSchema,
  volunteerPackKeySchema,
  volunteerPackRoleInputSchema,
  volunteerPackRecordSchema,
  volunteerPackWithCountsSchema,
  volunteerPackWithRolesSchema,
  platformRoleTemplateSchema,
  platformRoleTemplateShiftSchema,
  MAX_PACK_ROLES,
  type VolunteerPackRoleInput,
} from "./schema";

export {
  listVolunteerPacksAdmin,
  listVolunteerPacksAdminInputSchema,
  listVolunteerPacksAdminOutputSchema,
  type ListVolunteerPacksAdminInput,
  type ListVolunteerPacksAdminOutput,
  type ListVolunteerPacksAdminDeps,
} from "./list-volunteer-packs-admin";

export {
  getVolunteerPackAdmin,
  getVolunteerPackAdminInputSchema,
  getVolunteerPackAdminOutputSchema,
  type GetVolunteerPackAdminInput,
  type GetVolunteerPackAdminOutput,
  type GetVolunteerPackAdminDeps,
} from "./get-volunteer-pack-admin";

export {
  upsertVolunteerPack,
  upsertVolunteerPackInputSchema,
  upsertVolunteerPackInputSchemaBase,
  upsertVolunteerPackOutputSchema,
  type UpsertVolunteerPackInput,
  type UpsertVolunteerPackOutput,
  type UpsertVolunteerPackDeps,
} from "./upsert-volunteer-pack";

export {
  setVolunteerPackStatus,
  setVolunteerPackStatusInputSchema,
  setVolunteerPackStatusOutputSchema,
  type SetVolunteerPackStatusInput,
  type SetVolunteerPackStatusOutput,
  type SetVolunteerPackStatusDeps,
} from "./set-volunteer-pack-status";

export {
  removeVolunteerPack,
  removeVolunteerPackInputSchema,
  removeVolunteerPackOutputSchema,
  type RemoveVolunteerPackInput,
  type RemoveVolunteerPackOutput,
  type RemoveVolunteerPackDeps,
} from "./remove-volunteer-pack";
