import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = process.env;

const loadPublicEnvModule = async () => {
  vi.resetModules();
  return import("./env.public");
};

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe("env.public", () => {
  it("exposes Better Auth URL from public env vars", async () => {
    const url = "http://localhost:3000";
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL = url;
    const { publicRuntimeEnv } = await loadPublicEnvModule();
    expect(publicRuntimeEnv.betterAuth.url).toBe(url);
  });
});
