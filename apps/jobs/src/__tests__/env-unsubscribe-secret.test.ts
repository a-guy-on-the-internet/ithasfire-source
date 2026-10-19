import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * UNSUBSCRIBE_SECRET is ALSO the root of the location obfuscation key
 * (`@th/core/lib/location/obfuscation-key`). The API has required it in
 * production all along; the jobs service treated it as optional, so a jobs
 * deploy without it would build the search index with every obscured event
 * and venue fully hidden — silently. Production now refuses to boot without
 * it, with the API's length floor.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadEnvWith(vars: Record<string, string>) {
  process.env = { ...vars } as NodeJS.ProcessEnv;
  vi.resetModules();
  return import("../lib/env");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

const BASE = { DATABASE_URL: "postgres://jobs:jobs@localhost:5432/jobs" };

describe("jobs env — UNSUBSCRIBE_SECRET", () => {
  it("PRODUCTION refuses to boot without it", async () => {
    await expect(
      loadEnvWith({ ...BASE, NODE_ENV: "production" }),
    ).rejects.toThrow(/UNSUBSCRIBE_SECRET/);
  });

  it("PRODUCTION refuses a secret shorter than the API's 32-character floor", async () => {
    await expect(
      loadEnvWith({ ...BASE, NODE_ENV: "production", UNSUBSCRIBE_SECRET: "short" }),
    ).rejects.toThrow(/UNSUBSCRIBE_SECRET/);
  });

  it("PRODUCTION boots with a full-length secret", async () => {
    const secret = "x".repeat(32);
    const { env } = await loadEnvWith({
      ...BASE,
      NODE_ENV: "production",
      UNSUBSCRIBE_SECRET: secret,
    });
    expect(env.UNSUBSCRIBE_SECRET).toBe(secret);
  });

  it("development still boots without it (circles fail closed, reported at boot)", async () => {
    const { env } = await loadEnvWith({ ...BASE, NODE_ENV: "development" });
    expect(env.UNSUBSCRIBE_SECRET).toBeUndefined();
  });
});
