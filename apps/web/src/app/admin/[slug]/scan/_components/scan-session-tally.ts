/**
 * FR-014 — the two numbers an organizer quotes at the door.
 *
 * PURE, and a module rather than three `setState` calls in a 700-line
 * component, because "how many people did we let in?" is a claim the venue
 * makes to a promoter. The old counter (`scanCount`) incremented on every
 * RESOLVE — every lookup, every re-resolve after an admit, every wrong-event
 * scan — so it always over-reported, and nothing tested it.
 *
 * ## Deviation from FR-014's literal wording
 *
 * FR-014 says both tallies are "fed by actual scanTicket outcomes (ACCEPTED vs
 * REPLAY)". `admitted` is exactly that. `alreadyIn` cannot be: on this surface
 * a used pass never reaches `scanTicket` at all — the resolver returns
 * `SCANNED`, the state is ALREADY IN, and the only action offered is dismiss.
 * A REPLAY-only tally would therefore sit at zero all night, which is worse
 * than no tally. So a used pass being PRESENTED again counts too, deduped by
 * ticket code so re-reading one pass twice is one event.
 */
import type { ResolveScanPayloadOutput } from "@th/core/use-cases/scanning";

export type ScanSessionTally = {
  /** `scanTicket` ACCEPTED outcomes — people who walked in. */
  admitted: number;
  /** Distinct used passes presented again this session. */
  alreadyIn: number;
  /** Codes already counted in {@link admitted}. */
  countedAdmits: readonly string[];
  /** Codes already counted in {@link alreadyIn}. */
  countedRepeats: readonly string[];
};

export const EMPTY_SCAN_SESSION_TALLY: ScanSessionTally = {
  admitted: 0,
  alreadyIn: 0,
  countedAdmits: [],
  countedRepeats: [],
};

const countRepeatOnce = (
  tally: ScanSessionTally,
  ticketCode: string,
): ScanSessionTally =>
  tally.countedRepeats.includes(ticketCode)
    ? tally
    : {
        ...tally,
        alreadyIn: tally.alreadyIn + 1,
        countedRepeats: [...tally.countedRepeats, ticketCode],
      };

/**
 * A ticket can be admitted at most ONCE — a second `scanTicket` for the same
 * code answers REPLAY, and this surface has no revert. So a repeated ACCEPTED
 * for one code is never a second person through the door; it is the 10-second
 * idempotency window replaying the first answer to a double tap. Dedupe by code
 * so the number a venue quotes to a promoter cannot be inflated by a nervous
 * thumb.
 */
const countAdmitOnce = (
  tally: ScanSessionTally,
  ticketCode: string,
): ScanSessionTally =>
  tally.countedAdmits.includes(ticketCode)
    ? tally
    : {
        ...tally,
        admitted: tally.admitted + 1,
        countedAdmits: [...tally.countedAdmits, ticketCode],
      };

/**
 * A resolver result arrived.
 *
 * This used to carry a `countRepeat: false` escape hatch for the re-resolve
 * that followed a successful admit. That re-resolve is gone — it is the async
 * call that used to overwrite a successful admission with a red SCAN FAILED
 * (see `scan-admit-outcome.ts`) — and with it the only caller that ever passed
 * the flag. A dead option that documents a removed behaviour is drift.
 */
export function tallyResolvedResult(
  tally: ScanSessionTally,
  result: ResolveScanPayloadOutput,
): ScanSessionTally {
  if (result.kind !== "ticket" || result.status !== "SCANNED") return tally;
  return countRepeatOnce(tally, result.ticketCode);
}

/** A `scanTicket` mutation settled. */
export function tallyAdmitOutcome(
  tally: ScanSessionTally,
  outcome: { outcome: "ACCEPTED" | "REPLAY" | "REJECTED" },
  ticketCode: string,
): ScanSessionTally {
  if (outcome.outcome === "ACCEPTED") {
    return countAdmitOnce(tally, ticketCode);
  }
  if (outcome.outcome === "REPLAY") {
    return countRepeatOnce(tally, ticketCode);
  }
  // REJECTED admits nobody and is not a repeat — it is a refusal, and the
  // operator sees it as its own STOP/REDIRECT verdict
  // (`ADMIT_REJECTION_PRESENTATION`). Counting it either way would be a lie.
  return tally;
}
