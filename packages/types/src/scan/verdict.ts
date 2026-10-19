/**
 * The SHARED scan-verdict map — one outcome vocabulary for every scan surface.
 *
 * ## What this is
 *
 * The Ithas Fire Design System's `ScanResult` (`components/tickets/ScanResult.jsx`,
 * DECISIONS.md D-122…D-126) separates two things the previous build conflated:
 *
 *   - **state** — what this pass IS ("Already used", "Wrong event"). A small
 *     uppercase line with the scan time appended.
 *   - **word** — what the operator should DO ("STOP", "LET THEM IN"). Huge.
 *
 * That separation is what lets **two** tones carry every outcome in
 * {@link SCAN_VERDICT_KEYS} (nineteen today: three pass, sixteen fail). The DS
 * ships exactly two — `pass` and `fail` — and the word, not the colour, is the
 * instruction. At a gate "Valid" still requires a decision; "LET THEM IN" does
 * not. (D-123.)
 *
 * ## Why it lives in `@th/types`
 *
 * Both scan surfaces render this: the native scanner (`apps/scanner`) and the
 * web admin scan page (`apps/web/src/app/admin/[slug]/scan`). They previously
 * held two hand-copied eleven-row tables that had already drifted once (the
 * scanner handled REFUNDED + VOID but not LISTED; the web labelled INVALID as
 * "Voided"). `@th/types` is framework-free pure TS with zero React /
 * React-Native imports and is already a dependency of both, so the map can be
 * ONE module rather than a fourth copy.
 *
 * **Nothing below may import React, React Native, or a colour token.** A tone
 * is named here (`pass` / `fail`); each surface resolves it against its own
 * palette — `@th/ui-native`'s `TONE_FILL_TOKENS` on native, the Tamagui theme
 * on web. That indirection keeps colour out of a types package and lets a
 * surface re-pair a tone without touching this map. Today both surfaces pin the
 * FAIL pair to ONE theme-invariant pair (`verdictFail` #B93312 with white, the
 * same on Ember and Stub), so a fail never changes colour with the theme.
 *
 * ## The extension beyond the DS's five outcomes
 *
 * D-124 fixes five: valid, already used, not a ticket, wrong event, expired.
 * Real scanning has more — refunds, resale listings, volunteer passes, an
 * offline manifest miss, a door that has not opened yet. Every extra row keeps
 * the DS's actual rule (D-123): **the word is an instruction**, never a status.
 *
 * Two of the extended words are load-bearing rather than stylistic:
 *
 *   - **`CHECK FIRST`** (offline, code absent from the manifest) is a SAFETY
 *     requirement, not a preference. A cache miss is not evidence the ticket is
 *     bad. `STOP` there tells an operator to turn away a possibly-valid holder
 *     on the strength of a sync gap that is entirely ours. The state line and
 *     `detail` carry the nuance; the word must not overstate it.
 *   - **`HOLD`** (doors not open) says the pass is fine and the moment is not.
 *     `STOP` would send a legitimate holder away rather than ask them to wait.
 *
 * ## i18n readiness
 *
 * Same shape as {@link TicketStatusCopy}: English defaults stored as DATA
 * alongside stable message keys, so a later pass can route them through the web
 * catalog without touching a call site's structure. Never inline these strings.
 */
import {
  SCAN_UNKNOWN_REASONS,
  TICKET_SCAN_STATUSES,
  type ScanUnknownReason,
  type TicketScanStatus,
} from "./ticket-status-copy";

// ── Tone ────────────────────────────────────────────────────────────────────

/**
 * The two verdict tones. NOT `ScanStatusTone` / `BadgeTone` — that is the badge
 * OUTLINE vocabulary (`neutral | success | warning | danger`) whose `warning`
 * maps to `accent`, a value with no legal foreground in either polarity. This
 * is the FULL-BLEED VERDICT axis, and it has exactly two members because the
 * DS says the word carries the instruction.
 */
export type VerdictTone = "pass" | "fail";

/**
 * Value-level twin of {@link VerdictTone}, so guards can iterate the tones at
 * runtime rather than transcribing them.
 */
export const VERDICT_TONES = [
  "pass",
  "fail",
] as const satisfies readonly VerdictTone[];

/**
 * The converse direction: adding a member to {@link VerdictTone} without adding
 * it here makes this annotation `false` and fails `pnpm typecheck`.
 */
const _everyVerdictToneIsListed: [
  Exclude<VerdictTone, (typeof VERDICT_TONES)[number]>,
] extends [never]
  ? true
  : false = true;
void _everyVerdictToneIsListed;

// ── Keys ────────────────────────────────────────────────────────────────────

/**
 * Every distinct thing an operator can be told at a door, across BOTH surfaces.
 *
 * Several outcomes deliberately share a key because they are the same FACT with
 * a different explanation — the three "we could not check this code offline"
 * reasons all read `cantVerifyOffline`, and the `detail` line is where they
 * differ. What must never happen is two outcomes that mean different things
 * sharing a key, because the key is what picks the word.
 */
export const SCAN_VERDICT_KEYS = [
  // ── pass ──
  "valid",
  "admitted",
  "volunteer",
  // ── fail ──
  "alreadyUsed",
  "admittedHere",
  "wrongEvent",
  "refunded",
  "voided",
  "listed",
  "invalid",
  "noMatch",
  "tampered",
  "unreadable",
  "doorsNotOpen",
  "cantVerifyOffline",
  "needsSignal",
  "notRecorded",
  "scanFailed",
  "unrecognised",
] as const;

export type ScanVerdictKey = (typeof SCAN_VERDICT_KEYS)[number];

// ── The map ─────────────────────────────────────────────────────────────────

export type ScanVerdictEntry = {
  key: ScanVerdictKey;
  tone: VerdictTone;
  /**
   * What this pass IS. Sentence case here; surfaces render it uppercase with
   * wide tracking and append the scan time (`ALREADY USED · 8:14 PM`).
   *
   * Never an instruction — that is {@link ScanVerdictEntry.word}'s job, and the
   * whole point of the split.
   */
  state: string;
  /**
   * What the operator should DO. Uppercase, an imperative, never a status.
   *
   * Stored already-uppercased rather than transformed at render because the
   * length budget (see {@link MAX_VERDICT_WORD_LENGTH}) is measured on the
   * rendered string, and a lowercase source would make the guard lie.
   */
  word: string;
  /** Stable catalog keys for a future i18n pass. */
  stateKey: string;
  wordKey: string;
};

const entry = (
  key: ScanVerdictKey,
  tone: VerdictTone,
  state: string,
  word: string,
): ScanVerdictEntry => ({
  key,
  tone,
  state,
  word,
  stateKey: `scan.verdict.${key}.state`,
  wordKey: `scan.verdict.${key}.word`,
});

/**
 * Outcome → (tone, state, word). **The single place this decision exists.**
 *
 * Read the `word` column top to bottom: every one is something a person at a
 * door can do. That is the invariant, and `verdict.test.ts` asserts the
 * mechanical half of it (imperative, uppercase, no punctuation, length).
 */
export const SCAN_VERDICTS: Record<ScanVerdictKey, ScanVerdictEntry> = {
  // ── pass ──────────────────────────────────────────────────────────────────
  valid: entry("valid", "pass", "Valid", "LET THEM IN"),
  /**
   * The post-admit confirmation, NOT a second "already used".
   *
   * A ticket reads `SCANNED` in two very different situations: this operator
   * just admitted them, or they were already in. Rendering both as "already
   * used" is a real safety problem — it fires the do-not-admit signature 200ms
   * after a successful admission and teaches the operator to read it as "fine,
   * carry on", which is the exact reflex that lets a genuine duplicate through
   * at 1am. Same tone as VALID, reached AFTER the action instead of before it,
   * and the word changes because "admit this person" and "this person is in"
   * are different instructions.
   */
  admitted: entry("admitted", "pass", "Admitted", "DONE"),
  volunteer: entry("volunteer", "pass", "Volunteer", "CHECK THEM IN"),

  // ── fail ──────────────────────────────────────────────────────────────────
  alreadyUsed: entry("alreadyUsed", "fail", "Already used", "STOP"),
  /**
   * The re-admit guard, made visible. THIS device admitted this code minutes
   * ago while the server-shaped status may still say VALID (a full manifest
   * re-sync overwrites an optimistic local SCANNED before the queue reports
   * it). Same word as `alreadyUsed` — it IS a used pass — but its own state
   * line, because "the server says this was scanned" and "I admitted this here,
   * minutes ago" are different facts with different recoveries.
   */
  admittedHere: entry("admittedHere", "fail", "Admitted here", "STOP"),
  wrongEvent: entry("wrongEvent", "fail", "Wrong event", "STOP"),
  refunded: entry("refunded", "fail", "Refunded", "STOP"),
  voided: entry("voided", "fail", "Voided", "STOP"),
  listed: entry("listed", "fail", "Listed for resale", "STOP"),
  invalid: entry("invalid", "fail", "Not a ticket", "STOP"),
  noMatch: entry("noMatch", "fail", "No match", "STOP"),
  tampered: entry("tampered", "fail", "Tampered", "STOP"),
  /**
   * We could not READ the code — a claim about the QR, not about the holder.
   * `TRY AGAIN` because the recovery is another scan, not a refusal.
   */
  unreadable: entry("unreadable", "fail", "Unreadable", "TRY AGAIN"),
  /**
   * The pass is fine; the door is not open (the event window has not started,
   * or closed). `HOLD`, never `STOP` — nothing is wrong with the person.
   */
  doorsNotOpen: entry("doorsNotOpen", "fail", "Doors not open", "HOLD"),
  /**
   * Offline, and this code is not in the synced manifest. See the module
   * docblock: `CHECK FIRST` is a safety requirement. A cache miss is not
   * evidence of forgery, and the operator is about to turn someone away on the
   * strength of this one line.
   */
  cantVerifyOffline: entry(
    "cantVerifyOffline",
    "fail",
    "Can't verify offline",
    "CHECK FIRST",
  ),
  /**
   * A volunteer pass with no connection. Signature verification is server-side
   * only and must stay there, so the JWT carries zero information about the
   * person offline. That is OUR capability gap with a clear next action —
   * `USE SEARCH` — not a verdict about the volunteer.
   */
  needsSignal: entry("needsSignal", "fail", "Needs signal", "USE SEARCH"),
  /**
   * The server refused to RECORD an admission for a reason it did not name.
   * Fails closed without claiming the pass is bad: the admission did not
   * happen, and the recovery is to retry.
   */
  notRecorded: entry("notRecorded", "fail", "Not recorded", "TRY AGAIN"),
  /**
   * A LOOKUP that threw — the resolve round trip failed before we learned
   * anything about the pass. Distinct from `notRecorded`, which is reserved for
   * a failed WRITE (an admit or check-in the server did not record): "we could
   * not look this up" and "we could not record this admission" have different
   * consequences for whether the person is already in. Same word, because the
   * recovery for both is another attempt, and nothing here is evidence the
   * pass is bad.
   */
  scanFailed: entry("scanFailed", "fail", "Scan failed", "TRY AGAIN"),
  /**
   * A status this build has never heard of (a server-side enum added after the
   * client shipped, or a stale manifest row). Fails CLOSED — an unrecognised
   * status is not a pass, and we do not pretend to know which kind of not-a-pass
   * it is.
   */
  unrecognised: entry("unrecognised", "fail", "Unrecognised", "STOP"),
};

/**
 * Longest legal `word`, measured on the rendered (uppercase) string.
 *
 * The word is set at the display rung, so a longer one wraps or shrinks on a
 * 375pt screen and stops being the thing readable at arm's length in 300ms.
 * `CHECK THEM IN` is the current maximum at 13.
 */
export const MAX_VERDICT_WORD_LENGTH = 13;

/** Longest legal `state` — it shares a line with the appended time. */
export const MAX_VERDICT_STATE_LENGTH = 20;

export function isScanVerdictKey(value: unknown): value is ScanVerdictKey {
  return (
    typeof value === "string" &&
    (SCAN_VERDICT_KEYS as readonly string[]).includes(value)
  );
}

/** Resolve a key to its entry. Total by construction. */
export function scanVerdict(key: ScanVerdictKey): ScanVerdictEntry {
  return SCAN_VERDICTS[key];
}

/**
 * Compose the DS's state line: `ALREADY USED · 8:14 PM`.
 *
 * `at` is a PRE-FORMATTED local time string, never a `Date` — this module has
 * no locale, no timezone and no business being given one. Surfaces format with
 * their own helper (`safeTimeString` on native) and hand the string in.
 */
export function verdictStateLine(
  key: ScanVerdictKey,
  at?: string | null,
): string {
  const state = SCAN_VERDICTS[key].state.toUpperCase();
  const time = at?.trim();
  return time ? `${state} · ${time}` : state;
}

// ── Outcome → key ───────────────────────────────────────────────────────────

/**
 * Ticket lifecycle status → verdict key.
 *
 * `VALID` is the only `pass`, and that is not a coincidence to be tidied away:
 * it is the same rule `TICKET_STATUS_COPY[…].admittable` encodes, expressed on
 * the other axis. The two are asserted to agree in `verdict.test.ts`.
 */
export const TICKET_STATUS_VERDICT: Record<TicketScanStatus, ScanVerdictKey> = {
  VALID: "valid",
  SCANNED: "alreadyUsed",
  INVALID: "invalid",
  REFUNDED: "refunded",
  LISTED: "listed",
  VOID: "voided",
};

/** Unresolvable-payload reason → verdict key. */
export const SCAN_UNKNOWN_VERDICT: Record<ScanUnknownReason, ScanVerdictKey> = {
  malformed: "unreadable",
  ticket_not_found: "noMatch",
  signature_failed: "tampered",
};

/** The fail-closed key for a status neither surface recognises. */
export const UNRECOGNISED_STATUS_VERDICT_KEY: ScanVerdictKey = "unrecognised";

/**
 * Resolve any status string to a verdict key, failing CLOSED on an unknown one.
 *
 * Deliberately NOT an exception: this runs on the scan hot path, where throwing
 * would blank the result an operator is standing at a door reading.
 */
export function resolveTicketStatusVerdictKey(
  status: string | null | undefined,
): ScanVerdictKey {
  return typeof status === "string" &&
    (TICKET_SCAN_STATUSES as readonly string[]).includes(status)
    ? TICKET_STATUS_VERDICT[status as TicketScanStatus]
    : UNRECOGNISED_STATUS_VERDICT_KEY;
}

/**
 * Resolve an unknown-reason to a verdict key, failing CLOSED on one this build
 * has never heard of — the same rule, and the same key, as an unrecognised
 * ticket status.
 *
 * It used to fall back to `unreadable` (TRY AGAIN). That sent an operator into a
 * rescan loop on a reason the server added after this client shipped, and it
 * disagreed with the status resolver one function up: an unknown status said
 * STOP while an unknown reason said "scan it again". An unrecognised claim
 * about a pass is not a pass, whichever axis it arrives on.
 */
export function resolveScanUnknownVerdictKey(
  reason: string | null | undefined,
): ScanVerdictKey {
  return typeof reason === "string" &&
    (SCAN_UNKNOWN_REASONS as readonly string[]).includes(reason)
    ? SCAN_UNKNOWN_VERDICT[reason as ScanUnknownReason]
    : UNRECOGNISED_STATUS_VERDICT_KEY;
}

/**
 * The `detail` line for an unknown-reason this build does not recognise. The
 * per-reason guidance in `SCAN_UNKNOWN_COPY` falls back to `malformed`'s
 * "Couldn't read this QR code. Try again", which would contradict a STOP.
 */
export const UNRECOGNISED_SCAN_REASON_GUIDANCE = {
  key: "scan.verdict.unrecognised.reasonGuidance",
  guidance: "This pass wasn't recognized — do not admit.",
} as const;

// ── A settled admit → key ───────────────────────────────────────────────────

/**
 * `tickets.scanTicket` answers `{ outcome: "REJECTED", reason }` with a 200,
 * not a throw. Each reason maps onto a verdict key here so both surfaces show
 * the same refusal for the same server answer.
 */
export const ADMIT_REJECTION_VERDICT: Readonly<Record<string, ScanVerdictKey>> =
  {
    ticket_not_found: "noMatch",
    ticket_not_valid: "invalid",
    event_mismatch: "wrongEvent",
    event_not_active: "doorsNotOpen",
  };

/**
 * An admit REJECTED for a reason this build does not know. Fails CLOSED onto
 * STOP — the same key as an unrecognised status or an unrecognised resolve
 * reason (orchestrator ruling). The server said no to THIS pass; TRY AGAIN
 * would send the operator round a loop the server will keep refusing.
 */
export const ADMIT_REJECTION_FALLBACK_KEY: ScanVerdictKey =
  UNRECOGNISED_STATUS_VERDICT_KEY;

/** The `detail` line for an admit rejected for an unrecognised reason. */
export const UNRECOGNISED_ADMIT_REJECTION_GUIDANCE = {
  key: "scan.verdict.unrecognised.admitRejectionGuidance",
  guidance:
    "The server refused this admission for a reason this app doesn't recognize — do not admit.",
} as const;

/**
 * A settled admit whose OUTCOME this build has never heard of. Not evidence
 * of an admission, and not a refusal of the pass either: `notRecorded`.
 */
export const UNKNOWN_ADMIT_OUTCOME_KEY: ScanVerdictKey = "notRecorded";

export function resolveAdmitRejectionVerdictKey(
  reason: string | null | undefined,
): ScanVerdictKey {
  // Own-property lookup: `reason` is a server string, and `"constructor"` must
  // not resolve to `Object.prototype.constructor`.
  return typeof reason === "string" &&
    Object.prototype.hasOwnProperty.call(ADMIT_REJECTION_VERDICT, reason)
    ? (ADMIT_REJECTION_VERDICT[reason] as ScanVerdictKey)
    : ADMIT_REJECTION_FALLBACK_KEY;
}

/**
 * Structural minimum of `scanTicketOutputSchema`
 * (`packages/core/src/use-cases/tickets/scan-ticket.ts`). Loose on purpose:
 * this package must not import core, and a widened server field must not break
 * the door.
 */
export type ScanAdmitOutcomeLike = {
  outcome: string;
  reason?: string | null;
};

/**
 * A settled `scanTicket` → the verdict the operator must see. The ONE place
 * either surface decides whether an admit tap became an admission.
 *
 *   - `ACCEPTED` → `admitted` (DONE). The only outcome that may.
 *   - `REPLAY`   → `alreadyUsed` (STOP). Someone else already let this person
 *     in; this tap recorded nothing.
 *   - `REJECTED` → the reason's key (see {@link ADMIT_REJECTION_VERDICT}).
 *     An unrecognised reason → `unrecognised` (STOP).
 *   - anything else → `notRecorded`. An outcome this build has never heard of
 *     is not evidence of an admission.
 */
export function resolveAdmitOutcomeVerdictKey(
  outcome: ScanAdmitOutcomeLike,
): ScanVerdictKey {
  switch (outcome.outcome) {
    case "ACCEPTED":
      return "admitted";
    case "REPLAY":
      return "alreadyUsed";
    case "REJECTED":
      return resolveAdmitRejectionVerdictKey(outcome.reason);
    default:
      return UNKNOWN_ADMIT_OUTCOME_KEY;
  }
}

// ── Glyph names ─────────────────────────────────────────────────────────────

/**
 * Hero glyph, by Lucide NAME. A string, never a component: this module stays
 * React-free, and each surface owns a name → component map
 * (`ToneResultState.tsx` on web, `unified-result-view.tsx` on native) typed
 * `Record<ScanGlyphId, …>`, so a name added here is a type error on both until
 * it resolves.
 *
 * Every outcome has its OWN glyph, and with only two fills that stopped being a
 * nicety: a deuteranope reads amber and flame as two similar blocks, so the
 * glyph is a load-bearing channel and not decoration.
 */
export const SCAN_GLYPH_IDS = [
  "CheckCircle2",
  "DoorOpen",
  "CheckCheck",
  "CircleDollarSign",
  "Ban",
  "Tag",
  "XCircle",
  "CalendarX2",
  "Clock",
  "HelpCircle",
  "SearchX",
  "ShieldAlert",
  "ServerOff",
  "UserCheck",
  "WifiOff",
  "ShieldQuestion",
] as const;

export type ScanGlyphId = (typeof SCAN_GLYPH_IDS)[number];

/**
 * Verdict key → glyph name. TOTAL over the key set and SHARED, so a verdict
 * shows the same symbol on both surfaces by construction rather than by two
 * hand-copied tables.
 *
 * `alreadyUsed` and `admittedHere` deliberately SHARE `CheckCheck`: the same
 * fact ("this pass has been used") reached two ways, separated by the state
 * line. `scanFailed` and `notRecorded` share `ServerOff`: both say the round
 * trip failed, and the state line says which one.
 */
export const SCAN_GLYPHS: Record<ScanVerdictKey, ScanGlyphId> = {
  valid: "CheckCircle2",
  admitted: "DoorOpen",
  volunteer: "UserCheck",
  alreadyUsed: "CheckCheck",
  admittedHere: "CheckCheck",
  wrongEvent: "CalendarX2",
  refunded: "CircleDollarSign",
  voided: "Ban",
  listed: "Tag",
  invalid: "XCircle",
  noMatch: "SearchX",
  tampered: "ShieldAlert",
  unreadable: "HelpCircle",
  doorsNotOpen: "Clock",
  cantVerifyOffline: "ShieldQuestion",
  needsSignal: "WifiOff",
  notRecorded: "ServerOff",
  scanFailed: "ServerOff",
  unrecognised: "ShieldQuestion",
};

// ── Feedback signatures ─────────────────────────────────────────────────────

/**
 * The four haptic/audio outcome signatures, by name. The native scanner plays
 * a haptic pattern and a tone per name; the web plays a vibration pattern only.
 *
 * RECORDED DEVIATION from the DS: `ScanResult.prompt.md` specifies a pass/fail
 * pair — a single tone for pass and a double pulse for fail. Four signatures
 * ship, kept by owner ruling on 2026-10-06, because the haptic is the only
 * channel left that separates "already used" from "wrong event" (both are the
 * `fail` tone). The deviation is logged in the DS DECISIONS.md.
 */
export const SCAN_FEEDBACK_KINDS = [
  "valid",
  "already_scanned",
  "wrong_event",
  "rejected",
] as const;

export type ScanFeedbackKind = (typeof SCAN_FEEDBACK_KINDS)[number];

/**
 * Verdict key → signature. TOTAL over the key set and SHARED by both surfaces
 * (web `scan-feedback.ts`, native `feedback-signatures.ts`), so the same
 * verdict buzzes the same way on both.
 *
 * Invariants (asserted in `verdict.test.ts`): total; every signature reachable;
 * `valid` fires if and only if the tone is `pass`.
 *
 *   - `already_scanned` (double pulse — the tactile "again") covers both ways a
 *     pass can have been used: the server saw it, or this device did.
 *   - `wrong_event` (stutter / one heavy thud) covers the outcomes where nothing
 *     is wrong with the PASS and the operator needs a different path.
 *   - `rejected` covers the rest, including `cantVerifyOffline` — the audio says
 *     "do not wave this one through"; the screen's CHECK FIRST says "and do not
 *     accuse them either".
 */
export const VERDICT_FEEDBACK: Record<ScanVerdictKey, ScanFeedbackKind> = {
  // pass
  valid: "valid",
  admitted: "valid",
  volunteer: "valid",
  // used
  alreadyUsed: "already_scanned",
  admittedHere: "already_scanned",
  // nothing wrong with the pass — a different path
  wrongEvent: "wrong_event",
  doorsNotOpen: "wrong_event",
  needsSignal: "wrong_event",
  // do not admit
  refunded: "rejected",
  voided: "rejected",
  listed: "rejected",
  invalid: "rejected",
  noMatch: "rejected",
  tampered: "rejected",
  unreadable: "rejected",
  cantVerifyOffline: "rejected",
  notRecorded: "rejected",
  scanFailed: "rejected",
  unrecognised: "rejected",
};
