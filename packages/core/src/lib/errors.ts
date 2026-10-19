export type KnownErrorCode =
  | "invalid_input"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "dependency_failed"
  | "transient"
  // Domain precondition / state codes with bespoke transport mappings —
  // every entry here must have a row in trpc's `errorCodeMap` so it never
  // falls through to INTERNAL_SERVER_ERROR.
  | "place_not_verified"
  | "performer_mode_required"
  | "place_not_accepting_requests"
  | "duplicate_open_request"
  // Entity-report dedupe (entity-report-intake FR-003): thrown by BOTH the
  // submit use-case pre-check and the adapter's P2002 mapping for the
  // partial unique index — one PENDING report per (reporter, subject).
  // Transport maps it to CONFLICT in trpc's `errorCodeMap`.
  | "report_already_open"
  | "invalid_status"
  // Booking-agreement finalize preconditions.
  | "lines_unconfirmed"
  | "payee_not_ready"
  | "event_already_has_agreement";

export type KnownError = {
  code: KnownErrorCode;
  message?: string;
  cause?: unknown;
};

/**
 * Type-safe error thrower for use cases. Returns `never` so TypeScript knows
 * code after `fail()` is unreachable.
 *
 * Pass `cause` whenever you're re-raising inside a `catch` block — the
 * transport layer (`toTrpcError`) hoists it onto the TRPCError.cause so
 * Sentry's `linkedErrors` integration follows the chain to the original
 * SDK / adapter error instead of stopping at the synthetic surface.
 *
 * @example
 * const user = await repo.getById(id);
 * if (!user) return fail("not_found", "user_not_found");
 *
 * @example
 * try { await fileStorage.presignPutObject(...); }
 * catch (err) { return fail("dependency_failed", "storage_error", err); }
 */
export function fail(
  code: KnownErrorCode,
  message?: string,
  cause?: unknown,
): never {
  throw cause !== undefined
    ? ({ code, message, cause } as const)
    : ({ code, message } as const);
}

export function isKnownError(error: unknown): error is KnownError {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as Partial<KnownError> & { code?: unknown };
  return typeof candidate.code === "string";
}

/**
 * Normalise a raw catch into a `KnownError` so it lands at trpc with a
 * recognisable code and Sentry sees the underlying adapter/SDK error as
 * a linked cause.
 *
 *  - Already a `KnownError` (e.g. domain `conflict`, `not_found`,
 *    pre-fail()'d transient): returned untouched so trpc's `errorCodeMap`
 *    can map it correctly.
 *  - Anything else (raw Stripe/Prisma/fetch error): wrapped as
 *    `dependency_failed` tagged with the call-site `action` (e.g.
 *    "create_checkout") and the original attached as `cause`.
 *
 * Intended for abandon-claim + throw wrappers around use-cases (release the
 *  claim on a transient error; see lib/idempotency-claim.ts for why not `fail`):
 *
 *     } catch (error) {
 *       await abandonClaim(deps.idempotency, key, ownerToken, error, { useCase: "createCheckout", logger, reportError });
 *       throw asKnownError("create_checkout", error);
 *     }
 */
export function asKnownError(action: string, error: unknown): KnownError {
  if (isKnownError(error)) return error;
  return toDependencyFailed(action, error);
}

export function toDependencyFailed(
  action: string,
  cause?: unknown,
): KnownError {
  return {
    code: "dependency_failed",
    message: action,
    ...(cause !== undefined ? { cause } : {}),
  } as KnownError;
}

export function toTransient(action: string, cause?: unknown): KnownError {
  return {
    code: "transient",
    message: action,
    ...(cause !== undefined ? { cause } : {}),
  } as KnownError;
}
