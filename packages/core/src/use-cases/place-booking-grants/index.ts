// Booking grants (docs/specs/2026-09-30/holds-without-a-request.spec.yaml,
// FR-003 / FR-013 / FR-014; plan step 5). Transport (plan step 9) exposes
// these as `placeBookingGrants.*` procedures, session-only (the key-scope
// repo override refuses the lifecycle under every API key), and turns the
// returned intents into notify() calls.

export {
  PLACE_BOOKING_GRANT_INTENT_KINDS,
  placeBookingGranteeSchema,
  placeBookingGrantNotificationIntentSchema,
  type PlaceBookingGrantIntentHold,
  type PlaceBookingGrantIntentKind,
  type PlaceBookingGrantNotificationIntent,
} from "./_shared/grant-intents";

export {
  grantEventOutputSchema,
  granteeGrantOutputSchema,
  grantStatusAt,
  isGrantLive,
  listEventsConfirmedUnderGrant,
  PLACE_BOOKING_GRANT_STATUSES,
  placeBookingGrantOutputSchema,
  type GrantEventOutput,
  type GranteeGrantOutput,
  type PlaceBookingGrantDeps,
  type PlaceBookingGrantOutput,
  type PlaceBookingGrantStatus,
} from "./_shared/grant-context";

export {
  givePlaceBookingGrant,
  givePlaceBookingGrantInputSchema,
  givePlaceBookingGrantOutputSchema,
  givePlaceBookingGrantWireOutputSchema,
  PLACE_BOOKING_GRANT_INVITES_PER_DAY,
  type GivePlaceBookingGrantDeps,
  type GivePlaceBookingGrantInput,
  type GivePlaceBookingGrantOutput,
} from "./give";

export {
  respondToPlaceBookingGrant,
  respondToPlaceBookingGrantInputSchema,
  respondToPlaceBookingGrantOutputSchema,
  respondToPlaceBookingGrantWireOutputSchema,
  type RespondToPlaceBookingGrantDeps,
  type RespondToPlaceBookingGrantInput,
  type RespondToPlaceBookingGrantOutput,
} from "./respond";

export {
  updatePlaceBookingGrant,
  updatePlaceBookingGrantInputSchema,
  updatePlaceBookingGrantOutputSchema,
  type UpdatePlaceBookingGrantDeps,
  type UpdatePlaceBookingGrantInput,
  type UpdatePlaceBookingGrantOutput,
} from "./update";

export {
  previewGrantRevoke,
  previewGrantRevokeInputSchema,
  previewGrantRevokeOutputSchema,
  type PreviewGrantRevokeDeps,
  type PreviewGrantRevokeInput,
  type PreviewGrantRevokeOutput,
} from "./preview-revoke";

export {
  GRANT_REVOKE_WITHDRAWAL_OUTCOMES,
  REVOKE_CHOICES_MAX,
  revokePlaceBookingGrant,
  revokePlaceBookingGrantInputSchema,
  revokePlaceBookingGrantOutputSchema,
  revokePlaceBookingGrantWireOutputSchema,
  type RevokePlaceBookingGrantDeps,
  type RevokePlaceBookingGrantInput,
  type RevokePlaceBookingGrantOutput,
} from "./revoke";

export {
  grantPartyOutputSchema,
  listPlaceBookingGrantsForPlace,
  listPlaceBookingGrantsForPlaceInputSchema,
  listPlaceBookingGrantsForPlaceOutputSchema,
  type GrantPartyOutput,
  type ListPlaceBookingGrantsForPlaceDeps,
  type ListPlaceBookingGrantsForPlaceInput,
  type ListPlaceBookingGrantsForPlaceOutput,
} from "./list-for-place";

export {
  listMyPlaceBookingGrants,
  listMyPlaceBookingGrantsInputSchema,
  listMyPlaceBookingGrantsOutputSchema,
  type ListMyPlaceBookingGrantsDeps,
  type ListMyPlaceBookingGrantsInput,
  type ListMyPlaceBookingGrantsOutput,
} from "./list-mine";
