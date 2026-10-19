/**
 * Shape of an event as consumed by the (retired) hero ticker feed. Kept as a
 * standalone type because `HeroEventMap` still emits `onTickerEventsChange`;
 * the `EventTicker` component that rendered these was removed.
 */
export interface TickerEvent {
  id: string;
  title: string;
  venue?: string;
  /** Short formatted date, e.g. "APR 15" */
  date?: string;
}
