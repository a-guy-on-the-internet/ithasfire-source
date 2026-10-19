/**
 * Outcome → verdict, on the Ithas Fire Design System's contract.
 *
 * PURE. No React, no Tamagui, no lucide — glyphs are named by a STRING id that
 * the view resolves through its own icon map (`ToneResultState.tsx`). The
 * decision of what an operator is told at a door is exactly the kind of logic
 * that must be asserted in vitest rather than eyeballed in a browser: this page
 * shipped two blockers that passed hundreds of green tests because the branch
 * logic lived in JSX.
 *
 * ## The verdict map is SHARED, for real (NFR-007)
 *
 * Tone, state and word all come from `@th/types`' `SCAN_VERDICTS`
 * (`packages/types/src/scan/verdict.ts`) — the SAME module `apps/scanner` and
 * `@th/ui-native` render from. This file names a {@link ScanVerdictKey} and
 * nothing else; it does not own a single tone, state or word of its own. The
 * per-status and per-reason resolvers (`TICKET_STATUS_VERDICT`,
 * `SCAN_UNKNOWN_VERDICT`, `resolveTicketStatusVerdictKey`) are shared too, so
 * the two surfaces cannot drift the way the old hand-copied tables did (the web
 * labelled `INVALID` as "Voided" and had no copy at all for `VOID`).
 *
 * The key → glyph NAME table (`SCAN_GLYPHS`) and the admit-rejection reason →
 * key table are shared too. What is NOT shared is the name → lucide component
 * map (`ToneResultState.tsx` — a component cannot live in `@th/types`) and the
 * handful of web-only `detail` strings below — the web's wording differs
 * from the scanner's in exactly one clause (its event picker is on this page,
 * the scanner's is in Settings). Those live as DATA with a message key, never
 * inlined at a call site (i18n readiness). Nothing here adds a catalog key: the
 * scan surface is English literals today on both platforms.
 *
 * ## state vs word — the load-bearing split
 *
 * The DS separates what a pass IS (`ALREADY USED · 8:14 PM`) from what to DO
 * about it (`STOP`). That split is what lets TWO tones carry nineteen outcomes
 * without lying: at a gate "Valid" still requires a decision; "LET THEM IN"
 * does not. See `@th/types`' `verdict.ts` docblock and DS DECISIONS.md D-123.
 *
 * Mirrors `apps/scanner/src/lib/scan-result-presentation.ts`. Where the two
 * differ, it is stated.
 */
import {
  ADMIT_REJECTION_FALLBACK_KEY,
  SCAN_GLYPHS,
  SCAN_VERDICTS,
  SCAN_UNKNOWN_COPY,
  TICKET_STATUS_COPY,
  UNRECOGNISED_ADMIT_REJECTION_GUIDANCE,
  UNRECOGNISED_SCAN_REASON_GUIDANCE,
  resolveAdmitRejectionVerdictKey,
  resolveScanUnknownCopy,
  resolveScanUnknownVerdictKey,
  resolveTicketStatusCopy,
  resolveTicketStatusVerdictKey,
  verdictStateLine,
  type ScanGlyphId,
  type ScanVerdictKey,
  type VerdictTone,
} from "@th/types";
import type {
  ResolveScanPayloadOutput,
  ResolveScanPayloadVolunteerResult,
} from "@th/core/use-cases/scanning";

import { SCAN_FAILURE_COPY } from "./scan-failure-copy";

/**
 * Hero glyph, by name, and the verdict key → name table — both SHARED from
 * `@th/types`, so a verdict shows the same symbol here and in `apps/scanner` by
 * construction. The view owns the name → lucide component map
 * (`ToneResultState.tsx`'s `SCAN_GLYPH_COMPONENTS`), typed over `ScanGlyphId`.
 * Re-exported so existing imports keep working.
 */
export { SCAN_GLYPHS };
export type { ScanGlyphId };

export type ScanPresentation = {
  /** The shared verdict key — the identity both surfaces agree on. */
  key: ScanVerdictKey;
  tone: VerdictTone;
  /** DS zone ① — `ALREADY USED · 8:14 PM`, composed and ready to render. */
  state: string;
  /** DS zone ② — the instruction. Uppercase, never a status. */
  word: string;
  glyph: ScanGlyphId;
  /** DS `detail` — the WHY. Null when there is nothing useful to add. */
  detail: string | null;
  /**
   * A raw server code/message, for SUPPORT only — the thing a venue reads down
   * the phone to us. Set on a failed round trip and nowhere else.
   *
   * Rendered small, BELOW the detail, never as the detail. An operator can do
   * nothing with it, which is exactly why it may never be the primary copy.
   */
  supportRef: string | null;
  /** True for exactly one outcome: a ticket whose status is literally VALID. */
  admittable: boolean;
};

// ── Copy with no shared home (structured as data — see the docblock) ────────

export const SCAN_VERDICT_COPY = {
  wrongEvent: {
    key: "scan.verdict.wrongEvent.detail",
    /**
     * `eventName` is null when the selected event has no title yet. The web
     * wording differs from the scanner's by ONE clause — the scanner says
     * "Switch events in Settings", the web's picker is on this page — because
     * the door-mode state hides the page chrome while it is up.
     */
    detail: (eventName: string | null) =>
      eventName
        ? `This QR is for a different event. Dismiss to switch events, or scan a pass for ${eventName}.`
        : "This QR is for a different event. Dismiss to switch events, or scan a pass for the selected event.",
  },
  alreadyUsed: {
    key: "scan.verdict.alreadyUsed.detail",
    /** `time` is a pre-formatted local time string, never a Date. */
    detail: (time: string) => `Scanned at ${time} — already admitted.`,
  },
  volunteer: {
    key: "scan.verdict.volunteer.detail",
    detail: (role: string, shift: string) => `${role} — ${shift}.`,
  },
  admitted: {
    key: "scan.verdict.admitted.detail",
    /**
     * `time` is a pre-formatted local time string, never a Date. Byte-identical
     * to the scanner's string so the two surfaces never say it differently.
     */
    detail: (time: string | null) =>
      time ? `Admitted at ${time}.` : "Admission recorded.",
  },
  doorsNotOpen: {
    key: "scan.verdict.doorsNotOpen.detail",
    detail:
      "This event isn't open for check-in right now. Check its start time, or dismiss and pick a different event.",
  },
  notRecorded: {
    key: "scan.verdict.notRecorded.detail",
    detail:
      "The server would not record this admission. Try again, or dismiss and use Search.",
  },
} as const;

// ── A rejected admit ────────────────────────────────────────────────────────

/**
 * `tickets.scanTicket` answers `{ outcome: "REJECTED", reason }` with a 200,
 * not a throw. The reason → key table and its fail-closed `unrecognised` (STOP)
 * fallback live in
 * `@th/types` (`resolveAdmitRejectionVerdictKey`), shared with `apps/scanner`,
 * so the two surfaces show the same refusal for the same server answer.
 * Re-exported for existing imports.
 */
export { ADMIT_REJECTION_FALLBACK_KEY, resolveAdmitRejectionVerdictKey };

/** The `detail` line for a rejected admit, per key. */
const admitRejectionDetail = (key: ScanVerdictKey): string | null => {
  switch (key) {
    case "noMatch":
      return SCAN_UNKNOWN_COPY.ticket_not_found.guidance;
    case "invalid":
      return TICKET_STATUS_COPY.INVALID.guidance;
    case "wrongEvent":
      return SCAN_VERDICT_COPY.wrongEvent.detail(null);
    case "doorsNotOpen":
      return SCAN_VERDICT_COPY.doorsNotOpen.detail;
    case "unrecognised":
      return UNRECOGNISED_ADMIT_REJECTION_GUIDANCE.guidance;
    default:
      return SCAN_VERDICT_COPY.notRecorded.detail;
  }
};

// ── Descriptor ──────────────────────────────────────────────────────────────

export type ScanResultDescriptor =
  | {
      kind: "ticket";
      status: string;
      /** Pre-formatted local time, for the ALREADY USED / ADMITTED lines. */
      scannedAtLabel?: string | null;
      /**
       * THIS operator just admitted this ticket — as opposed to finding it
       * already `SCANNED`. Nothing in the envelope distinguishes the two (both
       * are `status: "SCANNED"` with a timestamp), so the fact travels with the
       * transition that knows it.
       *
       * They must not look alike: firing the do-not-admit signature 200ms after
       * a successful admission teaches the operator to read it as "fine, carry
       * on", which is the exact reflex that lets a genuine duplicate through at
       * 1am. `admitted` is `pass`/DONE; `alreadyUsed` is `fail`/STOP.
       */
      admitted?: boolean;
    }
  | { kind: "wrong_event"; selectedEventName?: string | null }
  | { kind: "unknown"; reason: string }
  | {
      kind: "volunteer";
      roleLabel?: string | null;
      shiftLabel?: string | null;
      scanWindowNote?: string | null;
    }
  /**
   * NOT a scan outcome: a resolve/admit call that THREW. It is still a `fail`,
   * and it renders through the same full-bleed verdict rather than regressing
   * to a banner the operator can scroll past.
   *
   * `stage` picks the shared key, same split as `apps/scanner`: `lookup` (a
   * resolve threw — `scanFailed`, SCAN FAILED) versus `record` (an admit or
   * check-in threw — `notRecorded`, NOT RECORDED). "We could not look this up"
   * and "we could not record this admission" mean different things about
   * whether the person is already in.
   *
   * `detail` is chosen by `describeScanFailure`, never taken from the server.
   * `supportRef` is the raw code, support material and nothing else.
   */
  | {
      kind: "failure";
      stage: "lookup" | "record";
      detail: string;
      supportRef?: string | null;
    }
  /**
   * `tickets.scanTicket` answered REJECTED — a 200, not a throw. See
   * {@link resolveAdmitRejectionVerdictKey}.
   */
  | { kind: "admit_rejected"; reason: string }
  /**
   * An admit the server ACCEPTED, with no matching card left in hand to patch.
   * Unreachable through the UI; it exists so that branch cannot degrade into an
   * error verdict for an admission that really happened.
   */
  | { kind: "admitted" };

/** Assemble a presentation from a shared verdict key. */
const present = (
  key: ScanVerdictKey,
  detail: string | null,
  opts: {
    admittable?: boolean;
    at?: string | null;
    supportRef?: string | null;
  } = {},
): ScanPresentation => {
  const verdict = SCAN_VERDICTS[key];
  return {
    key,
    tone: verdict.tone,
    state: verdictStateLine(key, opts.at ?? null),
    word: verdict.word,
    glyph: SCAN_GLYPHS[key],
    detail,
    supportRef: opts.supportRef ?? null,
    admittable: opts.admittable ?? false,
  };
};

/**
 * The one place an outcome becomes a verdict.
 *
 * An unrecognised ticket status fails CLOSED onto `unrecognised` — its own
 * state line, its own glyph, and the word STOP — never onto `invalid`. A status
 * the client has not shipped support for is not evidence that a ticket is bad,
 * and the verdict must not make an accusation the server never made.
 */
export function presentScanResult(
  descriptor: ScanResultDescriptor,
): ScanPresentation {
  switch (descriptor.kind) {
    case "ticket": {
      const copy = resolveTicketStatusCopy(descriptor.status);
      const key = resolveTicketStatusVerdictKey(descriptor.status);

      if (key === "unrecognised") {
        return present("unrecognised", copy.guidance);
      }

      // The confirmation branch. Only ever reachable straight off a
      // `scanTicket` the server ACCEPTED — never from a resolve, which cannot
      // know who admitted the ticket or when relative to this session.
      if (key === "alreadyUsed" && descriptor.admitted) {
        return present(
          "admitted",
          SCAN_VERDICT_COPY.admitted.detail(descriptor.scannedAtLabel ?? null),
          { at: descriptor.scannedAtLabel },
        );
      }

      const detail =
        key === "alreadyUsed" && descriptor.scannedAtLabel
          ? SCAN_VERDICT_COPY.alreadyUsed.detail(descriptor.scannedAtLabel)
          : key === "valid"
            ? // The ADMIT button IS the copy here. A detail line saying "admit"
              // under a button saying ADMIT is noise.
              null
            : copy.guidance;

      return present(key, detail, {
        admittable: copy.admittable,
        // The DS appends the scan time to the state line; it is only a fact for
        // a pass that has already been used. Matches the scanner exactly.
        at: key === "alreadyUsed" ? descriptor.scannedAtLabel : null,
      });
    }

    case "wrong_event":
      return present(
        "wrongEvent",
        SCAN_VERDICT_COPY.wrongEvent.detail(descriptor.selectedEventName ?? null),
      );

    case "unknown": {
      /**
       * Resolved through the SHARED resolver, the same call `apps/scanner`
       * makes. `malformed` → `unreadable` (TRY AGAIN), `ticket_not_found` →
       * `noMatch`, `signature_failed` → `tampered`, and a reason this build
       * has never heard of fails CLOSED onto `unrecognised` (STOP) — the same
       * rule as an unrecognised status, never a rescan loop.
       */
      const key = resolveScanUnknownVerdictKey(descriptor.reason);
      return present(
        key,
        key === "unrecognised"
          ? UNRECOGNISED_SCAN_REASON_GUIDANCE.guidance
          : resolveScanUnknownCopy(descriptor.reason).guidance,
      );
    }

    case "volunteer": {
      const role = descriptor.roleLabel?.trim();
      const shift = descriptor.shiftLabel?.trim();
      const line =
        role && shift ? SCAN_VERDICT_COPY.volunteer.detail(role, shift) : null;
      const note = descriptor.scanWindowNote?.trim() || null;
      return present("volunteer", [line, note].filter(Boolean).join(" ") || null);
    }

    case "failure":
      /**
       * `detail` arrives already CLASSIFIED (`describeScanFailure`). There is
       * deliberately no `?? descriptor.rawMessage` fallback: that fallback is
       * exactly how `volunteer_scan_token_not_configured` ended up as a door
       * operator's instructions. A raw string can only reach the screen through
       * `supportRef`.
       *
       * A LOOKUP that threw is `scanFailed`; only a WRITE that threw is
       * `notRecorded`. Both say TRY AGAIN — neither claims the pass is bad.
       */
      return present(
        descriptor.stage === "lookup" ? "scanFailed" : "notRecorded",
        descriptor.detail.trim() || SCAN_FAILURE_COPY.unknown.guidance,
        { supportRef: descriptor.supportRef?.trim() || null },
      );

    case "admit_rejected": {
      const key = resolveAdmitRejectionVerdictKey(descriptor.reason);
      return present(key, admitRejectionDetail(key));
    }

    case "admitted":
      return present("admitted", SCAN_VERDICT_COPY.admitted.detail(null));

    default: {
      const _never: never = descriptor;
      void _never;
      return present("unrecognised", null);
    }
  }
}

// ── Result → descriptor ─────────────────────────────────────────────────────

/** The APPROVED signup is the one that can be checked in, else the first. */
export function primaryVolunteerCandidate(
  result: ResolveScanPayloadVolunteerResult,
): ResolveScanPayloadVolunteerResult["candidates"][number] | null {
  return (
    result.candidates.find((c) => c.status === "APPROVED") ??
    result.candidates[0] ??
    null
  );
}

/**
 * tRPC envelope → descriptor. Kept out of the component so every branch is
 * asserted in node.
 *
 * `formatTime` is injected rather than called here so this module stays free of
 * locale/timezone behaviour (and so tests are deterministic).
 */
export function describeScanResult(
  result: ResolveScanPayloadOutput,
  opts: {
    selectedEventName?: string | null;
    formatTime: (value: Date | string) => string;
    /**
     * The card on screen is the one THIS operator just admitted. Passed down
     * from the page rather than inferred, because nothing in the envelope
     * distinguishes "I admitted them two seconds ago" from "they were already
     * scanned when the pass was presented" — and those two must not look alike.
     */
    admitted?: boolean;
  },
): ScanResultDescriptor {
  if (result.kind === "ticket") {
    return {
      kind: "ticket",
      status: result.status,
      scannedAtLabel: result.scannedAt ? opts.formatTime(result.scannedAt) : null,
      admitted: opts.admitted === true,
    };
  }
  if (result.kind === "volunteer") {
    const primary = primaryVolunteerCandidate(result);
    return {
      kind: "volunteer",
      roleLabel: primary?.roleLabel ?? null,
      shiftLabel: primary?.shiftLabel ?? null,
      scanWindowNote: primary?.scanWindowNote ?? null,
    };
  }
  if (result.kind === "wrong_event") {
    return {
      kind: "wrong_event",
      selectedEventName: opts.selectedEventName ?? null,
    };
  }
  return { kind: "unknown", reason: result.reason };
}

// ── What the operator may do ────────────────────────────────────────────────

export type ScanActionPlan =
  /** Ticket VALID — `ADMIT` (primary) + `SKIP` (secondary). */
  | { kind: "admit"; ticketCode: string }
  /**
   * Volunteer with an APPROVED signup — `CHECK IN` (primary) + `DISMISS`.
   *
   * `locked` is NOT `disabled`: a SCANNER-role operator still reads "this is
   * the action, and it is not yours" instead of finding no button at all.
   */
  | { kind: "check-in"; signupId: string; locked: boolean }
  /** Everything else — `SCAN NEXT` (primary, full width). */
  | { kind: "dismiss" };

export function planScanAction(input: {
  result: ResolveScanPayloadOutput | null;
  /** From `presentScanResult` — computed once so state and actions agree. */
  admittable: boolean;
  /** Role gate: volunteer check-in needs OWNER | ADMIN | EDITOR. */
  canCheckInVolunteer: boolean;
}): ScanActionPlan {
  const { result } = input;
  if (!result) return { kind: "dismiss" };

  if (result.kind === "ticket" && input.admittable) {
    return { kind: "admit", ticketCode: result.ticketCode };
  }

  if (result.kind === "volunteer") {
    // Only an APPROVED signup can be checked in. CHECKED_IN / NO_SHOW rows
    // have no action, so the plan falls back to dismiss rather than offering a
    // button the server would reject.
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
 * May a tap on the verdict block dismiss it?
 *
 * Everywhere EXCEPT `admit`, where the operator's single most practised
 * gesture (tap the screen, next person) would silently SKIP an admission: the
 * ticket is never marked, the count is wrong, and nothing tells anyone.
 * Reading a pass never admits anyone — Admit stays an explicit tap.
 *
 * `check-in` stays tap-dismissable, matching `railTapDismissable` in
 * `apps/scanner/src/lib/scan-rail-plan.ts`. One gesture, one meaning, on both
 * surfaces — a web-only exception here would be a cross-surface trap.
 */
export const actionTapDismissable = (plan: ScanActionPlan): boolean =>
  plan.kind !== "admit";

// ── What sits below the fold ────────────────────────────────────────────────

/**
 * `hasDetail` is computed ONCE, here, and handed to both the detail panel and
 * the state that frames it.
 *
 * Phase A shipped `hasDetail = !!children` and it was permanently `true`,
 * because a host passes a detail *component* unconditionally and lets it return
 * null — and a React element is truthy whether or not it renders anything. Ten
 * of eleven states grew an empty `surface`-coloured band cut into the tone
 * fill. One predicate, no second copy to drift.
 */
export type ScanDetailPlan = {
  hasDetail: boolean;
  /** `alsoVolunteering` rows on a ticket result. */
  alsoVolunteeringCount: number;
  /** Volunteer candidate rows (0 renders the "no eligible signups" line). */
  isVolunteer: boolean;
  /** `alsoHoldsTicket` rows on a volunteer result. */
  alsoHoldsTicketCount: number;
};

const NO_DETAIL: ScanDetailPlan = {
  hasDetail: false,
  alsoVolunteeringCount: 0,
  isVolunteer: false,
  alsoHoldsTicketCount: 0,
};

export function planScanDetail(
  result: ResolveScanPayloadOutput | null,
): ScanDetailPlan {
  if (!result) return NO_DETAIL;

  if (result.kind === "volunteer") {
    /**
     * A volunteer result ALWAYS has detail: the candidate row (role, shift,
     * scan-window note, check-in time) or — when there are none — the
     * "No eligible signups for this event." line, which is information the
     * operator needs and cannot get anywhere else on the screen.
     */
    return {
      hasDetail: true,
      alsoVolunteeringCount: 0,
      isVolunteer: true,
      alsoHoldsTicketCount: result.alsoHoldsTicket.length,
    };
  }

  if (result.kind === "ticket") {
    /**
     * Deliberate deviation from the scanner's `planResultDetail`, which also
     * carries a `showScanHistory` row: on the web the ALREADY USED detail line
     * ("Scanned at 21:14 — already admitted.") is already on the fill, so a
     * second "Already scanned at 21:14" band below it is duplicate copy with a
     * cream stripe attached.
     */
    const alsoVolunteeringCount = result.alsoVolunteering.length;
    return {
      hasDetail: alsoVolunteeringCount > 0,
      alsoVolunteeringCount,
      isVolunteer: false,
      alsoHoldsTicketCount: 0,
    };
  }

  // wrong_event / unknown carry nothing below the fold.
  return NO_DETAIL;
}
