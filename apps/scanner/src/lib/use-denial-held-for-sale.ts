import { useCallback, useEffect, useRef, useState } from "react";

import type { LeaveRisk } from "../features/pos/sale-attempt";
import { reportRetentionIssue } from "./report";

/**
 * The longest a refusal waits for a sale, from when it arrived. An unresolved
 * attempt the server never answers would otherwise hold the denial (and the
 * attendee data) until the operator taps a tab.
 */
export const DENIAL_HOLD_CAP_MS = 3 * 60_000;

/**
 * Holds the access-denied state back while a door sale is at risk.
 *
 * The access-denied screen replaces the whole app shell, so showing it
 * unmounts the Sell tab, an open card sale included, and the denial wipe
 * cancels the sale's queries. A SCANNER moved to EDITOR mid-sale can still
 * finish it on the server. So while a sale is at risk the denial waits.
 *
 * "At risk" is the sale guard's own signal (`features/pos/sale-guard.ts`):
 * a card is open, a press is sending, or an attempt is unresolved
 * (`onSaleAtRisk`). The hold ends at the first of:
 *   - the risk going away anywhere but the done screen (`onRiskChange(null,
 *     false)`: browse, the cash screen). The done screen keeps it, so a
 *     "paid, admitted" answer stays up until the operator moves on;
 *   - the till idle or the Sell screen gone (`onSaleIdle`, "New sale");
 *   - `capMs` after the refusal arrived. `onCapReached` runs first, so the
 *     app can clear the sale on purpose (a card sale gets its cancel and the
 *     "don't take cash" notice) before the denied screen takes the Sell
 *     screen down.
 *
 * `onDenialEnded` runs when a refusal ends (access given back), so whatever
 * the app kept about that refusal (the sale its cap cleared) goes with it.
 */
export function useDenialHeldForSale(
  accessDenied: boolean,
  options?: {
    capMs?: number;
    onCapReached?: () => void;
    onDenialEnded?: () => void;
  },
): {
  /** `accessDenied`, unless a sale holds it back. */
  denied: boolean;
  saleAtRisk: () => void;
  saleIdle: () => void;
  riskChanged: (risk: LeaveRisk | null, done: boolean) => void;
} {
  const capMs = options?.capMs ?? DENIAL_HOLD_CAP_MS;
  const onCapRef = useRef(options?.onCapReached);
  const onEndedRef = useRef(options?.onDenialEnded);
  useEffect(() => {
    onCapRef.current = options?.onCapReached;
    onEndedRef.current = options?.onDenialEnded;
  });
  const [saleAtRiskNow, setSaleAtRiskNow] = useState(false);
  const [capReached, setCapReached] = useState(false);
  const refusedAtRef = useRef<number | null>(null);

  const saleAtRisk = useCallback(() => setSaleAtRiskNow(true), []);
  const saleIdle = useCallback(() => setSaleAtRiskNow(false), []);
  const riskChanged = useCallback((risk: LeaveRisk | null, done: boolean) => {
    if (risk === null && !done) setSaleAtRiskNow(false);
  }, []);

  useEffect(() => {
    if (!accessDenied) {
      const ended = refusedAtRef.current !== null;
      refusedAtRef.current = null;
      setCapReached(false);
      if (ended) onEndedRef.current?.();
      return;
    }
    refusedAtRef.current ??= Date.now();
    // Reached once per refusal: the sale is cleared once.
    if (!saleAtRiskNow || capReached) return;
    const reachCap = () => {
      // A throwing clear must not keep the denial (and the attendee data)
      // back, nor escape the timer as a fatal error.
      try {
        onCapRef.current?.();
      } catch (err) {
        reportRetentionIssue(err, { branch: "denial_cap_clear_failed" });
      } finally {
        setCapReached(true);
      }
    };
    const left = refusedAtRef.current + capMs - Date.now();
    if (left <= 0) {
      reachCap();
      return;
    }
    const id = setTimeout(reachCap, left);
    return () => clearTimeout(id);
  }, [accessDenied, saleAtRiskNow, capReached, capMs]);

  return {
    denied: accessDenied && (!saleAtRiskNow || capReached),
    saleAtRisk,
    saleIdle,
    riskChanged,
  };
}
