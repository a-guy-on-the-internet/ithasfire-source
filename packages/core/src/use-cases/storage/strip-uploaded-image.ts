import { createHash } from "node:crypto";

import { fail } from "@th/errors";
import type { FileStoragePort } from "@th/ports/file-storage";

import {
  readImageDimensions,
  type ImageDimensions,
} from "../../lib/images/image-dimensions";
import {
  ImageMetadataStripError,
  stripImageMetadata,
} from "../../lib/images/strip-image-metadata";

/**
 * The message (and `meta.reason`) a finalize path refuses with when the
 * uploaded bytes cannot be walked as the image type they were declared as.
 * Rides `INVALID_INPUT` so it needs no new catalog copy, the same way
 * `UPLOAD_SIZE_EXCEEDED` does.
 */
export const IMAGE_UNREADABLE = "image_unreadable";

/**
 * Where the stripped copy of an upload lives: the upload's directory, a name
 * that is the first 32 hex chars of `sha256(uploadKey + "\0" + strippedBytes)`,
 * and the upload's extension.
 * `events/e1/images/u-<uuid>.jpg` → `events/e1/images/<32 hex>.jpg`.
 *
 *   - NEITHER KEY IS DERIVABLE FROM THE OTHER, OR FROM THE IMAGE ID. The
 *     original (with its GPS) stays public at the upload key until its
 *     deletion lands. The upload key is built from its own random token
 *     (`request-event-image-upload.ts`), not the image id that public reads
 *     expose, and the stripped key is a hash over it, so a suffix scheme
 *     (`<uuid>-s.jpg`) cannot hand anyone holding the public URL the
 *     original's URL. Only the uploader and the database know the upload key.
 *   - Deterministic for the same upload key AND the same bytes, so a finalize
 *     retried after a crash overwrites its own copy instead of leaking a
 *     second one.
 *   - Different bytes (the upload re-PUT in between) give a different key, so
 *     two finalizes never write different files to one key.
 *   - Never the upload key itself: a CDN may already hold the original there.
 */
export function strippedImageKey(uploadKey: string, strippedBytes: Uint8Array): string {
  const slash = uploadKey.lastIndexOf("/");
  const dir = uploadKey.slice(0, slash + 1);
  const name = uploadKey.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const digest = createHash("sha256")
    .update(uploadKey)
    .update("\0")
    .update(strippedBytes)
    .digest("hex")
    .slice(0, 32);
  return `${dir}${digest}${ext}`;
}

export type StripUploadedImageDeps = {
  fileStorage: Pick<FileStoragePort, "getObject" | "putObject" | "getObjectUrl">;
};

export type StripUploadedImageArgs = {
  /** Key the client PUT the original to. Read, never written. */
  uploadKey: string;
  /** The type declared (and signed into the PUT) at presign time. */
  contentType: string;
  /** Whether the stripped object is publicly readable. */
  public: boolean;
  /**
   * Asked once a strip slot is held, BEFORE the object is read. Returning
   * false ends the call as `superseded` without reading anything: a batch of
   * finalizes for one image that queued behind the first then costs one
   * row read each, not one 25 MB object read each.
   */
  stillNeeded?: () => Promise<boolean>;
};

export type StripUploadedImageResult =
  | {
      ok: true;
      /** Key of the stripped copy ({@link strippedImageKey}). */
      key: string;
      /** URL of the stripped copy. */
      publicUrl: string;
      /**
       * Pixel size read from the stripped file inside the slot; null when the
       * header cannot be read. The file itself is NOT returned: it must not
       * outlive the slot (see {@link IMAGE_STRIP_CONCURRENCY}).
       */
      dimensions: ImageDimensions | null;
      /** Size of the stripped file. */
      sizeBytes: number;
      /**
       * Never set: the file stays inside the slot. Declared so that adding
       * the buffer back to this result is a type error.
       */
      bytes?: never;
      /** What the stripper dropped (for logs): the first few labels. */
      removed: string[];
      removedCount: number;
    }
  | {
      ok: false;
      superseded: false;
      /** The bytes are not a walkable image of `contentType`. */
      error: ImageMetadataStripError;
    }
  | {
      ok: false;
      /** `stillNeeded` said no: nothing was read or written. */
      superseded: true;
    };

/**
 * Strips allowed at once in this process. Each one holds the upload (up to
 * 25 MB) and its stripped copy (up to the same again) in memory, so this is
 * what bounds the memory finalize can take, whatever the request rate: the
 * API runs in 1 GiB. Two keeps a second user from queueing behind one slow
 * read without letting a burst multiply.
 *
 * The bound only holds because NO BYTES LEAVE THE SLOT: everything a caller
 * needs from the file (its key, pixel size, byte size) is computed inside,
 * and the buffers are garbage once the slot's work returns. A caller that
 * kept them through its own transaction and storage calls would hold 25 MB
 * per request for as long as the database and R2 take, outside any bound.
 */
export const IMAGE_STRIP_CONCURRENCY = 2;

/**
 * Callers allowed to WAIT for a slot. Past this, a call is refused at once
 * (`RATE_LIMITED`, message {@link IMAGE_STRIP_BUSY}; the transport answers
 * TOO_MANY_REQUESTS) rather than queueing without bound behind slow reads.
 * Concurrent calls for the same upload do not queue: they join the first.
 */
export const IMAGE_STRIP_MAX_WAITING = 32;

/** The message a strip refused for a full queue carries. Retryable. */
export const IMAGE_STRIP_BUSY = "image_strip_busy";

/**
 * A counting semaphore with a bounded queue. Waiters hold no bytes (the read
 * happens inside the slot), so the queue itself costs a closure per caller.
 */
class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(
    size: number,
    private readonly maxWaiting: number,
  ) {
    this.free = size;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) {
      this.free -= 1;
    } else {
      if (this.waiting.length >= this.maxWaiting) {
        fail("RATE_LIMITED", {
          message: IMAGE_STRIP_BUSY,
          meta: { reason: IMAGE_STRIP_BUSY, retryable: true },
        });
      }
      // A releasing caller hands its slot straight to us (no decrement here).
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

const stripSlots = new Slots(IMAGE_STRIP_CONCURRENCY, IMAGE_STRIP_MAX_WAITING);

/**
 * Strips already running in this process, by upload. A second caller for the
 * same upload (a double-submit, or one tRPC batch of N finalizes for one
 * image) joins the first instead of reading the object again.
 */
const inFlight = new Map<string, Promise<StripUploadedImageResult>>();

/**
 * Runs `fn` inside one of this process's strip slots. For callers that read
 * and strip an image without going through {@link stripUploadedImage} (the
 * booking-ask copy), so they count against the same memory bound. `fn` must
 * not return the file's bytes; return what was read from them instead.
 * Rejects with `RATE_LIMITED` when the queue is full.
 */
export function withImageStripSlot<T>(fn: () => Promise<T>): Promise<T> {
  return stripSlots.run(fn);
}

/**
 * Reads an uploaded image, removes its metadata (EXIF/GPS, XMP, IPTC,
 * comments, appended secondary images; see `strip-image-metadata.ts`) and
 * writes the result to a NEW key beside the upload.
 *
 * Storage failures throw (including a `not_found` read, which the caller may
 * treat as "a concurrent finalize already deleted it"): the caller has not
 * committed anything yet, and a retry re-derives the same key. Bytes the
 * stripper cannot parse come back as `{ ok: false, superseded: false }` so
 * the caller can refuse the upload; nothing is written. The upload key is
 * left alone either way: deleting it is the caller's job, after its own
 * commit.
 *
 * MEMORY. The read, strip and write run inside one of
 * {@link IMAGE_STRIP_CONCURRENCY} process-wide slots, and concurrent calls
 * for the same upload share one run (and so one result). Inside the slot,
 * `stillNeeded` is asked before the read. The result carries no bytes. A full
 * slot queue rejects with `RATE_LIMITED` ({@link IMAGE_STRIP_BUSY}).
 */
export function stripUploadedImage(
  deps: StripUploadedImageDeps,
  args: StripUploadedImageArgs,
): Promise<StripUploadedImageResult> {
  const flightKey = `${args.uploadKey}\0${args.contentType}\0${args.public}`;
  const joined = inFlight.get(flightKey);
  if (joined) return joined;

  const run: Promise<StripUploadedImageResult> = stripSlots
    .run(() => readStripWrite(deps, args))
    .finally(() => {
      if (inFlight.get(flightKey) === run) inFlight.delete(flightKey);
    });
  inFlight.set(flightKey, run);
  return run;
}

async function readStripWrite(
  deps: StripUploadedImageDeps,
  args: StripUploadedImageArgs,
): Promise<StripUploadedImageResult> {
  if (args.stillNeeded && !(await args.stillNeeded())) {
    return { ok: false, superseded: true };
  }

  const { content } = await deps.fileStorage.getObject({ key: args.uploadKey });

  let stripped: ReturnType<typeof stripImageMetadata>;
  try {
    stripped = stripImageMetadata(content, args.contentType);
  } catch (err) {
    if (err instanceof ImageMetadataStripError) {
      return { ok: false, superseded: false, error: err };
    }
    throw err;
  }

  const key = strippedImageKey(args.uploadKey, stripped.bytes);
  await deps.fileStorage.putObject({
    key,
    content: stripped.bytes,
    options: { contentType: args.contentType, public: args.public },
  });
  const { url } = await deps.fileStorage.getObjectUrl({
    key,
    options: { public: args.public },
  });

  // Last use of the bytes: everything below is plain data.
  return {
    ok: true,
    key,
    publicUrl: url,
    dimensions: readImageDimensions(stripped.bytes),
    sizeBytes: stripped.bytes.length,
    removed: stripped.removed,
    removedCount: stripped.removedCount,
  };
}
