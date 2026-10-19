/**
 * Pins the app's event while a door sale is at risk, and lets go once the
 * till is idle again.
 *
 * With nothing picked, the app's event follows its DEFAULT, which moves on
 * its own (the default event drops out of the accessible list and the
 * nearest one is picked). Under a sale that would reset the Sell screen with
 * no tap to guard. So the first time a sale is at risk, the current event is
 * written into the picked event; when the Sell screen is idle again (browse
 * with an empty cart, after Next sale or a clear, or the tab left), a pin the
 * GUARD made is released, so Scan and Lookup follow the default again.
 *
 * Not released the moment the risk goes away: the done screen ("Change
 * $16.30") has no risk and must not be reset by a default-event swap.
 * An event the operator picked themselves is never released.
 */
import { useCallback, useRef } from "react";

export function useSaleEventPin(args: {
  /** The event the app is on now (picked, or the default). */
  eventId: string | null;
  /** The event the operator (or this pin) picked, or null for the default. */
  selectedEventId: string | null;
  setSelectedEventId: (eventId: string | null) => void;
}) {
  const { setSelectedEventId } = args;
  // Assigned during render, not in an effect: a pin fired from a child's
  // effect in the same commit must read THIS render's event, not the last.
  const eventIdRef = useRef(args.eventId);
  eventIdRef.current = args.eventId;
  const selectedRef = useRef(args.selectedEventId);
  selectedRef.current = args.selectedEventId;
  const pinnedByGuardRef = useRef(false);

  /** A sale is at risk: hold the event it belongs to. */
  const pin = useCallback(() => {
    if (selectedRef.current !== null || eventIdRef.current === null) return;
    pinnedByGuardRef.current = true;
    selectedRef.current = eventIdRef.current;
    setSelectedEventId(eventIdRef.current);
  }, [setSelectedEventId]);

  /** The till is idle: drop a pin the guard made (never an operator's pick). */
  const release = useCallback(() => {
    if (!pinnedByGuardRef.current) return;
    pinnedByGuardRef.current = false;
    selectedRef.current = null;
    setSelectedEventId(null);
  }, [setSelectedEventId]);

  /** The operator picked an event: it is theirs, not a pin. */
  const pick = useCallback(
    (eventId: string) => {
      pinnedByGuardRef.current = false;
      selectedRef.current = eventId;
      setSelectedEventId(eventId);
    },
    [setSelectedEventId],
  );

  return { pin, release, pick };
}
