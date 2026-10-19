/**
 * FR-013 — a raw server identifier must never become a door operator's
 * instructions.
 *
 * The live defect: an operator at a door was shown
 *
 *     SCAN FAILED / ERROR
 *     volunteer_scan_token_not_configured
 *
 * as the guidance under a full-bleed red verdict. The property asserted below
 * is structural, not a list of known codes: whatever the server says, it lands
 * in `detail` and the guidance comes from the classified copy table. A test
 * that only checked the one code we saw would pass on the next one.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_FAILURE_DETAIL_LENGTH,
  SCAN_FAILURE_COPY,
  describeScanFailure,
} from "../scan-failure-copy";

const trpcError = (code: string, message: string) =>
  Object.assign(new Error(message), { data: { code } });

const GUIDANCES = Object.values(SCAN_FAILURE_COPY).map((c) => c.guidance);

describe("describeScanFailure — guidance is never the server's words", () => {
  it.each([
    ["the exact live defect", trpcError("INTERNAL_SERVER_ERROR", "volunteer_scan_token_not_configured")],
    ["a bare domain code", new Error("volunteer_scan_token_not_configured")],
    ["a snake_case code with no error wrapper", "ticket_repo_unavailable"],
    ["an appCode on the wire envelope", { data: { appCode: "scan_token_missing" } }],
    ["a stack-ish multi-line message", new Error("boom\n  at foo (bar.ts:1:1)")],
    ["nothing useful at all", {}],
  ])("%s never reaches the guidance line", (_label, err) => {
    const failure = describeScanFailure(err);
    expect(GUIDANCES).toContain(failure.guidance);
    // Belt and braces: the guidance is one of ours AND contains no identifier.
    expect(failure.guidance).not.toMatch(/_/);
  });

  it("keeps the identifier as a support detail", () => {
    const failure = describeScanFailure(
      trpcError("INTERNAL_SERVER_ERROR", "volunteer_scan_token_not_configured"),
    );
    expect(failure.detail).toContain("volunteer_scan_token_not_configured");
    expect(failure.detail).toContain("INTERNAL_SERVER_ERROR");
  });

  it("prefers the domain appCode over the transport code", () => {
    const err = Object.assign(new Error("nope"), {
      data: { code: "BAD_REQUEST", appCode: "scan_token_missing" },
    });
    expect(describeScanFailure(err).detail).toBe("scan_token_missing · nope");
  });

  it("collapses whitespace and caps the length so it cannot push the verdict off screen", () => {
    const failure = describeScanFailure(new Error(`x${"y".repeat(400)}`));
    expect(failure.detail!.length).toBeLessThanOrEqual(
      MAX_FAILURE_DETAIL_LENGTH,
    );
    expect(describeScanFailure(new Error("a\n  b\tc")).detail).toBe("a b c");
  });

  it("has no detail when there is genuinely nothing to quote", () => {
    expect(describeScanFailure({}).detail).toBeNull();
    expect(describeScanFailure(new Error("   ")).detail).toBeNull();
  });
});

describe("describeScanFailure — classification", () => {
  it("believes the device over the fetch layer when the radio is off", () => {
    // The single most likely failure at a door.
    const failure = describeScanFailure(
      trpcError("INTERNAL_SERVER_ERROR", "boom"),
      { online: false },
    );
    expect(failure.kind).toBe("offline");
  });

  it.each([
    ["UNAUTHORIZED", "permission"],
    ["FORBIDDEN", "permission"],
    ["TIMEOUT", "timeout"],
    ["CLIENT_CLOSED_REQUEST", "timeout"],
    ["INTERNAL_SERVER_ERROR", "server"],
    ["BAD_REQUEST", "server"],
    ["NOT_FOUND", "server"],
  ])("%s → %s", (code, kind) => {
    expect(describeScanFailure(trpcError(code, "x")).kind).toBe(kind);
  });

  it.each([
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "Network request failed",
    "Load failed",
    "fetch failed",
  ])("recognises %s as offline", (message) => {
    expect(describeScanFailure(new Error(message)).kind).toBe("offline");
  });

  it("treats a bare TypeError as a transport failure, which is all fetch tells us", () => {
    expect(describeScanFailure(new TypeError("cors or something")).kind).toBe(
      "offline",
    );
  });

  it("falls back to the generic class rather than guessing", () => {
    expect(describeScanFailure(new Error("weird")).kind).toBe("unknown");
  });

  it("routes permission failures to copy an operator can act on", () => {
    const failure = describeScanFailure(trpcError("FORBIDDEN", "forbidden"));
    expect(failure.guidance).toMatch(/organizer/i);
    // Not "try again" — retrying a 403 forever is the wrong instruction.
    expect(failure.guidance).not.toMatch(/try the scan again/i);
  });

  it("every class points at an action the operator actually has", () => {
    for (const [kind, copy] of Object.entries(SCAN_FAILURE_COPY)) {
      expect(copy.guidance, `${kind} has no action`).toMatch(
        /try|search|ask|dismiss/i,
      );
      expect(copy.key, `${kind} has no message key`).toMatch(/^scan\.failure\./);
    }
  });
});
