/**
 * FR-013 / FR-014 — what the screen shows AFTER `tickets.scanTicket` settles.
 *
 * PURE, and the whole point of it is that it is synchronous.
 *
 * ## The blocker this replaces
 *
 * The page used to re-resolve the ticket after a successful admit, purely to
 * refresh the card to its now-SCANNED state. At a real door that produced this:
 * a ticket was admitted, the server recorded it (`SCANNED` in the database),
 * the session tally incremented — and then the decorative re-resolve failed and
 * replaced the confirmation with a full-bleed red **SCAN FAILED**. The person
 * was through the door and the operator was looking at an error. At a door that
 * means they get turned around or re-scanned.
 *
 * The invariant, stated once so it can be tested: **an admit the server
 * ACCEPTED must never render as a failure.** The strongest way to hold that is
 * not to defend the success against a later async result — it is to have no
 * later async result at all. `scanTicket`'s response already contains
 * everything the post-admit card needs (the new `scannedAt`), and the rest of
 * the ticket is unchanged by admitting it, so the next state is DERIVED here
 * from the response we already trust. No round trip, nothing to fail, and the
 * card flips instantly instead of after a second network hop.
 *
 * ## REJECTED is a real outcome, not an error
 *
 * `tickets.scanTicket` returns `{ outcome: "REJECTED", reason }` as a
 * successful 200 — only THROWN errors become tRPC errors. The page used to drop
 * that on the floor: no message, no tally change, the button simply re-enabled.
 * An operator whose event was outside its check-in window could tap ADMIT
 * forever and never learn why. Each reason now becomes a STOP/REDIRECT verdict
 * (`scan-result-presentation.ts`).
 *
 * Design: docs/records/2026-08-04-scan-screen-design.md §2.2.
 */
import type { ResolveScanPayloadOutput } from "@th/core/use-cases/scanning";

import type { ScanResultDescriptor } from "./scan-result-presentation";

/**
 * Structural mirror of `scanTicketOutputSchema`
 * (`packages/core/src/use-cases/tickets/scan-ticket.ts`), kept loose on purpose:
 * this module must stay importable in node without dragging the core use case's
 * zod graph in, and a widened server field must not break the door.
 */
export type ScanAdmitOutcome =
  | { outcome: "ACCEPTED"; scannedAt?: Date | string | null }
  | {
      outcome: "REPLAY";
      scannedAt?: Date | string | null;
      previousScannedAt?: Date | string | null;
    }
  | { outcome: "REJECTED"; reason?: string | null };

export type ScanAdmitResolution =
  /**
   * Replace the live resolve envelope with this one.
   *
   * `admitted` separates the two ways a ticket becomes `SCANNED`: THIS operator
   * just let them in (`admitted` — a PASS, whose word is DONE), versus the pass
   * coming back already used (`alreadyUsed` — a FAIL, whose word is STOP).
   * Nothing in the envelope can tell those apart — both are `status:
   * "SCANNED"` with a timestamp — so the fact travels with the transition that
   * knows it. See `presentScanResult`.
   */
  | { kind: "result"; result: ResolveScanPayloadOutput; admitted: boolean }
  /** Show this verdict instead of the live envelope. */
  | { kind: "override"; descriptor: ScanResultDescriptor };

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Fold a settled `scanTicket` response into the next verdict.
 *
 * `previous` is the resolve envelope the ADMIT button was rendered from. It is
 * matched on `ticketCode` rather than trusted blindly: if the screen has moved
 * on to a different ticket, patching THIS ticket's status onto it would put one
 * person's admission on another person's card.
 */
export function resolveAdmitOutcome(
  previous: ResolveScanPayloadOutput | null,
  outcome: ScanAdmitOutcome,
  ticketCode: string,
): ScanAdmitResolution {
  if (outcome.outcome === "REJECTED") {
    return {
      kind: "override",
      descriptor: {
        kind: "admit_rejected",
        reason: outcome.reason ?? "",
      },
    };
  }

  const scannedAt =
    outcome.outcome === "REPLAY"
      ? // The time that matters on a replay is the ORIGINAL admission — that is
        // what "already admitted at 21:14" means to the operator. The server
        // sends both; `scannedAt` on a replay is just "now".
        (toDate(outcome.previousScannedAt) ?? toDate(outcome.scannedAt))
      : toDate(outcome.scannedAt);

  if (previous?.kind === "ticket" && previous.ticketCode === ticketCode) {
    return {
      kind: "result",
      result: { ...previous, status: "SCANNED", scannedAt },
      /**
       * A REPLAY is NOT this operator's admission — the server is telling us the
       * ticket was already scanned. That is exactly the "someone already let
       * this person in" case `alreadyUsed` exists for, so it keeps the fail
       * verdict and the original timestamp.
       */
      admitted: outcome.outcome === "ACCEPTED",
    };
  }

  /**
   * No matching card in hand. Unreachable through the UI — ADMIT only exists on
   * a live ticket envelope — but it is the branch where a bug would otherwise
   * turn an accepted admission into an error, so it fails toward the truth: the
   * server admitted this person, and the operator is told so.
   */
  return { kind: "override", descriptor: { kind: "admitted" } };
}
