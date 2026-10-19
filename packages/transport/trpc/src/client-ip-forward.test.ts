import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CLIENT_IP_FORWARD_HEADER,
  CLIENT_IP_FORWARD_SIG_HEADER,
  CLIENT_IP_FORWARD_TS_HEADER,
  checkClientIpForward,
  describeClientIp,
  resolveClientIp,
  signClientIpForward,
  transitedEdge,
  verifyClientIpForward,
} from "./client-ip";

/**
 * The web → API signed client-IP forward (`x-th-client-ip*`).
 *
 * The web app and the API deploy separately, so the wire format is pinned by
 * a FIXED VECTOR below (also asserted in
 * apps/web/src/server/__tests__/client-ip-forward.test.ts). The expected
 * signature was computed straight from the documented formula with raw
 * node:crypto, not from `signClientIpForward`, so a change to the key label,
 * message layout or encoding fails here instead of silently splitting the two
 * services.
 */

const SECRET = "test-origin-shared-secret-0123456789abcdef";
const NOW = 1_790_000_000;

const CLIENT_IP_FORWARD_VECTOR = {
  secret: SECRET,
  ip: "203.0.113.7",
  ts: NOW,
  sig: "snJ9EpzW7oaa8hpAtMKBXNKpbC4A_eV0G-pui0h5SuU",
} as const;

const signed = (ip = "203.0.113.7", nowSeconds = NOW, secret = SECRET) =>
  signClientIpForward({ ip, secret, nowSeconds });

describe("signClientIpForward", () => {
  it("matches the fixed wire-format vector", () => {
    expect(signed()).toEqual({
      [CLIENT_IP_FORWARD_HEADER]: "203.0.113.7",
      [CLIENT_IP_FORWARD_TS_HEADER]: String(NOW),
      [CLIENT_IP_FORWARD_SIG_HEADER]: CLIENT_IP_FORWARD_VECTOR.sig,
    });
    expect(signed("2001:db8::1")[CLIENT_IP_FORWARD_SIG_HEADER]).toBe(
      "ZNMMhrID02H2QqKEiSn7PSbVdDDkyG2XPpLFg6JVsQs",
    );
  });

  it("floors a fractional clock to whole seconds", () => {
    expect(signed("203.0.113.7", NOW + 0.9)[CLIENT_IP_FORWARD_TS_HEADER]).toBe(
      String(NOW),
    );
  });

  it("signs nothing without a secret or a real IP", () => {
    expect(signed("203.0.113.7", NOW, "")).toEqual({});
    expect(signed("203.0.113.7", NOW, "   ")).toEqual({});
    expect(
      signClientIpForward({ ip: "203.0.113.7", secret: null, nowSeconds: NOW }),
    ).toEqual({});
    expect(signed("not-an-ip")).toEqual({});
    expect(signed("")).toEqual({});
  });

  it("derives the same key from a secret with surrounding whitespace", () => {
    // Cloudflare stamps the TRIMMED secret; both sides trim before deriving.
    expect(signed("203.0.113.7", NOW, `  ${SECRET}\n`)).toEqual(signed());
  });
});

describe("verifyClientIpForward", () => {
  it("returns the IP for a valid signed forward", () => {
    expect(verifyClientIpForward(signed(), SECRET, NOW)).toBe("203.0.113.7");
    expect(
      verifyClientIpForward(signed("2001:db8::1"), SECRET, NOW),
    ).toBe("2001:db8::1");
  });

  it("reads header names case-insensitively", () => {
    const upper = Object.fromEntries(
      Object.entries(signed()).map(([k, v]) => [k.toUpperCase(), v]),
    );
    expect(verifyClientIpForward(upper, SECRET, NOW)).toBe("203.0.113.7");
  });

  it("accepts a timestamp exactly at the ±60s edge and rejects beyond it", () => {
    expect(verifyClientIpForward(signed(), SECRET, NOW + 60)).toBe(
      "203.0.113.7",
    );
    expect(verifyClientIpForward(signed(), SECRET, NOW - 60)).toBe(
      "203.0.113.7",
    );
    expect(verifyClientIpForward(signed(), SECRET, NOW + 61)).toBeNull();
    expect(verifyClientIpForward(signed(), SECRET, NOW - 61)).toBeNull();
  });

  it("ignores a bad signature", () => {
    const headers = signed();
    const sig = headers[CLIENT_IP_FORWARD_SIG_HEADER]!;
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(
      verifyClientIpForward(
        { ...headers, [CLIENT_IP_FORWARD_SIG_HEADER]: flipped },
        SECRET,
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores a signature minted for a different IP", () => {
    const forOther = signed("198.51.100.9");
    expect(
      verifyClientIpForward(
        { ...forOther, [CLIENT_IP_FORWARD_HEADER]: "203.0.113.7" },
        SECRET,
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores a signature minted under a different secret", () => {
    expect(
      verifyClientIpForward(
        signed("203.0.113.7", NOW, "some-other-secret"),
        SECRET,
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores a re-dated timestamp (the ts is inside the MAC)", () => {
    expect(
      verifyClientIpForward(
        { ...signed(), [CLIENT_IP_FORWARD_TS_HEADER]: String(NOW + 1) },
        SECRET,
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores everything when no secret is configured", () => {
    expect(verifyClientIpForward(signed(), null, NOW)).toBeNull();
    expect(verifyClientIpForward(signed(), undefined, NOW)).toBeNull();
    expect(verifyClientIpForward(signed(), "", NOW)).toBeNull();
    expect(verifyClientIpForward(signed(), "   ", NOW)).toBeNull();
  });

  it("ignores array-valued (repeated) headers", () => {
    const headers = signed();
    for (const name of [
      CLIENT_IP_FORWARD_HEADER,
      CLIENT_IP_FORWARD_TS_HEADER,
      CLIENT_IP_FORWARD_SIG_HEADER,
    ]) {
      expect(
        verifyClientIpForward(
          { ...headers, [name]: [headers[name], headers[name]] },
          SECRET,
          NOW,
        ),
      ).toBeNull();
      expect(
        verifyClientIpForward({ ...headers, [name]: [headers[name]] }, SECRET, NOW),
      ).toBeNull();
    }
  });

  it("ignores a missing header", () => {
    for (const name of [
      CLIENT_IP_FORWARD_HEADER,
      CLIENT_IP_FORWARD_TS_HEADER,
      CLIENT_IP_FORWARD_SIG_HEADER,
    ]) {
      const headers: Record<string, string> = { ...signed() };
      delete headers[name];
      expect(verifyClientIpForward(headers, SECRET, NOW)).toBeNull();
    }
  });

  it("ignores a non-IP value even when it carries a valid MAC", () => {
    // Build a correctly-MACed forward for a non-IP by hand: the verifier must
    // still refuse it, so a signer bug can never inject junk into bucket keys.
    const key = createHmac("sha256", SECRET)
      .update("th-client-ip-forward:v1")
      .digest();
    for (const ip of ["not-an-ip", "203.0.113.7, 10.0.0.1", "x".repeat(65)]) {
      const sig = createHmac("sha256", key)
        .update(`th-client-ip:v1\n${ip}\n${NOW}`)
        .digest("base64url");
      expect(
        verifyClientIpForward(
          {
            [CLIENT_IP_FORWARD_HEADER]: ip,
            [CLIENT_IP_FORWARD_TS_HEADER]: String(NOW),
            [CLIENT_IP_FORWARD_SIG_HEADER]: sig,
          },
          SECRET,
          NOW,
        ),
      ).toBeNull();
    }
  });

  it("ignores a non-integer timestamp", () => {
    for (const ts of ["", "abc", "1790000000.5", "-1790000000", "1e9", " 1790000000"]) {
      expect(
        verifyClientIpForward(
          { ...signed(), [CLIENT_IP_FORWARD_TS_HEADER]: ts },
          SECRET,
          NOW,
        ),
      ).toBeNull();
    }
  });

  it("returns null (never throws) on a length-mismatched signature", () => {
    for (const sig of ["", "short", `${signed()[CLIENT_IP_FORWARD_SIG_HEADER]}x`, "ü".repeat(43)]) {
      expect(() =>
        verifyClientIpForward(
          { ...signed(), [CLIENT_IP_FORWARD_SIG_HEADER]: sig },
          SECRET,
          NOW,
        ),
      ).not.toThrow();
      expect(
        verifyClientIpForward(
          { ...signed(), [CLIENT_IP_FORWARD_SIG_HEADER]: sig },
          SECRET,
          NOW,
        ),
      ).toBeNull();
    }
  });

  it("returns null for null/garbage header containers", () => {
    expect(verifyClientIpForward(null, SECRET, NOW)).toBeNull();
    expect(verifyClientIpForward(undefined, SECRET, NOW)).toBeNull();
    expect(verifyClientIpForward(signed(), SECRET, Number.NaN)).toBeNull();
  });
});

describe("resolveClientIp is unchanged by the forward headers", () => {
  it("does not read x-th-client-ip (only the verifier does)", () => {
    expect(
      resolveClientIp(
        { ...signed("198.51.100.9"), "cf-connecting-ip": "203.0.113.50" },
        "10.0.0.1",
      ),
    ).toBe("203.0.113.50");
  });
});

describe("verifyClientIpForward — timestamp spelling and repeated headers", () => {
  it("rejects a timestamp with leading zeros (one ts, one spelling)", () => {
    // Would otherwise parse to the same, correctly-signed number.
    for (const ts of [`0${NOW}`, `00${NOW}`]) {
      expect(
        verifyClientIpForward(
          { ...signed(), [CLIENT_IP_FORWARD_TS_HEADER]: ts },
          SECRET,
          NOW,
        ),
      ).toBeNull();
    }
    expect(verifyClientIpForward(signed(), SECRET, NOW)).toBe("203.0.113.7");
  });

  it("rejects a comma-joined repeated header (how Node delivers repeats)", () => {
    const a = signed("203.0.113.7");
    const b = signed("198.51.100.9");
    for (const name of [
      CLIENT_IP_FORWARD_HEADER,
      CLIENT_IP_FORWARD_TS_HEADER,
      CLIENT_IP_FORWARD_SIG_HEADER,
    ]) {
      const joined = { ...a, [name]: `${a[name]}, ${b[name]}` };
      expect(verifyClientIpForward(joined, SECRET, NOW)).toBeNull();
    }
  });
});

describe("checkClientIpForward — rejection reasons", () => {
  it("ok with the IP for a valid forward", () => {
    expect(checkClientIpForward(signed(), SECRET, NOW)).toEqual({
      ok: true,
      ip: "203.0.113.7",
    });
  });

  it("absent: none of the three headers", () => {
    expect(
      checkClientIpForward({ "cf-connecting-ip": "203.0.113.7" }, SECRET, NOW),
    ).toEqual({ ok: false, reason: "absent", complete: false });
    // Absent wins over no_secret: a normal request is never "misconfigured".
    expect(checkClientIpForward({}, null, NOW)).toMatchObject({
      reason: "absent",
    });
  });

  it("malformed (incomplete): only some of the headers", () => {
    expect(
      checkClientIpForward(
        { [CLIENT_IP_FORWARD_HEADER]: "203.0.113.7" },
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "malformed", complete: false });
  });

  it("malformed (complete): an array value, or a non-canonical timestamp", () => {
    const h = signed();
    expect(
      checkClientIpForward(
        { ...h, [CLIENT_IP_FORWARD_SIG_HEADER]: [h[CLIENT_IP_FORWARD_SIG_HEADER]] },
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "malformed", complete: true });
    expect(
      checkClientIpForward(
        { ...h, [CLIENT_IP_FORWARD_TS_HEADER]: `0${NOW}` },
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "malformed", complete: true });
  });

  it("no_secret: a complete forward this side cannot check", () => {
    expect(checkClientIpForward(signed(), "  ", NOW)).toEqual({
      ok: false,
      reason: "no_secret",
      complete: true,
    });
  });

  it("bad_ip: a non-IP value", () => {
    expect(
      checkClientIpForward(
        { ...signed(), [CLIENT_IP_FORWARD_HEADER]: "not-an-ip" },
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "bad_ip", complete: true });
  });

  it("stale: carries the skew so clock drift is diagnosable", () => {
    expect(checkClientIpForward(signed(), SECRET, NOW + 61)).toEqual({
      ok: false,
      reason: "stale",
      complete: true,
      skewSeconds: 61,
    });
    expect(checkClientIpForward(signed(), SECRET, NOW - 90)).toMatchObject({
      reason: "stale",
      skewSeconds: -90,
    });
  });

  it("bad_sig: wrong secret (e.g. rotated on one side)", () => {
    expect(
      checkClientIpForward(signed("203.0.113.7", NOW, "rotated-secret"), SECRET, NOW),
    ).toEqual({ ok: false, reason: "bad_sig", complete: true, skewSeconds: 0 });
  });
});

describe("transitedEdge", () => {
  it("true when cf-connecting-ip is present (any case, any value)", () => {
    expect(transitedEdge({ "cf-connecting-ip": "203.0.113.7" })).toBe(true);
    expect(transitedEdge({ "CF-Connecting-IP": "203.0.113.7" })).toBe(true);
    expect(transitedEdge({ "cf-connecting-ip": "" })).toBe(true);
  });

  it("false without it — whatever else is there", () => {
    expect(
      transitedEdge({ "x-origin-secret": SECRET, "x-forwarded-for": "34.120.0.10" }),
    ).toBe(false);
    expect(transitedEdge({})).toBe(false);
    expect(transitedEdge(null)).toBe(false);
  });
});

describe("describeClientIp — resolvedClientIp", () => {
  const headers = {
    "cf-connecting-ip": "34.120.0.10",
    "x-forwarded-for": "34.120.0.10, 172.70.0.1",
  };

  it("logs the limiter's value when given, keeping the raw header fields", () => {
    expect(describeClientIp(headers, "169.254.1.1", "198.51.100.23")).toEqual({
      clientIp: "198.51.100.23",
      cfConnectingIp: "34.120.0.10",
      forwardedFor: "34.120.0.10, 172.70.0.1",
    });
  });

  it("null means null (no IP resolved), still IP-validated for logs", () => {
    expect(describeClientIp(headers, undefined, null).clientIp).toBeNull();
    expect(describeClientIp(headers, undefined, "not-an-ip").clientIp).toBeNull();
  });

  it("undefined keeps header-only resolution", () => {
    expect(describeClientIp(headers, undefined, undefined).clientIp).toBe(
      "34.120.0.10",
    );
  });
});
