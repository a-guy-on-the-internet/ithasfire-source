export {
  getPlatformSettings,
  getPlatformSettingsInputSchema,
  getPlatformSettingsOutputSchema,
  type GetPlatformSettingsInput,
  type GetPlatformSettingsOutput,
  type GetPlatformSettingsDeps,
} from "./get-platform-settings";

export {
  updatePlatformSetting,
  updatePlatformSettingInputSchema,
  updatePlatformSettingOutputSchema,
  type UpdatePlatformSettingInput,
  type UpdatePlatformSettingOutput,
  type UpdatePlatformSettingDeps,
} from "./update-platform-setting";

export {
  getGlobalFeePolicy,
  getGlobalFeePolicyInputSchema,
  getGlobalFeePolicyOutputSchema,
  feePolicyOutputSchema,
  type GetGlobalFeePolicyInput,
  type GetGlobalFeePolicyOutput,
  type GetGlobalFeePolicyDeps,
} from "./get-org-fee-policy";

export {
  listFeeWaivers,
  listFeeWaiversInputSchema,
  listFeeWaiversOutputSchema,
  grantFeeWaiver,
  grantFeeWaiverInputSchema,
  grantFeeWaiverInputSchemaBase,
  grantFeeWaiverOutputSchema,
  revokeFeeWaiver,
  revokeFeeWaiverInputSchema,
  revokeFeeWaiverOutputSchema,
  feeWaiverOutputSchema,
  type ListFeeWaiversInput,
  type ListFeeWaiversOutput,
  type GrantFeeWaiverInput,
  type GrantFeeWaiverOutput,
  type RevokeFeeWaiverInput,
  type RevokeFeeWaiverOutput,
  type FeeWaiverDeps,
} from "./fee-waivers";

// NOTE: there is deliberately no `upsertGlobalFeePolicy`. The GLOBAL fee policy
// is defined in code (`packages/core/src/lib/pricing/platform-fee-policy.ts`)
// and materialized into the DB by `seed-platform-fee-policy.ts` on every
// deploy. `/platform/fees` reads `getGlobalFeePolicy` and nothing else — a
// hand-edit path would be silently reverted by the next deploy. The write side
// is the deploy-time reconciler below, which takes no actor and is NOT exposed
// on any router.

export {
  reconcilePlatformFeePolicy,
  diffPlatformFeePolicy,
  type ReconcilePlatformFeePolicyDeps,
  type ReconcilePlatformFeePolicyOptions,
  type ReconcilePlatformFeePolicyResult,
  type PlatformFeePolicyField,
  type PlatformFeePolicyFieldDiff,
} from "./reconcile-platform-fee-policy";

export * from "./theme-presets";

export {
  getPlatformStats,
  getPlatformStatsInputSchema,
  getPlatformStatsOutputSchema,
  type GetPlatformStatsInput,
  type GetPlatformStatsOutput,
  type GetPlatformStatsDeps,
} from "./get-platform-stats";

// ── Admin Human Management ───────────────────────────────────────────────

export {
  adminSetHumanStatus,
  adminSetHumanStatusInputSchema,
  adminSetHumanStatusOutputSchema,
  type AdminSetHumanStatusInput,
  type AdminSetHumanStatusOutput,
  type AdminSetHumanStatusDeps,
} from "./admin-set-human-status";

export {
  listFlaggedSignups,
  listFlaggedSignupsInputSchema,
  listFlaggedSignupsOutputSchema,
  type ListFlaggedSignupsInput,
  type ListFlaggedSignupsOutput,
  type ListFlaggedSignupsDeps,
} from "./list-flagged-signups";

export {
  adminForceVerifyEmail,
  adminForceVerifyEmailInputSchema,
  adminForceVerifyEmailOutputSchema,
  type AdminForceVerifyEmailInput,
  type AdminForceVerifyEmailOutput,
  type AdminForceVerifyEmailDeps,
} from "./admin-force-verify-email";

export {
  adminUnlinkAuthAccount,
  adminUnlinkAuthAccountInputSchema,
  adminUnlinkAuthAccountOutputSchema,
  type AdminUnlinkAuthAccountInput,
  type AdminUnlinkAuthAccountOutput,
  type AdminUnlinkAuthAccountDeps,
} from "./admin-unlink-auth-account";

export {
  adminDeleteHuman,
  adminDeleteHumanInputSchema,
  adminDeleteHumanOutputSchema,
  type AdminDeleteHumanInput,
  type AdminDeleteHumanOutput,
  type AdminDeleteHumanDeps,
} from "./admin-delete-human";

export {
  adminGrantHumanRole,
  adminGrantHumanRoleInputSchema,
  adminGrantHumanRoleOutputSchema,
  type AdminGrantHumanRoleInput,
  type AdminGrantHumanRoleOutput,
  type AdminGrantHumanRoleDeps,
} from "./admin-grant-human-role";

export {
  adminRevokeHumanRole,
  adminRevokeHumanRoleInputSchema,
  adminRevokeHumanRoleOutputSchema,
  type AdminRevokeHumanRoleInput,
  type AdminRevokeHumanRoleOutput,
  type AdminRevokeHumanRoleDeps,
} from "./admin-revoke-human-role";

// ── Audit Log Viewer ─────────────────────────────────────────────────────

export {
  listAuditLogs,
  listAuditLogsInputSchema,
  listAuditLogsOutputSchema,
  type ListAuditLogsInput,
  type ListAuditLogsOutput,
  type ListAuditLogsDeps,
} from "./list-audit-logs";

// ── Admin Place Management ───────────────────────────────────────────────

export {
  adminBulkDeletePlaces,
  adminBulkDeletePlacesInputSchema,
  adminBulkDeletePlacesOutputSchema,
  type AdminBulkDeletePlacesInput,
  type AdminBulkDeletePlacesOutput,
  type AdminBulkDeletePlacesDeps,
} from "./admin-bulk-delete-places";

// ── Featured Items ───────────────────────────────────────────────────────

export {
  listFeaturedItems,
  listFeaturedItemsInputSchema,
  listFeaturedItemsOutputSchema,
  type ListFeaturedItemsInput,
  type ListFeaturedItemsOutput,
  type ListFeaturedItemsDeps,
  listFeaturedAdminItems,
  listFeaturedAdminItemsInputSchema,
  listFeaturedAdminItemsOutputSchema,
  type ListFeaturedAdminItemsInput,
  type ListFeaturedAdminItemsOutput,
  type ListFeaturedAdminItemsDeps,
  upsertFeaturedItem,
  upsertFeaturedItemInputSchema,
  upsertFeaturedItemOutputSchema,
  type UpsertFeaturedItemInput,
  type UpsertFeaturedItemOutput,
  type UpsertFeaturedItemDeps,
  removeFeaturedItem,
  removeFeaturedItemInputSchema,
  removeFeaturedItemOutputSchema,
  type RemoveFeaturedItemInput,
  type RemoveFeaturedItemOutput,
  type RemoveFeaturedItemDeps,
} from "./featured-items";

// ── Volunteer Packs (staff-curated volunteer role catalogue) ─────────────

export * from "./volunteer-packs";

// ── Ticket Packs (staff-curated ticket-type catalogue) ───────────────────

export * from "./ticket-packs";

// ── Payees in debt (negative ledger payables) ────────────────────────────

export {
  listPayeeDebtPositions,
  listPayeeDebtPositionsInputSchema,
  listPayeeDebtPositionsOutputSchema,
  payeeDebtPositionSchema,
  PAYEE_DEBT_READ_ROLES,
  type ListPayeeDebtPositionsInput,
  type ListPayeeDebtPositionsOutput,
  type ListPayeeDebtPositionsDeps,
  type PayeeDebtPosition,
} from "./list-payee-debt-positions";

// ── Unpaid cash balances (door cash-sale debt older than 30 days) ────────

export {
  listUnrecoveredCashDebts,
  listUnrecoveredCashDebtsInputSchema,
  listUnrecoveredCashDebtsOutputSchema,
  unrecoveredCashDebtSchema,
  CASH_DEBT_OVERDUE_DAYS,
  UNRECOVERED_CASH_DEBT_STATEMENT_TIMEOUT_MS,
  type ListUnrecoveredCashDebtsInput,
  type ListUnrecoveredCashDebtsOutput,
  type ListUnrecoveredCashDebtsDeps,
  type UnrecoveredCashDebt,
} from "./list-unrecovered-cash-debts";

// ── Payouts: what we OWE and what we PAID (platform settlements page) ────

export {
  listPayablePositions,
  listPayablePositionsInputSchema,
  listPayablePositionsOutputSchema,
  payablePositionSchema,
  payableCurrencyTotalSchema,
  outstandingLiabilityTotalSchema,
  PAYABLE_POSITIONS_READ_ROLES,
  PAYABLE_POSITIONS_MAX_ROWS,
  PAYABLE_POSITIONS_STATEMENT_TIMEOUT_MS,
  type ListPayablePositionsInput,
  type ListPayablePositionsOutput,
  type ListPayablePositionsDeps,
  type PayablePosition,
} from "./list-payable-positions";

export {
  listUpcomingPayouts,
  listUpcomingPayoutsInputSchema,
  listUpcomingPayoutsOutputSchema,
  upcomingPayoutTrancheSchema,
  upcomingPayoutsByDateSchema,
  upcomingPayoutNextByPayeeSchema,
  upcomingPayoutCurrencyTotalSchema,
  UPCOMING_PAYOUTS_READ_ROLES,
  UPCOMING_PAYOUTS_MAX_ROWS,
  UPCOMING_PAYOUTS_STATEMENT_TIMEOUT_MS,
  type ListUpcomingPayoutsInput,
  type ListUpcomingPayoutsOutput,
  type ListUpcomingPayoutsDeps,
  type UpcomingPayoutTranche,
} from "./list-upcoming-payouts";

// ── What the PLATFORM charged (and what the DB cannot say it kept) ───────

export {
  getPlatformRevenue,
  getPlatformRevenueInputSchema,
  getPlatformRevenueOutputSchema,
  platformRevenueCurrencyRowSchema,
  platformRevenueUnavailableReasonSchema,
  PLATFORM_REVENUE_READ_ROLES,
  PLATFORM_REVENUE_STATUSES,
  type GetPlatformRevenueInput,
  type GetPlatformRevenueOutput,
  type GetPlatformRevenueDeps,
  type PlatformRevenueCurrencyRow,
  type PlatformRevenueUnavailableReason,
} from "./get-platform-revenue";

export {
  listPayoutHistory,
  listPayoutHistoryInputSchema,
  listPayoutHistoryOutputSchema,
  payoutHistoryRowSchema,
  payoutHistoryStatusFilterSchema,
  PAYOUT_HISTORY_READ_ROLES,
  PAYOUT_HISTORY_STATEMENT_TIMEOUT_MS,
  type ListPayoutHistoryInput,
  type ListPayoutHistoryOutput,
  type ListPayoutHistoryDeps,
  type PayoutHistoryRow,
} from "./list-payout-history";

// ── Memberships: what they are worth, and which ones are broken ──────────
// (the visibility half of /platform/memberships; the RISK half lives in
// `memberships/membership-standing-admin.ts`)

export {
  summariseRecurringRevenue,
  summariseRecurringRevenueInputSchema,
  summariseRecurringRevenueOutputSchema,
  recurringRevenueCurrencyTotalSchema,
  RECURRING_REVENUE_READ_ROLES,
  RECURRING_REVENUE_STATEMENT_TIMEOUT_MS,
  type SummariseRecurringRevenueInput,
  type SummariseRecurringRevenueOutput,
  type SummariseRecurringRevenueDeps,
  type RecurringRevenueCurrencyTotal,
} from "./summarise-recurring-revenue";

export {
  listMembershipPositions,
  listMembershipPositionsInputSchema,
  listMembershipPositionsOutputSchema,
  membershipPositionSchema,
  membershipPositionBucketSchema,
  MEMBERSHIP_POSITIONS_READ_ROLES,
  MEMBERSHIP_POSITIONS_STATEMENT_TIMEOUT_MS,
  MEMBERSHIP_POSITIONS_INCOMPLETE_GRACE_HOURS,
  MEMBERSHIP_POSITIONS_LEAVING_WITHIN_DAYS,
  type ListMembershipPositionsInput,
  type ListMembershipPositionsOutput,
  type ListMembershipPositionsDeps,
  type MembershipPosition,
  type MembershipPositionBucket,
} from "./list-membership-positions";
