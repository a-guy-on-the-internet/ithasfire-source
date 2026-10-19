import { createHash } from "node:crypto";

import type { ChainableCommander } from "ioredis";

/**
 * Run a MULTI/pipeline and throw a SANITISED error on any failure.
 *
 * ioredis's `exec()` does not reliably reject when the write failed:
 *   - a queued command that fails arrives as an `[err, result]` tuple;
 *   - an aborted transaction (a WATCHed key changed) resolves `null`;
 *   - EXECABORT and connection loss DO reject, but with an error carrying
 *     `previousErrors` and `command.args`.
 * Callers rely on a rejection to know a write did not land, so all three
 * become a thrown error here.
 *
 * What the error may carry. Keys can hold secrets (e.g. idempotency key
 * `claim-transfer:<bearer token>:<clientKey>`) and ioredis errors carry the
 * command arguments — the values being written — as `command.args` /
 * `previousErrors`, which pino's default `err` serializer writes out in full.
 * So the thrown error holds:
 *   - `op`, a static label from the call site (e.g. "idempotency commit");
 *   - `keyHash`, the first 12 hex chars of sha256(key): stable, so an
 *     operator can match it against a suspect key, but not reversible;
 *   - the Redis error CODE only (e.g. "OOM", "WRONGTYPE", "EXECABORT"), never
 *     the reply text (some replies echo arguments);
 * and no `cause`. It never includes the raw key or any value.
 */
export async function execOrThrow(
  multi: ChainableCommander,
  op: string,
  key: string,
): Promise<void> {
  let replies: Awaited<ReturnType<ChainableCommander["exec"]>>;
  try {
    replies = await multi.exec();
  } catch (err) {
    throw redisWriteError(op, key, "rejected", err);
  }
  if (replies === null) {
    throw redisWriteError(op, key, "aborted");
  }
  const failed = replies.findIndex(([err]) => err);
  if (failed !== -1) {
    throw redisWriteError(op, key, `failed at command ${failed}`, replies[failed]![0]);
  }
}

/** Short, non-reversible key fingerprint for error messages. */
export function redisKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

const CLIENT_ERROR_CODES: ReadonlyArray<readonly [string, string]> = [
  ["Command timed out", "TIMEOUT"],
  ["Connection is closed", "CONNECTION_CLOSED"],
];

/**
 * The Redis error code (the leading all-caps word of a reply, e.g. "OOM"), or
 * the error's class name for client-side errors. Never the message text.
 */
function redisErrorCode(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  // Client-side ioredis errors are plain `Error`s with no Redis code. Map the
  // known message prefixes to fixed codes; never echo any other message text.
  for (const [prefix, code] of CLIENT_ERROR_CODES) {
    if (err.message.startsWith(prefix)) return code;
  }
  const head = /^([A-Z][A-Z_]{1,31})\b/.exec(err.message)?.[1];
  return head ?? err.name ?? "Error";
}

function redisWriteError(
  op: string,
  key: string,
  what: string,
  err?: unknown,
): Error {
  const code = err === undefined ? "" : ` [${redisErrorCode(err)}]`;
  return new Error(`redis ${op} ${what}${code} (keyHash=${redisKeyHash(key)})`);
}
