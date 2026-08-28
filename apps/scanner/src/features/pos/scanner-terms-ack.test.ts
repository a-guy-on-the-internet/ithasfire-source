import { describe, expect, it } from "vitest";

import { SCANNER_TERMS_TEXT, SCANNER_TERMS_VERSION } from "@th/types";

import { needsScannerTermsAck } from "./scanner-terms-ack";

describe("needsScannerTermsAck", () => {
  it("fails closed when the operator state is missing entirely", () => {
    expect(needsScannerTermsAck(null)).toBe(true);
    expect(needsScannerTermsAck(undefined)).toBe(true);
    expect(needsScannerTermsAck({})).toBe(true);
  });

  it("requires ack when ackAt is null even if the version matches", () => {
    expect(
      needsScannerTermsAck({
        scannerTermsAckAt: null,
        scannerTermsAckVersion: SCANNER_TERMS_VERSION,
      }),
    ).toBe(true);
  });

  it("passes with a current-version ack (Date or serialized string)", () => {
    expect(
      needsScannerTermsAck({
        scannerTermsAckAt: new Date("2026-06-01T12:00:00Z"),
        scannerTermsAckVersion: SCANNER_TERMS_VERSION,
      }),
    ).toBe(false);
    expect(
      needsScannerTermsAck({
        scannerTermsAckAt: "2026-06-01T12:00:00.000Z",
        scannerTermsAckVersion: SCANNER_TERMS_VERSION,
      }),
    ).toBe(false);
  });

  it("re-prompts when the stored version is stale (version bump)", () => {
    // A synthetic stale value rather than a literal old version: hardcoding
    // "1" vs "2" meant this test silently stopped being a BUMP test the day
    // the live constant became "2" — it was then just asserting the current
    // pair. This shape stays a bump test through every future bump.
    expect(
      needsScannerTermsAck(
        {
          scannerTermsAckAt: new Date("2026-06-01T12:00:00Z"),
          scannerTermsAckVersion: "__superseded__",
        },
        SCANNER_TERMS_VERSION,
      ),
    ).toBe(true);
  });

  it("current SCANNER_TERMS_VERSION has copy to render", () => {
    // Guards against bumping the version constant without adding the
    // matching entry — the modal would have nothing to show.
    const terms = SCANNER_TERMS_TEXT[SCANNER_TERMS_VERSION];
    expect(terms).toBeDefined();
    expect(terms?.title.length).toBeGreaterThan(0);
    expect(terms?.bullets.length).toBeGreaterThan(0);
    expect(terms?.confirmLabel.length).toBeGreaterThan(0);
  });
});
