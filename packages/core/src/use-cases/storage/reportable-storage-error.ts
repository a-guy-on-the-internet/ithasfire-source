import { isFileStorageError } from "@th/ports/file-storage";

/**
 * File-storage adapters throw plain `{ code, message }` objects
 * (`FileStorageError`), not `Error`s. Sentry turns a non-Error into a
 * "Non-Error exception captured" event with no message to group on, so wrap
 * one before handing it to a `ReporterPort`; the original stays as `cause`.
 * Anything else passes through unchanged.
 */
export function reportableStorageError(err: unknown): unknown {
  if (err instanceof Error || !isFileStorageError(err)) return err;
  return new Error(`${err.code}: ${err.message}`, { cause: err });
}
