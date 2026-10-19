import { describe, expect, it, vi } from "vitest";

import { createAzureContentSafetyModerationAdapter } from "./azure-content-safety-adapter";

const CONFIG = {
  endpoint: "https://cs.test.local",
  apiKey: "test-key",
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const input = {
  imageBytes: new Uint8Array([1, 2, 3, 4]),
  contentType: "image/jpeg",
  imageId: "img_123",
};

describe("createAzureContentSafetyModerationAdapter", () => {
  it("maps a 200 categoriesAnalysis into normalized severities + maxSeverity", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categoriesAnalysis: [
          { category: "Hate", severity: 0 },
          { category: "SelfHarm", severity: 2 },
          { category: "Sexual", severity: 6 },
          { category: "Violence", severity: 0 },
        ],
      }),
    );

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(false);
    expect(result.provider).toBe("azure-content-safety");
    expect(result.rawSeverityScale).toBe("four");
    expect(result.maxSeverity).toBe(6);
    // Sexual→SEXUAL, SelfHarm→SELF_HARM name normalization.
    expect(result.categories).toContainEqual({
      category: "SEXUAL",
      severity: 6,
    });
    expect(result.categories).toContainEqual({
      category: "SELF_HARM",
      severity: 2,
    });
    // Provisional verdict from severity >= 4.
    expect(result.verdict).toBe("FLAGGED");

    // Verify request shape.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://cs.test.local/contentsafety/image:analyze?api-version=2024-09-01",
    );
    expect(
      (init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"],
    ).toBe("test-key");
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.image.content).toBe(
      Buffer.from(input.imageBytes).toString("base64"),
    );
    expect(parsedBody.outputType).toBe("FourSeverityLevels");
  });

  it("fails closed to a degraded FLAGGED result + reports the error on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 403));
    const reportError = vi.fn();

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reportError,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(true);
    expect(result.verdict).toBe("FLAGGED");
    expect(result.categories).toEqual([]);
    expect(result.maxSeverity).toBe(6);
    // 403 is a client error — not retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][1]).toMatchObject({
      tags: { area: "image-moderation", provider: "azure-content-safety" },
      extra: { imageId: "img_123" },
    });
  });

  it("fails closed to degraded FLAGGED on timeout/abort", async () => {
    // A fetch that never resolves until the abort signal fires.
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const reportError = vi.fn();

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      timeoutMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reportError,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(true);
    expect(result.verdict).toBe("FLAGGED");
    // Timeout is retryable: 1 initial + 2 retries.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a 200 with an empty/missing categoriesAnalysis (no fail-open)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const reportError = vi.fn();

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reportError,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(true);
    expect(result.verdict).toBe("FLAGGED");
    expect(result.categories).toEqual([]);
    // Unusable body — not retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a 200 whose category names don't map (casing / api drift)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categoriesAnalysis: [
          { category: "sexual", severity: 6 }, // lowercase — unmappable
          { category: "Nudity", severity: 4 }, // unknown category
        ],
      }),
    );
    const reportError = vi.fn();

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reportError,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(true);
    expect(result.verdict).toBe("FLAGGED");
    expect(result.maxSeverity).toBe(6); // sentinel, not the un-analyzed 0
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a PARTIAL 200 with only 2 of the 4 requested categories", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categoriesAnalysis: [
          { category: "Sexual", severity: 0 },
          { category: "Violence", severity: 0 },
          // Hate + SelfHarm missing → incomplete, must not resolve APPROVED.
        ],
      }),
    );
    const reportError = vi.fn();

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reportError,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(true);
    expect(result.verdict).toBe("FLAGGED");
    expect(result.maxSeverity).toBe(6); // sentinel, not the un-analyzed 0
    // Incomplete shape won't fix itself on retry.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a 200 with a non-numeric/NaN severity (no coercion to 0)", async () => {
    for (const badSeverity of ["6", null, Number.NaN, undefined] as const) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          categoriesAnalysis: [
            { category: "Sexual", severity: badSeverity },
            { category: "Violence", severity: 0 },
            { category: "Hate", severity: 0 },
            { category: "SelfHarm", severity: 0 },
          ],
        }),
      );
      const reportError = vi.fn();

      const adapter = createAzureContentSafetyModerationAdapter({
        ...CONFIG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        reportError,
      });

      const result = await adapter.moderateImage(input);

      expect(result.degraded).toBe(true);
      expect(result.verdict).toBe("FLAGGED");
      expect(result.maxSeverity).toBe(6);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed on a 200 with an unknown category alongside valid ones", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categoriesAnalysis: [
          { category: "Sexual", severity: 0 },
          { category: "Violence", severity: 0 },
          { category: "Hate", severity: 0 },
          { category: "SelfHarm", severity: 0 },
          { category: "Nudity", severity: 0 }, // unknown name = api drift
        ],
      }),
    );
    const reportError = vi.fn();

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reportError,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(true);
    expect(result.verdict).toBe("FLAGGED");
    expect(result.maxSeverity).toBe(6);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("parses a full, valid, all-clean 4-category 200 as APPROVED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categoriesAnalysis: [
          { category: "Hate", severity: 0 },
          { category: "SelfHarm", severity: 0 },
          { category: "Sexual", severity: 0 },
          { category: "Violence", severity: 0 },
        ],
      }),
    );

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(false);
    expect(result.verdict).toBe("APPROVED");
    expect(result.maxSeverity).toBe(0);
    expect(result.categories).toHaveLength(4);
  });

  it("retries a 429 then succeeds (NFR-002 backoff)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(
        jsonResponse({
          categoriesAnalysis: [
            { category: "Hate", severity: 0 },
            { category: "SelfHarm", severity: 0 },
            { category: "Sexual", severity: 0 },
            { category: "Violence", severity: 0 },
          ],
        }),
      );

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(false);
    expect(result.verdict).toBe("APPROVED");
    expect(result.maxSeverity).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a persistent 5xx then fails closed after exhausting attempts", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const reportError = vi.fn();

    const adapter = createAzureContentSafetyModerationAdapter({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reportError,
    });

    const result = await adapter.moderateImage(input);

    expect(result.degraded).toBe(true);
    expect(result.verdict).toBe("FLAGGED");
    // 5xx is retryable: 1 initial + 2 retries = 3 attempts.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
