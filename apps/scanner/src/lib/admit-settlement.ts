/**
 * What the scan screen does when `tickets.scanTicket` SETTLES (a 200).
 *
 * PURE, so the decision is asserted in vitest rather than discovered at a door.
 *
 * ## The bug this closes
 *
 * `handleAdmit` marks the code "just admitted" BEFORE the round trip, so the
 * confirmation lands in the frame of the tap. Its `.then` never read the
 * response — but `scanTicket` answers `REJECTED` and `REPLAY` as normal 200s
 * (only thrown errors reach `.catch`, see `scan-error-classification.ts`). So
 * a door outside its check-in window, a refund race, or a second door that got
 * there first all left the mark in place and the screen said ADMITTED / DONE
 * with the admit buzz, though nothing was recorded. In express mode (no
 * re-resolve) that held for the whole dwell.
 *
 * The rule, stated once: **only ACCEPTED keeps the mark.** Every other outcome
 * un-marks it and takes the screen with its own verdict — the same key the web
 * shows for the same answer (`@th/types`' `resolveAdmitOutcomeVerdictKey`).
 */
import {
  isScanVerdictKey,
  resolveAdmitOutcomeVerdictKey,
  verdictStateLine,
  type ScanVerdictKey,
} from "@th/types";

import {
  feedbackKindForOutcome,
  type FeedbackKind,
} from "./feedback-signatures";
import {
  presentScanResult,
  type ScanPresentation,
  type ScanResultDescriptor,
} from "./scan-result-presentation";

/**
 * Structural mirror of `scanTicketOutputSchema` — loose, so a widened server
 * field cannot break the door, and so this module never imports core.
 */
export type AdmitResponse = {
  outcome: string;
  reason?: string | null;
  scannedAt?: Date | string | null;
  previousScannedAt?: Date | string | null;
};

export type AdmitSettlement =
  /** The server recorded THIS admission. Keep the mark, cue, re-resolve. */
  | { kind: "accepted" }
  /**
   * The tap did not become an admission. The screen shows `descriptor` in
   * place of the result (sticky, like a thrown failure), the mark is removed,
   * and the recent-scan row is retired so its UNDO cannot revert an admission
   * that was never ours.
   */
  | {
      kind: "refused";
      key: ScanVerdictKey;
      descriptor: Extract<ScanResultDescriptor, { kind: "admit_settled" }>;
      feedback: FeedbackKind;
      /**
       * Keep the optimistic local SCANNED mark? Only on REPLAY, where the
       * ticket really IS scanned (by someone else). On REJECTED the server
       * recorded nothing and the counter must not over-report.
       */
      keepLocalScanned: boolean;
    };

export function planAdmitSettlement(
  response: AdmitResponse,
  opts: {
    selectedEventName?: string | null;
    formatTime: (value: Date | string) => string | null;
  },
): AdmitSettlement {
  const key = resolveAdmitOutcomeVerdictKey(response);
  if (key === "admitted") return { kind: "accepted" };

  const isReplay = response.outcome === "REPLAY";
  // On a replay the time that matters is the ORIGINAL admission — that is what
  // "already used at 21:14" means. `scannedAt` on a replay is just "now".
  const at = isReplay
    ? (response.previousScannedAt ?? response.scannedAt ?? null)
    : null;
  const outcome = { outcome: response.outcome, reason: response.reason ?? null };

  return {
    kind: "refused",
    key,
    descriptor: {
      kind: "admit_settled",
      outcome,
      scannedAtLabel: at ? opts.formatTime(at) : null,
      selectedEventName: opts.selectedEventName ?? null,
    },
    feedback: feedbackKindForOutcome({ kind: "admit_settled", outcome }),
    keepLocalScanned: isReplay,
  };
}

// ── Where a refusal is shown ────────────────────────────────────────────────

/** What the operator is told on the recent-scans row of a refused admit. */
export const REFUSED_ROW_PREFIX = "NOT ADMITTED";

/** What can take the screen when an admit did not become an admission. */
export type RefusalDescriptor = Extract<
  ScanResultDescriptor,
  { kind: "admit_settled" } | { kind: "failure" }
>;

export type RefusalSurface = {
  /**
   * The descriptor to show full-bleed, or null when another person's verdict
   * owns the screen. A LATE refusal carries `late: true` (and the holder name
   * when known), so the VISIBLE detail says it is about an earlier scan — not
   * only the announcement.
   */
  show: RefusalDescriptor | null;
  /**
   * The late-refusal notice for when another verdict is up. Never written over
   * that verdict; the screen keeps it in its own timed slot.
   */
  notice: string | null;
  /** Exactly what a screen reader hears — built from the same visible words. */
  announcement: string;
};

const verdictText = (p: ScanPresentation): string =>
  [`${p.state}.`, `${p.word}.`, p.detail].filter(Boolean).join(" ");

/**
 * Where a refused admit is surfaced. Pure, so the late path is tested here
 * rather than discovered at a door.
 *
 * ## The late path is the dangerous one
 *
 * Express mode's 1.2s dwell runs WHILE the admit is in flight. When it expires
 * `dismissResult` clears the admit's identity, so a REPLAY arriving 1.5s later
 * (one screenshot QR at two express doors) is "not current". Whatever the
 * timing, the refusal buzzes (the screen fires the haptic on every path), the
 * recent-scans row stays visible marked {@link REFUSED_ROW_PREFIX}, and the
 * words land somewhere visible:
 *
 *   - **current** — this admit still owns the screen: take it.
 *   - **late, screen free** — take it, but MARKED late: the next person may
 *     already be stepping up, and an unmarked ALREADY USED / STOP reads as
 *     THEIR verdict. The detail line names the earlier scan (and the holder).
 *   - **late, screen busy** — another person's verdict is up: never write over
 *     it; raise the timed notice instead.
 */
export function planRefusalSurface(input: {
  current: boolean;
  /** A result or a failure is on screen right now (camera OR search). */
  screenOccupied: boolean;
  descriptor: RefusalDescriptor;
  /** Holder of the refused admit, when known. */
  holderName?: string | null;
}): RefusalSurface {
  const holderName = input.holderName?.trim() || null;

  if (input.current) {
    return {
      show: input.descriptor,
      notice: null,
      announcement: verdictText(presentScanResult(input.descriptor)),
    };
  }
  if (!input.screenOccupied) {
    const show: RefusalDescriptor = {
      ...input.descriptor,
      late: true,
      holderName,
    };
    return {
      show,
      notice: null,
      announcement: verdictText(presentScanResult(show)),
    };
  }
  const p = presentScanResult(input.descriptor);
  const who = holderName ? ` for ${holderName}` : "";
  const notice = `An earlier scan${who} was ${REFUSED_ROW_PREFIX}: ${p.state}. It is marked in the recent scans list.`;
  return { show: null, notice, announcement: notice };
}

/** The recent-scans row suffix for a refused admit: `NOT ADMITTED · ALREADY USED`. */
export function refusedRowLabel(verdictKey: string | null): string | null {
  if (!verdictKey) return null;
  return isScanVerdictKey(verdictKey)
    ? `${REFUSED_ROW_PREFIX} · ${verdictStateLine(verdictKey)}`
    : REFUSED_ROW_PREFIX;
}
