import type { FileStoragePort } from "@th/ports/file-storage";

import {
  IMAGE_DIMENSIONS_PREFIX_BYTES,
  readImageDimensions,
  type ImageDimensions,
} from "./image-dimensions";

/**
 * Reads a stored image's pixel size from the first
 * {@link IMAGE_DIMENSIONS_PREFIX_BYTES} of the object (a ranged read, never the
 * whole file).
 *
 * Resolves `null` when the header cannot be parsed from that prefix: that is
 * an answer, not a failure, and there is deliberately no fallback to a full
 * read. REJECTS when storage does (missing object, network): the caller
 * decides whether that is fatal. Finalize swallows and reports it; the
 * backfill counts it.
 */
export async function readStoredImageDimensions(
  storage: Pick<FileStoragePort, "getObject">,
  key: string,
): Promise<ImageDimensions | null> {
  const { content } = await storage.getObject({
    key,
    range: { start: 0, end: IMAGE_DIMENSIONS_PREFIX_BYTES - 1 },
  });
  return readImageDimensions(content);
}
