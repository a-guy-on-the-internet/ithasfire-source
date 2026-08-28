import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-004 / NFR-005 — the express-mode preference's failure modes.
 *
 * Only one of these is about "does JSON round-trip". The rest are about a
 * preference whose OFF state is a safety property: an operator who never opted
 * in must never end up in a mode that admits people with no gesture, whatever
 * the stored payload looks like — an old build's payload, a truncated write, a
 * SecureStore read that throws.
 */

const getItemAsync = vi.fn();
const setItemAsync = vi.fn();
vi.mock("expo-secure-store", () => ({
  getItemAsync: (...a: unknown[]) => getItemAsync(...a) as unknown,
  setItemAsync: (...a: unknown[]) => setItemAsync(...a) as unknown,
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
}));

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { loadScannerPreferences, saveScannerPreferences } from "./storage";

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset();
});

describe("loadScannerPreferences — express mode", () => {
  it("defaults OFF when there is no stored payload at all", async () => {
    getItemAsync.mockResolvedValue(null);
    await expect(loadScannerPreferences()).resolves.toMatchObject({
      expressModeEnabled: false,
    });
  });

  it("reads an OLD payload (no such key) without losing the other fields", async () => {
    // The exact shape a build predating FR-004 wrote.
    getItemAsync.mockResolvedValue(
      JSON.stringify({
        eventId: "evt_1",
        soundEnabled: false,
        hapticsEnabled: true,
        passkeyPromptDismissed: true,
      }),
    );
    await expect(loadScannerPreferences()).resolves.toEqual({
      eventId: "evt_1",
      soundEnabled: false,
      hapticsEnabled: true,
      passkeyPromptDismissed: true,
      expressModeEnabled: false,
    });
  });

  it("honours an explicit true", async () => {
    getItemAsync.mockResolvedValue(
      JSON.stringify({ expressModeEnabled: true }),
    );
    await expect(loadScannerPreferences()).resolves.toMatchObject({
      expressModeEnabled: true,
    });
  });

  it("treats anything that is not literally `true` as OFF", async () => {
    // `"true"`, `1` and `{}` are all truthy. For a preference that admits
    // people with zero taps, truthy is not good enough.
    for (const value of ["true", 1, {}, [], "yes", null]) {
      getItemAsync.mockResolvedValue(
        JSON.stringify({ expressModeEnabled: value }),
      );
      await expect(loadScannerPreferences()).resolves.toMatchObject({
        expressModeEnabled: false,
      });
    }
  });

  it("falls back to OFF when the stored payload is corrupt", async () => {
    getItemAsync.mockResolvedValue("{not json");
    await expect(loadScannerPreferences()).resolves.toMatchObject({
      expressModeEnabled: false,
    });
  });

  it("falls back to OFF when SecureStore itself throws", async () => {
    getItemAsync.mockRejectedValue(new Error("keychain unavailable"));
    await expect(loadScannerPreferences()).resolves.toMatchObject({
      expressModeEnabled: false,
    });
  });
});

describe("saveScannerPreferences", () => {
  it("round-trips the flag", async () => {
    setItemAsync.mockResolvedValue(undefined);
    await saveScannerPreferences({
      eventId: "evt_1",
      soundEnabled: true,
      hapticsEnabled: true,
      passkeyPromptDismissed: false,
      expressModeEnabled: true,
    });
    const [, payload] = setItemAsync.mock.calls[0] as [string, string];
    expect(JSON.parse(payload)).toMatchObject({ expressModeEnabled: true });
  });
});
