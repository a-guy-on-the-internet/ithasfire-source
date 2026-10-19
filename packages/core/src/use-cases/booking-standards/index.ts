// Venue booking standards (venue-booking-standards spec, 2026-09-25).
//
// S1 ships the pure pieces: the field catalogue + satisfied-predicate table,
// the platform defaults, the FR-003 resolver, and the write-path schemas. The
// options read, the create-path gate and the write use cases are S2.
//
// Client bundles import the LEAF modules directly
// (`@th/core/use-cases/booking-standards/standard-fields`,
// `…/resolve-booking-standards`, `…/platform-defaults`), never this barrel,
// which also pulls the zod/sanitize-html schema graph.

export {
  BOOKING_PITCH_EXAMPLE_BODY_MAX,
  BOOKING_PITCH_EXAMPLE_TITLE_MAX,
  BOOKING_PITCH_EXAMPLES_MAX,
  BOOKING_STANDARD_FIELD_SPECS,
  BOOKING_STANDARD_FIELDS,
  BOOKING_STANDARD_HINT_MAX,
  BOOKING_STANDARD_ITEMS_MAX,
  BOOKING_STANDARD_LABEL_MAX,
  fieldAppliesToIntent,
  fieldCanBeRequired,
  fieldsForIntent,
  isFieldSatisfied,
  isKnownBookingStandardField,
  type BookingStandardFieldSpec,
  type BookingStandardsPayload,
} from "./standard-fields";

export {
  BOOKING_STANDARDS_PLATFORM_DEFAULTS,
  platformBookingStandardKeys,
  type PlatformBookingPitchExample,
  type PlatformBookingStandardItem,
  type PlatformBookingStandards,
} from "./platform-defaults";

export {
  resolveBookingStandards,
  unmetRequiredStandards,
  type BookingStandardSource,
  type EffectiveBookingPitchExample,
  type EffectiveBookingStandard,
  type EffectiveBookingStandards,
  type OwnerBookingStandardRows,
  type PlatformEffectiveBookingPitchExample,
  type PlatformEffectiveBookingStandard,
  type ResolveBookingStandardsInput,
  type VenueBookingStandardSource,
  type VenueEffectiveBookingPitchExample,
  type VenueEffectiveBookingStandard,
} from "./resolve-booking-standards";

export {
  bookingPitchExampleInputSchema,
  bookingPitchExamplesSchema,
  bookingPitchExamplesWriteBaseSchema,
  bookingPitchExamplesWriteSchema,
  bookingStandardFieldSchema,
  bookingStandardIntentSchema,
  bookingStandardItemInputSchema,
  bookingStandardItemsSchema,
  bookingStandardItemsWriteBaseSchema,
  bookingStandardItemsWriteSchema,
  bookingStandardOwnerTypeSchema,
  bookingStandardRequirementSchema,
  containsLinkLikeText,
  refineItemsApplyToIntent,
  type BookingPitchExampleWriteInput,
  type BookingStandardItemWriteInput,
} from "./booking-standards-schemas";

// ── S2: the loader, the create-path gate, wire schemas, authoring ──────────

export {
  calendarRequestIntents,
  loadEffectiveBookingStandards,
  loadEffectiveBookingStandardsForCalendar,
  type BookingStandardsTarget,
  type EffectiveBookingStandardsByIntent,
  type LoadedBookingStandards,
  type LoadEffectiveBookingStandardsDeps,
  type LoadEffectiveBookingStandardsInput,
} from "./load-effective-booking-standards";

export { assertBookingStandardsMet } from "./enforce-booking-standards";

export {
  effectiveBookingPitchExampleSchema,
  effectiveBookingStandardSchema,
  effectiveBookingStandardsByIntentWireSchema,
  effectiveBookingStandardsWireSchema,
  toEffectiveBookingStandardsByIntentWire,
  toEffectiveBookingStandardsWire,
  type EffectiveBookingStandardsByIntentWire,
  type EffectiveBookingStandardsWire,
} from "./effective-booking-standards-schemas";

export {
  bookingPitchExampleRowSchema,
  bookingStandardItemRowSchema,
  getBookingStandardsForEditing,
  getBookingStandardsForEditingInputSchema,
  getBookingStandardsForEditingOutputSchema,
  setBookingStandardsOutputSchema,
  setCalendarBookingStandards,
  setCalendarBookingStandardsInputSchema,
  setCalendarPitchExamples,
  setCalendarPitchExamplesInputSchema,
  setPitchExamplesOutputSchema,
  setPlaceBookingStandards,
  setPlaceBookingStandardsInputSchema,
  setPlacePitchExamples,
  setPlacePitchExamplesInputSchema,
  type GetBookingStandardsForEditingInput,
  type GetBookingStandardsForEditingOutput,
  type ManageBookingStandardsDeps,
  type SetBookingStandardsOutput,
  type SetCalendarBookingStandardsInput,
  type SetCalendarPitchExamplesInput,
  type SetPitchExamplesOutput,
  type SetPlaceBookingStandardsInput,
  type SetPlacePitchExamplesInput,
} from "./manage-booking-standards";
