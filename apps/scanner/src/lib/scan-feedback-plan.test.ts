import { describe, expect, it } from "vitest";

import { FEEDBACK_KINDS, FEEDBACK_SIGNATURES } from "./feedback-signatures";
import {
  applyScanFeedbackToggle,
  planFeedback,
  scanFeedbackEnabled,
} from "./scan-feedback-plan";

const ON = { soundEnabled: true, hapticsEnabled: true };
const OFF = { soundEnabled: false, hapticsEnabled: false };

describe("planFeedback", () => {
  it("maps every verdict class to its own tone and haptic when enabled", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(planFeedback(kind, ON)).toEqual({
        tone: FEEDBACK_SIGNATURES[kind].tone,
        haptic: FEEDBACK_SIGNATURES[kind].haptic,
      });
    }
  });

  it("admit is a success pulse; stop is an error pulse; already-in is a double pulse", () => {
    expect(planFeedback("valid", ON).haptic?.fallbackNotification).toBe(
      "success",
    );
    expect(planFeedback("rejected", ON).haptic?.fallbackNotification).toBe(
      "error",
    );
    expect(
      planFeedback("already_scanned", ON).haptic?.rich.filter(
        (s) => s.type === "impact",
      ),
    ).toHaveLength(2);
    expect(
      planFeedback("already_scanned", ON).haptic?.fallbackNotification,
    ).toBe("warning");
  });

  it("disabled ⇒ nothing fires, for every verdict class", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(planFeedback(kind, OFF)).toEqual({ tone: null, haptic: null });
    }
  });

  it("gates each channel independently", () => {
    expect(
      planFeedback("valid", { soundEnabled: true, hapticsEnabled: false }),
    ).toEqual({ tone: "valid", haptic: null });
    expect(
      planFeedback("valid", { soundEnabled: false, hapticsEnabled: true }),
    ).toEqual({ tone: null, haptic: FEEDBACK_SIGNATURES.valid.haptic });
  });
});

describe("the on-page Sound & haptics switch", () => {
  it("reads ON when either channel would fire", () => {
    expect(scanFeedbackEnabled(ON)).toBe(true);
    expect(
      scanFeedbackEnabled({ soundEnabled: true, hapticsEnabled: false }),
    ).toBe(true);
    expect(
      scanFeedbackEnabled({ soundEnabled: false, hapticsEnabled: true }),
    ).toBe(true);
    expect(scanFeedbackEnabled(OFF)).toBe(false);
  });

  it("flipping OFF silences both channels; flipping ON restores both", () => {
    const full = { ...ON, eventId: "e1", expressModeEnabled: true };
    const off = applyScanFeedbackToggle(full, false);
    expect(off).toEqual({ ...full, ...OFF });
    expect(scanFeedbackEnabled(off)).toBe(false);
    // Half-state ("sound only") comes back as BOTH on — see module doc.
    const half = { ...full, soundEnabled: true, hapticsEnabled: false };
    expect(applyScanFeedbackToggle(half, true)).toEqual({ ...full, ...ON });
  });

  it("does not mutate its input and leaves unrelated keys alone", () => {
    const full = { ...ON, eventId: "e1", expressModeEnabled: true };
    const next = applyScanFeedbackToggle(full, false);
    expect(full).toEqual({ ...ON, eventId: "e1", expressModeEnabled: true });
    expect(next.eventId).toBe("e1");
    expect(next.expressModeEnabled).toBe(true);
  });
});
