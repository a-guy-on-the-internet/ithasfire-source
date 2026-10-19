/**
 * MOVED to `@/components/bookings/create-event-from-booking`.
 *
 * The helpers now serve two surfaces — FinalizeDialog on `/agreements/{id}`
 * and the "Create event from this booking" action inside the venue inbox's
 * conversation — so they live with the shared booking components. This path
 * re-exports so FinalizeDialog, CreateEventOutcomeNotice and the existing test
 * keep resolving.
 */
export * from "@/components/bookings/create-event-from-booking";
