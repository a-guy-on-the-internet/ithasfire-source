import { describe, expect, it } from "vitest";

import {
  FEEDBACK_KINDS,
  FEEDBACK_SIGNATURES,
  feedbackKindForOutcome,
  feedbackSignature,
  type FeedbackKind,
  type HapticStep,
} from "./feedback-signatures";

/** Stable, comparable fingerprint of a haptic pattern. */
const hapticFingerprint = (steps: readonly HapticStep[]): string =>
  steps
    .map((s) =>
      s.type === "delay"
        ? `delay:${s.ms}`
        : s.type === "impact"
          ? `impact:${s.impact}`
          : `notification:${s.notification}`,
    )
    .join("|");

describe("feedback signatures", () => {
  it("defines exactly four outcome signatures", () => {
    expect(FEEDBACK_KINDS).toEqual([
      "valid",
      "already_scanned",
      "wrong_event",
      "rejected",
    ]);
    expect(Object.keys(FEEDBACK_SIGNATURES).sort()).toEqual(
      [...FEEDBACK_KINDS].sort(),
    );
  });

  it("gives each kind its own tone asset", () => {
    const tones = FEEDBACK_KINDS.map((k) => FEEDBACK_SIGNATURES[k].tone);
    expect(new Set(tones).size).toBe(FEEDBACK_KINDS.length);
  });

  it("gives each kind a distinct rich haptic pattern", () => {
    // The bug FR-002 fixes: already_scanned and wrong_event previously shared
    // one "warning" notification. All four must now differ.
    const patterns = FEEDBACK_KINDS.map((k) =>
      hapticFingerprint(FEEDBACK_SIGNATURES[k].haptic.rich),
    );
    expect(new Set(patterns).size).toBe(FEEDBACK_KINDS.length);
  });

  it("pins the exact haptic pattern per kind", () => {
    expect(hapticFingerprint(FEEDBACK_SIGNATURES.valid.haptic.rich)).toBe(
      "notification:success",
    );
    // Double pulse — the tactile "again".
    expect(
      hapticFingerprint(FEEDBACK_SIGNATURES.already_scanned.haptic.rich),
    ).toBe("impact:medium|delay:120|impact:medium");
    // Single heavy thud.
    expect(hapticFingerprint(FEEDBACK_SIGNATURES.wrong_event.haptic.rich)).toBe(
      "impact:heavy",
    );
    expect(hapticFingerprint(FEEDBACK_SIGNATURES.rejected.haptic.rich)).toBe(
      "notification:error",
    );
  });

  it("keeps already_scanned and wrong_event distinct even when degraded", () => {
    // Three notification types cannot express four signatures, so exactly one
    // collision is expected in fallback mode — and it must NOT be the pair
    // this FR exists to separate.
    expect(
      FEEDBACK_SIGNATURES.already_scanned.haptic.fallbackNotification,
    ).toBe("warning");
    expect(FEEDBACK_SIGNATURES.wrong_event.haptic.fallbackNotification).toBe(
      "error",
    );
    expect(
      FEEDBACK_SIGNATURES.already_scanned.haptic.fallbackNotification,
    ).not.toBe(FEEDBACK_SIGNATURES.wrong_event.haptic.fallbackNotification);
    expect(FEEDBACK_SIGNATURES.valid.haptic.fallbackNotification).toBe(
      "success",
    );
  });

  it("degrades only to the three expo-haptics notification types", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(["success", "warning", "error"]).toContain(
        FEEDBACK_SIGNATURES[kind].haptic.fallbackNotification,
      );
    }
  });

  it("never emits a zero-length rich pattern", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(FEEDBACK_SIGNATURES[kind].haptic.rich.length).toBeGreaterThan(0);
    }
  });

  it("looks signatures up by kind", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(feedbackSignature(kind).kind).toBe(kind);
    }
  });
});

describe("feedbackKindForOutcome", () => {
  const cases: Array<
    [Parameters<typeof feedbackKindForOutcome>[0], FeedbackKind]
  > = [
    [{ kind: "volunteer" }, "valid"],
    [{ kind: "ticket", status: "VALID" }, "valid"],
    [{ kind: "ticket", status: "SCANNED" }, "already_scanned"],
    [{ kind: "ticket", status: "INVALID" }, "rejected"],
    [{ kind: "ticket", status: "REFUNDED" }, "rejected"],
    [{ kind: "ticket", status: "LISTED" }, "rejected"],
    [{ kind: "ticket", status: "VOID" }, "rejected"],
    [{ kind: "wrong_event" }, "wrong_event"],
    [{ kind: "unknown" }, "rejected"],
    [{ kind: "offline_unverifiable" }, "rejected"],
    // REDIRECT family, so the REDIRECT signature — the screen says
    // "NEEDS SIGNAL" on the `redirect` fill, and a `rejected` buzz would tell
    // the operator "do not admit" while the pixels said "reconnect".
    [{ kind: "volunteer_needs_connection" }, "wrong_event"],
  ];

  it.each(cases)("maps %j to %s", (outcome, expected) => {
    expect(feedbackKindForOutcome(outcome)).toBe(expected);
  });

  it("fails closed on an unrecognised ticket status", () => {
    // A status the client has never heard of must never sound like an admit.
    expect(
      feedbackKindForOutcome({ kind: "ticket", status: "TRANSFERRED" }),
    ).toBe("rejected");
    expect(feedbackKindForOutcome({ kind: "ticket", status: "valid" })).toBe(
      "rejected",
    );
    expect(feedbackKindForOutcome({ kind: "ticket", status: "" })).toBe(
      "rejected",
    );
  });
});
