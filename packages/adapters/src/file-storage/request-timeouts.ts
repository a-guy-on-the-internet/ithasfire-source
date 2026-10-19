import type { Readable } from "node:stream";

import {
  createFileStorageError,
  type FileStorageError,
} from "@th/ports/file-storage";

/**
 * Time limits for the S3-compatible storage clients (R2, MinIO).
 *
 * The SDK's default is to wait forever. A read that hangs then holds whatever
 * waits on it: event-image finalize reads, strips and rewrites uploads inside
 * a small process-wide pool of strip slots (`strip-uploaded-image.ts`), so one
 * stuck R2 connection would take a slot for good.
 *
 * THE SDK'S OWN TIMEOUTS DO NOT BOUND A STALLED BODY, and what they do mean
 * depends on the `@smithy/node-http-handler` version that gets installed
 * (4.3.x nested under client-s3 here; 4.4.x hoisted at the root, and a deploy
 * can resolve either):
 *
 *   - 4.3: `requestTimeout` (alias `socketTimeout`) is a socket-idle timer,
 *     but at ≥ 6 s its arming is deferred by 3 s and it is dropped once the
 *     response headers arrive, so the body read is never watched.
 *   - 4.4: `requestTimeout` is a deadline for the response HEADERS that only
 *     logs a warning unless `throwOnRequestTimeout`; the idle timer moved to
 *     `socketTimeout`.
 *
 * So both are set (they cost nothing and catch a dead connect or a server that
 * never answers), and the bound that actually holds is the HARD DEADLINE:
 * `readDeadlineMs` / `writeDeadlineMs` cover the whole `getObject` /
 * `putObject` call, SDK retries and body transfer included
 * ({@link startDeadline}). Past it the request is aborted, the body stream
 * destroyed, and the call fails `transient` (`<op>_deadline_exceeded`).
 */
export type FileStorageRequestTimeouts = {
  /** Time to establish the TCP/TLS connection. */
  connectionMs: number;
  /**
   * The SDK's per-attempt timer, and its meaning depends on the handler:
   *
   *   - 4.4 (`requestTimeout` + `throwOnRequestTimeout`): a cap on the time
   *     from request start to the response headers. For a GET that is the
   *     wait before the body; for a PUT the response comes only after the
   *     WHOLE upload, so every PUT attempt must finish uploading within it,
   *     and a timed-out attempt is retried from byte 0. A caller moving more
   *     data must raise `requestMs`, not only `writeDeadlineMs`
   *     ({@link resolveRequestTimeouts} does this when only the write
   *     deadline is overridden).
   *   - 4.3 (`requestTimeout`) and 4.4 (`socketTimeout`): socket idle, which
   *     at ≥ 6 s is armed late and dropped at the headers, so it never
   *     watches a GET's body.
   *
   * The SDK sends every PUT body with `Expect: 100-continue`; the handler
   * waits up to 6 s for the interim 100 before sending anyway, and that wait
   * counts against this same per-attempt cap.
   */
  requestMs: number;
  /** Hard ceiling on one `getObject` (body included) or `headObject`. */
  readDeadlineMs: number;
  /** Hard ceiling on one `putObject`, body included. */
  writeDeadlineMs: number;
};

/**
 * Chosen against what the callers move (all Buffers, nothing streamed):
 *   - getObject: event images and booking-ask attachments (≤ 25 MB, read and
 *     stripped), moderation reads of the same images, ranged header reads.
 *     Audio is NOT read here: the transcoder downloads through a presigned
 *     URL.
 *   - putObject: stripped images (≤ 25 MB), HLS segments and playlists (small),
 *     sitemaps, CSV exports, the boot-time probe.
 * The binding limit for 25 MB is the per-attempt `requestMs` (60 s): on
 * handler 4.4 one PUT attempt must upload it within that, ~430 KB/s, and a
 * GET must see headers within it; the 120 s deadlines then leave room for an
 * SDK retry. Both are far below any healthy R2 link, so a call that hits
 * them is stuck, not slow. A caller that moves something bigger passes its
 * own `timeouts` (raising `requestMs` with the deadlines). The API passes
 * tighter values (`apps/api/src/bootstrap/storage.ts`) to fit Cloud Run's
 * 300 s request limit.
 */
export const DEFAULT_FILE_STORAGE_REQUEST_TIMEOUTS: FileStorageRequestTimeouts = {
  connectionMs: 5_000,
  requestMs: 60_000,
  readDeadlineMs: 120_000,
  writeDeadlineMs: 120_000,
};

/**
 * The `requestHandler` option for `new S3Client(...)`, in the SDK's
 * options-object form (the client builds its NodeHttpHandler from it), so
 * `@smithy/node-http-handler` need not be a direct dependency. Written for
 * both handler versions; see {@link FileStorageRequestTimeouts}.
 */
export const s3RequestHandlerOptions = (
  timeouts: Pick<FileStorageRequestTimeouts, "connectionMs" | "requestMs"> = DEFAULT_FILE_STORAGE_REQUEST_TIMEOUTS,
): {
  connectionTimeout: number;
  requestTimeout: number;
  socketTimeout: number;
  throwOnRequestTimeout: boolean;
} => ({
  connectionTimeout: timeouts.connectionMs,
  requestTimeout: timeouts.requestMs,
  socketTimeout: timeouts.requestMs,
  throwOnRequestTimeout: true,
});

/**
 * Fills in defaults for a partial override. A caller that raises ONLY
 * `writeDeadlineMs` gets `requestMs` raised to match: on handler 4.4 the
 * per-attempt `requestMs` caps the whole PUT upload (see
 * {@link FileStorageRequestTimeouts.requestMs}), so a longer write deadline
 * alone would change nothing. An explicit `requestMs` is always kept.
 */
export const resolveRequestTimeouts = (
  timeouts?: Partial<FileStorageRequestTimeouts>,
): FileStorageRequestTimeouts => {
  const resolved = { ...DEFAULT_FILE_STORAGE_REQUEST_TIMEOUTS, ...timeouts };
  if (
    timeouts?.writeDeadlineMs !== undefined &&
    timeouts.requestMs === undefined &&
    resolved.requestMs < timeouts.writeDeadlineMs
  ) {
    resolved.requestMs = timeouts.writeDeadlineMs;
  }
  return resolved;
};

export type StorageDeadline = {
  /** Pass to `client.send(command, { abortSignal })`. */
  signal: AbortSignal;
  /** True once the deadline has passed. */
  readonly expired: boolean;
  /**
   * Settles with `work`, or rejects at the deadline even if `work` never
   * settles (a body stream the abort did not reach). `body`, when given, is
   * destroyed at the deadline so the socket is released. With
   * `destroyWithError` it is destroyed WITH the deadline error, so a stream
   * piped into it (an upload's source) is torn down too; only for streams
   * that have an `error` listener (an unheard `error` event would crash the
   * process), which is why a GET's response body is destroyed without one.
   */
  race<T>(work: Promise<T>, body?: unknown, destroyWithError?: boolean): Promise<T>;
  /** The error to throw once {@link expired}. */
  error(): FileStorageError;
  /** Stops the timer (call in `finally`). */
  clear(): void;
};

/**
 * Starts a hard deadline for one storage call. Unref'd, so it never holds the
 * process open.
 */
export function startDeadline(
  op: "getObject" | "putObject" | "headObject",
  ms: number,
): StorageDeadline {
  const controller = new AbortController();
  let expired = false;
  const onExpire: Array<() => void> = [];
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`${op}_deadline_exceeded`));
    for (const fn of onExpire.splice(0)) fn();
  }, ms);
  // Node timers have `unref`; the DOM typing some tsconfigs pick does not.
  (timer as unknown as { unref?: () => void }).unref?.();

  const error = (): FileStorageError =>
    createFileStorageError("transient", `${op}_deadline_exceeded`);

  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    race<T>(work: Promise<T>, body?: unknown, destroyWithError = false): Promise<T> {
      const teardown = () =>
        destroyBody(body, destroyWithError ? new Error(`${op}_deadline_exceeded`) : undefined);
      if (expired) {
        teardown();
        return Promise.reject(error());
      }
      return new Promise<T>((resolve, reject) => {
        onExpire.push(() => {
          teardown();
          reject(error());
        });
        work.then(resolve, reject);
      });
    },
    error,
    clear() {
      clearTimeout(timer);
      onExpire.length = 0;
    },
  };
}

function destroyBody(body: unknown, err?: Error): void {
  if (body && typeof (body as Readable).destroy === "function") {
    try {
      (body as Readable).destroy(err);
    } catch {
      // Already torn down.
    }
  }
}
