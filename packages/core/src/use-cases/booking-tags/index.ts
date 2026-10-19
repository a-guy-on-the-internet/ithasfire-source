// Org booking tags (booking-holds spec FR-017) — venue-internal labels on
// booking requests. Transport (step 3) exposes `bookingTags.*`.

export {
  BOOKING_TAG_COLORS,
  BOOKING_TAG_NAME_MAX,
  BOOKING_TAG_SLUG_MAX,
  bookingTagColorSchema,
  bookingTagOutputSchema,
  toBookingTagSlug,
  type BookingTagColor,
  type BookingTagOutput,
} from "./_shared/booking-tag-schemas";

export {
  listBookingTags,
  listBookingTagsInputSchema,
  listBookingTagsOutputSchema,
  createBookingTag,
  createBookingTagInputSchema,
  createBookingTagOutputSchema,
  updateBookingTag,
  updateBookingTagInputSchema,
  updateBookingTagOutputSchema,
  deleteBookingTag,
  deleteBookingTagInputSchema,
  deleteBookingTagOutputSchema,
  type BookingTagsDeps,
  type ListBookingTagsInput,
  type ListBookingTagsOutput,
  type CreateBookingTagInput,
  type CreateBookingTagOutput,
  type UpdateBookingTagInput,
  type UpdateBookingTagOutput,
  type DeleteBookingTagInput,
  type DeleteBookingTagOutput,
} from "./manage-booking-tags";

export {
  setBookingRequestTags,
  setBookingRequestTagsInputSchema,
  setBookingRequestTagsOutputSchema,
  MAX_BOOKING_REQUEST_TAGS,
  type SetBookingRequestTagsDeps,
  type SetBookingRequestTagsInput,
  type SetBookingRequestTagsOutput,
} from "./set-booking-request-tags";
