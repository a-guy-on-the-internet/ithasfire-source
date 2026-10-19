import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";

import { CloudflareTurnstileAdapter } from "../cloudflare-turnstile-adapter";

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function unparseableResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
    text: async () => "<html>error</html>",
  } as unknown as Response;
}

function stubLogger(): LoggerPort & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    child: () => logger,
    withTime: async <T>(_name: string, f: () => Promise<T>) => f(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as unknown as LoggerPort & { warn: ReturnType<typeof vi.fn> };
}

function makeAdapter(overrides?: {
  logger?: LoggerPort;
  reportError?: (error: unknown, context?: unknown) => void;
}) {
  const logger = overrides?.logger ?? stubLogger();
  const reportError = overrides?.reportError ?? vi.fn();
  const adapter = new CloudflareTurnstileAdapter({
    secretKey: "test-secret",
    logger,
    reportError,
    // Keep the default 15-minute window unless a test overrides it via a
    // second adapter — two calls in one test run land inside one window.
  });
  return { adapter, logger, reportError };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CloudflareTurnstileAdapter", () => {
  it("throws on an empty secret key", () => {
    expect(() => new CloudflareTurnstileAdapter({ secretKey: "" })).toThrow(
      /non-empty secret key/,
    );
  });

  it("returns true on success:true without logging or reporting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { adapter, logger, reportError } = makeAdapter();

    await expect(adapter.verify("tok", "1.2.3.4")).resolves.toBe(true);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();

    // remoteip is forwarded to siteverify.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      secret: "test-secret",
      response: "tok",
      remoteip: "1.2.3.4",
    });
  });

  it("attaches an abort signal so a hanging siteverify cannot hold requests open", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { adapter } = makeAdapter();

    await adapter.verify("tok");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("logs turnstile_token_rejected on success:false and does NOT report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: false,
          "error-codes": ["invalid-input-response"],
        }),
      ),
    );
    const { adapter, logger, reportError } = makeAdapter();

    await expect(adapter.verify("bad-tok")).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith("turnstile_token_rejected", {
      errorCodes: ["invalid-input-response"],
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("returns false, warns, and reports when fetch rejects", async () => {
    const cause = new Error("ECONNREFUSED");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));
    const { adapter, logger, reportError } = makeAdapter();

    await expect(adapter.verify("tok")).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      "turnstile_siteverify_unavailable",
      expect.objectContaining({ branch: "fetch_failed" }),
    );
    expect(reportError).toHaveBeenCalledWith(
      cause,
      expect.objectContaining({
        tags: { area: "turnstile_fail_closed", branch: "fetch_failed" },
      }),
    );
  });

  it("returns false, warns, and reports on a non-2xx siteverify response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ nope: true }, 503)),
    );
    const { adapter, logger, reportError } = makeAdapter();

    await expect(adapter.verify("tok")).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      "turnstile_siteverify_unavailable",
      expect.objectContaining({ branch: "http_error", status: 503 }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "turnstile_fail_closed", branch: "http_error" },
        extra: { status: 503 },
      }),
    );
  });

  it("returns false, warns, and reports on unparseable JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unparseableResponse()));
    const { adapter, logger, reportError } = makeAdapter();

    await expect(adapter.verify("tok")).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      "turnstile_siteverify_unavailable",
      expect.objectContaining({ branch: "bad_json" }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      expect.objectContaining({
        tags: { area: "turnstile_fail_closed", branch: "bad_json" },
      }),
    );
  });

  it("throttles repeat reports for the same branch within the window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const { adapter, reportError } = makeAdapter();

    await adapter.verify("tok-1");
    await adapter.verify("tok-2");

    // Two failures inside one 15-minute window ⇒ exactly one Sentry event.
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a throwing reporter does not change the verify result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const { adapter } = makeAdapter({
      reportError: () => {
        throw new Error("sentry exploded");
      },
    });

    await expect(adapter.verify("tok")).resolves.toBe(false);
  });

  it("works without a logger or reporter (both optional)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const adapter = new CloudflareTurnstileAdapter({
      secretKey: "test-secret",
    });

    await expect(adapter.verify("tok")).resolves.toBe(false);
  });
});
