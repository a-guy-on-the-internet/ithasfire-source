import type { LoggerPort } from "@th/ports/logger";
import type {
  ImageModerationResult,
  ModerationPort,
} from "@th/ports/moderation";
import type { ReporterPort } from "@th/ports/reporter";
import type {
  ImageModerationCategory,
  ImageModerationCategoryScore,
} from "@th/types/repos/image-moderation-records";

const API_VERSION = "2024-09-01";
const PROVIDER = "azure-content-safety";
const DEFAULT_TIMEOUT_MS = 5000;

// Backoff schedule (ms) applied BEFORE a retry. Length = max retries; the total
// attempt count is backoffs.length + 1. Mirrors the ZipTax 429 hardening — a
// short, fixed schedule with no external retry lib.
const RETRY_BACKOFFS_MS = [250, 500] as const;

// Sentinel severity used on the fail-closed path. Degraded results carry the
// maximum four-level severity (6) so any downstream comparison against a review
// threshold treats them as "at/above threshold" — belt-and-braces on top of the
// `degraded` flag, which the use case already uses to force FLAGGED (FR-006).
const DEGRADED_SENTINEL_SEVERITY = 6;

// Azure's four-level review threshold. The adapter computes a PROVISIONAL
// verdict from this as a convenience; the use case re-derives the real verdict
// from its configured reviewThreshold and does NOT rely on this field for the
// gate (FR-004 owns the threshold decision, kept out of the port).
const PROVISIONAL_FLAG_SEVERITY = 4;

// Azure category name → our normalized union.
const CATEGORY_MAP: Record<string, ImageModerationCategory> = {
  Sexual: "SEXUAL",
  Violence: "VIOLENCE",
  Hate: "HATE",
  SelfHarm: "SELF_HARM",
};

// The four categories we request on every call. A trustworthy 2xx echoes all
// four exactly once with finite severities; anything else is treated as an
// incomplete/untrustworthy analysis and fails closed (see below).
const REQUIRED_CATEGORIES: readonly ImageModerationCategory[] = [
  "SEXUAL",
  "VIOLENCE",
  "HATE",
  "SELF_HARM",
];

type AzureCategoriesAnalysis = {
  categoriesAnalysis?: Array<{ category?: string; severity?: number }>;
};

/** A classified provider failure — `retryable` drives the backoff loop. */
class ProviderError extends Error {
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.cause = cause;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type AzureContentSafetyModerationConfig = {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  /** Injected for testability; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Best-effort error reporter for the fail-closed path. Called (guarded) when
   * the provider is unreachable/errored/timed out so the failure reaches Sentry
   * even though the adapter swallows it and returns a degraded result. A
   * throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

/**
 * Azure AI Content Safety adapter (FR-002). POSTs the image bytes (base64) to
 * `image:analyze`, maps the per-category four-level severities into the
 * normalized {@link ImageModerationResult}, and FAILS CLOSED — on any non-2xx,
 * network error, timeout, or parse failure it returns a degraded FLAGGED result
 * (never throws to the caller) and surfaces the underlying error via
 * `reportError` / `logger` from config (FR-006). Transient failures (429 / 5xx /
 * timeout) are retried with a short backoff before falling back to degraded
 * (NFR-002 / NFR-005).
 */
export function createAzureContentSafetyModerationAdapter(
  config: AzureContentSafetyModerationConfig,
): ModerationPort {
  const endpoint = config.endpoint.replace(/\/+$/g, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  const analyzeOnce = async (
    base64: string,
  ): Promise<ImageModerationResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(
        `${endpoint}/contentsafety/image:analyze?api-version=${API_VERSION}`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            image: { content: base64 },
            categories: ["Hate", "SelfHarm", "Sexual", "Violence"],
            outputType: "FourSeverityLevels",
          }),
          signal: controller.signal,
        },
      );
    } catch (err) {
      // Abort → timeout; anything else network-level is transient. Both retry.
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || controller.signal.aborted);
      throw new ProviderError(
        isAbort ? "azure_content_safety_timeout" : "azure_content_safety_network",
        true,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      // Drain the body so undici doesn't warn about an undisposed stream.
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(
        `azure_content_safety_http_${response.status}`,
        retryable,
      );
    }

    let parsed: AzureCategoriesAnalysis;
    try {
      parsed = (await response.json()) as AzureCategoriesAnalysis;
    } catch (err) {
      // A malformed body is not going to fix itself on retry.
      throw new ProviderError("azure_content_safety_parse", false, err);
    }

    // Strictly validate the 2xx analysis before trusting it. A PARTIAL or
    // malformed 200 (only some of the four categories present, a duplicate, an
    // unknown/unmappable category name from api-version drift, or a
    // missing/non-numeric/non-finite severity) must NEVER coerce to a low
    // maxSeverity → APPROVED and publish an UN-ANALYZED image — that is a
    // fail-OPEN on the trust boundary. Anything we can't fully trust throws
    // `azure_content_safety_incomplete_analysis` (non-retryable → routes to the
    // degraded FLAGGED path, FR-006). We do NOT reject a finite severity merely
    // for exceeding the expected {0,2,4,6}: a higher finite value errs toward
    // "more severe", which is fail-SAFE. Only negatives (nonsensical) throw.
    const seen = new Map<ImageModerationCategory, number>();
    for (const entry of parsed.categoriesAnalysis ?? []) {
      const category = entry.category
        ? CATEGORY_MAP[entry.category]
        : undefined;
      if (!category) {
        // Unknown/missing/unmappable category name = api/version drift we can't
        // trust — don't silently skip it.
        throw new ProviderError(
          "azure_content_safety_incomplete_analysis",
          false,
        );
      }
      if (seen.has(category)) {
        // Duplicate category — ambiguous which severity governs.
        throw new ProviderError(
          "azure_content_safety_incomplete_analysis",
          false,
        );
      }
      const severity = entry.severity;
      if (
        typeof severity !== "number" ||
        !Number.isFinite(severity) ||
        severity < 0
      ) {
        // Missing / non-numeric / NaN / Infinity / negative — do NOT coerce.
        throw new ProviderError(
          "azure_content_safety_incomplete_analysis",
          false,
        );
      }
      seen.set(category, severity);
    }

    // Every one of the four requested categories must be present exactly once.
    for (const required of REQUIRED_CATEGORIES) {
      if (!seen.has(required)) {
        throw new ProviderError(
          "azure_content_safety_incomplete_analysis",
          false,
        );
      }
    }

    const categories: ImageModerationCategoryScore[] = REQUIRED_CATEGORIES.map(
      (category) => ({ category, severity: seen.get(category)! }),
    );

    // Subsumed by the completeness check above (categories is always length 4
    // here), kept as a harmless belt-and-braces guard against an unusable 2xx.
    if (categories.length === 0) {
      throw new ProviderError("azure_content_safety_empty_analysis", false);
    }

    const maxSeverity = categories.reduce(
      (max, c) => (c.severity > max ? c.severity : max),
      0,
    );

    return {
      // Provisional only — the use case re-derives the real verdict from its
      // configured threshold and ignores this field for the gate (FR-004).
      verdict: maxSeverity >= PROVISIONAL_FLAG_SEVERITY ? "FLAGGED" : "APPROVED",
      maxSeverity,
      categories,
      provider: PROVIDER,
      rawSeverityScale: "four",
      degraded: false,
    };
  };

  return {
    async moderateImage({ imageBytes, imageId }): Promise<ImageModerationResult> {
      const base64 = Buffer.from(imageBytes).toString("base64");

      let lastError: unknown;
      for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
        try {
          return await analyzeOnce(base64);
        } catch (err) {
          lastError = err;
          const retryable = err instanceof ProviderError && err.retryable;
          if (retryable && attempt < RETRY_BACKOFFS_MS.length) {
            await sleep(RETRY_BACKOFFS_MS[attempt] ?? 0);
            continue;
          }
          break;
        }
      }

      // Fail-closed: surface the error (best-effort) and return a degraded,
      // held-for-human result. `degraded = true` is the signal the use case
      // uses to force FLAGGED + mark the record degraded (FR-006).
      const reportCause =
        lastError instanceof ProviderError && lastError.cause !== undefined
          ? lastError.cause
          : lastError;
      try {
        config.reportError?.(reportCause, {
          tags: { area: "image-moderation", provider: PROVIDER },
          extra: { imageId },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
      config.logger?.error("azure_content_safety_degraded", {
        err: lastError,
        imageId,
      });

      return {
        verdict: "FLAGGED",
        maxSeverity: DEGRADED_SENTINEL_SEVERITY,
        categories: [],
        provider: PROVIDER,
        rawSeverityScale: "four",
        degraded: true,
      };
    },
  };
}
