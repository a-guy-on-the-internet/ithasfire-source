import * as Sentry from "@sentry/nextjs";

/**
 * Use INSTEAD of `.catch(() => {})` or `.catch(() => undefined)`.
 *
 * Returns a rejection handler that logs to the console in development and
 * sends the error to Sentry with a `traceIgnoredError` tag in production,
 * so intentionally-ignored errors stay visible without breaking calling
 * code. The name spells out what the call site is actually doing: "I am
 * ignoring this rejection for control-flow purposes — please record it."
 *
 * @param label  Stable identifier for the call site (e.g. "checkout.hold").
 *               Used as a Sentry tag and shows up in the dev console prefix.
 * @param expected  Optional predicate that returns true for known-benign
 *               rejections (e.g. autoplay blocked, AbortError from a
 *               cancelled fetch). When it matches, telemetry is skipped.
 *
 * @example
 *   audio.play().catch(traceIgnoredError("audio.play", isAutoplayBlocked));
 *   handleCheckout().catch(traceIgnoredError("checkout.submit"));
 */
export function traceIgnoredError(
  label: string,
  expected?: (err: unknown) => boolean,
): (err: unknown) => void {
  return (err: unknown) => {
    if (expected?.(err)) return;
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[traceIgnoredError:${label}]`, err);
    }
    try {
      Sentry.captureException(err, {
        tags: { traceIgnoredError: label },
      });
    } catch {
      // Sentry not initialised (SSR boundary, etc.) — fall back to console
      // so we never silently drop on top of silently dropping.
      console.warn(
        `[traceIgnoredError:${label}] (sentry unavailable)`,
        err,
      );
    }
  };
}

/** True for `AbortController.abort()` cancellations. */
export const isAbortError = (err: unknown): boolean =>
  typeof DOMException !== "undefined" &&
  err instanceof DOMException &&
  err.name === "AbortError";

/** True for autoplay-blocked or user-gesture rejection on `HTMLMediaElement.play()`. */
export const isAutoplayBlocked = (err: unknown): boolean =>
  typeof DOMException !== "undefined" &&
  err instanceof DOMException &&
  (err.name === "NotAllowedError" || err.name === "AbortError");
