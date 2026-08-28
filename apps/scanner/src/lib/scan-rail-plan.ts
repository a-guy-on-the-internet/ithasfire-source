/**
 * What the one-handed control rail offers for a given result (FR-007), and
 * whether the verdict block above it is tappable / holdable (design §2.4, §6).
 *
 * ## Why volunteer needed its own row
 *
 * Design §5's contextual-swap table has three rows — VALID-manual,
 * VALID-express, and "any other" — and a volunteer is none of them. Routing it
 * to "any other" is what stranded the ONLY thing an operator can do with a
 * volunteer pass ("Check in volunteer") below the fold, under a 96px glyph, a
 * verdict, a name, a badge and a guidance line — while the gesture that would
 * reveal it ("⌄ MORE") sat next to a rail whose single button DISMISSED the
 * result. `admittable` is false for volunteers by design (only a literal
 * ticket `VALID` is admittable), so the rail cannot key off that flag alone.
 *
 * ## Why EXPRESS lives here too
 *
 * It did not, and both of the state machine's shipped defects were in the JSX
 * that decided it:
 *
 *   1. Design §5's table assumes express always auto-dismisses. NFR-002
 *      suspends auto-dismiss while a screen reader is active — and the rail was
 *      never updated, so that combination rendered the express branch (whose
 *      only control is UNDO) with no dwell to clear it and no tap-to-dismiss
 *      either. **Nothing on the screen could clear the state.**
 *   2. An express UNDO the server refuses nulled the express plan, which
 *      switched the rail to `admit` — putting ADMIT under the operator's thumb
 *      one frame after they failed to un-admit that same ticket.
 *
 * Both were untested branch logic in a 1300-line component. The decision is
 * therefore a total function over a small input, asserted state by state in
 * node, and the component became a dumb switch on `kind`.
 *
 * PURE — no `expo-*`, no `react-native`. The rail's contents are an admission
 * decision, so they are asserted in vitest rather than eyeballed on a device.
 */
import type { AnyScanResult } from "./scan-result-types";

export type ScanRailPlan =
  /** Ticket VALID — `ADMIT` (primary, flex) + `SKIP` (secondary). */
  | { kind: "admit"; ticketCode: string }
  /**
   * Volunteer with an APPROVED signup — `CHECK IN` (primary, flex) +
   * `DISMISS` (secondary), mirroring the VALID row.
   *
   * `locked` is NOT `disabled`: it keeps the primary-action framing (orange
   * border) while muting fill and text, so a SCANNER-role operator still reads
   * "this is the action, and it is not yours" instead of finding no button at
   * all. The host pairs it with the explanatory hint.
   */
  | { kind: "check-in"; signupId: string; locked: boolean }
  /** Everything else — `DISMISS AND SCAN NEXT` (primary, full width). */
  | { kind: "dismiss" }
  /**
   * FR-004 / design §6 — express admitted this ticket AND the dwell will clear
   * the state on its own. One full-width `UNDO`; the verdict block is HELD to
   * pause the dwell, not tapped (a tap would race the countdown it exists to
   * extend).
   */
  | { kind: "express-undo" }
  /**
   * Express admitted this ticket but auto-dismiss is SUSPENDED (NFR-002 —
   * a screen reader is active). No dwell will ever fire, so the state needs a
   * real exit: `DISMISS AND SCAN NEXT` (primary) + `UNDO` (secondary).
   *
   * Tap-to-dismiss is safe here and §2.4's hazard does not apply: that hazard
   * is "a tap silently SKIPS an admission", and the admission has already
   * happened.
   */
  | { kind: "express-undo-with-dismiss" }
  /**
   * An express UNDO came back REFUSED (offline, no ticket id, or the server
   * rejected the revert). The admission still stands.
   *
   * Distinct from every other kind for one reason: it must never offer ADMIT.
   * `DISMISS AND SCAN NEXT` (primary) + `UNDO` (secondary, so a transient
   * failure can be retried), with the refusal notice rendered beside them.
   */
  | { kind: "refused" };

/** The express half of the input — null when express did not fire. */
export type ScanRailExpressState = {
  /** `ExpressPlan.autoAdmit` — this result was admitted with no gesture. */
  autoAdmit: boolean;
  /** `ExpressPlan.autoDismiss` — false while a screen reader is active. */
  autoDismiss: boolean;
  /** True once an UNDO for this admission has been refused. */
  undoRefused: boolean;
};

export function planScanRail(input: {
  result: AnyScanResult;
  /** From `presentScanResult` — computed once so rail and state agree. */
  admittable: boolean;
  /** Role gate: OWNER / ADMIN / EDITOR (see `role-gates.ts`). */
  canCheckInVolunteer: boolean;
  /** FR-004. Omit (or pass null) for the manual path. */
  express?: ScanRailExpressState | null;
}): ScanRailPlan {
  const { result, express } = input;

  // ── Express first, and the ORDER inside it matters ────────────────────────
  // A refusal outranks everything: the admission stands, so the one thing the
  // rail must not do is offer to admit again.
  if (express?.autoAdmit) {
    if (express.undoRefused) return { kind: "refused" };
    return express.autoDismiss
      ? { kind: "express-undo" }
      : { kind: "express-undo-with-dismiss" };
  }

  if (result.kind === "ticket" && input.admittable) {
    return { kind: "admit", ticketCode: result.ticketCode };
  }

  if (result.kind === "volunteer") {
    // Same primary-candidate rule the detail panel and `describeScanResult`
    // use: an APPROVED signup is the one that can be checked in. CHECKED_IN /
    // NO_SHOW candidates have no action, so the rail falls back to dismiss
    // rather than offering a button the server would reject.
    const approved = result.candidates.find((c) => c.status === "APPROVED");
    if (approved) {
      return {
        kind: "check-in",
        signupId: approved.signupId,
        locked: !input.canCheckInVolunteer,
      };
    }
  }

  return { kind: "dismiss" };
}

/**
 * Design §2.4 — may a tap on the verdict block dismiss it?
 *
 * Everywhere EXCEPT the two states where a tap would destroy something:
 *
 *   - `admit`: the operator's single most practised gesture (tap the screen,
 *     next person) would silently SKIP an admission — the ticket is never
 *     marked, the count is wrong, and nothing tells anyone.
 *   - `express-undo`: a running dwell already owns the exit, and the block is
 *     the HOLD target for extending it.
 *
 * Derived from the plan rather than from `admittable` so the rail and the state
 * cannot disagree — the version keyed on `admittable` alone is what left the
 * screen-reader express state with no exit at all.
 */
export const railTapDismissable = (plan: ScanRailPlan): boolean =>
  plan.kind !== "admit" && plan.kind !== "express-undo";

/**
 * Design §6 — is there a running dwell for press-and-hold to pause?
 *
 * Only while one is actually counting. Wiring hold handlers to a state with
 * auto-dismiss suspended gives the operator a gesture that does nothing and
 * (because `ToneResultState` makes any interactive block one composed
 * accessibility target) an unhelpful hint about a countdown that is not running.
 */
export const railHoldable = (plan: ScanRailPlan): boolean =>
  plan.kind === "express-undo";
