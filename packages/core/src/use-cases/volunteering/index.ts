// Volunteering use cases — barrel export

export {
  createRoleTemplate,
  updateRoleTemplate,
  archiveRoleTemplate,
  listRoleTemplates,
  getRoleTemplateWithShifts,
  upsertRoleTemplateShifts,
  type ManageRoleTemplatesDeps,
} from "./manage-role-templates";

export {
  forkPlatformRoleTemplate,
  type ForkPlatformRoleTemplateDeps,
} from "./fork-platform-template";

export {
  listVolunteerPacks,
  listVolunteerPacksOutputSchema,
  type ListVolunteerPacksDeps,
  type ListedVolunteerPack,
} from "./list-volunteer-packs";

export {
  createEventVolunteerRole,
  createFromTemplates,
  updateEventVolunteerRole,
  deleteEventVolunteerRole,
  listEventVolunteerRoles,
  type ManageEventVolunteerRolesDeps,
  type CreateFromTemplatesOutput,
} from "./manage-event-volunteer-roles";

export {
  createVolunteerShift,
  createVolunteerShiftBatch,
  updateVolunteerShift,
  deleteVolunteerShift,
  listVolunteerShifts,
  type ManageVolunteerShiftsDeps,
} from "./manage-volunteer-shifts";

export {
  createVolunteerAsk,
  type CreateVolunteerAskDeps,
  type CreateVolunteerAskOutput,
} from "./create-volunteer-ask";

export {
  updateVolunteerAsk,
  type UpdateVolunteerAskDeps,
} from "./update-volunteer-ask";

export {
  assignWaiverToAsk,
  assignWaiverToAskInputBaseSchema,
  assignWaiverToAskInputSchema,
  assignWaiverToAskOutputSchema,
  type AssignWaiverToAskDeps,
  type AssignWaiverToAskInput,
  type AssignWaiverToAskOutput,
} from "./assign-waiver-to-ask";

export {
  addVolunteerAskRole,
  updateVolunteerAskRole,
  type ManageVolunteerAskRolesDeps,
} from "./add-volunteer-role";

export {
  createVolunteerGroup,
  type CreateVolunteerGroupDeps,
  type CreateVolunteerGroupOutput,
} from "./create-volunteer-group";

export {
  assignGroupCoordinator,
  type AssignGroupCoordinatorDeps,
} from "./assign-group-coordinator";

export {
  resolveAskOwnership,
  type AskSubjectRef,
  type AskOwnershipContext,
} from "./_shared/resolve-ask-ownership";

export {
  requireCoordinatorOrOwner,
  type CoordinatorOrOwnerAccess,
} from "./_shared/require-coordinator-or-owner";

export { resolveOrCreateEventAsk } from "./_shared/resolve-event-ask";

export {
  askOffersTextReminders,
  signupReminderAnchor,
  type SignupReminderAnchor,
} from "./_shared/signup-reminder-anchor";

export {
  assignSignupToGroup,
  type AssignSignupToGroupDeps,
} from "./assign-signup-to-group";

export {
  broadcastToRoster,
  type BroadcastToRosterDeps,
  type BroadcastToRosterOutput,
} from "./broadcast-to-roster";

export {
  listAskBroadcasts,
  type ListAskBroadcastsDeps,
  type ListAskBroadcastsOutput,
} from "./list-ask-broadcasts";

export {
  exportSignupIcs,
  VOLUNTEER_ICS_UID_DOMAIN,
  type ExportSignupIcsDeps,
  type ExportSignupIcsOutput,
} from "./export-signup-ics";

export {
  getMyVolunteerIcsFeedToken,
  rotateMyVolunteerIcsFeedToken,
  exportMyVolunteeringIcs,
  type VolunteerIcsFeedDeps,
  type GetMyVolunteerIcsFeedTokenOutput,
  type ExportMyVolunteeringIcsOutput,
} from "./volunteer-ics-feed";

export {
  listAskRoster,
  type ListAskRosterDeps,
  type ListAskRosterOutput,
  type AskRosterRole,
} from "./list-ask-roster";

export {
  listCoordinatorRoster,
  type ListCoordinatorRosterDeps,
  type ListCoordinatorRosterOutput,
  type CoordinatorRosterGroup,
} from "./list-coordinator-roster";

export {
  listAskSignups,
  type ListAskSignupsDeps,
  type ListAskSignupsOutput,
} from "./list-ask-signups";

export {
  submitVolunteerSignup,
  reviewVolunteerSignup,
  reviewVolunteerSignupsBatch,
  checkInVolunteer,
  withdrawVolunteerSignup,
  listMyVolunteerSignups,
  listMyVolunteerCommitments,
  type MyVolunteerCommitment,
  listVolunteerSignups,
  type VolunteerSignupDeps,
  type VolunteerRewardHooks,
  type ReviewVolunteerSignupsBatchItemResult,
  type ReviewVolunteerSignupsBatchResult,
} from "./volunteer-signups";

export {
  setVolunteerReward,
  type SetVolunteerRewardDeps,
  type SetVolunteerRewardOutput,
} from "./set-volunteer-reward";

export {
  grantVolunteerReward,
  type GrantVolunteerRewardDeps,
  type GrantVolunteerRewardOutput,
  type GrantVolunteerRewardSkip,
} from "./grant-volunteer-reward";

export {
  revokeVolunteerReward,
  type RevokeVolunteerRewardDeps,
  type RevokeVolunteerRewardOutput,
} from "./revoke-volunteer-reward";

export {
  listAskRewardLedger,
  type ListAskRewardLedgerDeps,
  type ListAskRewardLedgerOutput,
  type RewardLedgerGrant,
  type RewardLedgerRewardSummary,
} from "./list-ask-reward-ledger";

export {
  listAskRewards,
  type ListAskRewardsDeps,
  type ListAskRewardsOutput,
  type AskRewardSummary,
} from "./list-ask-rewards";

export {
  updateVolunteerContactPrefs,
  type UpdateVolunteerContactPrefsDeps,
} from "./update-volunteer-contact-prefs";

export {
  sendVolunteerShiftReminders,
  sendVolunteerShiftRemindersInputSchema,
  type SendVolunteerShiftRemindersInput,
  type SendVolunteerShiftRemindersOutput,
  type SendVolunteerShiftRemindersDeps,
} from "./send-volunteer-shift-reminders";

export {
  updateVolunteerHours,
  updateVolunteerHoursInputSchema,
  exportEventVolunteerHours,
  exportEventVolunteerHoursInputSchema,
  type UpdateVolunteerHoursInput,
  type ExportEventVolunteerHoursInput,
  type ExportEventVolunteerHoursOutput,
  type ManageVolunteerHoursDeps,
} from "./manage-volunteer-hours";

export {
  getOrgVolunteerHoursSummary,
  type OrgVolunteerHoursDeps,
  type GetOrgVolunteerHoursSummaryOutput,
} from "./org-volunteer-hours";

export {
  mintVolunteerScanToken,
  resolveVolunteerSignupByToken,
  searchVolunteerSignupsForCheckIn,
  getVolunteerContextForTicketScan,
  type VolunteerScanTokenDeps,
  type VolunteerCheckInCandidate,
} from "./volunteer-scan-tokens";

export {
  getPublicVolunteerWaiver,
  getPublicVolunteerWaiverInputSchema,
  type GetPublicVolunteerWaiverInput,
  type GetPublicVolunteerWaiverOutput,
  type GetPublicVolunteerWaiverDeps,
  type PublicVolunteerWaiver,
} from "./get-public-volunteer-waiver";

export {
  getPublicVolunteerAsk,
  getPublicVolunteerAskInputSchema,
  type GetPublicVolunteerAskInput,
  type GetPublicVolunteerAskOutput,
  type GetPublicVolunteerAskDeps,
  type PublicVolunteerAsk,
  type PublicVolunteerAskRole,
  type PublicVolunteerAskStatus,
} from "./get-public-volunteer-ask";

export {
  getPublicAskWaiver,
  getPublicAskWaiverInputSchema,
  type GetPublicAskWaiverInput,
  type GetPublicAskWaiverOutput,
  type GetPublicAskWaiverDeps,
  type PublicAskWaiver,
} from "./get-public-ask-waiver";

export {
  listPublicEventVolunteerRoles,
  listPublicEventVolunteerRolesInputSchema,
  type ListPublicEventVolunteerRolesInput,
  type ListPublicEventVolunteerRolesOutput,
  type ListPublicEventVolunteerRolesDeps,
  type PublicVolunteerRole,
  type PublicVolunteerShift,
} from "./list-public-event-volunteer-roles";

export {
  createRoleTemplateInputSchema,
  updateRoleTemplateInputSchema,
  archiveRoleTemplateInputSchema,
  listRoleTemplatesInputSchema,
  upsertRoleTemplateShiftsInputSchema,
  getRoleTemplateWithShiftsInputSchema,
  roleTemplateShiftDraftSchema,
  createEventVolunteerRoleInputSchema,
  createFromTemplatesInputSchema,
  updateEventVolunteerRoleInputSchema,
  deleteEventVolunteerRoleInputSchema,
  listEventVolunteerRolesInputSchema,
  createVolunteerShiftInputSchema,
  createVolunteerShiftInputSchemaBase,
  createVolunteerShiftBatchInputSchema,
  createVolunteerShiftBatchInputSchemaBase,
  updateVolunteerShiftInputSchema,
  updateVolunteerShiftInputSchemaBase,
  deleteVolunteerShiftInputSchema,
  listVolunteerShiftsInputSchema,
  submitVolunteerSignupInputSchema,
  reviewVolunteerSignupInputSchema,
  reviewVolunteerSignupsBatchInputSchema,
  checkInVolunteerInputSchema,
  withdrawVolunteerSignupInputSchema,
  updateVolunteerContactPrefsInputSchema,
  listMyVolunteerSignupsInputSchema,
  listMyVolunteerCommitmentsInputSchema,
  listVolunteerSignupsInputSchema,
  type CreateRoleTemplateUseCaseInput,
  type UpdateRoleTemplateUseCaseInput,
  type ArchiveRoleTemplateUseCaseInput,
  type ListRoleTemplatesUseCaseInput,
  type UpsertRoleTemplateShiftsUseCaseInput,
  type GetRoleTemplateWithShiftsUseCaseInput,
  type RoleTemplateShiftDraftUseCaseInput,
  type CreateEventVolunteerRoleUseCaseInput,
  type CreateFromTemplatesUseCaseInput,
  type UpdateEventVolunteerRoleUseCaseInput,
  type DeleteEventVolunteerRoleUseCaseInput,
  type ListEventVolunteerRolesUseCaseInput,
  type CreateVolunteerShiftUseCaseInput,
  type CreateVolunteerShiftBatchUseCaseInput,
  type UpdateVolunteerShiftUseCaseInput,
  type DeleteVolunteerShiftUseCaseInput,
  type ListVolunteerShiftsUseCaseInput,
  type SubmitVolunteerSignupUseCaseInput,
  type ReviewVolunteerSignupUseCaseInput,
  type ReviewVolunteerSignupsBatchUseCaseInput,
  type CheckInVolunteerUseCaseInput,
  type WithdrawVolunteerSignupUseCaseInput,
  type UpdateVolunteerContactPrefsUseCaseInput,
  type ListMyVolunteerSignupsUseCaseInput,
  type ListMyVolunteerCommitmentsUseCaseInput,
  type ListVolunteerSignupsUseCaseInput,
} from "./schemas";

export {
  forkPlatformRoleTemplateInputSchema,
  listVolunteerPacksInputSchema,
  volunteerShiftAnchorSchema,
  type ForkPlatformRoleTemplateUseCaseInput,
  type ListVolunteerPacksUseCaseInput,
} from "./schemas";

export {
  mintVolunteerScanTokenInputSchema,
  resolveVolunteerSignupByTokenInputSchema,
  searchVolunteerSignupsForCheckInInputSchema,
  getVolunteerContextForTicketScanInputSchema,
  type MintVolunteerScanTokenUseCaseInput,
  type ResolveVolunteerSignupByTokenUseCaseInput,
  type SearchVolunteerSignupsForCheckInUseCaseInput,
  type GetVolunteerContextForTicketScanUseCaseInput,
} from "./schemas";

export {
  getOrgVolunteerHoursSummaryInputSchema,
  type GetOrgVolunteerHoursSummaryUseCaseInput,
} from "./schemas";

export {
  createShiftOccurrence,
  updateShiftOccurrence,
  cancelShiftOccurrence,
  listAskOccurrences,
  type ManageShiftOccurrencesDeps,
} from "./manage-shift-occurrences";

export {
  claimOccurrence,
  withdrawOccurrenceClaim,
  assignOccurrenceClaim,
  checkInOccurrenceClaim,
  listOccurrenceRoster,
  getPublicAskSchedule,
  type OccurrenceClaimDeps,
  type OccurrenceRoster,
  type PublicAskScheduleOccurrence,
  type GetPublicAskScheduleOutput,
} from "./occurrence-claims";

export {
  createShiftOccurrenceInputSchema,
  createShiftOccurrenceInputSchemaBase,
  updateShiftOccurrenceInputSchema,
  cancelShiftOccurrenceInputSchema,
  listAskOccurrencesInputSchema,
  claimOccurrenceInputSchema,
  withdrawOccurrenceClaimInputSchema,
  assignOccurrenceClaimInputSchema,
  checkInOccurrenceClaimInputSchema,
  listOccurrenceRosterInputSchema,
  getPublicAskScheduleInputSchema,
  type CreateShiftOccurrenceUseCaseInput,
  type UpdateShiftOccurrenceUseCaseInput,
  type CancelShiftOccurrenceUseCaseInput,
  type ListAskOccurrencesUseCaseInput,
  type ClaimOccurrenceUseCaseInput,
  type WithdrawOccurrenceClaimUseCaseInput,
  type AssignOccurrenceClaimUseCaseInput,
  type CheckInOccurrenceClaimUseCaseInput,
  type ListOccurrenceRosterUseCaseInput,
  type GetPublicAskScheduleUseCaseInput,
} from "./schemas";

export {
  volunteerRewardTriggerSchema,
  setVolunteerRewardInputSchema,
  grantVolunteerRewardInputSchema,
  revokeVolunteerRewardInputSchema,
  listAskRewardLedgerInputSchema,
  listAskRewardsInputSchema,
  type SetVolunteerRewardUseCaseInput,
  type GrantVolunteerRewardUseCaseInput,
  type RevokeVolunteerRewardUseCaseInput,
  type ListAskRewardLedgerUseCaseInput,
  type ListAskRewardsUseCaseInput,
} from "./schemas";

export {
  volunteerSubjectTypeSchema,
  volunteerAskStatusSchema,
  volunteerAskCadenceSchema,
  createVolunteerAskInputSchema,
  createVolunteerAskInputSchemaBase,
  updateVolunteerAskInputSchema,
  addVolunteerAskRoleInputSchema,
  updateVolunteerAskRoleInputSchema,
  createVolunteerGroupInputSchema,
  assignGroupCoordinatorInputSchema,
  assignGroupCoordinatorInputSchemaBase,
  assignSignupToGroupInputSchema,
  listAskRosterInputSchema,
  listCoordinatorRosterInputSchema,
  listAskSignupsScopeSchema,
  listAskSignupsInputSchema,
  volunteerBroadcastScopeSchema,
  broadcastToRosterInputSchema,
  listAskBroadcastsInputSchema,
  exportSignupIcsInputSchema,
  getMyVolunteerIcsFeedTokenInputSchema,
  rotateMyVolunteerIcsFeedTokenInputSchema,
  exportMyVolunteeringIcsInputSchema,
  type VolunteerBroadcastScopeInput,
  type BroadcastToRosterUseCaseInput,
  type ListAskBroadcastsUseCaseInput,
  type ExportSignupIcsUseCaseInput,
  type GetMyVolunteerIcsFeedTokenUseCaseInput,
  type RotateMyVolunteerIcsFeedTokenUseCaseInput,
  type ExportMyVolunteeringIcsUseCaseInput,
  type CreateVolunteerAskUseCaseInput,
  type UpdateVolunteerAskUseCaseInput,
  type AddVolunteerAskRoleUseCaseInput,
  type UpdateVolunteerAskRoleUseCaseInput,
  type CreateVolunteerGroupUseCaseInput,
  type AssignGroupCoordinatorUseCaseInput,
  type AssignSignupToGroupUseCaseInput,
  type ListAskRosterUseCaseInput,
  type ListCoordinatorRosterUseCaseInput,
  type ListAskSignupsScopeInput,
  type ListAskSignupsUseCaseInput,
} from "./schemas";
