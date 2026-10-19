import type { LoggerPort } from "@th/ports/logger";
import {
  isApiKeyRepoError,
  type ApiKeyRepoError,
  type ApiKeyRepoRefusalReason,
} from "@th/ports/repos/api-keys";

/**
 * Stable domain codes of the scoped API key use cases (scoped-api-keys spec
 * 2026-10-08). Thrown in the legacy `{ code: <category>, message: <domain
 * code> }` shape the tRPC boundary already maps (`errorCodeMap` reads the
 * category, the message carries the stable code). Not (yet) in the
 * `@th/errors` registry: that needs en + es catalog copy for each, which lands
 * with the screens (plan steps 8 / 9).
 *
 * Never carries a key's plaintext, an ApiKeyRepoError message or a DB
 * constraint name.
 */
export const API_KEY_ERROR_CATEGORIES = {
  // ── Not found (also every IDOR refusal: an actor with no right to see a
  //    row is told it does not exist) ──
  api_key_not_found: "not_found",
  api_key_request_not_found: "not_found",
  // ── Who may do this ──
  api_key_request_not_eligible: "forbidden",
  api_key_requester_no_longer_eligible: "forbidden",
  api_key_holder_no_longer_eligible: "forbidden",
  api_key_decide_not_allowed: "forbidden",
  api_key_own_request: "forbidden",
  api_key_step_up_required: "forbidden",
  api_key_session_only: "forbidden",
  api_key_revoke_not_allowed: "forbidden",
  api_key_auto_renew_not_allowed: "forbidden",
  api_key_holder_inactive: "forbidden",
  api_key_list_not_allowed: "forbidden",
  // ── Request shape the schema cannot express alone ──
  api_key_expiry_not_allowed: "invalid_input",
  api_key_auto_renew_needs_term: "invalid_input",
  api_key_platform_wide_read_only: "invalid_input",
  api_key_org_required: "invalid_input",
  api_key_denial_reason_required: "invalid_input",
  api_key_self_approval_terms: "invalid_input",
  // ── Caps (FR-011) ──
  api_key_cap_reached: "conflict",
  api_key_org_cap_reached: "conflict",
  // ── Abuse limit (orchestrator, not a spec rule): `rate_limited` is the
  //    category the tRPC errorCodeMap sends as 429 ──
  api_key_request_rate_limited: "rate_limited",
  // ── State (derived from timestamps) ──
  api_key_request_already_decided: "conflict",
  api_key_request_withdrawn: "conflict",
  api_key_request_closed_for_account_security: "conflict",
  api_key_request_lapsed: "conflict",
  api_key_request_not_approved: "conflict",
  api_key_already_collected_or_lapsed: "conflict",
  api_key_not_renewable: "conflict",
  api_key_not_live: "conflict",
  api_key_legacy_key: "conflict",
  // ── The DB refused a write core should have refused first (a bug), or a
  //    deadlock that survived one retry ──
  api_key_write_refused: "conflict",
  api_key_busy_retry: "conflict",
} as const;

export type ApiKeyErrorCode = keyof typeof API_KEY_ERROR_CATEGORIES;
export type ApiKeyErrorCategory =
  (typeof API_KEY_ERROR_CATEGORIES)[ApiKeyErrorCode];

/**
 * A typed refusal: `code` is the transport category, `message` the stable
 * domain code (the shape `toTrpcError` maps). `meta` holds only numbers and
 * enum strings, never free text from the DB.
 */
export class ApiKeyUseCaseError extends Error {
  readonly code: ApiKeyErrorCategory;
  readonly domainCode: ApiKeyErrorCode;
  readonly meta?: Record<string, string | number | boolean | null>;

  constructor(
    domainCode: ApiKeyErrorCode,
    meta?: Record<string, string | number | boolean | null>,
  ) {
    super(domainCode);
    this.name = "ApiKeyUseCaseError";
    this.code = API_KEY_ERROR_CATEGORIES[domainCode];
    this.domainCode = domainCode;
    if (meta) this.meta = meta;
    Object.setPrototypeOf(this, ApiKeyUseCaseError.prototype);
  }
}

export function apiKeyError(
  domainCode: ApiKeyErrorCode,
  meta?: Record<string, string | number | boolean | null>,
): ApiKeyUseCaseError {
  return new ApiKeyUseCaseError(domainCode, meta);
}

export function isApiKeyUseCaseError(
  error: unknown,
): error is ApiKeyUseCaseError {
  return error instanceof ApiKeyUseCaseError;
}

/**
 * Guard refusals that mean "the request moved under you" (a race the guard
 * settled), each with the code a caller can act on. Every other reason means
 * core let through a write it should have refused: a bug, reported as
 * `api_key_write_refused` and logged at error level (Sentry via pino).
 */
const STATE_REASONS: Partial<Record<ApiKeyRepoRefusalReason, ApiKeyErrorCode>> =
  {
    request_lapsed: "api_key_request_lapsed",
    decision_final: "api_key_request_already_decided",
    request_withdrawn: "api_key_request_withdrawn",
    withdrawal_final: "api_key_request_withdrawn",
    request_not_approved: "api_key_request_not_approved",
    already_collected_or_collect_lapsed: "api_key_already_collected_or_lapsed",
    renewal_not_allowed: "api_key_not_renewable",
    renewal_overlap: "api_key_not_renewable",
    auto_renew_not_allowed: "api_key_not_renewable",
    revocation_final: "api_key_not_live",
  };

/**
 * Map an {@link ApiKeyRepoError} to a typed core error. `overrides` lets a use
 * case read a generic reason in its own context (e.g. `unique_violation` on
 * collect = already collected).
 */
export function mapApiKeyRepoError(
  error: ApiKeyRepoError,
  context: {
    useCase: string;
    logger?: LoggerPort;
    overrides?: Partial<Record<ApiKeyRepoRefusalReason, ApiKeyErrorCode>>;
  },
): ApiKeyUseCaseError {
  if (error.code === "retryable") return apiKeyError("api_key_busy_retry");
  const reason = error.reason;
  const mapped =
    (reason && context.overrides?.[reason]) ??
    (reason && STATE_REASONS[reason]) ??
    null;
  if (mapped) return apiKeyError(mapped);
  // Internal log only: the constraint name helps find the bug and never
  // leaves the server.
  context.logger?.error("api_keys.guard_refused_unexpected_write", {
    useCase: context.useCase,
    reason,
    constraint: error.constraint,
    sqlState: error.sqlState,
  });
  return apiKeyError("api_key_write_refused");
}

/**
 * Run `fn` and turn any {@link ApiKeyRepoError} it throws into a typed core
 * error.
 *
 * A repo refusal leaves the transaction aborted (Postgres semantics), so the
 * whole `fn` (normally one `repos.tx()`) is the unit: nothing keeps writing
 * after a refusal. A `retryable` refusal (deadlock 40P01 / serialization
 * 40001) re-runs `fn` ONCE: the lock order is fixed (cap lock → request →
 * key), so a deadlock is a rare crossing with a peer writer and the second
 * run usually wins. Safe because `fn` rolled back completely and the use
 * cases send notifications only after it returns. A second `retryable`
 * surfaces as `api_key_busy_retry`, which the caller may retry.
 */
export async function runApiKeyWrite<T>(
  fn: () => Promise<T>,
  context: {
    useCase: string;
    logger?: LoggerPort;
    overrides?: Partial<Record<ApiKeyRepoRefusalReason, ApiKeyErrorCode>>;
  },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isApiKeyRepoError(error)) throw error;
      if (error.code === "retryable" && attempt < 2) continue;
      throw mapApiKeyRepoError(error, context);
    }
  }
}
