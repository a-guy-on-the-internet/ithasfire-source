import { describe, expect, it } from "vitest";

import { TONE_FAMILIES, type ToneFamily } from "@th/ui-native/tone";

import {
  FEEDBACK_KINDS,
  TONE_FAMILY_FEEDBACK,
  feedbackKindForOutcome,
  type FeedbackKind,
  type ScanOutcomeDescriptor,
} from "../lib/feedback-signatures";
import {
  presentScanResult,
  type ScanResultDescriptor,
} from "../lib/scan-result-presentation";

/**
 * Design §0's central premise, enforced: the four TONE FAMILIES and the four
 * FEEDBACK SIGNATURES are the same four things. Colour, fill lightness, glyph,
 * verdict word, haptic and audio all say the same one of four at the same
 * moment — an operator learns four responses, not eight.
 *
 * Two independently-authored tables encode it (`presentScanResult`'s tone
 * column and `feedbackKindForOutcome`'s signature column) and they DRIFTED:
 * `volunteer_needs_connection` rendered REDIRECT ("NEEDS SIGNAL", structure
 * fill) while buzzing `rejected` — the haptic and the tone said "do not admit"
 * while the screen said "reconnect". Nothing caught it, because each table had
 * its own test and neither test knew about the other.
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
    // FR-004's re-admit guard. The RESULT still says VALID (a full manifest
    // re-sync can overwrite an optimistic local SCANNED), so without this the
    // screen paints green and the haptic says "admit" on the one outcome the
    // guard exists to interrupt.
    label: "ticket VALID, already admitted on THIS device",
    present: { kind: "ticket", status: "VALID", admittedHereRecently: true },
    feedback: { kind: "ticket", status: "VALID", admittedHereRecently: true },
  },
  {
    label: "ticket UNRECOGNISED",
    // Fails closed on both sides: STOP + rejected.
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

describe("ToneFamily ↔ FeedbackKind is a bijection", () => {
  it("the canonical map covers every family exactly once", () => {
    const families = Object.keys(TONE_FAMILY_FEEDBACK).sort() as ToneFamily[];
    expect(families).toEqual([...TONE_FAMILIES].sort());

    const kinds = Object.values(TONE_FAMILY_FEEDBACK) as FeedbackKind[];
    // Injective (no two families share a signature) AND surjective (every
    // signature is reachable) — i.e. an actual bijection, not just a total
    // function.
    expect(new Set(kinds).size).toBe(kinds.length);
    expect([...kinds].sort()).toEqual([...FEEDBACK_KINDS].sort());
  });

  it.each(OUTCOMES)(
    "$label: the tone family and the feedback signature agree",
    ({ present, feedback }) => {
      const tone = presentScanResult(present).tone;
      expect(feedbackKindForOutcome(feedback)).toBe(TONE_FAMILY_FEEDBACK[tone]);
    },
  );

  it("covers every tone family across the outcome set", () => {
    // A guard that only ever exercises `stop` would pass while three of the
    // four families rotted.
    const seen = new Set(OUTCOMES.map((o) => presentScanResult(o.present).tone));
    expect([...seen].sort()).toEqual([...TONE_FAMILIES].sort());
  });
});
