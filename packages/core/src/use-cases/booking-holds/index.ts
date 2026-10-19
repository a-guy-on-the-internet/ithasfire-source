// Booking holds (docs/specs/2026-08-25/completed/booking-holds.spec.yaml) — step 2,
// core. Transport (step 3) exposes these as `bookingHolds.*` procedures and
// turns the returned `notificationIntents` into notify() calls.

export {
  BOOKING_HOLD_INTENT_KINDS,
  bookingHoldNotificationIntentSchema,
  bookingHoldReleaseReasonSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldIntentAudience,
  type BookingHoldIntentKind,
  type BookingHoldNotificationIntent,
  type BookingHoldStaffRecipientHint,
} from "./_shared/booking-hold-intents";

export {
  isHoldGrantEnded,
  isHoldLapsed,
  todayInZone,
  type BookingHoldLapse,
  type HoldLapseOptions,
} from "./_shared/booking-hold-lapse";

export {
  settleLapsedHolds,
  TERMINAL_BOOKING_REQUEST_STATUSES,
  type SettleLapsedHoldsArgs,
  type SettleLapsedHoldsResult,
} from "./_shared/settle-lapsed-holds";

export {
  bookerBookingHoldOutputSchema,
  bookingHoldOutputSchema,
  bookingHoldStatusSchema,
  type BookerBookingHoldOutput,
  type BookingHoldDeps,
  type BookingHoldOutput,
} from "./_shared/hold-context";

// ── booking-the-night P2d-2 ── N20 readiness + N19 Keep = commit.
export {
  findReadyBehind,
  findReadyBehindOnLine,
  holdOwnerKindOf,
  isOwnerReadyToBook,
  isReadyToBookNight,
  READY_TERMS_STATUSES,
  type HoldOwnerKind,
} from "./_shared/night-readiness";
export {
  KEEP_AWAITING_TERMS_WINDOW_MS,
  resolveKeepPlan,
  type KeepWill,
} from "./_shared/keep-will";

export {
  placeBookingHold,
  placeBookingHoldInputSchema,
  placeBookingHoldOutputSchema,
  placeBookingHoldWireOutputSchema,
  type PlaceBookingHoldDeps,
  type PlaceBookingHoldInput,
  type PlaceBookingHoldOutput,
  type PlaceBookingHoldWireOutput,
} from "./place-booking-hold";

export {
  BOOKING_HOLD_BATCH_FAILURE_CODES,
  MAX_BOOKING_HOLD_BATCH_DATES,
  placeBookingHolds,
  placeBookingHoldsInputSchema,
  placeBookingHoldsOutputSchema,
  placeBookingHoldsWireOutputSchema,
  type BookingHoldBatchFailureCode,
  type PlaceBookingHoldsDeps,
  type PlaceBookingHoldsInput,
  type PlaceBookingHoldsOutput,
  type PlaceBookingHoldsWireOutput,
} from "./place-booking-holds";

// ── holds-without-a-request (spec 2026-09-30) step 6 ── request-less holds.
export {
  NAMED_PARTY_NOTICES_PER_DAY,
  placeRequestlessHolds,
  placeRequestlessHoldsInputSchema,
  placeRequestlessHoldsOutputSchema,
  placeRequestlessHoldsWireOutputSchema,
  REQUESTLESS_HOLD_FAILURE_CODES,
  type PlaceRequestlessHoldsDeps,
  type PlaceRequestlessHoldsInput,
  type PlaceRequestlessHoldsOutput,
  type RequestlessHoldFailureCode,
} from "./place-requestless-holds";
export {
  passNamedHold,
  passNamedHoldInputSchema,
  passNamedHoldOutputSchema,
  passNamedHoldWireOutputSchema,
  type PassNamedHoldDeps,
  type PassNamedHoldInput,
  type PassNamedHoldOutput,
} from "./pass-named-hold";
export {
  REQUESTLESS_HOLD_INTENT_KINDS,
  requestlessHoldNotificationIntentSchema,
  type RequestlessHoldIntentAudience,
  type RequestlessHoldIntentKind,
  type RequestlessHoldNotificationIntent,
} from "./_shared/requestless-hold-intents";

export {
  reorderBookingHold,
  reorderBookingHoldInputSchema,
  reorderBookingHoldOutputSchema,
  reorderBookingHoldWireOutputSchema,
  type ReorderBookingHoldDeps,
  type ReorderBookingHoldInput,
  type ReorderBookingHoldOutput,
  type ReorderBookingHoldWireOutput,
} from "./reorder-booking-hold";

export {
  challengeBookingHold,
  challengeBookingHoldInputSchema,
  challengeBookingHoldOutputSchema,
  challengeBookingHoldWireOutputSchema,
  challengeTermsToFirstHoldSchema,
  DEFAULT_CHALLENGE_WINDOW_MS,
  MAX_CHALLENGE_WINDOW_MS,
  MIN_CHALLENGE_WINDOW_MS,
  toChallengeBookingHoldWire,
  type ChallengeBookingHoldDeps,
  type ChallengeBookingHoldInput,
  type ChallengeBookingHoldOutput,
  type ChallengeBookingHoldWireOutput,
} from "./challenge-booking-hold";

export {
  extendBookingHoldChallenge,
  extendBookingHoldChallengeInputSchema,
  extendBookingHoldChallengeOutputSchema,
  extendBookingHoldChallengeWireOutputSchema,
  type ExtendBookingHoldChallengeDeps,
  type ExtendBookingHoldChallengeInput,
  type ExtendBookingHoldChallengeOutput,
  type ExtendBookingHoldChallengeWireOutput,
} from "./extend-booking-hold-challenge";

export {
  answerBookingHoldChallenge,
  answerBookingHoldChallengeInputSchema,
  answerBookingHoldChallengeOutputSchema,
  answerBookingHoldChallengeWireOutputSchema,
  keepOutcomeSchema,
  toAnswerBookingHoldChallengeWire,
  type AnswerBookingHoldChallengeDeps,
  type AnswerBookingHoldChallengeInput,
  type AnswerBookingHoldChallengeOutput,
  type AnswerBookingHoldChallengeWireOutput,
} from "./answer-booking-hold-challenge";

export {
  releaseBookingHold,
  releaseBookingHoldInputSchema,
  releaseBookingHoldOutputSchema,
  releaseBookingHoldWireOutputSchema,
  toReleaseBookingHoldWire,
  type ReleaseBookingHoldDeps,
  type ReleaseBookingHoldInput,
  type ReleaseBookingHoldOutput,
  type ReleaseBookingHoldWireOutput,
} from "./release-booking-hold";

export {
  confirmBookingHold,
  confirmBookingHoldInputSchema,
  confirmBookingHoldOutputSchema,
  confirmBookingHoldWireOutputSchema,
  type ConfirmBookingHoldDeps,
  type ConfirmBookingHoldInput,
  type ConfirmBookingHoldOutput,
  type ConfirmBookingHoldWireOutput,
} from "./confirm-booking-hold";

export {
  bookNightWithoutTerms,
  bookNightWithoutTermsInputSchema,
  bookNightWithoutTermsOutputSchema,
  bookNightWithoutTermsWireOutputSchema,
  type BookNightWithoutTermsDeps,
  type BookNightWithoutTermsInput,
  type BookNightWithoutTermsOutput,
  type BookNightWithoutTermsWireOutput,
} from "./book-night-without-terms";

export {
  listBookingHoldsForRequest,
  listBookingHoldsForRequestInputSchema,
  listBookingHoldsForRequestOutputSchema,
  actBookingHoldOutputSchema,
  type ActBookingHoldOutput,
  type ListBookingHoldsForRequestDeps,
  type ListBookingHoldsForRequestInput,
  type ListBookingHoldsForRequestOutput,
} from "./list-booking-holds-for-request";

export {
  listMyBookingHolds,
  listMyBookingHoldsInputSchema,
  listMyBookingHoldsOutputSchema,
  requesterBookingHoldSchema,
  type ListMyBookingHoldsDeps,
  type ListMyBookingHoldsInput,
  type ListMyBookingHoldsOutput,
  type RequesterBookingHold,
} from "./list-my-booking-holds";

export {
  BOOKING_HOLD_VARIANTS,
  buildIdempotencyKey as buildBookingHoldIdempotencyKey,
  dispatchBookingHoldIntents,
  type DispatchBookingHoldIntentsArgs,
  type DispatchBookingHoldIntentsDeps,
  type NotifyBookingHoldIntentsFn,
} from "./notify-booking-hold-intents";

export {
  settleBookingHolds,
  settleBookingHoldsInputSchema,
  settleBookingHoldsOutputSchema,
  settleBookingHoldsWireOutputSchema,
  type SettleBookingHoldsDeps,
  type SettleBookingHoldsInput,
  type SettleBookingHoldsOutput,
  type SettleBookingHoldsWireOutput,
} from "./settle-booking-holds";

export { resolveStaffRecipientOrgId } from "./_shared/staff-recipient-org";

export {
  committedHoldIntentsOf,
  type CommittedHoldIntents,
} from "./_shared/booking-hold-intents";

export {
  heldDatesOwnerOf,
  occupiedDatesForEvent,
  settleHeldDatesForEvent,
  settleHeldDatesForPublishedEvent,
  type HeldDatesOwner,
  type SettleHeldDatesForEventArgs,
  type SettleHeldDatesForEventResult,
  type SettleHeldDatesForPublishedEventArgs,
  type SettleHeldDatesForPublishedEventResult,
} from "./settle-held-dates-for-published-event";
