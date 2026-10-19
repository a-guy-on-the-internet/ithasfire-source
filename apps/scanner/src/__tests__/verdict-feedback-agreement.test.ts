import { describe, expect, it } from "vitest";

import { SCAN_VERDICTS, SCAN_VERDICT_KEYS } from "@th/types";

import {
  FEEDBACK_KINDS,
  VERDICT_FEEDBACK,
  feedbackKindForOutcome,
  type FeedbackKind,
  type ScanOutcomeDescriptor,
} from "../lib/feedback-signatures";
import {
  presentScanResult,
  type ScanResultDescriptor,
} from "../lib/scan-result-presentation";

/**
 * The verdict ⇄ feedback agreement guard.
 *
 * ## What this used to assert, and why it changed
 *
 * It asserted a BIJECTION between four tone families and four feedback
 * signatures — the old system's premise ("an operator learns four responses,
 * not eight"). The Design System collapsed the fills to two, `pass` and `fail`,
 * so a bijection is no longer arithmetically possible: sixteen of the nineteen
 * verdict keys are `fail`.
 *
 * The four signatures stayed, deliberately. In a dark room an operator must be
 * able to tell "seen this ticket" from "wrong show" without reading, and the
 * visual system no longer carries that distinction. Audio and haptics are the
 * only channel left that does. What this file guards is therefore the weaker,
 * true invariant:
 *
 *   1. **Total** — every verdict key has a signature.
 *   2. **Stable** — the two independently-authored tables
 *      (`presentScanResult`'s key column, `feedbackKindForOutcome`'s signature
 *      column) agree for EVERY descriptor the app can produce.
 *   3. **Never contradicts the verdict** — the `valid` signature fires if and
 *      only if the tone is `pass`.
 *
 * (2) is not hypothetical: the two tables drifted once already.
 * `volunteer_needs_connection` rendered a "reconnect" screen while buzzing
 * `rejected` — the haptic said "do not admit" while the pixels said "get
 * signal". Nothing caught it, because each table had its own test and neither
 * test knew about the other.
 */

/** Every outcome the app can present, in both descriptor vocabularies. */
const OUTCOMES: Array<{
  label: string;
  present: ScanResultDescriptor;
  feedback: ScanOutcomeDescriptor;
}> = [
  ...(["VALID", "SCANNED", "INVALID", "REFUNDED", "LISTED", "VOID"] as const).map(
    (status) => ({
      label: `ticket ${status}`,
      present: { kind: "ticket" as const, status },
      feedback: { kind: "ticket" as const, status },
    }),
  ),
  {
    // The post-admit confirmation. Both this and a stale SCANNED are `SCANNED`
    // on the wire; only the screen knows which one happened here. If the cue
    // followed the wire it would fire the do-not-admit double pulse a beat
    // after telling the operator the admission worked.
    label: "ticket SCANNED, just admitted by THIS operator",
    present: { kind: "ticket", status: "SCANNED", admitted: true },
    feedback: { kind: "ticket", status: "SCANNED", admitted: true },
  },
  // `admitted` is set at the TAP. On anything but SCANNED it is evidence of a
  // tap, not an admission — an admit that came back REJECTED re-resolves to
  // VALID / REFUNDED / INVALID and must neither read DONE nor buzz "admit".
  // These rows used to assert VALID + admitted → admitted / valid buzz.
  ...(["VALID", "REFUNDED", "INVALID", "VOID", "LISTED"] as const).map(
    (status) => ({
      label: `ticket ${status}, admit tapped but not (yet) accepted`,
      present: { kind: "ticket" as const, status, admitted: true },
      feedback: { kind: "ticket" as const, status, admitted: true },
    }),
  ),
  // The re-admit guard applies only to VALID; elsewhere the status stands.
  ...(["SCANNED", "REFUNDED", "INVALID", "VOID"] as const).map((status) => ({
    label: `ticket ${status}, admitted on THIS device recently`,
    present: { kind: "ticket" as const, status, admittedHereRecently: true },
    feedback: { kind: "ticket" as const, status, admittedHereRecently: true },
  })),
  // An admit that settled as something other than ACCEPTED.
  ...(
    [
      { outcome: "REPLAY" },
      { outcome: "REJECTED", reason: "event_not_active" },
      { outcome: "REJECTED", reason: "event_mismatch" },
      { outcome: "REJECTED", reason: "ticket_not_valid" },
      { outcome: "REJECTED", reason: "ticket_not_found" },
      { outcome: "REJECTED", reason: "brand_new_reason" },
      { outcome: "SOMETHING_NEW" },
    ] as const
  ).map((outcome) => ({
    label: `admit settled ${outcome.outcome} ${"reason" in outcome ? outcome.reason : ""}`,
    present: { kind: "admit_settled" as const, outcome },
    feedback: { kind: "admit_settled" as const, outcome },
  })),
  ...(["lookup", "record"] as const).map((stage) => ({
    label: `failure (${stage})`,
    present: { kind: "failure" as const, stage, detail: "boom" },
    feedback: { kind: "failure" as const },
  })),
  {
    label: "unknown reason this build never heard of",
    present: { kind: "unknown", reason: "brand_new_reason" },
    feedback: { kind: "unknown" },
  },
  {
    // The re-admit guard. The RESULT still says VALID (a full manifest re-sync
    // can overwrite an optimistic local SCANNED), so without this the screen
    // paints the PASS field and the haptic says "admit" on the one outcome the
    // guard exists to interrupt.
    label: "ticket VALID, already admitted on THIS device",
    present: { kind: "ticket", status: "VALID", admittedHereRecently: true },
    feedback: { kind: "ticket", status: "VALID", admittedHereRecently: true },
  },
  {
    // A prior admission outranks a fresh one on BOTH tables, or they disagree
    // about which of the two "used" states this is.
    label: "ticket VALID, admitted here AND just admitted",
    present: {
      kind: "ticket",
      status: "VALID",
      admitted: true,
      admittedHereRecently: true,
    },
    feedback: {
      kind: "ticket",
      status: "VALID",
      admitted: true,
      admittedHereRecently: true,
    },
  },
  {
    label: "ticket UNRECOGNISED",
    // Fails closed on both sides.
    present: { kind: "ticket", status: "SOMETHING_NEW" },
    feedback: { kind: "ticket", status: "SOMETHING_NEW" },
  },
  {
    label: "wrong_event",
    present: { kind: "wrong_event", selectedEventName: "Door Test" },
    feedback: { kind: "wrong_event" },
  },
  ...(["malformed", "ticket_not_found", "signature_failed"] as const).map(
    (reason) => ({
      label: `unknown ${reason}`,
      present: { kind: "unknown" as const, reason },
      feedback: { kind: "unknown" as const },
    }),
  ),
  {
    label: "volunteer",
    present: { kind: "volunteer", roleLabel: "Door", shiftLabel: "19:00" },
    feedback: { kind: "volunteer" },
  },
  ...(
    [
      "not_in_manifest",
      "unreadable_payload",
      "unrecognized_status",
      "lookup_failed",
    ] as const
  ).map((reason) => ({
    label: `offline_unverifiable ${reason}`,
    present: { kind: "offline_unverifiable" as const, reason },
    feedback: { kind: "offline_unverifiable" as const },
  })),
  {
    label: "volunteer_needs_connection",
    present: { kind: "volunteer_needs_connection" },
    feedback: { kind: "volunteer_needs_connection" },
  },
];

describe("the outcome → signature mapping is TOTAL", () => {
  it("gives every shared verdict key a signature, and only real ones", () => {
    expect(Object.keys(VERDICT_FEEDBACK).sort()).toEqual(
      [...SCAN_VERDICT_KEYS].sort(),
    );
    for (const key of SCAN_VERDICT_KEYS) {
      expect(FEEDBACK_KINDS, key).toContain(VERDICT_FEEDBACK[key]);
    }
  });

  it("leaves no signature unreachable", () => {
    // Four WAV assets ship. A signature nothing maps to is dead weight the
    // operator can never learn — and, more to the point, evidence that a
    // distinction the audio channel exists to carry has quietly been dropped.
    const used = new Set(SCAN_VERDICT_KEYS.map((k) => VERDICT_FEEDBACK[k]));
    expect([...used].sort()).toEqual([...FEEDBACK_KINDS].sort());
  });
});

describe("the signature never contradicts the verdict", () => {
  it("fires `valid` if and ONLY if the tone is `pass`", () => {
    // The one-way door. An operator acting on the buzz before reading must
    // never be told "admit" on a fail, and a genuine admission must not sound
    // like a refusal.
    for (const key of SCAN_VERDICT_KEYS) {
      const isPass = SCAN_VERDICTS[key].tone === "pass";
      expect(VERDICT_FEEDBACK[key] === "valid", key).toBe(isPass);
    }
  });

  it.each(OUTCOMES)(
    "$label: the presented verdict and the fired signature agree",
    ({ present, feedback }) => {
      const key = presentScanResult(present).key;
      expect(feedbackKindForOutcome(feedback)).toBe(VERDICT_FEEDBACK[key]);
    },
  );

  it("exercises every signature across the real outcome set", () => {
    // A guard that only ever reached `rejected` would pass while three of the
    // four signatures rotted.
    const seen = new Set(
      OUTCOMES.map((o) => VERDICT_FEEDBACK[presentScanResult(o.present).key]),
    );
    expect([...seen].sort()).toEqual([...FEEDBACK_KINDS].sort());
  });

  it("exercises BOTH tones across the real outcome set", () => {
    const seen = new Set(
      OUTCOMES.map((o) => presentScanResult(o.present).tone),
    );
    expect([...seen].sort()).toEqual(["fail", "pass"]);
  });
});

describe("the mapping is STABLE", () => {
  it("pins the grouping, so a re-point is a deliberate edit", () => {
    /**
     * Not a restatement of the map: the GROUPS are the design, and each one is
     * an argument.
     *
     *   - `already_scanned` (double pulse — the tactile "again") is both ways a
     *     pass can have been used.
     *   - `wrong_event` (one heavy thud) is "nothing is wrong with the pass;
     *     you need a different path". Painting those as rejection trains the
     *     operator to distrust people for reasons that are ours.
     *   - `rejected` is everything else — including `cantVerifyOffline`, a
     *     deliberate asymmetry with the visuals, which say CHECK FIRST rather
     *     than STOP. The audio says "do not wave this one through"; the screen
     *     says "and do not accuse them either".
     */
    const grouped: Record<FeedbackKind, string[]> = {
      valid: [],
      already_scanned: [],
      wrong_event: [],
      rejected: [],
    };
    for (const key of SCAN_VERDICT_KEYS) grouped[VERDICT_FEEDBACK[key]].push(key);
    expect(grouped.valid.sort()).toEqual(["admitted", "valid", "volunteer"]);
    expect(grouped.already_scanned.sort()).toEqual([
      "admittedHere",
      "alreadyUsed",
    ]);
    expect(grouped.wrong_event.sort()).toEqual([
      "doorsNotOpen",
      "needsSignal",
      "wrongEvent",
    ]);
    expect(grouped.rejected.sort()).toEqual([
      "cantVerifyOffline",
      "invalid",
      "listed",
      "noMatch",
      "notRecorded",
      "refunded",
      "scanFailed",
      "tampered",
      "unreadable",
      "unrecognised",
      "voided",
    ]);
  });
});

describe("an admit tap the server did not accept never buzzes or reads as one", () => {
  it.each([
    { outcome: "REPLAY" },
    { outcome: "REJECTED", reason: "event_not_active" },
    { outcome: "REJECTED", reason: "ticket_not_valid" },
  ])("$outcome $reason", (outcome) => {
    const p = presentScanResult({ kind: "admit_settled", outcome });
    expect(p.tone).toBe("fail");
    expect(p.word).not.toBe("DONE");
    expect(feedbackKindForOutcome({ kind: "admit_settled", outcome })).not.toBe(
      "valid",
    );
  });
});
