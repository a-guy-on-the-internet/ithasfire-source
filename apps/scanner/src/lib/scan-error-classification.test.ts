import { describe, expect, it } from "vitest";

import { offlineFallbackTrigger } from "./offline-resolve";
import {
  classifyScanError,
  isNetworkScanError,
} from "./scan-error-classification";

describe("classifyScanError", () => {
  it("treats a rejection with no tRPC envelope as a network failure", () => {
    expect(classifyScanError(new TypeError("Network request failed"))).toBe(
      "network",
    );
    expect(classifyScanError(null)).toBe("network");
    expect(classifyScanError(undefined)).toBe("network");
    expect(classifyScanError({ data: {} })).toBe("network");
  });

  it.each([
    "BAD_REQUEST",
    "NOT_FOUND",
    "FORBIDDEN",
    "METHOD_NOT_SUPPORTED",
    "PRECONDITION_FAILED",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "UNPROCESSABLE_CONTENT",
    "CONFLICT",
    "PARSE_ERROR",
  ])("classifies %s as permanent", (code) => {
    expect(classifyScanError({ data: { code } })).toBe("permanent");
  });

  it.each(["INTERNAL_SERVER_ERROR", "TIMEOUT", "UNAUTHORIZED", "WAT"])(
    "classifies %s as transient",
    (code) => {
      expect(classifyScanError({ data: { code } })).toBe("transient");
    },
  );

  it("exposes a network predicate", () => {
    expect(isNetworkScanError(new Error("boom"))).toBe(true);
    expect(isNetworkScanError({ data: { code: "FORBIDDEN" } })).toBe(false);
  });
});

describe("offlineFallbackTrigger", () => {
  it("goes local whenever the device is offline", () => {
    expect(offlineFallbackTrigger({ network: "offline" })).toBe(
      "device_offline",
    );
  });

  it("goes local when a server resolve failed with a network error", () => {
    expect(
      offlineFallbackTrigger({
        network: "online",
        error: new TypeError("Network request failed"),
      }),
    ).toBe("resolver_network_error");
  });

  it("stays on the server for permanent and transient failures", () => {
    // A FORBIDDEN means the operator lost access — the manifest must not be
    // used to answer around that.
    expect(
      offlineFallbackTrigger({
        network: "online",
        error: { data: { code: "FORBIDDEN" } },
      }),
    ).toBeNull();
    expect(
      offlineFallbackTrigger({
        network: "online",
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      }),
    ).toBeNull();
  });

  it("does not pre-emptively degrade on a merely degraded link", () => {
    expect(offlineFallbackTrigger({ network: "degraded" })).toBeNull();
  });

  it("returns null when the server path has not been tried and we are online", () => {
    expect(offlineFallbackTrigger({ network: "online" })).toBeNull();
  });
});
