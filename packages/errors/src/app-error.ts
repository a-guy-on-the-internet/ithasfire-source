import type { AppErrorCode } from "./codes";

export type AppErrorOptions = {
  message?: string;
  meta?: Record<string, unknown>;
  cause?: unknown;
  /**
   * Optional coarse transport-category hint: another {@link AppErrorCode} whose
   * default HTTP / tRPC bucket this error should borrow when a transport maps
   * it. This is pure data — the `errors` package stays transport-agnostic and
   * never references tRPC/HTTP status names. The tRPC boundary
   * (`packages/transport/trpc/src/utils.ts`) owns the
   * `AppErrorCode → tRPC code` table and resolves the status from this
   * `category` when present, else from the error's own `code` (`category ??
   * code`).
   *
   * Only needed at the rare throw site where the code's default bucket is wrong
   * (e.g. reusing a generic code that should be a 409 here). Defaults to the
   * error's own `code`.
   */
  category?: AppErrorCode;
};

/**
 * Structured application error carrying a canonical {@link AppErrorCode} plus
 * an arbitrary `meta` bag. Extends `Error` so it produces a real stack trace
 * for Sentry and flows through the server logging path as an `Error` instance.
 *
 * Prefer throwing this (via {@link fail}) over a raw `throw { code, message }`
 * object literal: an `AppError` carries the canonical code directly, so the
 * tRPC boundary resolves `data.appCode` and the HTTP status without the
 * message-first/code-fallback guesswork the legacy shape requires.
 *
 * `meta` is intentionally untyped (`Record<string, unknown>`) for now — a
 * per-code discriminated `meta` union is a tracked follow-up, not part of this
 * contract.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly meta?: Record<string, unknown>;
  /** @see AppErrorOptions.category */
  readonly category?: AppErrorCode;

  constructor(code: AppErrorCode, opts: AppErrorOptions = {}) {
    super(opts.message ?? code, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.meta = opts.meta;
    this.category = opts.category;
    // Restore the prototype chain for environments that transpile `extends
    // Error` down (e.g. older RN/Hermes targets).
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** Type guard for {@link AppError} instances. */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Throw an {@link AppError} for the given canonical code. The ergonomic,
 * preferred way for use-cases to raise a typed domain error:
 *
 * ```ts
 * if (!event) throw fail("EVENT_NOT_FOUND");
 * if (overQuota) return fail("QUOTA_EXCEEDED", { meta: { kind, limitValue } });
 * ```
 *
 * Returns `never`, so it works in both `throw fail(...)` and `return fail(...)`
 * positions (the latter satisfies any declared return type). This is the path
 * of least resistance for new code — reach for it instead of a raw
 * `throw { code, message }` literal so the codebase stops accruing ad-hoc
 * string codes.
 */
export function fail(code: AppErrorCode, opts?: AppErrorOptions): never {
  throw new AppError(code, opts);
}
