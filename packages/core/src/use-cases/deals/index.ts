/**
 * Deal terms and the settlement sheet (deal-terms-and-settlement stage 1,
 * P4b). The calculator lives in `lib/settlement`; these are its use cases.
 */
export * from "./get-agreement-deal";
export * from "./set-agreement-deal";
export * from "./project-agreement-deal";
export * from "./set-terms-deal";
export * from "./get-terms-deal";
export * from "./answer-deal-clause";
export * from "./set-resale-clause";
export * from "./get-resale-clause";
export {
  resaleClauseViewSchema,
  resaleTermsViewSchema,
  type ResaleTermsView,
} from "./_shared/resale-terms-view";
export { dealFingerprint, dealDeductionsFingerprint } from "./_shared/deal-fingerprint";
export {
  dealNotEditableReasonSchema,
  dealTargetSchema,
  type DealNotEditableReason,
  type DealTarget,
} from "./_shared/deal-target";
export * from "./get-event-settlement";
export * from "./settlement-sheet-entries";
export * from "./mark-event-settled";
export * from "./export-event-settlement-csv";
// freeze-the-deal (docs/specs/2026-10-14/freeze-the-deal.spec.yaml)
export * from "./freeze-event-deal";
export * from "./list-deal-changes";
export {
  assertDealWritable,
  bookingDealScope,
  notifyDealChange,
  recordDealChange,
  type DealChangeNoticeDeps,
  type DealFence,
  type DealScope,
  type EventDealSnapshot,
  type RecordedDealChange,
} from "./_shared/deal-freeze";
export { dealFreezeViewSchema, type DealFreezeView } from "./_shared/deal-freeze-view";
export {
  resolveDealRemainder,
  type DealRemainder,
  type DealRemainderSource,
} from "./_shared/deal-from-storage";
export {
  projectSettlementForViewer,
  resolveDealViewer,
  type DealViewer,
  type SettlementView,
} from "./_shared/deal-visibility";
