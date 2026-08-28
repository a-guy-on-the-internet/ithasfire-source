/**
 * FR-004 — express mode's decision layer, as a pure function.
 *
 * PURE. No `expo-*`, no `react-native`, no timers: the caller supplies the
 * result, the preference, the screen-reader state and the local-admit fact, and
 * gets back exactly two booleans and a reason. Same split as `offline-resolve`
 * and `scan-rail-plan`, and for a sharper reason than either — **this is the
 * only code path in the product that admits a human being with no operator
 * gesture at all.** Every halt condition below is asserted in node rather than
 * eyeballed on a device, because the failure mode of a missed halt is someone
 * walking through a door they should not have.
 *
 * ## The rule, stated once
 *
 * Express auto-admits exactly ONE outcome: a ticket result whose status is
 * literally `VALID`, which the operator's device has not already admitted
 * recently, and — if it came from the offline manifest — whose manifest is
 * fresher than {@link EXPRESS_MODE_MAX_MANIFEST_AGE_MS}. **Everything else
 * halts** into the sticky, explicitly-dismissed manual state: SCANNED,
 * wrong_event, unknown (all three reasons), volunteer (any), REFUNDED, VOID,
 * LISTED, INVALID, `offline_unverifiable`, `volunteer_needs_connection`. Bulk
 * admit never auto-fires — it is not a scan outcome and never reaches here.
 *
 * The list is written as "everything that is not the one case" rather than as
 * an enumeration of halts, because an enumeration is a thing that can be
 * incomplete when a twelfth outcome is added. {@link planExpressMode} keys off
 * the single positive case and falls through to halt.
 *
 * ## Two decisions, not one
 *
 * `autoAdmit` (does the scan admit itself?) and `autoDismiss` (does the state
 * clear itself?) are separate, because NFR-002 suspends the SECOND one while a
 * screen reader is active without suspending the first. Collapsing them into a
 * single "express on" boolean is how a VoiceOver operator ends up with a state
 * that vanishes mid-sentence.
 */
import {
  canExpressAdmitOffline,
  EXPRESS_MODE_MAX_MANIFEST_AGE_MS,
  type OfflineResolveResult,
} from "./offline-resolve";
import { provenanceOf, type AnyScanResult } from "./scan-result-types";

/**
 * Dwell duration. **Fixed, and deliberately not a preference** (design §6).
 *
 * 1.2s sits inside a narrow band: reading a short name is a fixation plus 1–2
 * saccades (~500–700ms once attention is on the screen), and NFR-001 caps
 * camera re-arm at 2s after a VALID scan while re-arming `CameraView` itself
 * costs ~300–500ms. 1.0s leaves no margin over the reading floor on a long
 * hyphenated name; 2.0s blows the budget once re-arm is added. A per-device
 * duration would also poison every later investigation of "it admitted someone
 * I wanted to stop" — the number would be one nobody remembers setting.
 *
 * The real need behind "make it configurable" is "let me look at THIS one
 * longer", which is per-scan, and the hold gesture answers it.
 */
export const EXPRESS_DWELL_MS = 1200;

/**
 * How far back the local admit log is consulted for the re-admit guard.
 *
 * Sized against the two clocks that create the window: the manifest re-sync
 * (60s) and the queue flush (15s, with a backoff ladder that can park a row for
 * far longer). Ten minutes covers the realistic case with room to spare and
 * matches the freshness gate, so there is one number to remember rather than
 * two.
 */
export const EXPRESS_REPEAT_GUARD_MS = EXPRESS_MODE_MAX_MANIFEST_AGE_MS;

export type ExpressHaltReason =
  /** The operator has not opted in. Default state — not an anomaly. */
  | "disabled"
  /** volunteer / wrong_event / unknown / offline_unverifiable / needs-connection. */
  | "not_a_ticket"
  /** A ticket, but SCANNED / REFUNDED / VOID / LISTED / INVALID / unrecognised. */
  | "status_not_valid"
  /**
   * Resolved offline against a manifest older than the freshness window (or of
   * unknown age — that counts as stale, fail closed). Drops to manual confirm,
   * and the provenance chip says `· CONFIRM MANUALLY` so the operator does not
   * just notice express "randomly stopped working".
   */
  | "manifest_stale"
  /**
   * This device already admitted this ticket inside
   * {@link EXPRESS_REPEAT_GUARD_MS}. See {@link ExpressPlanInput.admittedRecentlyOnDevice}.
   */
  | "recently_admitted_here";

export type ExpressPlan =
  | {
      autoAdmit: true;
      /** False when a screen reader is active (NFR-002). */
      autoDismiss: boolean;
      dwellMs: number;
      /** Present when the admit fired but the dwell did not. */
      dismissSuppressedBy: "screen_reader" | null;
    }
  | {
      autoAdmit: false;
      autoDismiss: false;
      dwellMs: 0;
      halt: ExpressHaltReason;
    };

export type ExpressPlanInput = {
  /** `ScannerPreferences.expressModeEnabled`. Defaults OFF, per-device. */
  enabled: boolean;
  /** The resolved outcome, server or offline. */
  result: AnyScanResult;
  /**
   * `AccessibilityInfo.isScreenReaderEnabled()`. See NFR-002 — auto-dismiss is
   * suspended for the whole life of the state when this is true.
   */
  screenReaderEnabled: boolean;
  /**
   * Has this device admitted this ticket inside {@link EXPRESS_REPEAT_GUARD_MS}?
   *
   * Supplied by the caller (it is a SQLite read —
   * `wasRecentlyAdmittedOnThisDevice`) so this module stays pure.
   *
   * ## Why express needs a guard the manual path does not
   *
   * `upsertTickets` is `INSERT OR REPLACE` and the manifest is re-written in
   * full every 60s, so a sync landing between an optimistic local admit and the
   * queue flush that reports it **rewrites the local `SCANNED` back to the
   * server's `VALID`**. The system converges (server REPLAY absorbs the
   * double-admit, NFR-004) and in manual mode an operator sees a green state
   * and decides. Express removes the operator from that loop: without this
   * guard a re-scan inside the window auto-admits a second time with **no
   * gesture from anyone**. The local admit log is authoritative about what this
   * device did, even when the manifest has been rewritten under it.
   *
   * This does not fix the sync semantics — it stops express from amplifying
   * them.
   */
  admittedRecentlyOnDevice: boolean;
};

const halt = (reason: ExpressHaltReason): ExpressPlan => ({
  autoAdmit: false,
  autoDismiss: false,
  dwellMs: 0,
  halt: reason,
});

/**
 * Decide whether this resolve auto-admits, and whether the resulting state
 * clears itself.
 *
 * Order is deliberate: the preference gate first (cheapest, and the common
 * case), then the outcome, then the two "we know something the status does not"
 * guards. A guard that ran BEFORE the status check would report
 * `recently_admitted_here` for a REFUNDED ticket, which is a confusing lie in a
 * Sentry tag.
 */
export function planExpressMode(input: ExpressPlanInput): ExpressPlan {
  if (!input.enabled) return halt("disabled");

  const { result } = input;
  if (result.kind !== "ticket") return halt("not_a_ticket");

  // A literal `VALID` and nothing else. Note this reads the RESULT's status,
  // which for the offline path already went through `resolveTicketStatusCopy`
  // (an unrecognised status resolves to `offline_unverifiable`, i.e. not a
  // ticket result at all).
  if (result.status !== "VALID") return halt("status_not_valid");

  // FR-004's freshness gate. `canExpressAdmitOffline` is the ONE place the
  // rule lives — re-deriving `age < 10 min` here is how the gate and the
  // provenance chip end up disagreeing about the same manifest.
  if (provenanceOf(result) !== null) {
    if (!canExpressAdmitOffline(result as OfflineResolveResult)) {
      return halt("manifest_stale");
    }
  }

  if (input.admittedRecentlyOnDevice) return halt("recently_admitted_here");

  return {
    autoAdmit: true,
    autoDismiss: !input.screenReaderEnabled,
    dwellMs: EXPRESS_DWELL_MS,
    dismissSuppressedBy: input.screenReaderEnabled ? "screen_reader" : null,
  };
}

/**
 * Should the provenance chip append `· CONFIRM MANUALLY`? (design §3)
 *
 * The visible half of the freshness gate: without it the operator just notices
 * that express stopped working and has no idea why. Only meaningful on an
 * offline VALID with express ON — a server result has no chip at all, and a
 * non-VALID outcome was never going to auto-admit.
 */
export function shouldShowConfirmManually(input: {
  enabled: boolean;
  result: AnyScanResult;
}): boolean {
  if (!input.enabled) return false;
  const { result } = input;
  if (result.kind !== "ticket" || result.status !== "VALID") return false;
  if (provenanceOf(result) === null) return false;
  return !canExpressAdmitOffline(result as OfflineResolveResult);
}
