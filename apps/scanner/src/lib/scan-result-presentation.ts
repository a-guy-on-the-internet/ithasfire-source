/**
 * Outcome → (verdict key, tone, state, word, hero glyph, detail).
 *
 * PURE. No `expo-*`, no `react-native`, no `lucide-react-native` — glyphs are
 * named by a STRING id that the view resolves through its own icon map
 * (`unified-result-view.tsx`). Same testability split as
 * `feedback-signatures.ts` vs `feedback.ts`: the decision of what an operator
 * is told at a door is exactly the kind of logic that must be asserted in
 * vitest rather than eyeballed on a device.
 *
 * ## Where the decision actually lives
 *
 * The (tone, state, word) columns are NOT authored here. They come from
 * `@th/types`' `SCAN_VERDICTS` — the module the web scan page renders from too,
 * so the two surfaces cannot drift the way their two hand-copied eleven-row
 * tables already did once. The glyph NAME per key is shared too
 * (`SCAN_GLYPHS`), and so is the admit-outcome → key decision
 * (`resolveAdmitOutcomeVerdictKey`). This file maps the SCANNER's descriptors
 * onto that shared key set and adds the one thing only this surface owns: the
 * `detail` line.
 *
 * ## Two tones, and why the outcomes did not collapse with them
 *
 * The Ithas Fire Design System specifies two verdict fills — pass and fail —
 * with the WORD carrying the instruction (D-123). Separating **state** ("Already
 * used") from **word** ("STOP") is what lets two fills carry nineteen outcomes.
 * Read `@th/types/scan/verdict.ts` before changing any row; two of the words
 * (`CHECK FIRST`, `HOLD`) are safety requirements, not phrasing preferences.
 *
 * ## Copy comes from the shared FR-008 map wherever one exists
 *
 * `detail` for the six ticket statuses and the three unknown reasons is read
 * from `@th/types`, and the offline states read `./offline-resolve`'s maps.
 * Only strings with no shared home live below, and they live as DATA with a
 * message key — never inlined at a call site, never concatenated with data in
 * the middle.
 */
import {
  SCAN_GLYPHS,
  SCAN_UNKNOWN_COPY,
  SCAN_VERDICTS,
  TICKET_STATUS_COPY,
  UNRECOGNISED_ADMIT_REJECTION_GUIDANCE,
  UNRECOGNISED_SCAN_REASON_GUIDANCE,
  resolveAdmitOutcomeVerdictKey,
  resolveScanUnknownCopy,
  resolveScanUnknownVerdictKey,
  resolveTicketStatusCopy,
  resolveTicketStatusVerdictKey,
  verdictStateLine,
  type ScanAdmitOutcomeLike,
  type ScanGlyphId,
  type ScanVerdictKey,
  type VerdictTone,
} from "@th/types";

import {
  OFFLINE_UNVERIFIABLE_COPY,
  OFFLINE_VOLUNTEER_COPY,
  type OfflineUnverifiableReason,
} from "./offline-resolve";
import type { AnyScanResult } from "./scan-result-types";

/**
 * Hero glyph, by name, and the key → name table — both SHARED from `@th/types`
 * so a verdict shows the same symbol on the web and here by construction. The
 * view owns the name → `LucideIcon` map (`unified-result-view.tsx`), typed
 * `Record<ScanGlyphId, LucideIcon>`, so a new name is a type error there until
 * it resolves. Re-exported so existing imports keep working.
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
  /** True for exactly one outcome: a ticket whose status is literally VALID. */
  admittable: boolean;
};

// ── Copy with no shared home (structured as data — see the docblock) ────────

export const SCAN_VERDICT_COPY = {
  wrongEvent: {
    key: "scan.verdict.wrongEvent.detail",
    /** `eventName` is null when the selected event has no title yet. */
    detail: (eventName: string | null) =>
      eventName
        ? `This QR is for a different event. Switch events in Settings, or scan a pass for ${eventName}.`
        : "This QR is for a different event. Switch events in Settings, or scan a pass for the selected event.",
  },
  alreadyUsed: {
    key: "scan.verdict.alreadyUsed.detail",
    /** `time` is a pre-formatted local time string, never a Date. */
    detail: (time: string) => `Scanned at ${time} — already admitted.`,
  },
  admitted: {
    key: "scan.verdict.admitted.detail",
    /**
     * The post-admit confirmation. Byte-identical to the web surface's string
     * so the two never say it differently.
     */
    detail: (time: string | null) =>
      time ? `Admitted at ${time}.` : "Admission recorded.",
  },
  admittedHere: {
    key: "scan.verdict.admittedHere.detail",
    /**
     * The re-admit guard, made visible. The manifest may still say VALID (a 60s
     * full re-sync can overwrite an optimistic local SCANNED before the queue
     * reports it), so the SERVER-shaped status is not evidence here — the
     * device's own admit log is.
     */
    detail:
      "You admitted this pass on this device in the last few minutes. If that was someone else, find them in Search before admitting again.",
  },
  volunteer: {
    key: "scan.verdict.volunteer.detail",
    detail: (role: string, shift: string) => `${role} — ${shift}.`,
  },
  doorsNotOpen: {
    key: "scan.verdict.doorsNotOpen.detail",
    /** The scanner's event switch is in Settings, not on this screen. */
    detail:
      "This event isn't open for check-in right now. Check its start time, or switch events in Settings.",
  },
  notRecorded: {
    key: "scan.verdict.notRecorded.detail",
    detail:
      "The server would not record this admission. Try again, or dismiss and use Search.",
  },
  lateRefusal: {
    key: "scan.verdict.lateRefusal.detail",
    detail: (holderName: string | null) =>
      holderName
        ? `EARLIER SCAN (${holderName}) — not the person in front of you.`
        : "EARLIER SCAN — not the person in front of you.",
  },
  scanFailed: {
    key: "scan.verdict.scanFailed.detail",
    detail: "Couldn't look this pass up. Try again, or dismiss and use Search.",
  },
} as const;

// ── Descriptor ──────────────────────────────────────────────────────────────

export type ScanResultDescriptor =
  | {
      kind: "ticket";
      status: string;
      /** Pre-formatted local time, for the ALREADY USED / ADMITTED lines. */
      scannedAtLabel?: string | null;
      /**
       * THIS operator just admitted this ticket, on this screen, since the last
       * dismiss — as opposed to finding it already used. See
       * {@link presentScanResult}: the two look nothing alike, deliberately.
       */
      admitted?: boolean;
      /**
       * The re-admit guard fired: this device admitted this ticket inside the
       * express repeat window. Only ever set when express is enabled (it is the
       * visible half of `planExpressMode`'s `recently_admitted_here` halt) —
       * the manual path is unchanged.
       */
      admittedHereRecently?: boolean;
    }
  | { kind: "wrong_event"; selectedEventName?: string | null }
  | { kind: "unknown"; reason: string }
  | {
      kind: "volunteer";
      roleLabel?: string | null;
      shiftLabel?: string | null;
      scanWindowNote?: string | null;
    }
  | { kind: "offline_unverifiable"; reason: OfflineUnverifiableReason }
  | { kind: "volunteer_needs_connection" }
  /**
   * A `scanTicket` that SETTLED with something other than ACCEPTED — REJECTED
   * (a 200 with a reason) or REPLAY (someone else already admitted them). The
   * key comes from `@th/types`' `resolveAdmitOutcomeVerdictKey`, the same
   * decision the web makes. `scannedAtLabel` is the ORIGINAL admission time on
   * a replay.
   */
  | ({
      kind: "admit_settled";
      outcome: ScanAdmitOutcomeLike;
      scannedAtLabel?: string | null;
      selectedEventName?: string | null;
    } & LateRefusal)
  /**
   * NOT a scan outcome: a round trip that THREW. `stage` picks the key —
   * `lookup` (the resolve failed: `scanFailed`) versus `record` (an admit,
   * bulk admit or check-in the server did not record: `notRecorded`). Same
   * split as the web. `detail` is the already-composed WHY.
   */
  | ({ kind: "failure"; stage: "lookup" | "record"; detail: string } & LateRefusal);

/**
 * A refusal that arrived after its admit lost the screen (express dwell
 * expired, or the operator moved on). The detail line then SAYS it is about an
 * earlier scan — otherwise a full-bleed STOP reads as the verdict for whoever
 * is now at the door.
 */
type LateRefusal = { late?: boolean; holderName?: string | null };

/** Assemble a presentation from a shared verdict key. */
const present = (
  key: ScanVerdictKey,
  detail: string | null,
  opts: { admittable?: boolean; at?: string | null } = {},
): ScanPresentation => {
  const verdict = SCAN_VERDICTS[key];
  return {
    key,
    tone: verdict.tone,
    state: verdictStateLine(key, opts.at ?? null),
    word: verdict.word,
    glyph: SCAN_GLYPHS[key],
    detail,
    admittable: opts.admittable ?? false,
  };
};

/**
 * The one place an outcome becomes a verdict.
 *
 * Three judgement calls are encoded here, all three about not making a false
 * accusation at a door:
 *
 *   - **"Can't verify offline" is a fail field but is NOT "Not a ticket".** A
 *     code absent from a synced manifest should make the operator hesitate, but
 *     it must never *claim* invalidity. It gets its own glyph
 *     (`ShieldQuestion`), its own state line, and — critically — its own WORD:
 *     `CHECK FIRST`, not `STOP`. A cache miss is our sync gap, and `STOP` there
 *     turns away a possibly-valid holder on the strength of it.
 *   - **A volunteer pass offline says `USE SEARCH`.** A volunteer JWT carries
 *     zero information about the person without the server; it is a known
 *     capability gap with a clear next action, not a verdict about them.
 *   - **A just-admitted ticket is not an already-used one.** Both read
 *     `SCANNED` on the wire. Rendering the post-admit confirmation as "already
 *     used" fires the do-not-admit signature moments after a successful
 *     admission and teaches the operator to read it as "fine, carry on" — the
 *     exact reflex that lets a genuine duplicate through at 1am.
 */
export function presentScanResult(
  descriptor: ScanResultDescriptor,
): ScanPresentation {
  switch (descriptor.kind) {
    case "ticket": {
      const copy = resolveTicketStatusCopy(descriptor.status);
      const key = resolveTicketStatusVerdictKey(descriptor.status);

      if (key === "unrecognised") {
        // Fails closed — an unrecognised status is not a pass, and we do not
        // pretend to know which kind of not-a-pass it is.
        return present(key, copy.guidance);
      }

      /**
       * `admittedHereRecently` applies ONLY to a ticket that still reads VALID.
       * It describes a PRIOR admission the status does not corroborate — the
       * halt the express guard exists to raise. On REFUNDED / INVALID / VOID /
       * LISTED / SCANNED the status is the stronger, server-shaped fact, and
       * the state line must say "REFUNDED", not "ADMITTED HERE".
       */
      if (key === "valid" && descriptor.admittedHereRecently) {
        return present("admittedHere", SCAN_VERDICT_COPY.admittedHere.detail);
      }

      /**
       * `admitted` applies ONLY to SCANNED — the status a server-ACCEPTED admit
       * produces — matching the web exactly. The flag is set when the operator
       * TAPS admit, before the server answers; on any other status it is
       * evidence of a tap, not of an admission. A REJECTED admit re-resolving
       * VALID or REFUNDED must never read ADMITTED / DONE.
       */
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
            ? // The rail's ADMIT button IS the copy here. A detail line saying
              // "admit" under a button saying ADMIT is noise.
              null
            : copy.guidance;

      return present(key, detail, {
        admittable: copy.admittable,
        // The DS appends the scan time to the state line; it is only a fact for
        // a pass that has already been used.
        at: key === "alreadyUsed" ? descriptor.scannedAtLabel : null,
      });
    }

    case "wrong_event":
      return present(
        "wrongEvent",
        SCAN_VERDICT_COPY.wrongEvent.detail(
          descriptor.selectedEventName ?? null,
        ),
      );

    case "unknown": {
      const key = resolveScanUnknownVerdictKey(descriptor.reason);
      // An unrecognised reason fails CLOSED onto STOP (see the resolver), and
      // the per-reason copy's fallback ("Couldn't read this QR. Try again")
      // would contradict that word.
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

    case "offline_unverifiable": {
      const copy = OFFLINE_UNVERIFIABLE_COPY[descriptor.reason];
      // "We couldn't READ the QR" is a different claim from "we couldn't CHECK
      // this code" — different state line, different word (TRY AGAIN vs CHECK
      // FIRST), different glyph.
      return present(
        descriptor.reason === "unreadable_payload"
          ? "unreadable"
          : "cantVerifyOffline",
        copy.guidance,
      );
    }

    case "volunteer_needs_connection":
      return present("needsSignal", OFFLINE_VOLUNTEER_COPY.guidance);

    case "admit_settled":
    case "failure":
      return markLate(descriptor, presentRefusal(descriptor));

    default: {
      const _never: never = descriptor;
      void _never;
      return present("unrecognised", null);
    }
  }
}

/** Prefix the detail of a LATE refusal so the visible words say whose it is. */
const markLate = (
  descriptor: { late?: boolean; holderName?: string | null },
  p: ScanPresentation,
): ScanPresentation =>
  descriptor.late
    ? {
        ...p,
        detail: [
          SCAN_VERDICT_COPY.lateRefusal.detail(
            descriptor.holderName?.trim() || null,
          ),
          p.detail,
        ]
          .filter(Boolean)
          .join(" "),
      }
    : p;

function presentRefusal(
  descriptor: Extract<
    ScanResultDescriptor,
    { kind: "admit_settled" } | { kind: "failure" }
  >,
): ScanPresentation {
  switch (descriptor.kind) {
    case "admit_settled": {
      const key = resolveAdmitOutcomeVerdictKey(descriptor.outcome);
      const at = descriptor.scannedAtLabel ?? null;
      switch (key) {
        case "admitted":
          return present(key, SCAN_VERDICT_COPY.admitted.detail(at), { at });
        case "alreadyUsed":
          return present(
            key,
            at
              ? SCAN_VERDICT_COPY.alreadyUsed.detail(at)
              : TICKET_STATUS_COPY.SCANNED.guidance,
            { at },
          );
        case "noMatch":
          return present(key, SCAN_UNKNOWN_COPY.ticket_not_found.guidance);
        case "invalid":
          return present(key, TICKET_STATUS_COPY.INVALID.guidance);
        case "wrongEvent":
          return present(
            key,
            SCAN_VERDICT_COPY.wrongEvent.detail(
              descriptor.selectedEventName ?? null,
            ),
          );
        case "doorsNotOpen":
          return present(key, SCAN_VERDICT_COPY.doorsNotOpen.detail);
        case "unrecognised":
          return present(key, UNRECOGNISED_ADMIT_REJECTION_GUIDANCE.guidance);
        default:
          return present(key, SCAN_VERDICT_COPY.notRecorded.detail);
      }
    }

    case "failure":
      return present(
        descriptor.stage === "lookup" ? "scanFailed" : "notRecorded",
        descriptor.detail.trim() ||
          (descriptor.stage === "lookup"
            ? SCAN_VERDICT_COPY.scanFailed.detail
            : SCAN_VERDICT_COPY.notRecorded.detail),
      );

    default: {
      const _never: never = descriptor;
      void _never;
      return present("unrecognised", null);
    }
  }
}

/**
 * WHICH verdict is on screen, as a string: the shared verdict key plus its
 * subject (the ticket code, or the result kind for a volunteer pass, an
 * offline state or a failure). The native twin of the web's
 * `verdictSignature()`, built the same way so the two surfaces stamp on the
 * same occasions.
 *
 * It is `ToneResultState`'s `stampKey`. It changes when what the operator is
 * TOLD changes — a new pass, a cross-ticket scan from inside a verdict, an
 * admit landing (VALID → ADMITTED is a new key on the same code) — and stays
 * put when the screen merely rebuilds the same verdict: `presentation` is a
 * fresh object whenever the event name or the re-admit flag re-derives it, so
 * object identity is not this. Two scans in a row with the SAME key are
 * separated by a dismiss (the camera is paused while a verdict is up), which
 * unmounts the state, so the second still stamps.
 */
export function verdictStampKey(
  presentation: Pick<ScanPresentation, "key">,
  result: AnyScanResult | null,
): string {
  const subject =
    result?.kind === "ticket" ? result.ticketCode : (result?.kind ?? "error");
  return `${presentation.key}|${subject}`;
}
