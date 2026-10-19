// Two-party booking Agreement editor (spec FR-004/FR-005).
//
// Deliberately OUTSIDE `use-cases/agreements/` — that folder is the
// PayoutTerms split engine (it calls PayoutTerms rows "agreements"); this one
// drives the `Agreement` negotiation header and reuses the engine's shared
// line validation by import, not colocation.

export {
  getBookingAgreement,
  getBookingAgreementInputSchema,
  getBookingAgreementOutputSchema,
  bookingAgreementLineSchema,
  payoutLineConfirmationStatusSchema,
  type GetBookingAgreementDeps,
  type GetBookingAgreementInput,
  type GetBookingAgreementOutput,
} from "./get-booking-agreement";

export {
  listBookingAgreements,
  listBookingAgreementsInputSchema,
  listBookingAgreementsOutputSchema,
  bookingAgreementSummarySchema,
  agreementStatusSchema,
  agreementPartyTypeSchema,
  type BookingAgreementSummary,
  type ListBookingAgreementsDeps,
  type ListBookingAgreementsInput,
  type ListBookingAgreementsOutput,
} from "./list-booking-agreements";

export {
  updateBookingAgreementHeader,
  updateBookingAgreementHeaderBaseSchema,
  updateBookingAgreementHeaderInputSchema,
  updateBookingAgreementHeaderOutputSchema,
  type UpdateBookingAgreementHeaderDeps,
  type UpdateBookingAgreementHeaderInput,
  type UpdateBookingAgreementHeaderOutput,
} from "./update-booking-agreement-header";

export {
  upsertBookingAgreementLine,
  upsertBookingAgreementLineInputSchema,
  upsertBookingAgreementLineOutputSchema,
  type BookingAgreementLineDeps,
  type UpsertBookingAgreementLineInput,
  type UpsertBookingAgreementLineOutput,
} from "./upsert-booking-agreement-line";

export {
  removeBookingAgreementLine,
  removeBookingAgreementLineInputSchema,
  removeBookingAgreementLineOutputSchema,
  type RemoveBookingAgreementLineInput,
  type RemoveBookingAgreementLineOutput,
} from "./remove-booking-agreement-line";

export {
  sendBookingAgreementForReview,
  sendBookingAgreementForReviewInputSchema,
  sendBookingAgreementForReviewOutputSchema,
  type BookingAgreementTransitionDeps,
  type SendBookingAgreementForReviewInput,
  type SendBookingAgreementForReviewOutput,
} from "./send-booking-agreement-for-review";

export {
  sendBookingTerms,
  sendBookingTermsInputSchema,
  sendBookingTermsOutputSchema,
  type SendBookingTermsDeps,
  type SendBookingTermsInput,
  type SendBookingTermsOutput,
} from "./send-booking-terms";

export {
  pullBackBookingAgreement,
  pullBackBookingAgreementInputSchema,
  pullBackBookingAgreementOutputSchema,
  type PullBackBookingAgreementInput,
  type PullBackBookingAgreementOutput,
} from "./pull-back-booking-agreement";

export {
  reopenBookingAgreement,
  reopenBookingAgreementInputSchema,
  reopenBookingAgreementOutputSchema,
  type ReopenBookingAgreementInput,
  type ReopenBookingAgreementOutput,
} from "./reopen-booking-agreement";

export {
  respondToBookingAgreement,
  respondToBookingAgreementBaseSchema,
  respondToBookingAgreementInputSchema,
  respondToBookingAgreementOutputSchema,
  respondToBookingAgreementWireOutputSchema,
  type RespondToBookingAgreementDeps,
  type RespondToBookingAgreementInput,
  type RespondToBookingAgreementOutput,
  type RespondToBookingAgreementWireOutput,
} from "./respond-to-booking-agreement";

export {
  cancelBookingAgreement,
  cancelBookingAgreementInputSchema,
  cancelBookingAgreementOutputSchema,
  CANCELLABLE_AGREEMENT_STATUSES,
  type CancelBookingAgreementInput,
  type CancelBookingAgreementOutput,
} from "./cancel-booking-agreement";

export {
  finalizeBookingAgreement,
  finalizeBookingAgreementInputSchema,
  finalizeBookingAgreementOutputSchema,
  type FinalizeBookingAgreementDeps,
  type FinalizeBookingAgreementInput,
  type FinalizeBookingAgreementOutput,
} from "./finalize-booking-agreement";

export {
  createEventFromAgreement,
  createEventFromAgreementForHold,
  createEventFromAgreementForHoldArgsSchema,
  createEventFromAgreementInputSchema,
  createEventFromAgreementOutputSchema,
  createEventFromAgreementWireOutputSchema,
  finalizeBlockedCodeSchema,
  type CreateEventFromAgreementDeps,
  type CreateEventFromAgreementInput,
  type CreateEventFromAgreementOutput,
  type FinalizeBlockedCode,
} from "./create-event-from-agreement";

export {
  EVENT_OWNER_SIDES,
  defaultEventOwnerSideForIntent,
  eventOwnerSideSchema,
  resolveEventOwnerSide,
  type EventOwnerSide,
} from "./_shared/event-owner-side";
