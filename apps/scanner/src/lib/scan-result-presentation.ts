/**
 * FR-003 — outcome → (tone family, hero glyph, verdict word, badge, guidance).
 *
 * PURE. No `expo-*`, no `react-native`, no `lucide-react-native` — glyphs are
 * named by a STRING id that the view resolves through its own icon map
 * (`unified-result-view.tsx`). Same testability split as
 * `feedback-signatures.ts` vs `feedback.ts`: the decision of what an operator
 * is told at a door is exactly the kind of logic that must be asserted in
 * vitest rather than eyeballed on a device.
 *
 * ## The four tone families are NOT `BadgeTone`
 *
 * `@th/types`' `ScanStatusTone` (and `@th/ui-native`'s `BadgeTone`) is a BADGE
 * OUTLINE vocabulary whose `warning` maps to `accent` — a value with no legal
 * foreground in either polarity. Mapping status → `ToneFamily` is therefore a
 * SEPARATE decision, made here, from the design's §2.2 table. Reusing the
 * badge tone for a full-bleed fill would silently produce an accent verdict
 * with unreadable copy.
 *
 * ## Copy comes from the shared FR-008 map wherever one exists
 *
 * Guidance for the six ticket statuses and the three unknown reasons is read
 * from `@th/types`, and the offline states read `./offline-resolve`'s maps.
 * Only strings with no shared home live below, and they live as DATA with a
 * message key — never inlined at a call site, never concatenated with data in
 * the middle (design §10, i18n readiness).
 *
 * Design: docs/specs/2026-08-04/scan-screen-design.md §2.2.
 */
import {
  resolveScanUnknownCopy,
  resolveTicketStatusCopy,
  type TicketScanStatus,
} from "@th/types";
import type { ToneFamily } from "@th/ui-native/tone";

import {
  OFFLINE_UNVERIFIABLE_COPY,
  OFFLINE_VOLUNTEER_COPY,
  type OfflineUnverifiableReason,
} from "./offline-resolve";

/**
 * Hero glyph, by name. The view owns the id → `LucideIcon` map so this module
 * stays importable in node.
 *
 * Every outcome has its OWN glyph, not one per tone. That is deliberate: a
 * deuteranope reads ADMIT and STOP as two similar dark blocks, so the glyph is
 * a load-bearing channel and not decoration.
 */
export type ScanGlyphId =
  | "CheckCircle2"
  | "CheckCheck"
  | "CircleDollarSign"
  | "Ban"
  | "Tag"
  | "XCircle"
  | "CalendarX2"
  | "HelpCircle"
  | "SearchX"
  | "ShieldAlert"
  | "UserCheck"
  | "WifiOff"
  | "ShieldQuestion";

export type ScanPresentation = {
  tone: ToneFamily;
  glyph: ScanGlyphId;
  /** ≤12 chars, uppercase, one word where possible. Never a sentence. */
  verdict: string;
  /** Status badge — the fifth redundancy channel. Never empty. */
  badge: string;
  guidance: string | null;
  /** True for exactly one outcome: a ticket whose status is literally VALID. */
  admittable: boolean;
};

// ── Copy with no shared home (structured as data — see the docblock) ────────

export const SCAN_VERDICT_COPY = {
  wrongEvent: {
    key: "scan.verdict.wrongEvent.guidance",
    /** `eventName` is null when the selected event has no title yet. */
    guidance: (eventName: string | null) =>
      eventName
        ? `This QR is for a different event. Switch events in Settings, or scan a pass for ${eventName}.`
        : "This QR is for a different event. Switch events in Settings, or scan a pass for the selected event.",
  },
  alreadyIn: {
    key: "scan.verdict.alreadyIn.guidance",
    /** `time` is a pre-formatted local time string, never a Date. */
    guidance: (time: string) => `Scanned at ${time} — already admitted.`,
  },
  admittedHere: {
    key: "scan.verdict.admittedHere.guidance",
    /**
     * FR-004's re-admit guard, made visible. The manifest may still say VALID
     * (a 60s full re-sync can overwrite an optimistic local SCANNED before the
     * queue reports it), so the SERVER-shaped status is not evidence here — the
     * device's own admit log is.
     */
    guidance:
      "You admitted this pass on this device in the last few minutes. If that was someone else, find them in Search before admitting again.",
  },
  volunteer: {
    key: "scan.verdict.volunteer.guidance",
    guidance: (role: string, shift: string) => `${role} — ${shift}.`,
  },
} as const;

// ── Per-status mapping (design §2.2 rows 1–6) ───────────────────────────────

const TICKET_TONE: Record<TicketScanStatus, ToneFamily> = {
  VALID: "admit",
  SCANNED: "alreadyIn",
  INVALID: "stop",
  REFUNDED: "stop",
  LISTED: "stop",
  VOID: "stop",
};

const TICKET_GLYPH: Record<TicketScanStatus, ScanGlyphId> = {
  VALID: "CheckCircle2",
  SCANNED: "CheckCheck",
  INVALID: "XCircle",
  REFUNDED: "CircleDollarSign",
  VOID: "Ban",
  LISTED: "Tag",
};

const TICKET_VERDICT: Record<TicketScanStatus, string> = {
  VALID: "ADMIT",
  SCANNED: "ALREADY IN",
  INVALID: "INVALID",
  REFUNDED: "REFUNDED",
  VOID: "VOIDED",
  LISTED: "LISTED",
};

const TICKET_BADGE: Record<TicketScanStatus, string> = {
  VALID: "VALID",
  SCANNED: "SCANNED",
  INVALID: "INVALID",
  REFUNDED: "REFUNDED",
  VOID: "VOID",
  LISTED: "LISTED",
};

// ── unknown reasons (design §2.2 rows 8 / 8b / 8c) ──────────────────────────

const UNKNOWN_PRESENTATION: Record<
  string,
  { glyph: ScanGlyphId; verdict: string; badge: string }
> = {
  malformed: {
    glyph: "HelpCircle",
    verdict: "UNREADABLE",
    badge: "NOT RECOGNIZED",
  },
  ticket_not_found: {
    glyph: "SearchX",
    verdict: "NO MATCH",
    badge: "NOT FOUND",
  },
  signature_failed: {
    glyph: "ShieldAlert",
    verdict: "TAMPERED",
    badge: "INVALID PASS",
  },
};

// ── Descriptor ──────────────────────────────────────────────────────────────

export type ScanResultDescriptor =
  | {
      kind: "ticket";
      status: string;
      /** Pre-formatted local time, for the ALREADY IN guidance line. */
      scannedAtLabel?: string | null;
      /**
       * FR-004's re-admit guard fired: THIS DEVICE admitted this ticket inside
       * {@link EXPRESS_REPEAT_GUARD_MS}. Only ever set when express is enabled
       * (it is the visible half of `planExpressMode`'s
       * `recently_admitted_here` halt) — the manual path is unchanged.
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
  | { kind: "volunteer_needs_connection" };

/**
 * The one place an outcome becomes a verdict.
 *
 * Two judgement calls encoded here, both from the design and both important:
 *
 *   - **"Can't verify offline" is red but is NOT "INVALID".** A code absent
 *     from a synced manifest is more likely bad than good, so the operator
 *     should hesitate — but it must never *claim* invalidity. It gets its own
 *     glyph (`ShieldQuestion`, not `XCircle`), its own verdict word
 *     (`CAN'T VERIFY`, not `INVALID`) and its own badge (`UNVERIFIED`). Three
 *     of the five channels differ. Colour alone does not carry a false
 *     accusation.
 *   - **A volunteer pass offline is REDIRECT, not STOP.** A volunteer JWT
 *     carries zero information about the person without the server; it is a
 *     known capability gap with a clear next action. Painting it red trains
 *     the operator to distrust volunteers for a reason that is entirely ours.
 */
export function presentScanResult(
  descriptor: ScanResultDescriptor,
): ScanPresentation {
  switch (descriptor.kind) {
    case "ticket": {
      const copy = resolveTicketStatusCopy(descriptor.status);
      if (copy.status === "UNKNOWN") {
        // Fails closed — an unrecognised status is not a pass, and we do not
        // pretend to know which kind of not-a-pass it is.
        return {
          tone: "stop",
          glyph: "ShieldQuestion",
          verdict: "CAN'T VERIFY",
          badge: "UNRECOGNIZED",
          guidance: copy.guidance,
          admittable: false,
        };
      }
      const status = copy.status;
      /**
       * The re-admit guard halts express — but until now the RESULT still said
       * `VALID`, so the screen painted the full-bleed green ADMIT state and the
       * rail offered ADMIT. That guard exists for exactly one scenario (a
       * shared or screenshotted QR presented twice inside the sync-overwrite
       * window), and in exactly that scenario an operator trained by express to
       * read green as "walk on" was shown green.
       *
       * So it presents as the ALREADY IN family instead — different fill,
       * different LIGHTNESS, different glyph, different word, different badge,
       * and (via `feedbackKindForOutcome`) a different haptic and tone. Five
       * channels, all saying the same thing. `admittable: false` is what stops
       * the rail offering ADMIT.
       */
      if (status === "VALID" && descriptor.admittedHereRecently) {
        return {
          tone: "alreadyIn",
          glyph: "CheckCheck",
          verdict: "ALREADY IN",
          badge: "ADMITTED HERE",
          guidance: SCAN_VERDICT_COPY.admittedHere.guidance,
          admittable: false,
        };
      }
      const guidance =
        status === "SCANNED" && descriptor.scannedAtLabel
          ? SCAN_VERDICT_COPY.alreadyIn.guidance(descriptor.scannedAtLabel)
          : status === "VALID"
            ? // The rail's ADMIT button IS the copy here. A guidance line
              // saying "admit" under a button saying ADMIT is noise.
              null
            : copy.guidance;
      return {
        tone: TICKET_TONE[status],
        glyph: TICKET_GLYPH[status],
        verdict: TICKET_VERDICT[status],
        badge: TICKET_BADGE[status],
        guidance,
        admittable: copy.admittable,
      };
    }

    case "wrong_event":
      return {
        tone: "redirect",
        glyph: "CalendarX2",
        verdict: "WRONG SHOW",
        badge: "WRONG EVENT",
        guidance: SCAN_VERDICT_COPY.wrongEvent.guidance(
          descriptor.selectedEventName ?? null,
        ),
        admittable: false,
      };

    case "unknown": {
      const copy = resolveScanUnknownCopy(descriptor.reason);
      const shape =
        UNKNOWN_PRESENTATION[copy.reason] ?? UNKNOWN_PRESENTATION.malformed!;
      return {
        tone: "stop",
        glyph: shape.glyph,
        verdict: shape.verdict,
        badge: shape.badge,
        guidance: copy.guidance,
        admittable: false,
      };
    }

    case "volunteer": {
      const role = descriptor.roleLabel?.trim();
      const shift = descriptor.shiftLabel?.trim();
      const line =
        role && shift
          ? SCAN_VERDICT_COPY.volunteer.guidance(role, shift)
          : null;
      const note = descriptor.scanWindowNote?.trim() || null;
      return {
        tone: "admit",
        glyph: "UserCheck",
        verdict: "VOLUNTEER",
        // The role label is the badge when there is one — it is the single
        // most useful word on the screen for a volunteer.
        badge: role ? role.toUpperCase() : "VOLUNTEER",
        guidance: [line, note].filter(Boolean).join(" ") || null,
        admittable: false,
      };
    }

    case "offline_unverifiable": {
      const copy = OFFLINE_UNVERIFIABLE_COPY[descriptor.reason];
      // The unreadable-payload branch is "we couldn't read the QR", which is
      // a different claim from "we couldn't check this code" — different
      // glyph, different word, different badge.
      const unreadable = descriptor.reason === "unreadable_payload";
      return {
        tone: "stop",
        glyph: unreadable ? "HelpCircle" : "ShieldQuestion",
        verdict: unreadable ? "UNREADABLE" : "CAN'T VERIFY",
        badge: unreadable ? "NOT RECOGNIZED" : "UNVERIFIED",
        guidance: copy.guidance,
        admittable: false,
      };
    }

    case "volunteer_needs_connection":
      return {
        tone: "redirect",
        glyph: "WifiOff",
        verdict: "NEEDS SIGNAL",
        badge: "OFFLINE",
        guidance: OFFLINE_VOLUNTEER_COPY.guidance,
        admittable: false,
      };

    default: {
      const _never: never = descriptor;
      void _never;
      return {
        tone: "stop",
        glyph: "ShieldQuestion",
        verdict: "CAN'T VERIFY",
        badge: "UNVERIFIED",
        guidance: null,
        admittable: false,
      };
    }
  }
}

/** Verdict words are capped so they fit one line at 375pt (design §10). */
export const MAX_VERDICT_LENGTH = 12;
