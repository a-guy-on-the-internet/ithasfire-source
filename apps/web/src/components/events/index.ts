// NOTE: EventPicker is deliberately NOT re-exported here. This barrel also
// pulls in EventContent, so a consumer importing the picker through it would
// drag the whole event-body renderer into its bundle. Import the deep path:
// `@/components/events/EventPicker`.
export {
  EventContent,
  type EventContentProps,
  type EventContentTicketType,
  type EventContentHuman,
  type EventContentLocationCoords,
} from "./EventContent";
