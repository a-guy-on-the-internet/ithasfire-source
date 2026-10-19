import { hkdfSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LOCATION_OBFUSCATION_KEY_LABEL } from "../../location/obfuscation-key";
import {
  deriveOpenCallStatusTokenSecret,
  OPEN_CALL_STATUS_TOKEN_KEY_LABEL,
} from "../open-call-status-token-key";
import { INVITE_TOKEN_KEY_LABEL } from "../invite-token";

const ROOT = "unsubscribe-root-secret-for-tests-0123456789abcdef";

describe("deriveOpenCallStatusTokenSecret", () => {
  it("is deterministic for the same root, 43 base64url chars", () => {
    const a = deriveOpenCallStatusTokenSecret(ROOT);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveOpenCallStatusTokenSecret(ROOT)).toBe(a);
  });

  it("a different root gives a different key", () => {
    expect(deriveOpenCallStatusTokenSecret(`${ROOT}x`)).not.toBe(deriveOpenCallStatusTokenSecret(ROOT));
  });

  it("never equals the root itself, the unsubscribe HMAC key, or the obfuscation / invite keys from the same root", () => {
    const key = deriveOpenCallStatusTokenSecret(ROOT)!;
    const other = (label: string) =>
      Buffer.from(hkdfSync("sha256", ROOT, Buffer.alloc(0), label, 32)).toString("base64url");
    expect(key).not.toBe(ROOT);
    expect(OPEN_CALL_STATUS_TOKEN_KEY_LABEL).not.toBe(LOCATION_OBFUSCATION_KEY_LABEL);
    expect(key).not.toBe(other(LOCATION_OBFUSCATION_KEY_LABEL));
    expect(key).not.toBe(other(INVITE_TOKEN_KEY_LABEL));
  });

  it("a missing or short root gives null (callers answer NOT_CONFIGURED)", () => {
    expect(deriveOpenCallStatusTokenSecret(undefined)).toBeNull();
    expect(deriveOpenCallStatusTokenSecret(null)).toBeNull();
    expect(deriveOpenCallStatusTokenSecret("short")).toBeNull();
  });
});
