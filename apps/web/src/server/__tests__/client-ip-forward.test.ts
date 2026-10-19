import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLIENT_IP_FORWARD_SIG_HEADER,
  verifyClientIpForward,
} from "@th/trpc/client-ip";

import { signedClientIpHeaders } from "../client-ip-forward";

/**
 * The web half of the signed client-IP forward. Strictness follows the
 * origin-secret rollout flag: with ENFORCE_ORIGIN_SECRET="true" we sign
 * `cf-connecting-ip` only when the inbound request carries the
 * Cloudflare-stamped `x-origin-secret`; in log-only mode we sign it as
 * received — the same trust the API already places in that header. Either
 * way: never without ORIGIN_SHARED_SECRET, never from `x-forwarded-for`, and
 * never a non-IP.
 */

const SECRET = "test-origin-shared-secret-0123456789abcdef";
const NOW_MS = 1_790_000_000_000;
const NOW_S = NOW_MS / 1000;

const incoming = (headers: Record<string, string>) => new Headers(headers);

const viaCloudflare = (ip: string, extra: Record<string, string> = {}) =>
  incoming({ "x-origin-secret": SECRET, "cf-connecting-ip": ip, ...extra });

const ENV_KEYS = ["ORIGIN_SHARED_SECRET", "ENFORCE_ORIGIN_SECRET"] as const;
let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

const setEnforcement = (on: boolean) => {
  if (on) process.env.ENFORCE_ORIGIN_SECRET = "true";
  else delete process.env.ENFORCE_ORIGIN_SECRET;
};

beforeEach(() => {
  savedEnv = {
    ORIGIN_SHARED_SECRET: process.env.ORIGIN_SHARED_SECRET,
    ENFORCE_ORIGIN_SECRET: process.env.ENFORCE_ORIGIN_SECRET,
  };
  process.env.ORIGIN_SHARED_SECRET = SECRET;
  setEnforcement(false);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const missingOrWrongSecret: Array<[string, Record<string, string>]> = [
  ["missing", {}],
  ["wrong", { "x-origin-secret": "nope" }],
  ["one char long", { "x-origin-secret": `${SECRET}x` }],
  ["one char short", { "x-origin-secret": SECRET.slice(0, -1) }],
  ["empty", { "x-origin-secret": "" }],
];

describe("signedClientIpHeaders", () => {
  it("matches the fixed wire-format vector the API is tested against", () => {
    // Same vector as packages/transport/trpc/src/client-ip-forward.test.ts:
    // the two services deploy separately, so the format is pinned on both.
    expect(signedClientIpHeaders(viaCloudflare("203.0.113.7"), NOW_MS)).toEqual({
      "x-th-client-ip": "203.0.113.7",
      "x-th-client-ip-ts": "1790000000",
      "x-th-client-ip-sig": "snJ9EpzW7oaa8hpAtMKBXNKpbC4A_eV0G-pui0h5SuU",
    });
  });

  it("produces a forward the API verifier accepts", () => {
    const headers = signedClientIpHeaders(viaCloudflare("2001:db8::1"), NOW_MS);
    expect(verifyClientIpForward(headers, SECRET, NOW_S)).toBe("2001:db8::1");
  });

  it("gives two visitors two different forwarded IPs", () => {
    const a = signedClientIpHeaders(viaCloudflare("198.51.100.23"), NOW_MS);
    const b = signedClientIpHeaders(viaCloudflare("203.0.113.99"), NOW_MS);
    expect(a["x-th-client-ip"]).toBe("198.51.100.23");
    expect(b["x-th-client-ip"]).toBe("203.0.113.99");
    expect(a[CLIENT_IP_FORWARD_SIG_HEADER]).not.toBe(
      b[CLIENT_IP_FORWARD_SIG_HEADER],
    );
  });

  describe("log-only mode (ENFORCE_ORIGIN_SECRET not \"true\")", () => {
    it.each(missingOrWrongSecret)(
      "still signs when the inbound origin secret is %s",
      (_label, originHeader) => {
        const headers = signedClientIpHeaders(
          incoming({ ...originHeader, "cf-connecting-ip": "203.0.113.7" }),
          NOW_MS,
        );
        expect(verifyClientIpForward(headers, SECRET, NOW_S)).toBe(
          "203.0.113.7",
        );
      },
    );

    it("treats any value other than \"true\" as log-only", () => {
      for (const flag of ["false", "1", "TRUE", ""]) {
        process.env.ENFORCE_ORIGIN_SECRET = flag;
        expect(
          signedClientIpHeaders(
            incoming({ "cf-connecting-ip": "203.0.113.7" }),
            NOW_MS,
          )["x-th-client-ip"],
        ).toBe("203.0.113.7");
      }
    });
  });

  describe("enforcing mode (ENFORCE_ORIGIN_SECRET=\"true\")", () => {
    beforeEach(() => setEnforcement(true));

    it.each(missingOrWrongSecret)(
      "signs nothing when the inbound origin secret is %s",
      (_label, originHeader) => {
        expect(
          signedClientIpHeaders(
            incoming({ ...originHeader, "cf-connecting-ip": "203.0.113.7" }),
            NOW_MS,
          ),
        ).toEqual({});
      },
    );

    it("signs when the inbound origin secret matches", () => {
      const headers = signedClientIpHeaders(viaCloudflare("203.0.113.7"), NOW_MS);
      expect(verifyClientIpForward(headers, SECRET, NOW_S)).toBe("203.0.113.7");
    });
  });

  it.each([false, true])(
    "signs nothing when ORIGIN_SHARED_SECRET is unset or blank (enforcing=%s)",
    (enforcing) => {
      setEnforcement(enforcing);
      delete process.env.ORIGIN_SHARED_SECRET;
      expect(signedClientIpHeaders(viaCloudflare("203.0.113.7"), NOW_MS)).toEqual(
        {},
      );
      process.env.ORIGIN_SHARED_SECRET = "   ";
      expect(signedClientIpHeaders(viaCloudflare("203.0.113.7"), NOW_MS)).toEqual(
        {},
      );
    },
  );

  it("uses cf-connecting-ip only — never x-forwarded-for", () => {
    expect(
      signedClientIpHeaders(
        incoming({
          "x-origin-secret": SECRET,
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "203.0.113.8",
        }),
        NOW_MS,
      ),
    ).toEqual({});
    expect(
      signedClientIpHeaders(
        viaCloudflare("198.51.100.23", { "x-forwarded-for": "10.0.0.1" }),
        NOW_MS,
      )["x-th-client-ip"],
    ).toBe("198.51.100.23");
  });

  it("signs nothing for a cf-connecting-ip that is not an IP", () => {
    for (const bad of ["not-an-ip", "203.0.113.7, 10.0.0.1", "x".repeat(70)]) {
      expect(signedClientIpHeaders(viaCloudflare(bad), NOW_MS)).toEqual({});
    }
  });
});
