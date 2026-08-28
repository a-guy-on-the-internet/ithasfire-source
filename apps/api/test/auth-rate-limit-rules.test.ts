import { describe, expect, it } from "vitest";

import {
  AUTH_ACCOUNT_BUCKET_MULTIPLIER,
  AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND,
  AUTH_GUESS_SPACE_PATHS,
  AUTH_GUESS_SPACE_PATH_SET,
  AUTH_RATE_LIMIT_CUSTOM_RULES,
  AUTH_RATE_LIMIT_GLOBAL,
  AUTH_RATE_LIMIT_MAX_WINDOW_SECONDS,
  resolveAccountCap,
  resolveAuthLimits,
  resolveGuessSpaceRule,
  type AuthRateLimitRule,
} from "../src/auth/rate-limit-rules";
import { DEFAULT_TTL_SECONDS } from "../src/auth/rate-limit-storage";

/**
 * These numbers were comment-only invariants until a near-miss made them
 * testable: `/token` sat on the global 100/60s floor while the web app minted
 * one JWT per gated navigation from a SINGLE shared egress IP, so a handful of
 * staff on /platform could exhaust the key inside a minute and silently bounce
 * real ADMINs to /access-denied. Everything asserted here is a property whose
 * violation is invisible in production.
 */

const isRule = (
  rule: AuthRateLimitRule,
): rule is { window: number; max: number } => rule !== false;

describe("better-auth rate-limit rules", () => {
  describe("TTL invariant", () => {
    /**
     * `customStorage` never receives the window, so it expires Redis keys on a
     * FIXED TTL. A window longer than that TTL silently under-limits — the key
     * expires mid-window and the counter restarts — which looks exactly like
     * working rate limiting from the outside.
     */
    it("keeps the max allowed window pinned to the storage TTL", () => {
      expect(AUTH_RATE_LIMIT_MAX_WINDOW_SECONDS).toBe(DEFAULT_TTL_SECONDS);
    });

    it("keeps the global floor's window within the storage TTL", () => {
      expect(AUTH_RATE_LIMIT_GLOBAL.window).toBeLessThanOrEqual(
        AUTH_RATE_LIMIT_MAX_WINDOW_SECONDS,
      );
    });

    it.each(Object.entries(AUTH_RATE_LIMIT_CUSTOM_RULES))(
      "keeps %s's window within the storage TTL",
      (_path, rule) => {
        if (!isRule(rule)) return;
        expect(rule.window).toBeGreaterThan(0);
        expect(rule.window).toBeLessThanOrEqual(
          AUTH_RATE_LIMIT_MAX_WINDOW_SECONDS,
        );
      },
    );
  });

  describe("brute-force surfaces stay stricter than the global floor", () => {
    it.each([
      "/sign-in/email",
      "/sign-in/username",
      "/sign-in/email-otp",
      "/email-otp/verify-email",
      "/two-factor/verify-totp",
      "/two-factor/verify-otp",
      "/two-factor/verify-backup-code",
      "/magic-link/verify",
      "/passkey/verify-authentication",
    ])("%s caps below the global floor", (path) => {
      const rule = AUTH_RATE_LIMIT_CUSTOM_RULES[path];
      expect(rule, `${path} lost its rule`).toBeDefined();
      if (!isRule(rule!)) throw new Error(`${path} must not be exempted`);
      expect(rule.max).toBeLessThan(AUTH_RATE_LIMIT_GLOBAL.max);
    });
  });

  describe("/get-session", () => {
    it("stays fully exempt (polled on virtually every page load)", () => {
      expect(AUTH_RATE_LIMIT_CUSTOM_RULES["/get-session"]).toBe(false);
    });
  });

  describe("/token", () => {
    /**
     * The mint is server-to-server from the web service, so Better Auth keys
     * every staff member's request onto ONE IP. Too low and the edge staff gate
     * fails closed for everyone at once.
     */
    it("has generous headroom above the global floor", () => {
      const rule = AUTH_RATE_LIMIT_CUSTOM_RULES["/token"];
      if (!isRule(rule!))
        throw new Error("/token must stay capped, not exempt");
      expect(rule.max).toBeGreaterThanOrEqual(AUTH_RATE_LIMIT_GLOBAL.max * 3);
    });

    /**
     * `false` would remove the ceiling entirely. Minting requires a valid
     * session, but an unbounded endpoint is still an amplifier for a
     * compromised one — raise the number instead.
     */
    it("stays finite (never exempted)", () => {
      expect(AUTH_RATE_LIMIT_CUSTOM_RULES["/token"]).not.toBe(false);
      const rule = AUTH_RATE_LIMIT_CUSTOM_RULES["/token"];
      if (!isRule(rule!)) throw new Error("unreachable");
      expect(Number.isFinite(rule.max)).toBe(true);
    });
  });

  describe("guess-space set (the atomic pre-limiter's scope)", () => {
    /**
     * The set and the rules table are the SINGLE source of truth shared by
     * Better Auth's limiter and the atomic pre-limiter
     * (`plugins/auth-rate-limit.ts`). If they ever drift, one layer guards a
     * path the other doesn't and the difference is invisible from outside.
     */
    it.each(AUTH_GUESS_SPACE_PATHS)("%s has a real rule to enforce", (path) => {
      const rule = AUTH_RATE_LIMIT_CUSTOM_RULES[path];
      expect(rule, `${path} lost its rule`).toBeDefined();
      expect(rule, `${path} must not be exempted`).not.toBe(false);
    });

    it.each(AUTH_GUESS_SPACE_PATHS)(
      "resolveGuessSpaceRule('%s') returns exactly the table's numbers",
      (path) => {
        const rule = AUTH_RATE_LIMIT_CUSTOM_RULES[path];
        if (!isRule(rule)) throw new Error(`${path} must not be exempted`);
        expect(resolveGuessSpaceRule(path)).toEqual({
          window: rule.window,
          max: rule.max,
        });
      },
    );

    /**
     * `/get-session` is polled on virtually every page load; `/token` is
     * minted server-to-server from ONE shared egress IP, and making its 300
     * a HARD (atomic) ceiling risks re-creating the silent staff-wide
     * ADMIN lockout that number was raised to fix.
     */
    it.each(["/get-session", "/token"])(
      "%s is NOT in the guess-space set",
      (path) => {
        expect(AUTH_GUESS_SPACE_PATH_SET.has(path)).toBe(false);
        expect(resolveGuessSpaceRule(path)).toBeNull();
      },
    );

    it("never claims a path that has no rule at all", () => {
      for (const path of AUTH_GUESS_SPACE_PATHS) {
        expect(
          Object.prototype.hasOwnProperty.call(
            AUTH_RATE_LIMIT_CUSTOM_RULES,
            path,
          ),
          `${path} is in the guess-space set but has no rule`,
        ).toBe(true);
      }
    });

    it("returns null for arbitrary/unknown auth paths", () => {
      for (const path of ["/sign-up/email", "/sign-out", "/nope", ""]) {
        expect(resolveGuessSpaceRule(path)).toBeNull();
      }
    });

    it("contains no duplicates", () => {
      expect(new Set(AUTH_GUESS_SPACE_PATHS).size).toBe(
        AUTH_GUESS_SPACE_PATHS.length,
      );
    });

    /**
     * Every guess-space path must be CLASSIFIED as guess or send, because the
     * two get different account multipliers. The compile-time guarantee is
     * `satisfies Record<AuthGuessSpacePath, …>` on `AUTH_PATH_KIND`; this is
     * the runtime half — `resolveAccountCap` must return a cap for every path,
     * and the send paths must land on the tighter one.
     */
    it("classifies EVERY guess-space path (no path falls through)", () => {
      for (const path of AUTH_GUESS_SPACE_PATHS) {
        const cap = resolveAccountCap(path);
        expect(cap, `${path} has no account cap`).not.toBeNull();
        const rule = resolveGuessSpaceRule(path)!;
        // Must be exactly one of the two sanctioned multipliers — never some
        // third value, and never the raw rule max.
        expect(
          [
            rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER,
            rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND,
          ],
          `${path} got an unsanctioned account cap`,
        ).toContain(cap!.max);
      }
    });

    it("resolveAuthLimits returns both caps consistently", () => {
      for (const path of AUTH_GUESS_SPACE_PATHS) {
        const limits = resolveAuthLimits(path);
        expect(limits, path).not.toBeNull();
        expect(limits!.ip).toEqual(resolveGuessSpaceRule(path));
        expect(limits!.account).toEqual(resolveAccountCap(path));
      }
      expect(resolveAuthLimits("/get-session")).toBeNull();
      expect(resolveAuthLimits("/token")).toBeNull();
    });

    /**
     * Per-account limiting is an attacker-induced-lockout DoS vector: anyone
     * who knows a victim's email can burn their bucket. The account cap must
     * therefore stay STRICTLY more generous than the per-IP cap, or the
     * lockout becomes the cheap path.
     */
    it("keeps the account bucket strictly more generous than the IP bucket", () => {
      expect(AUTH_ACCOUNT_BUCKET_MULTIPLIER).toBeGreaterThan(1);
      for (const path of AUTH_GUESS_SPACE_PATHS) {
        const rule = resolveGuessSpaceRule(path)!;
        expect(
          rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER,
          `${path}'s account cap must exceed its IP cap`,
        ).toBeGreaterThan(rule.max);
      }
    });
  });

  it("has no rule with a non-positive max (which would lock the path out)", () => {
    for (const [path, rule] of Object.entries(AUTH_RATE_LIMIT_CUSTOM_RULES)) {
      if (!isRule(rule)) continue;
      expect(rule.max, `${path} has a non-positive max`).toBeGreaterThan(0);
    }
  });
});
