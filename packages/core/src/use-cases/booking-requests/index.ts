export {
  createBookingRequest,
  createBookingRequestBaseSchema,
  createBookingRequestInputSchema,
  createBookingRequestOutputSchema,
  createBookingRequestWireOutputSchema,
  bookingIntentSchema,
  normalizeBookingTags,
  BOOKING_REQUEST_TTL_DAYS,
  BOOKING_PURPOSE_MAX_LENGTH,
  BOOKING_WINDOW_MAX_DAYS,
  BOOKING_WINDOW_PAST_GRACE_MS,
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_FEE_AMOUNT_MAX_CENTS,
  BOOKING_FEE_DEFAULT_CURRENCY,
  runBookingRequestGates,
  writeBookingRequestInTx,
  assertPlaceTakesRequests,
  BOOKING_LINEUP_TAG_DAILY_MAX,
  BOOKING_LINEUP_TAG_DAILY_WINDOW_SECONDS,
  bookingLineupTagBudgetKey,
  type BookingRequestGateArgs,
  type BookingRequestGateRepos,
  type BookingRequestGateResult,
  type BookingRequestWriteArgs,
  type BookingRequestWriteFields,
  type BookingIntentInput,
  type CreateBookingRequestDeps,
  type CreateBookingRequestInput,
  type CreateBookingRequestOutput,
  type CreateBookingRequestWireOutput,
} from "./create-booking-request";

// ── Notification intents on requests (docs/specs/2026-08-27) ───────────────

export {
  BOOKING_REQUEST_INTENT_KINDS,
  bookingRequestNotificationIntentSchema,
  type BookingRequestIntentKind,
  type BookingRequestNotificationIntent,
  type RequestReceivedIntent,
} from "./_shared/booking-request-intents";

export {
  dispatchBookingRequestIntents,
  type DispatchBookingRequestIntentsArgs,
  type DispatchBookingRequestIntentsDeps,
  type NotifyBookingRequestIntentsFn,
} from "./notify-booking-request-intents";

export {
  createBookingRequestFromEvent,
  EVENT_FIRST_ABSORBED_SKIP_REASONS,
  EVENT_FIRST_SKIP_CODES,
  isEventFirstAbsorbedSkip,
  type CreateBookingRequestFromEventArgs,
  type CreateBookingRequestFromEventRepos,
  type CreateBookingRequestFromEventResult,
  type EventFirstAbsorbedSkip,
  type EventFirstAbsorbedSkipReason,
  type EventFirstInternalSkip,
  type EventFirstInternalSkipReason,
  type EventFirstSkipReason,
} from "./create-booking-request-from-event";

// ── Amendment 2026-09-25: requests parked before it are expired (ops) ───────
export {
  expireParkedBookingRequests,
  expireParkedBookingRequestsInputSchema,
  expireParkedBookingRequestsOutputSchema,
  type ExpireParkedBookingRequestsDeps,
  type ExpireParkedBookingRequestsInput,
  type ExpireParkedBookingRequestsOutput,
} from "./expire-parked-booking-requests";

export { BOOKING_TAG_MAX_COUNT, BOOKING_TAG_MAX_LENGTH } from "./constants";

export {
  createOrganizerBookingRequest,
  createOrganizerBookingRequestBaseSchema,
  createOrganizerBookingRequestInputSchema,
  createOrganizerBookingRequestOutputSchema,
  type CreateOrganizerBookingRequestDeps,
  type CreateOrganizerBookingRequestInput,
  type CreateOrganizerBookingRequestOutput,
} from "./create-organizer-booking-request";

export {
  listBookingRequests,
  listBookingRequestsInputSchema,
  listBookingRequestsOutputSchema,
  bookingRequestStatusSchema,
  bookingRequestSummarySchema,
  bookingRequestHoldSummarySchema,
  bookingRequestTagSummarySchema,
  toBookingRequestSummary,
  type BookingRequestSummary,
  type BookingWorkflow,
  // The stage projection (request → agreement → event) `toBookingRequestSummary`
  // takes — exported so a caller can name the shape it is supplying.
  type BookingStage,
  type ListBookingRequestsDeps,
  type ListBookingRequestsInput,
  type ListBookingRequestsOutput,
} from "./list-booking-requests";

export {
  countOpenBookingRequests,
  countOpenBookingRequestsBaseSchema,
  countOpenBookingRequestsOwnerSchema,
  countOpenBookingRequestsInputSchema,
  countOpenBookingRequestsOutputSchema,
  type CountOpenBookingRequestsDeps,
  type CountOpenBookingRequestsInput,
  type CountOpenBookingRequestsOutput,
} from "./count-open-booking-requests";

export {
  markBookingRequestViewed,
  markBookingRequestViewedInputSchema,
  markBookingRequestViewedOutputSchema,
  type MarkBookingRequestViewedDeps,
  type MarkBookingRequestViewedInput,
  type MarkBookingRequestViewedOutput,
} from "./mark-booking-request-viewed";

export {
  respondToBookingRequest,
  respondToBookingRequestBaseSchema,
  respondToBookingRequestInputSchema,
  respondToBookingRequestOutputSchema,
  respondToBookingRequestWireOutputSchema,
  type RespondToBookingRequestDeps,
  type RespondToBookingRequestInput,
  type RespondToBookingRequestOutput,
  type RespondToBookingRequestWireOutput,
} from "./respond-to-booking-request";

// NOTE(booking-embed step 6): expose the two use cases below as tRPC
// procedures on routers/booking-requests.ts —
//   bookingRequests.claim (authed, performer-mode inside the use case)
//     deps: repos, idempotency, clock, logger
//   bookingRequests.resendInvite (authed, venue-side)
//     deps: repos, clock, logger, mailer, publicAppUrl, reportError
export {
  claimBookingRequest,
  claimBookingRequestInputSchema,
  claimBookingRequestOutputSchema,
  type ClaimBookingRequestDeps,
  type ClaimBookingRequestInput,
  type ClaimBookingRequestOutput,
} from "./claim-booking-request";

export {
  resendBookingRequestInvite,
  resendBookingRequestInviteInputSchema,
  resendBookingRequestInviteOutputSchema,
  type ResendBookingRequestInviteDeps,
  type ResendBookingRequestInviteInput,
  type ResendBookingRequestInviteOutput,
} from "./resend-booking-request-invite";

export {
  withdrawBookingRequest,
  withdrawBookingRequestInputSchema,
  withdrawBookingRequestOutputSchema,
  withdrawBookingRequestWireOutputSchema,
  type WithdrawBookingRequestDeps,
  type WithdrawBookingRequestInput,
  type WithdrawBookingRequestOutput,
  type WithdrawBookingRequestWireOutput,
} from "./withdraw-booking-request";

// booking-the-night N14 / FR-010: the venue's exit after accept.
export {
  closeBookingRequest,
  closeBookingRequestInputSchema,
  closeBookingRequestOutputSchema,
  closeBookingRequestWireOutputSchema,
  type CloseBookingRequestDeps,
  type CloseBookingRequestInput,
  type CloseBookingRequestOutput,
} from "./close-booking-request";

// booking-the-night N13 / FR-009 (review W4): both sides hear the cancel.
export {
  notifyBookingCancelled,
  fireBookingCancelled,
  BOOKING_CANCELLED_VARIANT,
  type NotifyBookingCancelledArgs,
  type NotifyBookingCancelledDeps,
  type NotifyBookingCancelledFn,
} from "./notify-booking-cancelled";

// booking-the-night N13 / FR-009: the one undo for a booked night.
export {
  cancelBooking,
  cancelBookingInputSchema,
  cancelBookingOutputSchema,
  cancelBookingWireOutputSchema,
  type CancelBookingDeps,
  type CancelBookingInput,
  type CancelBookingOutput,
} from "./cancel-booking";

export {
  assignBookingRequest,
  assignBookingRequestInputSchema,
  assignBookingRequestOutputSchema,
  isEligibleAssignee,
  type AssignBookingRequestDeps,
  type AssignBookingRequestInput,
  type AssignBookingRequestOutput,
} from "./assign-booking-request";

export {
  acceptBookingRequestInTx,
  requireRespondableInTx,
  type AcceptBookingRequestInTxArgs,
  type AcceptBookingRequestInTxResult,
} from "./_shared/accept-in-tx";

export {
  expireBookingRequests,
  expireBookingRequestsInputSchema,
  expireBookingRequestsOutputSchema,
  expireBookingRequestsWireOutputSchema,
  type ExpireBookingRequestsDeps,
  type ExpireBookingRequestsInput,
  type ExpireBookingRequestsOutput,
  type ExpireBookingRequestsWireOutput,
} from "./expire-booking-requests";

export {
  notifyBookingRequestReceived,
  BOOKING_REQUEST_RECEIVED_VARIANT,
  type NotifyBookingRequestReceivedArgs,
  type NotifyBookingRequestReceivedDeps,
  type NotifyBookingRequestReceivedFn,
} from "./notify-booking-request-received";

// ── The bill (lineup-booking-requests v2, docs/specs/2026-09-25) ───────────

export {
  notifyBookingLineupInvited,
  bookingLineupInvitedIdempotencyKey,
  BOOKING_LINEUP_INVITED_VARIANT,
  type NotifyBookingLineupInvitedArgs,
  type NotifyBookingLineupInvitedDeps,
  type NotifyBookingLineupInvitedFn,
} from "./notify-booking-lineup-invited";

export {
  anonymousBookingBillSchema,
  bookingBillActSchema,
  bookingBillExternalActSchema,
  bookingBillSchema,
  bookingBillSignedInExternalActSchema,
  bookingBillTaggedActSchema,
  BOOKING_BILL_ACT_NAME_MAX_LENGTH,
  BOOKING_BILL_ANONYMOUS_MAX_EXTRA_ACTS,
  BOOKING_BILL_CUSTOM_ROLE_LABEL_MAX_LENGTH,
  BOOKING_BILL_MAX_ROWS,
  type AnonymousBookingBillInput,
  type BookingBillActInput,
  type BookingBillInput,
} from "./_shared/bill-schema";

export {
  resolveTaggableGroups,
  resolveTaggableHumans,
  type TaggableGroup,
  type TaggableHuman,
} from "./_shared/taggable-humans";

export {
  bookingRequestActConfirmationSchema,
  bookingRequestActRoleSchema,
  bookingRequestActSourceSchema,
  bookingRequestBillItemSchema,
  type BookingRequestBillItem,
} from "./_shared/bill-items";

export {
  findBookingEventForBill,
  isActOnBookingEventLineup,
} from "./_shared/bill-event";

export {
  confirmBookingRequestAct,
  declineBookingRequestAct,
  confirmBookingRequestActInputSchema,
  declineBookingRequestActInputSchema,
  joinBookingRequestAct,
  passBookingRequestAct,
  joinBookingRequestActInputSchema,
  passBookingRequestActInputSchema,
  bookingRequestActAnswerOutputSchema,
  judgeActAnswer,
  ACT_CONFIRMABLE_REQUEST_STATUSES,
  BOOKING_ACT_DECLINE_REASON_MAX_LENGTH,
  type ActAnswerVerdict,
  type AnswerBookingRequestActDeps,
  type BookingRequestActAnswerOutput,
  type ConfirmBookingRequestActInput,
  type DeclineBookingRequestActInput,
} from "./answer-booking-request-act";

export {
  getBookingRequestActInvite,
  getBookingRequestActInviteInputSchema,
  getBookingRequestActInviteOutputSchema,
  type GetBookingRequestActInviteDeps,
  type GetBookingRequestActInviteInput,
  type GetBookingRequestActInviteOutput,
} from "./get-booking-request-act-invite";

// ── The bill, v3: editing it and what each change tells (FR-009 / FR-012) ──

export {
  editBookingRequestBill,
  editBookingRequestBillInputSchema,
  editBookingRequestBillOutputSchema,
  bookingBillEditOpSchema,
  planBillEdit,
  BOOKING_BILL_EDIT_MAX_OPS,
  BOOKING_LINEUP_REINVITE_EMAIL_COOLDOWN_MS,
  type BookingBillEditOp,
  type EditBookingRequestBillDeps,
  type EditBookingRequestBillInput,
  type EditBookingRequestBillOutput,
} from "./edit-booking-request-bill";

export {
  buildBillChangedEntry,
  isVenueVisibleAct,
  type BillChangedEntryData,
} from "./_shared/bill-changed-entry";

export {
  BILL_ACT_NAME_FALLBACK,
  BILL_ACT_NAME_MAX_LENGTH,
  resolveBillActName,
  resolveBillActNames,
} from "./_shared/bill-act-names";

export {
  notifyBookingLineupAnswered,
  bookingLineupAnsweredIdempotencyKey,
  BOOKING_LINEUP_ANSWERED_VARIANT,
  type BookingLineupAnswer,
  type NotifyBookingLineupAnsweredArgs,
  type NotifyBookingLineupAnsweredDeps,
  type NotifyBookingLineupAnsweredFn,
} from "./notify-booking-lineup-answered";

export {
  notifyBookingLineupRequestClosed,
  fireBookingLineupRequestClosed,
  bookingLineupRequestClosedIdempotencyKey,
  BOOKING_LINEUP_REQUEST_CLOSED_VARIANT,
  type BookingLineupRequestClosedBy,
  type NotifyBookingLineupRequestClosedArgs,
  type NotifyBookingLineupRequestClosedDeps,
  type NotifyBookingLineupRequestClosedFn,
} from "./notify-booking-lineup-request-closed";

export {
  notifyBookingLineupRemoved,
  bookingLineupRemovedIdempotencyKey,
  BOOKING_LINEUP_REMOVED_VARIANT,
  type NotifyBookingLineupRemovedArgs,
  type NotifyBookingLineupRemovedDeps,
  type NotifyBookingLineupRemovedFn,
} from "./notify-booking-lineup-removed";

export {
  notifyOrganizerBookingRequestReceived,
  ORGANIZER_BOOKING_REQUEST_RECEIVED_VARIANT,
  type NotifyOrganizerBookingRequestReceivedArgs,
  type NotifyOrganizerBookingRequestReceivedDeps,
  type NotifyOrganizerBookingRequestReceivedFn,
} from "./notify-organizer-booking-request-received";

// booking-the-night N9 / FR-008: the sender hears the answer, both
// directions (the organiser-only notifier folded into this one).
export {
  notifyBookingRequestResponded,
  fireBookingRequestResponded,
  BOOKING_REQUEST_RESPONDED_VARIANT,
  type BookingRequestResponseAction,
  type NotifyBookingRequestRespondedArgs,
  type NotifyBookingRequestRespondedDeps,
  type NotifyBookingRequestRespondedFn,
} from "./notify-booking-request-responded";

// ── Thread messages (booking-conversation 2026-07-14 / venue-hierarchy FR-012) ──

export {
  postBookingRequestMessage,
  postBookingRequestMessageInputSchema,
  bookingRequestMessageOutputSchema,
  BOOKING_MESSAGE_MAX,
  type PostBookingRequestMessageDeps,
  type PostBookingRequestMessageInput,
  type PostBookingRequestMessageOutput,
} from "./messages/post-message";

export {
  listBookingRequestMessages,
  listBookingRequestMessagesInputSchema,
  listBookingRequestMessagesOutputSchema,
  type ListBookingRequestMessagesDeps,
  type ListBookingRequestMessagesUseCaseInput,
  type ListBookingRequestMessagesOutput,
} from "./messages/list-messages";

export {
  markBookingRequestMessagesRead,
  markBookingRequestMessagesReadInputSchema,
  markBookingRequestMessagesReadOutputSchema,
  type MarkBookingRequestMessagesReadDeps,
  type MarkBookingRequestMessagesReadUseCaseInput,
  type MarkBookingRequestMessagesReadOutput,
} from "./messages/mark-read";

export {
  notifyBookingRequestMessage,
  BOOKING_MESSAGE_RECEIVED_VARIANT,
  type NotifyBookingRequestMessageArgs,
  type NotifyBookingRequestMessageDeps,
  type NotifyBookingRequestMessagePostedFn,
} from "./notify-booking-request-message";

// ── Venue → anonymous inquirer outreach (booking-inquirer-outreach) ─────────

export {
  notifyBookingInquirer,
  type NotifyBookingInquirerDeps,
} from "./notify-booking-inquirer";

export {
  markBookingInquirerUndeliverable,
  markBookingInquirerUndeliverableInputSchema,
  markBookingInquirerUndeliverableOutputSchema,
  type MarkBookingInquirerUndeliverableDeps,
  type MarkBookingInquirerUndeliverableInput,
  type MarkBookingInquirerUndeliverableOutput,
} from "./mark-booking-inquirer-undeliverable";

// ── Attachments (venue-hierarchy FR-008) ────────────────────────────────────

export {
  addBookingRequestAttachment,
  addBookingRequestAttachmentInputSchema,
  listBookingRequestAttachments,
  listBookingRequestAttachmentsInputSchema,
  deleteBookingRequestAttachment,
  deleteBookingRequestAttachmentInputSchema,
  bookingRequestAttachmentOutputSchema,
  type AddBookingRequestAttachmentUseCaseInput,
  type BookingRequestAttachmentOutput,
  type BookingRequestAttachmentsDeps,
  type DeleteBookingRequestAttachmentUseCaseInput,
  type ListBookingRequestAttachmentsUseCaseInput,
} from "./attachments";

// ── P3b (asks) ── venue-booking-standards v1.1 FR-009 ───────────────────────

export { type AddBookingRequestAttachmentDeps } from "./attachments";

export {
  requestBookingAttachmentUpload,
  requestBookingAttachmentUploadInputSchema,
  requestBookingAttachmentUploadOutputSchema,
  getBookingAttachmentUrl,
  getBookingAttachmentUrlInputSchema,
  getBookingAttachmentUrlOutputSchema,
  type RequestBookingAttachmentUploadDeps,
  type RequestBookingAttachmentUploadInput,
  type RequestBookingAttachmentUploadOutput,
  type GetBookingAttachmentUrlDeps,
  type GetBookingAttachmentUrlInput,
  type GetBookingAttachmentUrlOutput,
} from "./attachment-files";

export {
  BOOKING_ATTACHMENT_CONTENT_TYPES,
  BOOKING_ATTACHMENT_MAX_BYTES,
} from "./_shared/attachment-files";

export {
  bookingRequestAskOutputSchema,
  ANSWER_TYPE_FOR_KIND,
  BOOKING_ASK_LABEL_MAX,
  BOOKING_ASK_NOTE_MAX,
  BOOKING_ASK_ANSWER_TEXT_MAX,
  BOOKING_ASK_SET_LENGTH_MIN,
  BOOKING_ASK_SET_LENGTH_MAX,
  type BookingRequestAskOutput,
} from "./asks/_shared/ask-schemas";

export {
  askOnBookingRequest,
  askOnBookingRequestInputSchema,
  type AskOnBookingRequestDeps,
  type AskOnBookingRequestInput,
} from "./asks/ask-on-booking-request";

export {
  answerBookingRequestAsk,
  answerBookingRequestAskInputSchema,
  type AnswerBookingRequestAskDeps,
  type AnswerBookingRequestAskUseCaseInput,
} from "./asks/answer-booking-request-ask";

export {
  withdrawBookingRequestAsk,
  withdrawBookingRequestAskInputSchema,
  type WithdrawBookingRequestAskDeps,
  type WithdrawBookingRequestAskUseCaseInput,
} from "./asks/withdraw-booking-request-ask";

export {
  listBookingRequestAsks,
  listBookingRequestAsksInputSchema,
  listBookingRequestAsksOutputSchema,
  listBookingRequestAskSuggestions,
  listBookingRequestAskSuggestionsInputSchema,
  listBookingRequestAskSuggestionsOutputSchema,
  ASK_KIND_FOR_STANDARD_FIELD,
  type ListBookingRequestAsksDeps,
  type ListBookingRequestAsksOutput,
  type ListBookingRequestAskSuggestionsOutput,
} from "./asks/list-booking-request-asks";

export {
  notifyBookingRequestAsk,
  BOOKING_ASK_RECEIVED_VARIANT,
  BOOKING_ASK_ANSWERED_VARIANT,
  type NotifyBookingRequestAskArgs,
  type NotifyBookingRequestAskDeps,
  type NotifyBookingRequestAskFn,
} from "./asks/notify-booking-request-ask";

export {
  mapAskImageToEvent,
  type AskImageMappingDeps,
  type AskImageMappingOutcome,
} from "./asks/map-ask-answers";
