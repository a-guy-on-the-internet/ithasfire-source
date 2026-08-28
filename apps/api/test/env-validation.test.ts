import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `apps/api/src/lib/env.ts` parses `process.env` at import time. These tests
 * drive that boot-time parse by mutating `process.env`, resetting the module
 * registry, and re-importing.
 *
 * Focus: in production, when S3/R2 file storage is configured (S3_BUCKET set),
 * a missing/invalid S3_PUBLIC_BASE_URL must fail loudly at startup rather than
 * surfacing as a silent per-request 500 on public image uploads.
 */

const ORIGINAL_ENV = process.env;

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...overrides };
  return import("../src/lib/env");
}

describe("env S3_PUBLIC_BASE_URL production gating", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.resetModules();
  });

  it("throws at boot in prod when S3_BUCKET is set but S3_PUBLIC_BASE_URL is missing", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "production",
        S3_BUCKET: "ithasfire-prod",
        S3_PUBLIC_BASE_URL: undefined,
        // satisfy other prod-required fields
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
        BETTER_AUTH_SECRET: "x".repeat(32),
        CONSENT_IP_HASH_SALT: "x".repeat(32),
        BETTER_AUTH_JWKS_URL: "https://api.example.com/jwks",
        UNSUBSCRIBE_SECRET: "x".repeat(32),
      ORIGIN_SHARED_SECRET: "x".repeat(32),
        ORIGIN_SHARED_SECRET: "x".repeat(32),
      }),
    ).rejects.toThrowError(/S3_PUBLIC_BASE_URL is required in production/);
  });

  it("throws at boot in prod when S3_PUBLIC_BASE_URL is whitespace-only", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "production",
        S3_BUCKET: "ithasfire-prod",
        S3_PUBLIC_BASE_URL: "   ",
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
        BETTER_AUTH_SECRET: "x".repeat(32),
        CONSENT_IP_HASH_SALT: "x".repeat(32),
        BETTER_AUTH_JWKS_URL: "https://api.example.com/jwks",
        UNSUBSCRIBE_SECRET: "x".repeat(32),
      ORIGIN_SHARED_SECRET: "x".repeat(32),
        ORIGIN_SHARED_SECRET: "x".repeat(32),
      }),
    ).rejects.toThrowError(/S3_PUBLIC_BASE_URL is required in production/);
  });

  it("throws at boot in prod when S3_PUBLIC_BASE_URL is set but not a valid URL", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "production",
        S3_BUCKET: "ithasfire-prod",
        S3_PUBLIC_BASE_URL: "not-a-url",
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
        BETTER_AUTH_SECRET: "x".repeat(32),
        CONSENT_IP_HASH_SALT: "x".repeat(32),
        BETTER_AUTH_JWKS_URL: "https://api.example.com/jwks",
        UNSUBSCRIBE_SECRET: "x".repeat(32),
      ORIGIN_SHARED_SECRET: "x".repeat(32),
        ORIGIN_SHARED_SECRET: "x".repeat(32),
      }),
    ).rejects.toThrowError(/must be a valid URL/);
  });

  it("accepts a valid S3_PUBLIC_BASE_URL in prod with S3_BUCKET set", async () => {
    const mod = await loadEnv({
      NODE_ENV: "production",
      S3_BUCKET: "ithasfire-prod",
      S3_PUBLIC_BASE_URL: "https://cdn.ithasfire.com",
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
      BETTER_AUTH_SECRET: "x".repeat(32),
      CONSENT_IP_HASH_SALT: "x".repeat(32),
      BETTER_AUTH_JWKS_URL: "https://api.example.com/jwks",
      UNSUBSCRIBE_SECRET: "x".repeat(32),
      ORIGIN_SHARED_SECRET: "x".repeat(32),
    });

    expect(mod.env.S3_PUBLIC_BASE_URL).toBe("https://cdn.ithasfire.com");
  });

  it("stays optional in prod when S3_BUCKET is unset (no S3/R2 storage)", async () => {
    const mod = await loadEnv({
      NODE_ENV: "production",
      S3_BUCKET: undefined,
      S3_PUBLIC_BASE_URL: undefined,
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
      BETTER_AUTH_SECRET: "x".repeat(32),
      CONSENT_IP_HASH_SALT: "x".repeat(32),
      BETTER_AUTH_JWKS_URL: "https://api.example.com/jwks",
      UNSUBSCRIBE_SECRET: "x".repeat(32),
      ORIGIN_SHARED_SECRET: "x".repeat(32),
    });

    expect(mod.env.S3_PUBLIC_BASE_URL).toBeUndefined();
  });

  it("stays optional outside prod even with S3_BUCKET set (local dev / minio)", async () => {
    const mod = await loadEnv({
      NODE_ENV: "development",
      S3_BUCKET: "local-bucket",
      S3_PUBLIC_BASE_URL: undefined,
    });

    expect(mod.env.S3_PUBLIC_BASE_URL).toBeUndefined();
  });
});

describe("STRIPE_CONNECT_WEBHOOK_SECRET", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.resetModules();
  });

  const prodBase = {
    NODE_ENV: "production",
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    BETTER_AUTH_SECRET: "x".repeat(32),
    CONSENT_IP_HASH_SALT: "x".repeat(32),
    BETTER_AUTH_JWKS_URL: "https://api.example.com/jwks",
    UNSUBSCRIBE_SECRET: "x".repeat(32),
    ORIGIN_SHARED_SECRET: "x".repeat(32),
  };

  // Was optional in prod, and the optionality was invisible: Terraform omits
  // the env var when the tfvar is empty, so a missing secret produced no error
  // anywhere — every connected-account event just failed signature
  // verification and was dropped. `account.updated` is the only writer of
  // `Payee.payoutsEnabled = true`, so that silently blocks orgs from
  // publishing paid events. Fail at boot instead.
  it("is REQUIRED in production", async () => {
    await expect(
      loadEnv({ ...prodBase, STRIPE_CONNECT_WEBHOOK_SECRET: undefined }),
    ).rejects.toThrowError();
  });

  it("rejects an empty string in production (a blank CI secret is not 'unset')", async () => {
    await expect(
      loadEnv({ ...prodBase, STRIPE_CONNECT_WEBHOOK_SECRET: "" }),
    ).rejects.toThrowError();
  });

  it("stays optional outside production", async () => {
    const mod = await loadEnv({
      NODE_ENV: "test",
      STRIPE_CONNECT_WEBHOOK_SECRET: undefined,
    });
    expect(mod.env.STRIPE_CONNECT_WEBHOOK_SECRET).toBeUndefined();
  });
});

describe("forceConnectCapabilities", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.resetModules();
  });

  // The dev bypass that keeps seeded Stripe Custom accounts sellable. It must
  // be impossible to switch on in production — doing so would mark every
  // connected account payouts-enabled regardless of what Stripe says.
  it("is always false in production, even when the env var asks for it", async () => {
    const mod = await loadEnv({
      NODE_ENV: "production",
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
      BETTER_AUTH_SECRET: "x".repeat(32),
      CONSENT_IP_HASH_SALT: "x".repeat(32),
      BETTER_AUTH_JWKS_URL: "https://api.example.com/jwks",
      UNSUBSCRIBE_SECRET: "x".repeat(32),
      ORIGIN_SHARED_SECRET: "x".repeat(32),
      STRIPE_CONNECT_FORCE_CAPABILITIES: "true",
    });
    expect(mod.forceConnectCapabilities).toBe(false);
  });

  it("defaults ON outside production so seeded accounts stay sellable", async () => {
    const mod = await loadEnv({
      NODE_ENV: "test",
      STRIPE_CONNECT_FORCE_CAPABILITIES: undefined,
    });
    expect(mod.forceConnectCapabilities).toBe(true);
  });

  it("can be switched OFF outside production to reproduce prod semantics", async () => {
    const mod = await loadEnv({
      NODE_ENV: "test",
      STRIPE_CONNECT_FORCE_CAPABILITIES: "false",
    });
    expect(mod.forceConnectCapabilities).toBe(false);
  });
});

describe("SESSION_COOKIE_PREFIX", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.resetModules();
  });

  /**
   * This var lives here but is consumed by cookie-NAME matchers in apps/web —
   * `lib/auth/session-cookie.ts`, `middleware/private-route-gate.ts`, and
   * (through the first) `middleware/staff-route-gate.ts`. The staff gate uses
   * cookie presence as a negative pre-filter before spending an API round
   * trip, so a prefix those matchers don't recognise short-circuits EVERY
   * signed-in user to `/sign-in` across `/admin`, `/moderate` and `/platform`
   * — silently, since "no session cookie" is an expected, unreported branch.
   * A cross-app coupling with no shared module can only be enforced here.
   */
  it("rejects a prefix outside the `better-auth` family at boot", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "development",
        SESSION_COOKIE_PREFIX: "ithasfire-dev",
      }),
    ).rejects.toThrowError(/must start with `better-auth`/);
  });

  it("accepts the deployed-dev prefix", async () => {
    const mod = await loadEnv({
      NODE_ENV: "development",
      SESSION_COOKIE_PREFIX: "better-auth-dev",
    });

    expect(mod.env.SESSION_COOKIE_PREFIX).toBe("better-auth-dev");
  });

  it("stays optional (prod leaves it unset to keep Better Auth's default)", async () => {
    const mod = await loadEnv({
      NODE_ENV: "development",
      SESSION_COOKIE_PREFIX: undefined,
    });

    expect(mod.env.SESSION_COOKIE_PREFIX).toBeUndefined();
  });
});
