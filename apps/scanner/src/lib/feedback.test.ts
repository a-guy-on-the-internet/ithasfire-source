import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `./feedback-tones` `require()`s `.wav` files — a Metro-only transform — so
 * it is mocked; the native channels are swapped through the module's own test
 * seam because `vi.mock` does not reach the lazy `require("expo-*")` calls
 * inside `feedback.ts` / `haptics.ts` (probed, not assumed).
 */
vi.mock("./feedback-tones", () => ({
  TONE_ASSETS: { valid: 1, already_scanned: 2, wrong_event: 3, rejected: 4 },
}));
const captureException = vi.fn();
vi.mock("@sentry/react-native", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
  addBreadcrumb: vi.fn(),
}));

import { FEEDBACK_SIGNATURES } from "./feedback-signatures";
import {
  __setFeedbackChannelsForTests,
  setFeedbackPrefs,
  triggerFeedback,
} from "./feedback";

const playTone = vi.fn(async () => {});
const playHaptic = vi.fn(async () => {});

beforeEach(() => {
  playTone.mockClear();
  playHaptic.mockClear();
  captureException.mockClear();
  __setFeedbackChannelsForTests({ playTone, playHaptic });
});
afterEach(() => {
  __setFeedbackChannelsForTests(null);
  setFeedbackPrefs({ soundEnabled: true, hapticsEnabled: true });
});

describe("triggerFeedback", () => {
  it("fires the verdict's tone and haptic when enabled", async () => {
    setFeedbackPrefs({ soundEnabled: true, hapticsEnabled: true });
    await triggerFeedback("rejected");
    expect(playTone).toHaveBeenCalledWith("rejected");
    expect(playHaptic).toHaveBeenCalledWith(FEEDBACK_SIGNATURES.rejected.haptic);
  });

  it("disabled ⇒ nothing fires", async () => {
    setFeedbackPrefs({ soundEnabled: false, hapticsEnabled: false });
    await triggerFeedback("valid");
    await triggerFeedback("rejected");
    expect(playTone).not.toHaveBeenCalled();
    expect(playHaptic).not.toHaveBeenCalled();
  });

  it("a throwing haptic channel is swallowed AND reported", async () => {
    setFeedbackPrefs({ soundEnabled: false, hapticsEnabled: true });
    const boom = new Error("motor");
    playHaptic.mockRejectedValueOnce(boom);
    await expect(triggerFeedback("valid")).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[0]).toBe(boom);
    expect(captureException.mock.calls[0]?.[1]).toMatchObject({
      tags: { feature: "scan", branch: "feedback_haptic_play" },
    });
  });

  it("a throwing reporter cannot reach the scan flow", async () => {
    setFeedbackPrefs({ soundEnabled: false, hapticsEnabled: true });
    playHaptic.mockRejectedValueOnce(new Error("motor"));
    captureException.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    await expect(triggerFeedback("valid")).resolves.toBeUndefined();
  });
});
