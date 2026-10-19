import { Prisma } from "@prisma/client";
import {
  ApiKeyRepoError,
  type ApiKeyRepoRefusalReason,
} from "@th/ports/repos/api-keys";

// Maps a Postgres refusal on api_keys / api_key_requests to a typed
// ApiKeyRepoError (scoped-api-keys spec, db_guards).
//
// WHERE THE SQLSTATE AND NAME LIVE (VERIFIED against PrismaPg 7.1 on a real
// Postgres 16, scratchpad probe 2026-10-13): a failing $queryRaw /
// $executeRaw throws PrismaClientKnownRequestError P2010 with
//   meta.driverAdapterError.cause = { originalCode, originalMessage, ... }
// PrismaPg DROPS the server's `constraint` field for 23514 (its default
// branch keeps message/detail/hint only), so:
//   - a CHECK is named only inside the message:
//       new row for relation "…" violates check constraint "<name>"
//   - a guard trigger's `RAISE … USING CONSTRAINT = 'api_keys_guard'` name
//     is LOST; the trigger is identified by its message prefix ("api key:" /
//     "key request:"), and the branch by a fixed phrase from the current
//     guard bodies, migration
//     20261013120000_scoped_api_keys_closed_for_security (which replaced
//     20261012120400_scoped_api_keys_guards_v4). The unit test pins every
//     phrase; the integration test fires every guard through this mapper.
//   - 23505 / 23503 name the index / FK inside the message as well.
// A deferred failure at COMMIT arrives as a bare DriverAdapterError whose
// `cause` has the same shape; a raw `pg` error carries code/constraint
// directly. All three shapes are read.

export const API_KEYS_GUARD = "api_keys_guard";
export const API_KEY_REQUESTS_GUARD = "api_key_requests_guard";

/**
 * Guard message phrase → reason. Order matters only where one phrase
 * contains another; none here do. Keep in step with the guard functions
 * (CREATE OR REPLACE in the latest guards migration).
 */
const REQUEST_GUARD_PHRASES: ReadonlyArray<
  readonly [string, ApiKeyRepoRefusalReason]
> = [
  ["a request is inserted pending", "request_not_inserted_pending"],
  ["content is immutable", "request_content_immutable"],
  ["auto-renew can only be switched off", "request_auto_renew_switch_on"],
  ["a decision names its decider", "decision_without_decider"],
  ["cannot be approved", "request_lapsed"],
  ["an undecided request has no decider", "undecided_with_decider"],
  ["decision is final", "decision_final"],
  ["withdrawn_at is final", "withdrawal_final"],
  ["withdrawal_reason is final", "withdrawal_final"],
  ["was withdrawn and cannot be decided", "request_withdrawn"],
  ["collected_at is written once", "collected_at_writer"],
];

const KEY_GUARD_PHRASES: ReadonlyArray<
  readonly [string, ApiKeyRepoRefusalReason]
> = [
  ["a new key has no revoke, notice or use yet", "key_born_dirty"],
  ["is not approved", "request_not_approved"],
  ["was withdrawn or closed for account security", "request_withdrawn"],
  ["expiry outside the request's term", "expiry_outside_term"],
  [
    "already collected or its collection window lapsed",
    "already_collected_or_collect_lapsed",
  ],
  ["renewal must continue", "renewal_not_allowed"],
  ["already has another live key", "renewal_overlap"],
  ["does not allow auto-renew", "auto_renew_not_allowed"],
  ["identity and scope columns are immutable", "key_identity_immutable"],
  ["revocation is final", "revocation_final"],
  ["expiry can only move earlier", "expiry_only_earlier"],
];

interface DbFailure {
  sqlState: string;
  message: string;
  /** Present only on a raw `pg` error. */
  constraint: string | null;
}

/** Pull SQLSTATE + message out of any of the three error shapes. */
export function extractDbFailure(error: unknown): DbFailure | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034") {
      // Interactive-transaction write conflict / deadlock.
      return { sqlState: "40001", message: error.message, constraint: null };
    }
    const cause = (
      error.meta as
        | { driverAdapterError?: { cause?: Record<string, unknown> } }
        | undefined
    )?.driverAdapterError?.cause;
    const fromCause = readCause(cause);
    if (fromCause) return fromCause;
    // P2010 without a driver cause: "Raw query failed. Code: `23514`. Message: `…`"
    const m = /Code: `([0-9A-Z]{5})`\. Message: `([\s\S]*)`/.exec(
      error.message,
    );
    if (m?.[1]) {
      return { sqlState: m[1], message: m[2] ?? "", constraint: null };
    }
    return null;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    const m = /Code: `([0-9A-Z]{5})`/.exec(error.message);
    return m?.[1]
      ? { sqlState: m[1], message: error.message, constraint: null }
      : null;
  }
  if (error !== null && typeof error === "object") {
    const e = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    // Bare DriverAdapterError (failure raised at COMMIT).
    if (e.name === "DriverAdapterError") {
      return readCause(e.cause as Record<string, unknown> | undefined);
    }
    // Raw `pg` DatabaseError.
    if (
      typeof e.code === "string" &&
      /^[0-9A-Z]{5}$/.test(e.code) &&
      typeof e.message === "string"
    ) {
      return {
        sqlState: e.code,
        message: e.message,
        constraint: typeof e.constraint === "string" ? e.constraint : null,
      };
    }
  }
  return null;
}

function readCause(
  cause: Record<string, unknown> | undefined,
): DbFailure | null {
  if (!cause) return null;
  const code = cause.originalCode ?? cause.code;
  if (typeof code !== "string") return null;
  const message =
    typeof cause.originalMessage === "string"
      ? cause.originalMessage
      : typeof cause.message === "string"
        ? cause.message
        : "";
  return { sqlState: code, message, constraint: null };
}

function quotedName(message: string, kind: string): string | null {
  const re = new RegExp(`${kind} "([^"]+)"`);
  return re.exec(message)?.[1] ?? null;
}

function matchPhrase(
  message: string,
  table: ReadonlyArray<readonly [string, ApiKeyRepoRefusalReason]>,
): ApiKeyRepoRefusalReason {
  for (const [phrase, reason] of table) {
    if (message.includes(phrase)) return reason;
  }
  return "guard_violation_unknown";
}

/**
 * The typed error for a DB refusal, or null when `error` is not one this
 * mapper owns (it is then rethrown untouched by {@link rethrowApiKeyDbError}).
 */
export function toApiKeyRepoError(error: unknown): ApiKeyRepoError | null {
  if (error instanceof ApiKeyRepoError) return error;
  const failure = extractDbFailure(error);
  if (!failure) return null;
  const { sqlState, message } = failure;

  if (sqlState === "40P01" || sqlState === "40001") {
    return new ApiKeyRepoError({
      code: "retryable",
      reason: null,
      constraint: null,
      sqlState,
      message: "api key write hit a deadlock or serialization failure; retry",
      cause: error,
    });
  }

  if (sqlState === "23514") {
    let constraint: string | null;
    let reason: ApiKeyRepoRefusalReason;
    if (message.startsWith("api key:")) {
      constraint = API_KEYS_GUARD;
      reason = matchPhrase(message, KEY_GUARD_PHRASES);
    } else if (message.startsWith("key request:")) {
      constraint = API_KEY_REQUESTS_GUARD;
      reason = matchPhrase(message, REQUEST_GUARD_PHRASES);
    } else {
      constraint =
        failure.constraint ?? quotedName(message, "check constraint");
      // A raw pg error names the trigger in `constraint` directly.
      if (constraint === API_KEYS_GUARD) {
        reason = matchPhrase(message, KEY_GUARD_PHRASES);
      } else if (constraint === API_KEY_REQUESTS_GUARD) {
        reason = matchPhrase(message, REQUEST_GUARD_PHRASES);
      } else if (constraint) {
        reason = "check_violation";
      } else {
        // 23514 with no guard prefix and no CHECK name: still typed, but
        // never claimed as a named CHECK.
        reason = "guard_violation_unknown";
      }
    }
    return new ApiKeyRepoError({
      code: "guard_refused",
      reason,
      constraint,
      sqlState,
      message: `api key write refused (${constraint ?? "check"}): ${message}`,
      cause: error,
    });
  }

  if (sqlState === "23505") {
    const constraint =
      failure.constraint ?? quotedName(message, "unique constraint");
    return new ApiKeyRepoError({
      code: "guard_refused",
      reason: "unique_violation",
      constraint,
      sqlState,
      message: `api key write refused (${constraint ?? "unique"}): ${message}`,
      cause: error,
    });
  }

  if (sqlState === "23503") {
    const constraint =
      failure.constraint ?? quotedName(message, "foreign key constraint");
    return new ApiKeyRepoError({
      code: "guard_refused",
      reason: "foreign_key_violation",
      constraint,
      sqlState,
      message: `api key write refused (${constraint ?? "foreign key"}): ${message}`,
      cause: error,
    });
  }

  return null;
}

/** Rethrow a DB refusal as {@link ApiKeyRepoError}; anything else untouched. */
export function rethrowApiKeyDbError(error: unknown): never {
  throw toApiKeyRepoError(error) ?? error;
}
