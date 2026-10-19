import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { NextRequest } from "next/server";

import { checkOriginSecret } from "../middleware";

/**
 * Regression coverage for the origin-secret guard's web-app half (the
 * apps/api counterpart is apps/api/src/plugins/origin-guard.ts, covered by
 * apps/api/test/origin-guard.test.ts). There's no established Next.js
 * middleware test harness in this repo, so this exercises the exported
 * `checkOriginSecret` comparison function directly rather than spinning up
 * a full middleware/route pipeline.
 */

const SECRET = "a".repeat(32);
const originalEnv = { ...process.env };

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest("https://ithasfire.example/protected", { headers });
}

describe("checkOriginSecret", () => {
  let warnSpy: MockInstance<Parameters<typeof console.warn>, void>;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ORIGIN_SHARED_SECRET = SECRET;
    delete process.env.ENFORCE_ORIGIN_SECRET;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...originalEnv };
    warnSpy.mockRestore();
  });

  it("proceeds (returns null) when the header matches the shared secret", () => {
    const result = checkOriginSecret(
      makeRequest({ "x-origin-secret": SECRET }),
    );

    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not throw on a mismatched-length header and treats it as a mismatch", () => {
    expect(() =>
      checkOriginSecret(makeRequest({ "x-origin-secret": "short" })),
    ).not.toThrow();

    const result = checkOriginSecret(
      makeRequest({ "x-origin-secret": "short" }),
    );

    // Log-only by default (ENFORCE_ORIGIN_SECRET unset) — mismatch is
    // logged, not blocked.
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "origin_secret_mismatch",
      expect.objectContaining({ path: "/protected" }),
    );
  });

  it("treats a missing header as a mismatch", () => {
    const result = checkOriginSecret(makeRequest());

    expect(result).toBeNull(); // log-only default
    expect(warnSpy).toHaveBeenCalledWith(
      "origin_secret_mismatch",
      expect.objectContaining({ path: "/protected" }),
    );
  });

  it("logs but does not block a mismatch when ENFORCE_ORIGIN_SECRET is unset (rollout default)", () => {
    const result = checkOriginSecret(
      makeRequest({ "x-origin-secret": "wrong-value-wrong-value-wrong-value" }),
    );

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("blocks with 403 when ENFORCE_ORIGIN_SECRET=true and the header mismatches", async () => {
    process.env.ENFORCE_ORIGIN_SECRET = "true";

    const result = checkOriginSecret(
      makeRequest({ "x-origin-secret": "wrong-value-wrong-value-wrong-value" }),
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe(403);
    expect(await result?.json()).toEqual({ error: "origin_secret_mismatch" });
  });

  it("exempts only the exact /api/health probe path when enforcing with no header", () => {
    process.env.ENFORCE_ORIGIN_SECRET = "true";
    const at = (path: string) =>
      checkOriginSecret(new NextRequest(`https://ithasfire.example${path}`));

    expect(at("/api/health")).toBeNull();
    expect(at("/api/health?x=1")).toBeNull();
    expect(at("/")?.status).toBe(403);
    expect(at("/api/healthz")?.status).toBe(403);
    expect(at("/api/health/x")?.status).toBe(403);
  });

  it("matches a header carrying the trimmed value when the env secret has a trailing newline", () => {
    process.env.ORIGIN_SHARED_SECRET = `${SECRET}\n`;
    process.env.ENFORCE_ORIGIN_SECRET = "true";

    const result = checkOriginSecret(
      makeRequest({ "x-origin-secret": SECRET }),
    );

    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still blocks a wrong header when the env secret has a trailing newline", () => {
    process.env.ORIGIN_SHARED_SECRET = `${SECRET}\n`;
    process.env.ENFORCE_ORIGIN_SECRET = "true";

    const result = checkOriginSecret(
      makeRequest({ "x-origin-secret": "b".repeat(32) }),
    );

    expect(result?.status).toBe(403);
    expect(warnSpy).toHaveBeenCalledWith(
      "origin_secret_mismatch",
      expect.objectContaining({ path: "/protected" }),
    );
  });

  it("treats an all-whitespace env secret as unconfigured", () => {
    process.env.ORIGIN_SHARED_SECRET = "  \n";
    process.env.ENFORCE_ORIGIN_SECRET = "true";

    const result = checkOriginSecret(makeRequest());

    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is skipped entirely outside production, even with a bad header", () => {
    vi.stubEnv("NODE_ENV", "development");

    const result = checkOriginSecret(
      makeRequest({ "x-origin-secret": "wrong-value" }),
    );

    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
