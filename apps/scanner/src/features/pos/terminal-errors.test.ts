import { describe, expect, it } from "vitest";

import {
  READER_CANCELLED_MESSAGE,
  READER_STOPPED_MAYBE_CHARGED_MESSAGE,
  READER_STOPPED_MESSAGE,
  READER_UNAVAILABLE_MESSAGE,
  TERMINAL_ALREADY_CONNECTED,
  TERMINAL_CANCELED,
  TERMINAL_NO_RETRY_CODES,
  describeTerminalFailure,
  isConnectedReader,
  readerSettingMessage,
} from "./terminal-errors";

describe("describeTerminalFailure", () => {
  it("says a reader cancel before confirm left the card uncharged, without a report", () => {
    expect(
      describeTerminalFailure({ code: TERMINAL_CANCELED }, "before-confirm", "collect"),
    ).toEqual({ message: READER_CANCELLED_MESSAGE, code: null, report: false });
  });

  it("maps any other SDK error before confirm to the stop copy, with its code", () => {
    expect(
      describeTerminalFailure(
        { code: TERMINAL_ALREADY_CONNECTED },
        "before-confirm",
        "connect",
      ),
    ).toEqual({
      message: READER_STOPPED_MESSAGE,
      code: TERMINAL_ALREADY_CONNECTED,
      report: true,
    });
    expect(describeTerminalFailure(undefined, "before-confirm", "collect")).toEqual({
      message: READER_STOPPED_MESSAGE,
      code: null,
      report: true,
    });
  });

  it("treats CANCELED outside collect as a stop, reported, not the reader's X", () => {
    // iOS: a dismissed Tap to Pay terms sheet at connect comes back CANCELED.
    expect(
      describeTerminalFailure({ code: TERMINAL_CANCELED }, "before-confirm", "connect"),
    ).toEqual({
      message: READER_STOPPED_MESSAGE,
      code: TERMINAL_CANCELED,
      report: true,
    });
  });

  it("offers a retry for UNSUPPORTED_OPERATION (iOS uses it for passing states)", () => {
    expect(TERMINAL_NO_RETRY_CODES.has("UNSUPPORTED_OPERATION")).toBe(false);
    expect(
      describeTerminalFailure(
        { code: "UNSUPPORTED_OPERATION" },
        "before-confirm",
        "collect",
      ),
    ).toEqual({
      message: READER_STOPPED_MESSAGE,
      code: "UNSUPPORTED_OPERATION",
      report: true,
    });
  });

  it("never offers a retry for a device, build or account problem", () => {
    for (const code of [
      "TAP_TO_PAY_DEBUG_NOT_SUPPORTED",
      "TAP_TO_PAY_INSECURE_ENVIRONMENT",
      "TAP_TO_PAY_UNSUPPORTED_DEVICE",
      "FEATURE_NOT_ENABLED_ON_ACCOUNT",
      "INVALID_REQUIRED_PARAMETER",
    ]) {
      expect(TERMINAL_NO_RETRY_CODES.has(code)).toBe(true);
      const failure = describeTerminalFailure({ code }, "before-confirm", "collect");
      expect(failure).toEqual({
        message: READER_UNAVAILABLE_MESSAGE,
        code,
        report: true,
      });
      expect(failure.message).not.toMatch(/try again/i);
    }
  });

  it("names the phone setting to turn on for NFC and Location", () => {
    expect(
      describeTerminalFailure({ code: "TAP_TO_PAY_NFC_DISABLED" }, "before-confirm", "collect"),
    ).toEqual({
      message: readerSettingMessage("NFC"),
      code: "TAP_TO_PAY_NFC_DISABLED",
      report: true,
    });
    expect(
      describeTerminalFailure(
        { code: "LOCATION_SERVICES_DISABLED" },
        "before-confirm",
        "discover",
      ).message,
    ).toBe(readerSettingMessage("Location"));
  });

  it("never claims the card was not charged from confirm onward, whatever the code", () => {
    for (const code of [
      TERMINAL_CANCELED,
      "TAP_TO_PAY_DEBUG_NOT_SUPPORTED",
      "TAP_TO_PAY_NFC_DISABLED",
      "SOMETHING_ELSE",
      undefined,
    ]) {
      const failure = describeTerminalFailure({ code }, "confirm-or-later", "confirm");
      expect(failure.message).toBe(READER_STOPPED_MAYBE_CHARGED_MESSAGE);
      expect(failure.message).not.toMatch(
        /wasn't charged|before the card was charged|(and|or) take cash/,
      );
      expect(failure.report).toBe(true);
    }
  });
});

describe("isConnectedReader", () => {
  it("is true for a reader object", () => {
    expect(isConnectedReader({ serialNumber: "abc", label: "x" })).toBe(true);
  });
  it("is false for null, an error, or an empty answer", () => {
    expect(isConnectedReader(null)).toBe(false);
    expect(isConnectedReader(undefined)).toBe(false);
    expect(isConnectedReader({})).toBe(false);
    expect(isConnectedReader({ error: { code: "X" } })).toBe(false);
  });
});
